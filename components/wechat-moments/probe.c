// 探针 DLL：用「守卫页 + 访问异常」找出到底哪段代码读了某个字符串。
//
// 背景：4.1.10.27 的 Weixin.dll 里，mmsnspost / SnsPostRequest 这些字符串在静态层面
// 既没有 lea 引用、也没有指针/RVA 引用，RTTI 也被剥掉，所以只能动态观察。
//
// 做法：给字符串所在页加上 PAGE_GUARD。下一次访问该页会抛 STATUS_GUARD_PAGE_VIOLATION，
// 而且操作系统会自动解除这一页的守卫，指令重试即可正常执行——不需要改 EFlags 单步，
// 也不会因为「处理过程自己又碰同一页」而递归。
//
// 约束：一次只捕获一次访问（不自动重新布防，避免自锁）。要更多样本就多布防几次。
// 全程只在被观察进程里改页面属性，不调用微信任何函数、不改代码。
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <string.h>

#define MAX_CAPTURE 16

static volatile LONG armed = 0;
static PVOID veh = NULL;
#define MAX_WATCH 8
static unsigned char *watch_page[MAX_WATCH];
static SIZE_T watch_size[MAX_WATCH];
static volatile LONG watch_count = 0;
static volatile LONG capture_count = 0;
static ULONG_PTR self_base = 0;
static ULONG_PTR self_end = 0;

static void remember_self(HMODULE module) {
    self_base = (ULONG_PTR)module;
    IMAGE_DOS_HEADER *dos = (IMAGE_DOS_HEADER *)module;
    if (dos->e_magic == IMAGE_DOS_SIGNATURE) {
        IMAGE_NT_HEADERS *nt = (IMAGE_NT_HEADERS *)((unsigned char *)module + dos->e_lfanew);
        self_end = self_base + nt->OptionalHeader.SizeOfImage;
    }
}
static ULONG_PTR capture_rip[MAX_CAPTURE];
static ULONG_PTR capture_addr[MAX_CAPTURE];
static DWORD capture_tid[MAX_CAPTURE];

static LONG CALLBACK on_exception(EXCEPTION_POINTERS *info) {
    const DWORD code = info->ExceptionRecord->ExceptionCode;
    /* 0x80000001 = STATUS_GUARD_PAGE_VIOLATION */
    if (code != (DWORD)0x80000001) return EXCEPTION_CONTINUE_SEARCH;
    if (!watch_count) return EXCEPTION_CONTINUE_SEARCH;
    /* 探针自己在扫描内存时也会读到这些页，这类读不算证据。 */
    ULONG_PTR rip = info->ContextRecord->Rip;
    if (self_base && rip >= self_base && rip < self_end) return EXCEPTION_CONTINUE_EXECUTION;
    ULONG_PTR fault_at = (ULONG_PTR)info->ExceptionRecord->ExceptionInformation[1];
    int ours = 0;
    for (LONG i = 0; i < watch_count && i < MAX_WATCH; i++) {
        if (watch_page[i] && fault_at >= (ULONG_PTR)watch_page[i] &&
            fault_at < (ULONG_PTR)watch_page[i] + watch_size[i]) { ours = 1; break; }
    }
    if (!ours) return EXCEPTION_CONTINUE_SEARCH;
    LONG slot = InterlockedIncrement(&capture_count) - 1;
    if (slot >= 0 && slot < MAX_CAPTURE) {
        capture_rip[slot] = info->ContextRecord->Rip;
        capture_addr[slot] = (ULONG_PTR)info->ExceptionRecord->ExceptionInformation[1];
        capture_tid[slot] = GetCurrentThreadId();
    }
    /* 系统已清掉这一页的守卫，直接继续即可；不再重新布防，避免自锁。 */
    return EXCEPTION_CONTINUE_EXECUTION;
}

/* 在已加载的 Weixin.dll 里找一段字节，返回其内存地址。 */
__declspec(dllexport) void *WeChatMomentsProbeFind(const char *literal) {
    HMODULE module = GetModuleHandleA("Weixin.dll");
    if (!module || !literal) return NULL;
    IMAGE_DOS_HEADER *dos = (IMAGE_DOS_HEADER *)module;
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) return NULL;
    IMAGE_NT_HEADERS *nt = (IMAGE_NT_HEADERS *)((unsigned char *)module + dos->e_lfanew);
    unsigned char *start = (unsigned char *)module;
    SIZE_T span = nt->OptionalHeader.SizeOfImage;
    SIZE_T needle = strlen(literal);
    if (!needle || needle > span) return NULL;
    for (SIZE_T i = 0; i + needle < span; i++) {
        if (start[i] == (unsigned char)literal[0] && memcmp(start + i, literal, needle) == 0) return start + i;
    }
    return NULL;
}

