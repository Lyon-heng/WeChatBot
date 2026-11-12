// 入口布防探针：把若干目标函数所在代码页设为“守卫页”，一执行就进异常，
// 按 RIP 判断是不是某个目标入口；命中就抓调用栈 + 四个整型参数（RCX/RDX/R8/R9）。
//
// 机制：守卫页命中后系统会自动清除该页守卫，我们置单步（TF），指令执行完再收到单步异常，
// 此时把守卫布回去。这样能精确覆盖页面上的每一次执行，而不需要修改任何代码字节。
//
// 四条硬约束（都是踩出来的）：
//   1. 绝不布防自己模块所在的页——异常处理器就在里面，会无限递归直到栈溢出；
//   2. 展开调用栈必须用 CONTEXT 副本，否则 Rip/Rsp 被改坏，返回后执行流跑飞；
//   3. 硬件断点（DR0）在 VEH 里改 CONTEXT 不能可靠生效，会原地死循环，所以走守卫页；
//   4. 守卫页只挡一次访问，必须靠单步把守卫布回去，否则同页其它代码会把它用掉。
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#define MAX_TARGETS 8
#define MAX_PAGES 64
#define MAX_REC 64
#define MAX_FRAMES 16

#define ARG_SNAP 768      /* 第一个参数（对象本身）要看得深一些 */
#define ARG_SNAP_OTHER 128

typedef struct {
    ULONG_PTR rip;
    ULONG_PTR args[4];
    USHORT depth;
    DWORD tid;
    ULONG_PTR frames[MAX_FRAMES];
    unsigned char snap[4][ARG_SNAP];
    unsigned char snap_ok[4];
    unsigned int snap_len[4];
    ULONG_PTR child_ptr[4][8];         /* 参数结构里前 8 个像指针的字段 */
    unsigned char child[4][8][64];     /* 这些字段各自指向的前 64 字节 */
    unsigned char child_ok[4][8];
} Rec;

static volatile LONG armed = 0;
static volatile LONG rec_count = 0;
static volatile LONG hits_total = 0;
static PVOID veh = NULL;
static ULONG_PTR core_base = 0;
static ULONG_PTR core_end = 0;
static ULONG_PTR self_base = 0;
static ULONG_PTR self_end = 0;
static SIZE_T page_size = 4096;
static ULONG_PTR targets[MAX_TARGETS];
static unsigned char *pages[MAX_PAGES];
static volatile LONG target_count = 0;
static volatile LONG page_count = 0;
static volatile LONG cov_mode = 0;
static Rec recs[MAX_REC];
static __declspec(thread) int pending_page = -1;   /* 本线程正在为哪一页重布而单步 */
static LONG max_hits = 2000000;

static void walk(CONTEXT *context, ULONG_PTR *frames, USHORT *depth_out);

/* 覆盖模式：记录“哪些地址执行过”，按 RVA 去重累计（哈希表 + 线性探测） */
#define COV_SLOTS 16384
static ULONG_PTR cov_rva[COV_SLOTS];
static LONG cov_hits[COV_SLOTS];
static LONG cov_seq[COV_SLOTS];
static volatile LONG cov_order = 0;
static volatile LONG cov_used = 0;

static void cov_record(ULONG_PTR rip, CONTEXT *context) {
    if (!core_base || rip < core_base) return;
    ULONG_PTR rva = rip - core_base;
    ULONG idx = (ULONG)((rva >> 4) & (COV_SLOTS - 1));
    for (LONG probe = 0; probe < 32; probe++) {
        ULONG i = (idx + probe) & (COV_SLOTS - 1);
        if (cov_rva[i] == rva) { InterlockedIncrement(&cov_hits[i]); return; }
        if (cov_rva[i] == 0) {
            LONG slot = InterlockedIncrement(&cov_used) - 1;
            if (slot >= COV_SLOTS) return;
            cov_rva[i] = rva;
            cov_hits[i] = 1;
            cov_seq[i] = InterlockedIncrement(&cov_order);
            /* 头 64 个“首次执行”的地址各抓一份调用栈：它们就是这段代码最早跑的地方 */
            LONG slot2 = InterlockedIncrement(&rec_count) - 1;
            if (slot2 >= 0 && slot2 < MAX_REC && context) {
                Rec *rec = &recs[slot2];
                rec->rip = rip;
                rec->args[0] = (ULONG_PTR)context->Rcx;
                rec->args[1] = (ULONG_PTR)context->Rdx;
                rec->args[2] = (ULONG_PTR)context->R8;
                rec->args[3] = (ULONG_PTR)context->R9;
                rec->tid = GetCurrentThreadId();
                CONTEXT copy = *context;
                walk(&copy, rec->frames, &rec->depth);
            }
            return;
        }
    }
}

