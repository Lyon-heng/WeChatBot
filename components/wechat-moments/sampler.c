// 栈采样探针：不修改任何代码、不改内存属性，只在采样窗口内周期性挂起线程、抓调用栈、恢复。
//
// 用途：微信 4.1.10.27 的 SNS 发送路径既没有字符串引用、也没有导入表可挂，只能靠
// “发布那一刻谁在跑”来定位。采到的栈帧换算成 Weixin.dll 的 RVA 后，再回静态里验证。
//
// 安全性：只 SuspendThread / GetThreadContext / StackWalk64 / ResumeThread，
// 不写目标进程内存（除了自己模块里的缓冲区），不改任何代码字节。
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <tlhelp32.h>
#include <stdio.h>
#include <string.h>


#define MAX_STACKS 2048
#define MAX_FRAMES 16

static volatile LONG sampling = 0;
static volatile LONG sample_count = 0;      /* 采样次数（含重复） */
static volatile LONG stack_count = 0;       /* 去重后的不同栈数量 */
typedef struct {
    ULONG_PTR frames[MAX_FRAMES];
    USHORT depth;
    ULONG hash;
    LONG hits;
    DWORD tid;
} StackEntry;
static StackEntry stacks[MAX_STACKS];
static HANDLE worker = NULL;
static DWORD interval_ms = 10;
static int require_core = 1;
static DWORD max_ms = 40000;   /* 自动停止，避免长时间拖慢微信 */
static ULONG_PTR core_base = 0;
static ULONG_PTR core_end = 0;
static ULONG_PTR self_base = 0;
static ULONG_PTR self_end = 0;

static void remember_modules(void) {
    HMODULE core = GetModuleHandleA("Weixin.dll");
    if (core) {
        core_base = (ULONG_PTR)core;
        IMAGE_DOS_HEADER *dos = (IMAGE_DOS_HEADER *)core;
        IMAGE_NT_HEADERS *nt = (IMAGE_NT_HEADERS *)((unsigned char *)core + dos->e_lfanew);
        core_end = core_base + nt->OptionalHeader.SizeOfImage;
    }
    HMODULE self = NULL;
    GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                       (LPCWSTR)remember_modules, &self);
    if (self) {
        self_base = (ULONG_PTR)self;
        IMAGE_DOS_HEADER *dos = (IMAGE_DOS_HEADER *)self;
        IMAGE_NT_HEADERS *nt = (IMAGE_NT_HEADERS *)((unsigned char *)self + dos->e_lfanew);
        self_end = self_base + nt->OptionalHeader.SizeOfImage;
    }
}

/* 自己按 .pdata 展开调用栈：不依赖符号，x64 下比 StackWalk64 稳得多。 */
typedef struct _UNWIND_HISTORY_TABLE UNWIND_HISTORY_TABLE_LOCAL;
typedef void *(WINAPI *RtlLookupFunctionEntryFn)(DWORD64, PDWORD64, PVOID);   /* 返回 RUNTIME_FUNCTION* */
typedef PVOID (WINAPI *RtlVirtualUnwindFn)(DWORD, DWORD64, DWORD64, PVOID, PCONTEXT, PVOID *, PDWORD64, PVOID);

static int read_self(ULONG_PTR address, ULONG_PTR *value) {
    SIZE_T got = 0;
    return ReadProcessMemory(GetCurrentProcess(), (LPCVOID)address, value, sizeof(*value), &got) && got == sizeof(*value);
}

