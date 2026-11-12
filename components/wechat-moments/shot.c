// 窗口截图工具：按标题子串找窗口，截它的客户区存成 BMP。
// 只读操作：不点击、不输入、不改窗口状态（不强制置顶）。
#include <windows.h>
#include <stdio.h>
#include <string.h>

static WCHAR needle[128];
static HWND target = NULL;

static BOOL CALLBACK scan(HWND hwnd, LPARAM lp) {
    (void)lp;
    if (!IsWindowVisible(hwnd)) return TRUE;
    WCHAR title[512] = {0}, cls[256] = {0};
    GetWindowTextW(hwnd, title, 512);
    GetClassNameW(hwnd, cls, 256);
    /* 类名或标题任一命中即可：类名是纯 ASCII，方便从命令行传 */
    if (wcsstr(title, needle) || wcsstr(cls, needle)) { target = hwnd; return FALSE; }
    return TRUE;
}

static int save_bmp(const char *path, int w, int h, void *bits) {
    BITMAPFILEHEADER fh;
    BITMAPINFOHEADER ih;
    DWORD size = (DWORD)(w * h * 4);
    memset(&fh, 0, sizeof(fh));
    memset(&ih, 0, sizeof(ih));
    fh.bfType = 0x4D42;
    fh.bfOffBits = sizeof(fh) + sizeof(ih);
    fh.bfSize = fh.bfOffBits + size;
    ih.biSize = sizeof(ih);
    ih.biWidth = w;
    ih.biHeight = h;   /* 负数表示自上而下，方便外部查看 */
    ih.biPlanes = 1;
    ih.biBitCount = 32;
    ih.biCompression = BI_RGB;
    ih.biSizeImage = size;
    ih.biHeight = -h;
    FILE *f = fopen(path, "wb");
    if (!f) return 0;
    fwrite(&fh, sizeof(fh), 1, f);
    fwrite(&ih, sizeof(ih), 1, f);
    fwrite(bits, size, 1, f);
    fclose(f);
    return 1;
}

int wmain(int argc, wchar_t **argv) {
    if (argc < 3) { wprintf(L"用法: shot.exe <标题子串> <输出.bmp>\n"); return 1; }
    /* 支持直接传窗口句柄：@0x1234 */
    if (argv[1][0] == L'@') {
        target = (HWND)(ULONG_PTR)_wcstoui64(argv[1] + 1, NULL, 16);
        if (!IsWindow(target)) { wprintf(L"句柄无效\n"); return 4; }
    } else {
        wcsncpy(needle, argv[1], 127);
        EnumWindows(scan, 0);
    }
    if (!target) { wprintf(L"没找到标题包含 \"%s\" 的窗口\n", needle); return 2; }

    RECT r;
    GetWindowRect(target, &r);
    int w = r.right - r.left, h = r.bottom - r.top;
    wprintf(L"窗口 0x%p  rect=%d,%d  %dx%d\n", (void *)target, r.left, r.top, w, h);

    HDC screen = GetDC(NULL);
    HDC mem = CreateCompatibleDC(screen);
    BITMAPINFO bi;
    memset(&bi, 0, sizeof(bi));
    bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    bi.bmiHeader.biWidth = w;
    bi.bmiHeader.biHeight = -h;
    bi.bmiHeader.biPlanes = 1;
    bi.bmiHeader.biBitCount = 32;
    bi.bmiHeader.biCompression = BI_RGB;
    void *bits = NULL;
    HBITMAP bmp = CreateDIBSection(mem, &bi, DIB_RGB_COLORS, &bits, NULL, 0);
    HGDIOBJ old = SelectObject(mem, bmp);

    /* 先用 PrintWindow（能抓到被遮挡的内容），不行再退回屏幕拷贝 */
    BOOL ok = PrintWindow(target, mem, 2 /* PW_RENDERFULLCONTENT */);
    if (!ok) {
        BOOL blt = BitBlt(mem, 0, 0, w, h, screen, r.left, r.top, SRCCOPY);
        wprintf(L"PrintWindow 失败，改用 BitBlt: %d\n", blt);
    } else {
        wprintf(L"PrintWindow 成功\n");
    }

    char out[512];
    WideCharToMultiByte(CP_ACP, 0, argv[2], -1, out, 512, NULL, NULL);
    int saved = save_bmp(out, w, h, bits);
    wprintf(L"保存: %S -> %d\n", argv[2], saved);

    SelectObject(mem, old);
    DeleteObject(bmp);
    DeleteDC(mem);
    ReleaseDC(NULL, screen);
    return saved ? 0 : 3;
}