static void module_range(HMODULE module, ULONG_PTR *lo, ULONG_PTR *hi) {
    *lo = 0;
    *hi = 0;
    if (!module) return;
    IMAGE_DOS_HEADER *dos = (IMAGE_DOS_HEADER *)module;
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) return;
    IMAGE_NT_HEADERS *nt = (IMAGE_NT_HEADERS *)((unsigned char *)module + dos->e_lfanew);
    *lo = (ULONG_PTR)module;
    *hi = *lo + nt->OptionalHeader.SizeOfImage;
}

static void remember_modules(void) {
    module_range(GetModuleHandleA("Weixin.dll"), &core_base, &core_end);
    HMODULE self = NULL;
    GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                       (LPCWSTR)remember_modules, &self);
    module_range(self, &self_base, &self_end);
}

typedef void *(WINAPI *LookupFn)(DWORD64, PDWORD64, PVOID);
typedef PVOID (WINAPI *UnwindFn)(DWORD, DWORD64, DWORD64, PVOID, PCONTEXT, PVOID *, PDWORD64, PVOID);

static int read_ptr(ULONG_PTR address, ULONG_PTR *value) {
    SIZE_T got = 0;
    return ReadProcessMemory(GetCurrentProcess(), (LPCVOID)address, value, sizeof(*value), &got)
           && got == sizeof(*value);
}

static void walk(CONTEXT *context, ULONG_PTR *frames, USHORT *depth_out) {
    static LookupFn lookup = NULL;
    static UnwindFn unwind = NULL;
    if (!lookup || !unwind) {
        HMODULE ntdll = GetModuleHandleA("ntdll.dll");
        lookup = (LookupFn)GetProcAddress(ntdll, "RtlLookupFunctionEntry");
        unwind = (UnwindFn)GetProcAddress(ntdll, "RtlVirtualUnwind");
    }
    ULONG_PTR local[MAX_FRAMES];
    USHORT depth = 0;
    if (!lookup || !unwind) { *depth_out = 0; return; }
    for (int i = 0; i < MAX_FRAMES; i++) {
        ULONG_PTR pc = (ULONG_PTR)context->Rip;
        if (!pc || pc < 0x10000) break;
        local[depth++] = pc;
        if (self_base && pc >= self_base && pc < self_end) break;
        DWORD64 image_base = 0;
        void *entry = lookup((DWORD64)pc, &image_base, NULL);
        if (!entry) {
            ULONG_PTR next = 0;
            if (!read_ptr((ULONG_PTR)context->Rsp, &next) || !next) break;
            context->Rip = next;
            context->Rsp += sizeof(ULONG_PTR);
        } else {
            DWORD64 establisher = 0;
            void *handler = NULL;
            ULONG_PTR before = (ULONG_PTR)context->Rip;
            unwind(0, image_base, (DWORD64)pc, entry, context, &handler, &establisher, NULL);
            if ((ULONG_PTR)context->Rip == before) break;
        }
    }
    memcpy(frames, local, depth * sizeof(ULONG_PTR));
    *depth_out = depth;
}

static int page_index_for(ULONG_PTR address) {
    LONG n = page_count;
    for (LONG i = 0; i < n && i < MAX_PAGES; i++) {
        if (pages[i] && address >= (ULONG_PTR)pages[i] && address < (ULONG_PTR)pages[i] + page_size) return (int)i;
    }
    return -1;
}

static void rearm(int index) {
    if (index < 0 || index >= MAX_PAGES || !pages[index]) return;
    DWORD old = 0;
    VirtualProtect(pages[index], page_size, PAGE_EXECUTE_READ | PAGE_GUARD, &old);
}

