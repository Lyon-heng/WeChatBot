// 列出微信相关进程的所有可见顶层窗口，输出 UTF-8 文件（避免控制台编码问题）。只读。
#include <windows.h>
#include <stdio.h>
#include <psapi.h>

static int is_wechat(DWORD pid) {
    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!h) return 0;
    WCHAR path[MAX_PATH] = {0};
    DWORD n = MAX_PATH;
    int ok = 0;
    if (QueryFullProcessImageNameW(h, 0, path, &n)) {
        WCHAR *base = wcsrchr(path, L'\\');
        base = base ? base + 1 : path;
        if (_wcsnicmp(base, L"Weixin", 6) == 0 || _wcsnicmp(base, L"WeChat", 6) == 0) ok = 1;
    }
    CloseHandle(h);
    return ok;
}

static FILE *out = NULL;

static BOOL CALLBACK scan(HWND hwnd, LPARAM lp) {
    (void)lp;
    if (!IsWindowVisible(hwnd)) return TRUE;
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (!is_wechat(pid)) return TRUE;
    WCHAR title[512] = {0}, cls[256] = {0};
    GetWindowTextW(hwnd, title, 512);
    GetClassNameW(hwnd, cls, 256);
    RECT r;
    GetWindowRect(hwnd, &r);
    char titleU[2048] = {0}, clsU[512] = {0};
    WideCharToMultiByte(CP_UTF8, 0, title, -1, titleU, sizeof(titleU), NULL, NULL);
    WideCharToMultiByte(CP_UTF8, 0, cls, -1, clsU, sizeof(clsU), NULL, NULL);
    fprintf(out, "hwnd=0x%p pid=%lu class=%s title=[%s] rect=%d,%d %dx%d zorder=top\n",
            (void *)hwnd, pid, clsU, titleU, r.left, r.top, r.right - r.left, r.bottom - r.top);
    return TRUE;
}

int wmain(int argc, wchar_t **argv) {
    const char *path = "winlist.txt";
    if (argc >= 2) {
        static char buf[512];
        WideCharToMultiByte(CP_UTF8, 0, argv[1], -1, buf, sizeof(buf), NULL, NULL);
        path = buf;
    }
    out = fopen(path, "wb");
    if (!out) return 1;
    EnumWindows(scan, 0);
    fclose(out);
    return 0;
}
