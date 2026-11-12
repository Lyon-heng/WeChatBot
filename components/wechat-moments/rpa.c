// 最小 RPA 工具：把窗口置前、点击、把 UTF-8 文本经剪贴板粘贴进去。
// 不注入、不改任何进程内存，只做普通的鼠标键盘输入。
#include <windows.h>
#include <stdio.h>
#include <string.h>

static WCHAR needle[128];
static HWND found = NULL;

static BOOL CALLBACK scan(HWND hwnd, LPARAM lp) {
    (void)lp;
    if (!IsWindowVisible(hwnd)) return TRUE;
    WCHAR title[512] = {0}, cls[256] = {0};
    GetWindowTextW(hwnd, title, 512);
    GetClassNameW(hwnd, cls, 256);
    if (wcsstr(title, needle) || wcsstr(cls, needle)) { found = hwnd; return FALSE; }
    return TRUE;
}

static HWND find_window(const wchar_t *n) {
    wcsncpy(needle, n, 127);
    found = NULL;
    EnumWindows(scan, 0);
    return found;
}

static void click_at(int x, int y, int double_click) {
    SetCursorPos(x, y);
    Sleep(60);
    INPUT in;
    memset(&in, 0, sizeof(in));
    in.type = INPUT_MOUSE;
    in.mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
    SendInput(1, &in, sizeof(INPUT));
    Sleep(40);
    memset(&in, 0, sizeof(in));
    in.type = INPUT_MOUSE;
    in.mi.dwFlags = MOUSEEVENTF_LEFTUP;
    SendInput(1, &in, sizeof(INPUT));
    if (double_click) {
        Sleep(60);
        memset(&in, 0, sizeof(in));
        in.type = INPUT_MOUSE;
        in.mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
        SendInput(1, &in, sizeof(INPUT));
        Sleep(40);
        memset(&in, 0, sizeof(in));
        in.type = INPUT_MOUSE;
        in.mi.dwFlags = MOUSEEVENTF_LEFTUP;
        SendInput(1, &in, sizeof(INPUT));
    }
}

static void key_combo(WORD vk, int ctrl) {
    INPUT in[4];
    int n = 0;
    memset(in, 0, sizeof(in));
    if (ctrl) {
        in[n].type = INPUT_KEYBOARD; in[n].ki.wVk = VK_CONTROL; n++;
        in[n].type = INPUT_KEYBOARD; in[n].ki.wVk = vk; n++;
        in[n].type = INPUT_KEYBOARD; in[n].ki.wVk = vk; in[n].ki.dwFlags = KEYEVENTF_KEYUP; n++;
        in[n].type = INPUT_KEYBOARD; in[n].ki.wVk = VK_CONTROL; in[n].ki.dwFlags = KEYEVENTF_KEYUP; n++;
    } else {
        in[n].type = INPUT_KEYBOARD; in[n].ki.wVk = vk; n++;
        in[n].type = INPUT_KEYBOARD; in[n].ki.wVk = vk; in[n].ki.dwFlags = KEYEVENTF_KEYUP; n++;
    }
    SendInput(n, in, sizeof(INPUT));
}

/* 把 UTF-8 文件内容放进剪贴板（CF_UNICODETEXT） */
static int set_clipboard_utf8(const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) return 0;
    static char buf[8192];
    size_t got = fread(buf, 1, sizeof(buf) - 1, f);
    fclose(f);
    buf[got] = 0;
    while (got > 0 && (buf[got - 1] == '\n' || buf[got - 1] == '\r')) buf[--got] = 0;

    int wlen = MultiByteToWideChar(CP_UTF8, 0, buf, -1, NULL, 0);
    if (wlen <= 0) return 0;
    HGLOBAL mem = GlobalAlloc(GMEM_MOVEABLE, wlen * sizeof(WCHAR));
    if (!mem) return 0;
    WCHAR *dst = (WCHAR *)GlobalLock(mem);
    MultiByteToWideChar(CP_UTF8, 0, buf, -1, dst, wlen);
    GlobalUnlock(mem);

    for (int i = 0; i < 10; i++) {
        if (OpenClipboard(NULL)) {
            EmptyClipboard();
            SetClipboardData(CF_UNICODETEXT, mem);
            CloseClipboard();
            return 1;
        }
        Sleep(60);
    }
    GlobalFree(mem);
    return 0;
}

static int wmain2(int argc, wchar_t **argv) {
    if (argc < 3) {
        wprintf(L"用法:\n  rpa fg <class>\n  rpa click <x> <y> [dbl]\n  rpa paste <utf8文件>\n  rpa copy <utf8文件>\n");
        return 1;
    }
    if (!wcscmp(argv[1], L"copy")) {
        char p[512];
        WideCharToMultiByte(CP_UTF8, 0, argv[2], -1, p, sizeof(p), NULL, NULL);
        return set_clipboard_utf8(p) ? 0 : 2;
    }
    if (!wcscmp(argv[1], L"paste")) {
        char p[512];
        WideCharToMultiByte(CP_UTF8, 0, argv[2], -1, p, sizeof(p), NULL, NULL);
        if (!set_clipboard_utf8(p)) return 2;
        Sleep(120);
        key_combo('V', 1);
        return 0;
    }
    if (!wcscmp(argv[1], L"click")) {
        int x = _wtoi(argv[2]), y = _wtoi(argv[3]);
        int dbl = (argc >= 5 && !wcscmp(argv[4], L"dbl"));
        click_at(x, y, dbl);
        return 0;
    }
    if (!wcscmp(argv[1], L"hold")) {
        /* 长按：按下 -> 停 <ms> -> 松开。微信朋友圈的“纯文字发表”就是这个手势。 */
        int x = _wtoi(argv[2]), y = _wtoi(argv[3]);
        int ms = (argc >= 5) ? _wtoi(argv[4]) : 900;
        SetCursorPos(x, y);
        Sleep(80);
        INPUT in;
        memset(&in, 0, sizeof(in));
        in.type = INPUT_MOUSE;
        in.mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
        SendInput(1, &in, sizeof(INPUT));
        Sleep(ms);
        memset(&in, 0, sizeof(in));
        in.type = INPUT_MOUSE;
        in.mi.dwFlags = MOUSEEVENTF_LEFTUP;
        SendInput(1, &in, sizeof(INPUT));
        return 0;
    }
    if (!wcscmp(argv[1], L"key")) {
        int vk = 0;
        if (!wcscmp(argv[2], L"ESC")) vk = VK_ESCAPE;
        else if (!wcscmp(argv[2], L"ENTER")) vk = VK_RETURN;
        else if (!wcscmp(argv[2], L"TAB")) vk = VK_TAB;
        else vk = _wtoi(argv[2]);
        key_combo((WORD)vk, 0);
        return 0;
    }
    if (!wcscmp(argv[1], L"fg")) {
        HWND h;
        if (argv[2][0] == L'@') h = (HWND)(ULONG_PTR)_wcstoui64(argv[2] + 1, NULL, 16);
        else h = find_window(argv[2]);
        if (!h) return 3;
        if (IsIconic(h)) ShowWindow(h, SW_RESTORE);
        /* 置前：先按一下 ALT 骗过前台锁 */
        key_combo(VK_MENU, 0);
        SetForegroundWindow(h);
        BringWindowToTop(h);
        SetActiveWindow(h);
        return 0;
    }
    return 1;
}

int wmain(int argc, wchar_t **argv) { return wmain2(argc, argv); }