/* 0x80000001 = 守卫页命中；0x80000004 = 单步 */
static LONG CALLBACK on_exception(EXCEPTION_POINTERS *info) {
    const DWORD code = info->ExceptionRecord->ExceptionCode;
    CONTEXT *context = info->ContextRecord;

    if (code == (DWORD)0x80000004) {
        if (pending_page < 0) return EXCEPTION_CONTINUE_SEARCH;
        context->EFlags &= ~(DWORD)0x100;
        int page = pending_page;
        pending_page = -1;
        if (armed) rearm(page);
        return EXCEPTION_CONTINUE_EXECUTION;
    }

    if (code != (DWORD)0x80000001) return EXCEPTION_CONTINUE_SEARCH;
    ULONG_PTR fault = (ULONG_PTR)info->ExceptionRecord->ExceptionInformation[1];
    int page = page_index_for(fault);
    if (page < 0) return EXCEPTION_CONTINUE_SEARCH;

    LONG total = InterlockedIncrement(&hits_total);
    if (total > max_hits) { armed = 0; return EXCEPTION_CONTINUE_EXECUTION; }

    ULONG_PTR rip = (ULONG_PTR)context->Rip;
    if (cov_mode) cov_record(rip, context);
    LONG n = target_count;
    for (LONG i = 0; i < n && i < MAX_TARGETS; i++) {
        if (targets[i] != rip) continue;
        LONG slot = InterlockedIncrement(&rec_count) - 1;
        if (slot >= 0 && slot < MAX_REC) {
            Rec *rec = &recs[slot];
            rec->rip = rip;
            rec->args[0] = (ULONG_PTR)context->Rcx;
            rec->args[1] = (ULONG_PTR)context->Rdx;
            rec->args[2] = (ULONG_PTR)context->R8;
            rec->args[3] = (ULONG_PTR)context->R9;
            rec->tid = GetCurrentThreadId();
            CONTEXT copy = *context;   /* 展开会改写 Rip/Rsp，必须用副本 */
            walk(&copy, rec->frames, &rec->depth);
            /* 参数指向的用户态内存快照：构造 SnsPost 任务对象时要用到这些布局 */
            for (int a = 0; a < 4; a++) {
                ULONG_PTR ptr = rec->args[a];
                rec->snap_ok[a] = 0;
                rec->snap_len[a] = 0;
                memset(rec->snap[a], 0, ARG_SNAP);
                if (ptr < 0x10000) continue;
                SIZE_T want = (a == 0) ? ARG_SNAP : ARG_SNAP_OTHER;
                SIZE_T got = 0;
                if (ReadProcessMemory(GetCurrentProcess(), (LPCVOID)ptr, rec->snap[a], want, &got))
                    rec->snap_ok[a] = 1;
                else if (got > 0) rec->snap_ok[a] = 2;
                rec->snap_len[a] = (unsigned int)got;
                if (!rec->snap_ok[a]) continue;
                /* 二级：跟着前 8 个指针字段各读 64 字节，一次发布就能看到结构层次 */
                for (int c = 0; c < 8 && (SIZE_T)(c * 8 + 8) <= want; c++) {
                    ULONG_PTR inner = 0;
                    memcpy(&inner, rec->snap[a] + c * 8, sizeof(inner));
                    rec->child_ok[a][c] = 0;
                    rec->child_ptr[a][c] = inner;
                    if (inner < 0x10000) continue;
                    SIZE_T got2 = 0;
                    if (ReadProcessMemory(GetCurrentProcess(), (LPCVOID)inner, rec->child[a][c], 64, &got2)
                        && got2 == 64) rec->child_ok[a][c] = 1;
                }
            }
        }
        break;
    }
    pending_page = page;
    context->EFlags |= (DWORD)0x100;
    return EXCEPTION_CONTINUE_EXECUTION;
}