/* 展开过程可能碰到奇怪的栈（线程在系统调用里、栈被换出等），用 SEH 兜住，绝不让采样把宿主带崩。 */
static void sample_body(HANDLE thread, DWORD tid) {
    CONTEXT context;
    memset(&context, 0, sizeof(context));
    context.ContextFlags = CONTEXT_FULL;
    if (!GetThreadContext(thread, &context)) return;
    static RtlLookupFunctionEntryFn lookup = NULL;
    static RtlVirtualUnwindFn unwind = NULL;
    if (!lookup || !unwind) {
        HMODULE ntdll = GetModuleHandleA("ntdll.dll");
        lookup = (RtlLookupFunctionEntryFn)GetProcAddress(ntdll, "RtlLookupFunctionEntry");
        unwind = (RtlVirtualUnwindFn)GetProcAddress(ntdll, "RtlVirtualUnwind");
    }
    if (!lookup || !unwind) return;
    ULONG_PTR local[MAX_FRAMES];
    USHORT depth = 0;
    int inside = 0;
    for (int i = 0; i < MAX_FRAMES; i++) {
        ULONG_PTR pc = (ULONG_PTR)context.Rip;
        if (!pc) break;
        local[depth++] = pc;
        if (core_base && pc >= core_base && pc < core_end) inside = 1;
        if ((self_base && pc >= self_base && pc < self_end) || pc < 0x10000) break;
        DWORD64 image_base = 0;
        void *entry = lookup((DWORD64)pc, &image_base, NULL);
        if (!entry) {
            ULONG_PTR next = 0;
            if (!read_self((ULONG_PTR)context.Rsp, &next) || !next) break;
            context.Rip = next;
            context.Rsp += sizeof(ULONG_PTR);
        } else {
            DWORD64 establisher = 0;
            void *handler = NULL;
            ULONG_PTR before = (ULONG_PTR)context.Rip;
            /* 返回值是异常处理器地址，NULL 是常态，不能当失败 */
            unwind(0, image_base, (DWORD64)pc, entry, &context, &handler, &establisher, NULL);
            if ((ULONG_PTR)context.Rip == before) break;   /* 没前进就停，防死循环 */
        }
    }
    if ((require_core ? inside : 1) && depth >= 2) {
        InterlockedIncrement(&sample_count);
        ULONG hash = 2166136261u;
        for (int i = 0; i < depth; i++) {
            hash ^= (ULONG)(local[i] & 0xFFFFFFFFu);
            hash *= 16777619u;
        }
        for (LONG i = 0; i < stack_count && i < MAX_STACKS; i++) {
            if (stacks[i].hash == hash && stacks[i].depth == depth) {
                InterlockedIncrement(&stacks[i].hits);
                return;
            }
        }
        LONG slot = InterlockedIncrement(&stack_count) - 1;
        if (slot >= 0 && slot < MAX_STACKS) {
            memcpy(stacks[slot].frames, local, depth * sizeof(ULONG_PTR));
            stacks[slot].depth = depth;
            stacks[slot].hash = hash;
            stacks[slot].hits = 1;
            stacks[slot].tid = tid;
        }
    }
}

static void sample_one(HANDLE thread, DWORD tid) {
    if (SuspendThread(thread) == (DWORD)-1) return;
    __try {
        sample_body(thread, tid);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        /* 单个线程展开失败就跳过，不影响其它线程与宿主 */
    }
    ResumeThread(thread);
}

static DWORD WINAPI worker_main(void *param) {
    (void)param;
    remember_modules();
    const DWORD me = GetCurrentThreadId();
    const DWORD started_at = GetTickCount();
    while (sampling) {
        if (max_ms && (DWORD)(GetTickCount() - started_at) > max_ms) break;
        HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if (snapshot != INVALID_HANDLE_VALUE) {
            THREADENTRY32 entry;
            entry.dwSize = sizeof(entry);
            if (Thread32First(snapshot, &entry)) {
                do {
                    if (entry.th32OwnerProcessID != GetCurrentProcessId() || entry.th32ThreadID == me) continue;
                    if (stack_count >= MAX_STACKS) break;
                    HANDLE thread = OpenThread(THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT | THREAD_QUERY_INFORMATION,
                                               FALSE, entry.th32ThreadID);
                    if (!thread) continue;
                    sample_one(thread, entry.th32ThreadID);
                    CloseHandle(thread);
                } while (Thread32Next(snapshot, &entry));
            }
            CloseHandle(snapshot);
        }
        Sleep(interval_ms);
    }
    return 0;
}

__declspec(dllexport) DWORD SamplerStart(DWORD interval, DWORD need_core) {
    if (sampling) return 1;
    require_core = need_core ? 1 : 0;
    max_ms = 180000;
    interval_ms = interval < 2 ? 2 : (interval > 200 ? 200 : interval);
    sampling = 1;
    worker = CreateThread(NULL, 0, worker_main, NULL, 0, NULL);
    if (!worker) { sampling = 0; return 2; }
    return 0;
}