/* 给包含该地址的整页布防。返回 0 表示成功。 */
__declspec(dllexport) DWORD WeChatMomentsProbeArm(void *address) {
    if (!address) return 1;
    if (watch_count >= MAX_WATCH) return 5;
    if (!veh) {
        veh = AddVectoredExceptionHandler(1, on_exception);
        if (!veh) return 3;
    }
    SYSTEM_INFO info;
    GetSystemInfo(&info);
    const SIZE_T page = info.dwPageSize;
    unsigned char *base = (unsigned char *)((ULONG_PTR)address & ~(page - 1));
    for (LONG i = 0; i < watch_count; i++) if (watch_page[i] == base) return 0;
    DWORD old = 0;
    if (!VirtualProtect(base, page, PAGE_READONLY | PAGE_GUARD, &old)) return 4;
    LONG slot = InterlockedIncrement(&watch_count) - 1;
    if (slot < 0 || slot >= MAX_WATCH) return 5;
    watch_page[slot] = base;
    watch_size[slot] = page;
    return 0;
}

__declspec(dllexport) DWORD WeChatMomentsProbeArmLiteral(const char *literal) {
    return WeChatMomentsProbeArm(WeChatMomentsProbeFind(literal));
}

__declspec(dllexport) DWORD WeChatMomentsProbeDisarm(void) {
    DWORD old = 0;
    for (LONG i = 0; i < watch_count && i < MAX_WATCH; i++) {
        if (watch_page[i]) { VirtualProtect(watch_page[i], watch_size[i], PAGE_READONLY, &old); watch_page[i] = NULL; }
    }
    InterlockedExchange(&watch_count, 0);
    if (veh) { RemoveVectoredExceptionHandler(veh); veh = NULL; }
    InterlockedExchange(&armed, 0);
    return 0;
}

__declspec(dllexport) LONG WeChatMomentsProbeCount(void) { return capture_count; }

__declspec(dllexport) ULONG_PTR WeChatMomentsProbeRip(LONG index) {
    return (index >= 0 && index < MAX_CAPTURE) ? capture_rip[index] : 0;
}

/* 把捕获结果追加到文件；刻意不用 CRT 的格式化/文件函数，避免在远端线程里触发 CRT 异常。 */
static void append_hex(char *buffer, size_t *at, ULONG_PTR value) {
    static const char digits[] = "0123456789ABCDEF";
    char temp[20];
    int count = 0;
    if (!value) temp[count++] = '0';
    while (value && count < 20) { temp[count++] = digits[value & 0xF]; value >>= 4; }
    buffer[(*at)++] = '0';
    buffer[(*at)++] = 'x';
    while (count > 0 && *at < 240) buffer[(*at)++] = temp[--count];
}

__declspec(dllexport) DWORD WeChatMomentsProbeDump(const wchar_t *path) {
    if (!path) return 1;
    HANDLE file = CreateFileW(path, FILE_APPEND_DATA, FILE_SHARE_READ, NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) return 2;
    HMODULE core = GetModuleHandleA("Weixin.dll");
    for (LONG i = 0; i < capture_count && i < MAX_CAPTURE; i++) {
        char line[300];
        size_t at = 0;
        const char *prefix = "{\"rip\":\"";
        while (*prefix) line[at++] = *prefix++;
        append_hex(line, &at, capture_rip[i]);
        const char *mid = "\",\"rva\":\"";
        while (*mid) line[at++] = *mid++;
        append_hex(line, &at, (core && capture_rip[i] >= (ULONG_PTR)core) ? capture_rip[i] - (ULONG_PTR)core : 0);
        const char *tail = "\"}\r\n";
        while (*tail) line[at++] = *tail++;
        DWORD written = 0;
        WriteFile(file, line, (DWORD)at, &written, NULL);
    }
    CloseHandle(file);
    return 0;
}

/* 自测：守卫自己模块里的一个字符串，故意读一次，确认能抓到 Rip。不涉及微信。 */
static const char self_test_string[] = "wechatwb-probe-selftest-literal-2026";
static const char *volatile self_test_sink;  /* 防止编译器把读取折叠成常量 */

__declspec(dllexport) LONG WeChatMomentsProbeSelfTest(void) {
    if (InterlockedCompareExchange(&armed, 1, 0)) return -1;
    if (!veh) {
        veh = AddVectoredExceptionHandler(1, on_exception);
        if (!veh) { InterlockedExchange(&armed, 0); return -2; }
    }
    SYSTEM_INFO info;
    GetSystemInfo(&info);
    const SIZE_T page = info.dwPageSize;
    unsigned char *base = (unsigned char *)((ULONG_PTR)self_test_string & ~(page - 1));
    DWORD old = 0;
    if (!VirtualProtect(base, page, PAGE_READONLY | PAGE_GUARD, &old)) {
        InterlockedExchange(&armed, 0);
        return -3;
    }
    LONG slot = InterlockedIncrement(&watch_count) - 1;
    if (slot >= 0 && slot < MAX_WATCH) { watch_page[slot] = base; watch_size[slot] = page; }
    self_test_sink = self_test_string;
    volatile char c = self_test_sink[0];
    (void)c;
    LONG captured = capture_count;
    WeChatMomentsProbeDisarm();
    return captured;
}