static DWORD add_target(ULONG_PTR address) {
    if (!address) return 2;
    if (page_count >= MAX_PAGES) return 7;
    unsigned char *page = (unsigned char *)(address & ~(page_size - 1));
    /* 自己的代码页绝不能布防：异常处理器就在里面，会无限递归 */
    if (self_base && (ULONG_PTR)page < self_end && (ULONG_PTR)page + page_size > self_base) return 6;
    LONG tslot = InterlockedIncrement(&target_count) - 1;
    if (tslot < 0 || tslot >= MAX_TARGETS) { InterlockedDecrement(&target_count); return 7; }
    targets[tslot] = address;
    if (page_index_for((ULONG_PTR)page + 1) >= 0) return 0;   /* 该页已在布防 */
    LONG slot = InterlockedIncrement(&page_count) - 1;
    if (slot < 0 || slot >= MAX_PAGES) { InterlockedDecrement(&page_count); return 7; }
    pages[slot] = page;
    return 0;
}

static void number(char *buffer, size_t *at, ULONG_PTR value, int hex) {
    char temp[20];
    int count = 0;
    if (hex) {
        static const char digits[] = "0123456789ABCDEF";
        if (!value) temp[count++] = '0';
        while (value && count < 20) { temp[count++] = digits[value & 0xF]; value >>= 4; }
    } else {
        if (!value) temp[count++] = '0';
        while (value && count < 20) { temp[count++] = (char)('0' + (value % 10)); value /= 10; }
    }
    while (count > 0 && *at < 59900) buffer[(*at)++] = temp[--count];
}

/* ---------------- 导出 ---------------- */

/* 增加一个目标：参数是 Weixin.dll 里的 RVA。返回 0 成功。 */
__declspec(dllexport) DWORD HbArm(DWORD rva) {
    remember_modules();
    if (!core_base) return 5;
    int was_armed = armed;
    DWORD code = add_target(core_base + rva);
    if (code) return code;
    if (!veh) {
        veh = AddVectoredExceptionHandler(1, on_exception);
        if (!veh) return 3;
    }
    if (!was_armed) {
        armed = 1;
        for (LONG i = 0; i < page_count && i < MAX_PAGES; i++) rearm((int)i);
    } else {
        rearm(page_index_for((ULONG_PTR)targets[target_count - 1]));
    }
    return 0;
}

__declspec(dllexport) DWORD HbClear(void) {
    armed = 0;
    for (LONG i = 0; i < page_count && i < MAX_PAGES; i++) {
        if (!pages[i]) continue;
        DWORD old = 0;
        VirtualProtect(pages[i], page_size, PAGE_EXECUTE_READ, &old);
        pages[i] = NULL;
    }
    InterlockedExchange(&page_count, 0);
    InterlockedExchange(&target_count, 0);
    InterlockedExchange(&rec_count, 0);
    InterlockedExchange(&hits_total, 0);
    InterlockedExchange(&cov_used, 0);
    for (LONG k = 0; k < COV_SLOTS; k++) { cov_rva[k] = 0; cov_hits[k] = 0; cov_seq[k] = 0; }
    InterlockedExchange(&cov_order, 0);
    InterlockedExchange(&cov_mode, 0);
    if (veh) { RemoveVectoredExceptionHandler(veh); veh = NULL; }
    return 0;
}

__declspec(dllexport) LONG HbCount(void) { return rec_count; }

__declspec(dllexport) LONG HbHits(void) { return hits_total; }

__declspec(dllexport) DWORD HbSetCap(DWORD cap) { max_hits = (LONG)cap; return 0; }

/* 区域覆盖：从 rva 所在页开始，连续 cover 页，记录其中每一次执行的地址。
   注意：只适合冷代码区，热区会拖慢宿主（有 max_hits 兜底）。 */
__declspec(dllexport) DWORD HbCover(DWORD rva, DWORD count) {
    remember_modules();
    if (!core_base) return 5;
    if (count == 0 || count > MAX_PAGES) return 7;
    if (!veh) {
        veh = AddVectoredExceptionHandler(1, on_exception);
        if (!veh) return 3;
    }
    ULONG_PTR start = (core_base + rva) & ~(page_size - 1);
    for (DWORD i = 0; i < count; i++) {
        unsigned char *page = (unsigned char *)(start + i * page_size);
        if (page_index_for((ULONG_PTR)page + 1) >= 0) continue;
        if (self_base && (ULONG_PTR)page < self_end && (ULONG_PTR)page + page_size > self_base) continue;
        LONG slot = InterlockedIncrement(&page_count) - 1;
        if (slot < 0 || slot >= MAX_PAGES) { InterlockedDecrement(&page_count); return 7; }
        pages[slot] = page;
    }
    cov_mode = 1;
    armed = 1;
    for (LONG i = 0; i < page_count && i < MAX_PAGES; i++) rearm((int)i);
    return 0;
}