/* 注入端只能传一个参数，这里给固定配置：10ms 间隔、只留含 Weixin.dll 帧的样本。 */
__declspec(dllexport) DWORD SamplerStartDefault(void) {
    return SamplerStart(10, 1);
}

__declspec(dllexport) DWORD SamplerStop(void) {
    sampling = 0;
    if (worker) { WaitForSingleObject(worker, 5000); CloseHandle(worker); worker = NULL; }
    return 0;
}

__declspec(dllexport) LONG SamplerCount(void) { return sample_count; }

__declspec(dllexport) LONG SamplerStacks(void) { return stack_count; }

__declspec(dllexport) void *SamplerCoreBase(void) { if (!core_base) remember_modules(); return (void *)core_base; }

/* 手写 64 位十六进制：wsprintfA 不支持 %llX，会打成乱码。 */
static size_t put_hex(char *buffer, size_t at, ULONG_PTR value) {
    static const char digits[] = "0123456789ABCDEF";
    char temp[18];
    int count = 0;
    if (!value) temp[count++] = '0';
    while (value && count < 18) { temp[count++] = digits[value & 0xF]; value >>= 4; }
    while (count > 0) buffer[at++] = temp[--count];
    return at;
}

static size_t put_dec(char *buffer, size_t at, unsigned long value) {
    char temp[12];
    int count = 0;
    if (!value) temp[count++] = '0';
    while (value && count < 12) { temp[count++] = (char)('0' + (value % 10)); value /= 10; }
    while (count > 0) buffer[at++] = temp[--count];
    return at;
}

/* 每行 "深度 tid rva1 rva2 ..."，rva 已换算成 Weixin.dll 偏移（0 表示不在核心里）。 */
__declspec(dllexport) DWORD SamplerDump(const wchar_t *path) {
    if (!path) return 1;
    HANDLE file = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) return 2;
    char line[64 + MAX_FRAMES * 20];
    for (LONG i = 0; i < stack_count && i < MAX_STACKS; i++) {
        size_t at = 0;
        at = put_dec(line, at, (unsigned long)stacks[i].hits);
        line[at++] = ' ';
        at = put_dec(line, at, (unsigned long)stacks[i].depth);
        line[at++] = ' ';
        at = put_dec(line, at, (unsigned long)stacks[i].tid);
        for (int f = 0; f < stacks[i].depth && at < sizeof(line) - 24; f++) {
            ULONG_PTR pc = stacks[i].frames[f];
            ULONG_PTR rva = (core_base && pc >= core_base && pc < core_end) ? pc - core_base : 0;
            line[at++] = ' ';
            at = put_hex(line, at, rva);
        }
        line[at++] = '\r';
        line[at++] = '\n';
        DWORD written = 0;
        WriteFile(file, line, (DWORD)at, &written, NULL);
    }
    CloseHandle(file);
    return 0;
}

/* 写到自己进程临时目录下的固定文件，供注入端读取。 */
__declspec(dllexport) DWORD SamplerDumpDefault(void) {
    wchar_t dir[MAX_PATH];
    DWORD length = GetTempPathW(MAX_PATH, dir);
    if (!length || length >= MAX_PATH) return 1;
    wchar_t path[MAX_PATH];
    SIZE_T i = 0;
    while (dir[i] && i < MAX_PATH - 1) { path[i] = dir[i]; i++; }
    const wchar_t *name = L"wechatwb-moments-samples.txt";
    SIZE_T j = 0;
    while (name[j] && i < MAX_PATH - 1) path[i++] = name[j++];
    path[i] = 0;
    return SamplerDump(path);
}

/* 自测：采样自己进程 500ms，返回样本数。 */
__declspec(dllexport) LONG SamplerSelfTest(void) {
    if (SamplerStart(5, 0)) return -1;   /* 自测时不过滤模块 */
    Sleep(500);
    SamplerStop();
    return sample_count;
}

BOOL WINAPI DllMain(HINSTANCE module, DWORD reason, LPVOID reserved) {
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) DisableThreadLibraryCalls(module);
    return TRUE;
}