/* ---------------- 给注入用的无参入口（远端线程只能传一个指针，避免传字符串） ---------------- */

static wchar_t default_dump[MAX_PATH];

/* 固定写到系统临时目录：不依赖模块路径，也不碰被观察进程的安装目录。 */
static void default_path(void) {
    if (default_dump[0]) return;
    wchar_t dir[MAX_PATH];
    DWORD length = GetTempPathW(MAX_PATH, dir);
    if (!length || length >= MAX_PATH) { default_dump[0] = 0; return; }
    SIZE_T i = 0;
    while (dir[i] && i < MAX_PATH - 1) { default_dump[i] = dir[i]; i++; }
    const wchar_t *name = L"wechatwb-moments-probe.jsonl";
    SIZE_T j = 0;
    while (name[j] && i < MAX_PATH - 1) default_dump[i++] = name[j++];
    default_dump[i] = 0;
}

/* 只读检查：微信进程里能不能找到 mmsnspost 字符串（1=找到）。不布防、不改任何属性。 */
__declspec(dllexport) DWORD WeChatMomentsProbeHasPostString(void) {
    return WeChatMomentsProbeFind("/cgi-bin/micromsg-bin/mmsnspost") ? 1 : 0;
}

/* 只读检查：找 SnsPostRequest（protobuf 消息名）。 */
__declspec(dllexport) DWORD WeChatMomentsProbeHasRequestString(void) {
    return WeChatMomentsProbeFind("SnsPostRequest") ? 1 : 0;
}

/* 一次布防多个候选字符串（返回成功布防的页数）。 */
__declspec(dllexport) DWORD WeChatMomentsProbeArmAll(void) {
    static const char *candidates[] = {
        "/cgi-bin/micromsg-bin/mmsnspost", "mmsnspost", "SnsPostRequest",
        "SnsPostResponse", "SnsObject", "TimelineObject", NULL,
    };
    DWORD armed_pages = 0;
    for (int i = 0; candidates[i]; i++) {
        void *at = WeChatMomentsProbeFind(candidates[i]);
        if (at && WeChatMomentsProbeArm(at) == 0) armed_pages++;
    }
    return armed_pages;
}

/* 布防微信里的 mmsnspost 字符串；返回 0 表示已布防。 */
__declspec(dllexport) DWORD WeChatMomentsProbeArmPost(void) {
    void *at = WeChatMomentsProbeFind("/cgi-bin/micromsg-bin/mmsnspost");
    return WeChatMomentsProbeArm(at);
}

/* 同上，换成 SnsPostRequest（protobuf 消息名）。 */
__declspec(dllexport) DWORD WeChatMomentsProbeArmRequest(void) {
    void *at = WeChatMomentsProbeFind("SnsPostRequest");
    return WeChatMomentsProbeArm(at);
}

/* 干跑用：布防本模块自己的自测字符串，不依赖微信。 */
__declspec(dllexport) DWORD WeChatMomentsProbeSelfArm(void) {
    if (InterlockedCompareExchange(&armed, 1, 0)) return 2;
    if (!veh) {
        veh = AddVectoredExceptionHandler(1, on_exception);
        if (!veh) { InterlockedExchange(&armed, 0); return 3; }
    }
    SYSTEM_INFO info;
    GetSystemInfo(&info);
    const SIZE_T page = info.dwPageSize;
    unsigned char *base = (unsigned char *)((ULONG_PTR)self_test_string & ~(page - 1));
    DWORD old = 0;
    if (!VirtualProtect(base, page, PAGE_READONLY | PAGE_GUARD, &old)) {
        InterlockedExchange(&armed, 0);
        return 4;
    }
    LONG slot = InterlockedIncrement(&watch_count) - 1;
    if (slot >= 0 && slot < MAX_WATCH) { watch_page[slot] = base; watch_size[slot] = page; }
    return 0;
}

/* 干跑用：读一次被布防的字符串，触发捕获。 */
__declspec(dllexport) LONG WeChatMomentsProbeSelfTouch(void) {
    self_test_sink = self_test_string;
    volatile char c = self_test_sink[0];
    (void)c;
    return capture_count;
}

/* 把结果写到 DLL 同目录的 probe-capture.jsonl；由注入端另起一次调用。 */
__declspec(dllexport) DWORD WeChatMomentsProbeDumpDefault(void) {
    if (!default_dump[0]) default_path();
    return WeChatMomentsProbeDump(default_dump);
}

BOOL WINAPI DllMain(HINSTANCE module, DWORD reason, LPVOID reserved) {
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) { DisableThreadLibraryCalls(module); remember_self(module); }
    return TRUE;
}