/* 导出覆盖画像：%TEMP%\wechatwb-moments-cover.txt，每行 "rva hits" */
__declspec(dllexport) DWORD HbCoverDump(void) {
    static char text[90000];
    size_t at = 0;
    for (LONG i = 0; i < COV_SLOTS; i++) {
        if (!cov_rva[i]) continue;
        number(text, &at, cov_rva[i], 1);
        text[at++] = ' ';
        number(text, &at, (ULONG_PTR)cov_hits[i], 0);
        text[at++] = ' ';
        number(text, &at, (ULONG_PTR)cov_seq[i], 0);
        text[at++] = '\r';
        text[at++] = '\n';
        if (at > sizeof(text) - 60) break;
    }
    wchar_t dir[MAX_PATH];
    DWORD length = GetTempPathW(MAX_PATH, dir);
    if (!length || length >= MAX_PATH) return 1;
    wchar_t path[MAX_PATH];
    SIZE_T i2 = 0;
    while (dir[i2] && i2 < MAX_PATH - 1) { path[i2] = dir[i2]; i2++; }
    const wchar_t *name = L"wechatwb-moments-cover.txt";
    SIZE_T j = 0;
    while (name[j] && i2 < MAX_PATH - 1) path[i2++] = name[j++];
    path[i2] = 0;
    HANDLE file = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) return 2;
    DWORD written = 0;
    WriteFile(file, text, (DWORD)at, &written, NULL);
    CloseHandle(file);
    return 0;
}

__declspec(dllexport) LONG HbCoverUsed(void) { return cov_used; }

/* 同上，但把 起始页号(高24位) 与 页数(低8位) 打包成一个 DWORD，便于远端单参数调用 */
__declspec(dllexport) DWORD HbCoverSpan(DWORD packed) {
    DWORD page_index = packed >> 8;
    DWORD count = packed & 0xFF;
    if (count == 0) return 7;
    return HbCover(page_index << 12, count);
}

/* 自测：在独立分配的代码页里放一个桩函数，布防后调用两次，应捕获 2 次。 */
typedef int (*StubFn)(int);

__declspec(dllexport) LONG HbSelfTest(void) {
    unsigned char *code = (unsigned char *)VirtualAlloc(NULL, 4096, MEM_COMMIT | MEM_RESERVE,
                                                        PAGE_EXECUTE_READWRITE);
    if (!code) return -100;
    code[0] = 0x8B; code[1] = 0xC1;                 /* mov eax, ecx */
    code[2] = 0x83; code[3] = 0xC0; code[4] = 0x01; /* add eax, 1   */
    code[5] = 0xC3;                                 /* ret          */
    FlushInstructionCache(GetCurrentProcess(), code, 8);
    remember_modules();
    if (add_target((ULONG_PTR)code)) { VirtualFree(code, 0, MEM_RELEASE); return -101; }
    veh = AddVectoredExceptionHandler(1, on_exception);
    armed = 1;
    rearm(page_index_for((ULONG_PTR)code + 1));
    StubFn stub = (StubFn)code;
    volatile int a = stub(7);
    volatile int b = stub(9);
    (void)a; (void)b;
    Sleep(80);
    LONG captured = rec_count;
    HbClear();
    VirtualFree(code, 0, MEM_RELEASE);
    return captured;
}

/* 导出参数内存快照：%TEMP%\wechatwb-moments-hwargs.txt */
__declspec(dllexport) DWORD HbArgsDump(void) {
    static char text[400000];
    size_t at = 0;
    LONG total = rec_count;
    if (total > MAX_REC) total = MAX_REC;
    for (LONG i = 0; i < total; i++) {
        Rec *rec = &recs[i];
        for (int a = 0; a < 4; a++) {
            if (!rec->snap_ok[a]) continue;
            const char *tag = "# rec ";
            while (*tag) text[at++] = *tag++;
            number(text, &at, (ULONG_PTR)i, 1);
            text[at++] = ' ';
            text[at++] = 'a';
            text[at++] = (char)('0' + a);
            text[at++] = ' ';
            number(text, &at, rec->args[a], 1);
            text[at++] = ' ';
            text[at++] = '=';
            text[at++] = ' ';
            for (unsigned int k = 0; k < rec->snap_len[a]; k++) {
                static const char digits[] = "0123456789abcdef";
                unsigned char b = rec->snap[a][k];
                text[at++] = digits[b >> 4];
                text[at++] = digits[b & 0xF];
                if ((k & 15) == 15) text[at++] = ' ';
            }
            text[at++] = '\r';
            text[at++] = '\n';
            if (at > sizeof(text) - 1600) break;
            for (int c = 0; c < 8; c++) {
                if (!rec->child_ok[a][c]) continue;
                const char *tag2 = "## rec ";
                while (*tag2) text[at++] = *tag2++;
                number(text, &at, (ULONG_PTR)i, 1);
                text[at++] = ' ';
                text[at++] = 'a';
                text[at++] = (char)('0' + a);
                text[at++] = '.';
                text[at++] = (char)('0' + c);
                text[at++] = ' ';
                number(text, &at, rec->child_ptr[a][c], 1);
                text[at++] = ' ';
                text[at++] = '=';
                text[at++] = ' ';
                for (int k = 0; k < 64; k++) {
                    static const char digits2[] = "0123456789abcdef";
                    unsigned char b = rec->child[a][c][k];
                    text[at++] = digits2[b >> 4];
                    text[at++] = digits2[b & 0xF];
                    if ((k & 15) == 15) text[at++] = ' ';
                }
                text[at++] = '\r';
                text[at++] = '\n';
                if (at > sizeof(text) - 1600) break;
            }
            if (at > sizeof(text) - 1600) break;
        }
        if (at > sizeof(text) - 1600) break;
    }
    wchar_t dir[MAX_PATH];
    DWORD length = GetTempPathW(MAX_PATH, dir);
    if (!length || length >= MAX_PATH) return 1;
    wchar_t path[MAX_PATH];
    SIZE_T i2 = 0;
    while (dir[i2] && i2 < MAX_PATH - 1) { path[i2] = dir[i2]; i2++; }
    const wchar_t *name = L"wechatwb-moments-hwargs.txt";
    SIZE_T j = 0;
    while (name[j] && i2 < MAX_PATH - 1) path[i2++] = name[j++];
    path[i2] = 0;
    HANDLE file = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) return 2;
    DWORD written = 0;
    WriteFile(file, text, (DWORD)at, &written, NULL);
    CloseHandle(file);
    return 0;
}

/* 导出结果：%TEMP%\wechatwb-moments-hwbreak.txt
   每行：tid 命中RIP(RVA) rcx rdx r8 r9 栈深 帧1 帧2 ...（帧为 RVA，0 表示不在核心里） */
__declspec(dllexport) DWORD HbDumpDefault(void) {
    static char text[60000];
    size_t at = 0;
    LONG total = rec_count;
    if (total > MAX_REC) total = MAX_REC;
    for (LONG i = 0; i < total; i++) {
        Rec *rec = &recs[i];
        number(text, &at, (ULONG_PTR)rec->tid, 1);
        text[at++] = ' ';
        number(text, &at, (core_base && rec->rip >= core_base && rec->rip < core_end)
                          ? rec->rip - core_base : 0, 1);
        text[at++] = ' ';
        for (int k = 0; k < 4; k++) {
            number(text, &at, rec->args[k], 1);
            text[at++] = ' ';
        }
        number(text, &at, rec->depth, 1);
        for (int f = 0; f < rec->depth; f++) {
            ULONG_PTR pc = rec->frames[f];
            ULONG_PTR rva = (core_base && pc >= core_base && pc < core_end) ? pc - core_base : 0;
            text[at++] = ' ';
            number(text, &at, rva, 1);
        }
        text[at++] = '\r';
        text[at++] = '\n';
        if (at > sizeof(text) - 600) break;
    }
    wchar_t dir[MAX_PATH];
    DWORD length = GetTempPathW(MAX_PATH, dir);
    if (!length || length >= MAX_PATH) return 1;
    wchar_t path[MAX_PATH];
    SIZE_T i2 = 0;
    while (dir[i2] && i2 < MAX_PATH - 1) { path[i2] = dir[i2]; i2++; }
    const wchar_t *name = L"wechatwb-moments-hwbreak.txt";
    SIZE_T j = 0;
    while (name[j] && i2 < MAX_PATH - 1) path[i2++] = name[j++];
    path[i2] = 0;
    HANDLE file = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) return 2;
    DWORD written = 0;
    WriteFile(file, text, (DWORD)at, &written, NULL);
    CloseHandle(file);
    return 0;
}


/* ---------- 对象图遍历：从一个指针出发，按 8 字节指针字段 BFS 三层，把内存和可读字符串打出来 ---------- */

#define GRAPH_MAX 320

static int looks_pointer(ULONG_PTR v) {
    return v >= 0x10000 && v < 0x0001000000000000ULL && (v & 3) == 0;   /* 只跟堆，排除 0x7FF8… 这类模块地址 */
}

__declspec(dllexport) DWORD HbGraph(ULONG_PTR root) {
    static char text[300000];
    size_t at = 0;
    ULONG_PTR queue[GRAPH_MAX];
    int visited[GRAPH_MAX];
    int head = 0, tail = 0, seen = 0;
    if (!looks_pointer(root)) return 9;
    queue[tail++] = root;

    while (head < tail && tail < GRAPH_MAX) {
        ULONG_PTR addr = queue[head++];
        int dup = 0;
        for (int k = 0; k < seen; k++) if (visited[k] == (int)0 && 0) dup = 0;
        /* 简易去重：线性查已访问地址表 */
        static ULONG_PTR seen_list[GRAPH_MAX];
        for (int k = 0; k < seen; k++) if (seen_list[k] == addr) { dup = 1; break; }
        if (dup) continue;
        if (seen < GRAPH_MAX) seen_list[seen++] = addr;

        unsigned char buf[64];
        SIZE_T got = 0;
        if (!ReadProcessMemory(GetCurrentProcess(), (LPCVOID)addr, buf, sizeof(buf), &got) || got < 8) continue;

        const char *tag = "N ";
        while (*tag) text[at++] = *tag++;
        number(text, &at, addr, 1);
        text[at++] = ' ';
        text[at++] = '=';
        text[at++] = ' ';
        for (int k = 0; k < 64; k++) {
            static const char d[] = "0123456789abcdef";
            unsigned char b = buf[k];
            text[at++] = d[b >> 4];
            text[at++] = d[b & 0xF];
            if ((k & 15) == 15) text[at++] = ' ';
        }
        text[at++] = '\r';
        text[at++] = '\n';
        if (at > sizeof(text) - 1200) break;

        /* 可读字符串 */
        for (int k = 0; k < 64; k++) {
            int run = 0;
            while (k + run < 64 && buf[k + run] >= 0x20 && buf[k + run] < 0x7F) run++;
            if (run >= 4) {
                const char *tag2 = "S ";
                while (*tag2) text[at++] = *tag2++;
                number(text, &at, addr, 1);
                text[at++] = '+';
                number(text, &at, (ULONG_PTR)k, 1);
                text[at++] = ' ';
                for (int j = 0; j < run && at < sizeof(text) - 8; j++) text[at++] = (char)buf[k + j];
                text[at++] = '\r';
                text[at++] = '\n';
                if (at > sizeof(text) - 1200) break;
                k += run - 1;
            }
        }

        /* 跟随指针字段 */
        if (tail < GRAPH_MAX) {
            for (int k = 0; k + 8 <= 64; k += 8) {
                ULONG_PTR v = 0;
                memcpy(&v, buf + k, sizeof(v));
                if (looks_pointer(v) && tail < GRAPH_MAX) queue[tail++] = v;
            }
        }
    }

    wchar_t dir[MAX_PATH];
    DWORD length = GetTempPathW(MAX_PATH, dir);
    if (!length || length >= MAX_PATH) return 1;
    wchar_t path[MAX_PATH];
    SIZE_T i2 = 0;
    while (dir[i2] && i2 < MAX_PATH - 1) { path[i2] = dir[i2]; i2++; }
    const wchar_t *name = L"wechatwb-moments-graph.txt";
    SIZE_T j = 0;
    while (name[j] && i2 < MAX_PATH - 1) path[i2++] = name[j++];
    path[i2] = 0;
    HANDLE file = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) return 2;
    DWORD written = 0;
    WriteFile(file, text, (DWORD)at, &written, NULL);
    CloseHandle(file);
    return 0;
}


/* ---------- 按标记扫描内存：从 %TEMP%\wechatwb-needle.txt 读一段 UTF-8，找出它在进程里的所有副本 ---------- */

__declspec(dllexport) DWORD HbScan(void) {
    static char text[200000];
    size_t at = 0;

    wchar_t dir[MAX_PATH];
    DWORD length = GetTempPathW(MAX_PATH, dir);
    if (!length || length >= MAX_PATH) return 1;
    wchar_t path[MAX_PATH];
    SIZE_T i2 = 0;
    while (dir[i2] && i2 < MAX_PATH - 1) { path[i2] = dir[i2]; i2++; }
    const wchar_t *name = L"wechatwb-needle.txt";
    SIZE_T j = 0;
    while (name[j] && i2 < MAX_PATH - 1) path[i2++] = name[j++];
    path[i2] = 0;

    HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) return 2;
    unsigned char needle[128];
    DWORD got = 0;
    ReadFile(file, needle, sizeof(needle), &got, NULL);
    CloseHandle(file);
    if (got < 4) return 3;
    /* 去掉行尾换行 */
    while (got > 0 && (needle[got - 1] == '\r' || needle[got - 1] == '\n')) got--;

    unsigned char *region = (unsigned char *)VirtualAlloc(NULL, 1 << 20, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!region) return 4;

    unsigned long long cursor = 0x10000;
    LONG found = 0;
    while (cursor < 0x00007FFFFFFE0000ULL && found < 24 && at < sizeof(text) - 600) {
        MEMORY_BASIC_INFORMATION mbi;
        if (!VirtualQuery((LPCVOID)(ULONG_PTR)cursor, &mbi, sizeof(mbi))) break;
        ULONG_PTR base = (ULONG_PTR)mbi.BaseAddress;
        SIZE_T size = mbi.RegionSize;
        cursor = (unsigned long long)(base + size);
        if (mbi.State != MEM_COMMIT) continue;
        if (mbi.Protect & PAGE_GUARD) continue;
        if (mbi.Protect & (PAGE_NOACCESS)) continue;

        SIZE_T offset = 0;
        while (offset < size && found < 24) {
            SIZE_T chunk = size - offset;
            if (chunk > (1 << 20)) chunk = 1 << 20;
            SIZE_T read = 0;
            if (ReadProcessMemory(GetCurrentProcess(), (LPCVOID)(base + offset), region, chunk, &read) && read >= got) {
                for (SIZE_T i = 0; i + got <= read; i++) {
                    if (region[i] != needle[0]) continue;
                    if (memcmp(region + i, needle, got) != 0) continue;
                    ULONG_PTR where = base + offset + i;
                    const char *tag = "F ";
                    while (*tag) text[at++] = *tag++;
                    number(text, &at, where, 1);
                    text[at++] = '\r';
                    text[at++] = '\n';
                    found++;
                    if (found >= 24 || at > sizeof(text) - 600) break;
                    i += got - 1;
                }
            }
            offset += chunk;
        }
    }
    VirtualFree(region, 0, MEM_RELEASE);

    const wchar_t *name2 = L"wechatwb-moments-scan.txt";
    SIZE_T k2 = 0;
    while (dir[k2] && k2 < MAX_PATH - 1) { path[k2] = dir[k2]; k2++; }
    SIZE_T m = 0;
    while (name2[m] && k2 < MAX_PATH - 1) path[k2++] = name2[m++];
    path[k2] = 0;
    HANDLE out = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (out == INVALID_HANDLE_VALUE) return 5;
    DWORD written = 0;
    WriteFile(out, text, (DWORD)at, &written, NULL);
    CloseHandle(out);
    return (DWORD)found;
}

BOOL WINAPI DllMain(HINSTANCE module, DWORD reason, LPVOID reserved) {
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(module);
        SYSTEM_INFO info;
        GetSystemInfo(&info);
        page_size = info.dwPageSize;
    }
    return TRUE;
}
