// 只读探针：在微信进程里找 SNS 网络管理器（root → +0x2c8 → manager → vtable[5]）。
// 不 hook、不改内存、不发请求；只 VirtualQuery + 读指针，结果写文件。
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdint.h>
#include <stdio.h>

/* 运行期解析系统临时目录，不把任何机器上的用户路径写进源码 */
static const wchar_t *temp_file(const wchar_t *name) {
    static wchar_t paths[2][MAX_PATH + 64];
    static int slot;
    wchar_t dir[MAX_PATH];
    if (!GetTempPathW(MAX_PATH, dir)) return name;
    slot = (slot + 1) % 2;
    _snwprintf_s(paths[slot], MAX_PATH + 64, _TRUNCATE, L"%s%s", dir, name);
    return paths[slot];
}

#define OUT temp_file(L"wb-moments-probe.json")
#define IMAGE_SIZE 0xaf0e000u

static int readable(const void *p, size_t n) {
    MEMORY_BASIC_INFORMATION m;
    uintptr_t a = (uintptr_t)p;
    if (!p || !n) return 0;
    if (!VirtualQuery(p, &m, sizeof(m))) return 0;
    if (m.State != MEM_COMMIT) return 0;
    if (m.Protect & (PAGE_NOACCESS | PAGE_GUARD)) return 0;
    return a >= (uintptr_t)m.BaseAddress && n <= (uintptr_t)m.BaseAddress + m.RegionSize - a;
}

static const unsigned char *g_core;
static uintptr_t g_base;
static uintptr_t text_lo, text_hi, rdata_lo, rdata_hi, data_lo, data_hi;

static int in_range(uintptr_t p, uintptr_t lo, uintptr_t hi) { return p >= lo && p < hi; }

__declspec(dllexport) DWORD WINAPI ProbeRoot(void *unused) {
    (void)unused;
    FILE *f = NULL;
    _wfopen_s(&f, OUT, L"wb");
    if (!f) return 1;
    g_core = (const unsigned char *)GetModuleHandleW(L"Weixin.dll");
    if (!g_core) { fprintf(f, "{\"error\":\"no-module\"}"); fclose(f); return 2; }
    g_base = (uintptr_t)g_core;
    const IMAGE_DOS_HEADER *dos = (const IMAGE_DOS_HEADER *)g_core;
    const IMAGE_NT_HEADERS64 *nt = (const IMAGE_NT_HEADERS64 *)(g_core + dos->e_lfanew);
    if (nt->OptionalHeader.SizeOfImage != IMAGE_SIZE) { fprintf(f, "{\"error\":\"image-size\"}"); fclose(f); return 3; }

    const IMAGE_SECTION_HEADER *sec = IMAGE_FIRST_SECTION(nt);
    for (unsigned i = 0; i < nt->FileHeader.NumberOfSections; i++) {
        uintptr_t lo = g_base + sec[i].VirtualAddress;
        uintptr_t hi = lo + sec[i].Misc.VirtualSize;
        if (!memcmp(sec[i].Name, ".text", 5)) { text_lo = lo; text_hi = hi; }
        else if (!memcmp(sec[i].Name, ".rdata", 6)) { rdata_lo = lo; rdata_hi = hi; }
        else if (!memcmp(sec[i].Name, ".data", 5)) { data_lo = lo; data_hi = hi; }
    }

    // 顺带把已定位的常量在运行时核对一遍
    uintptr_t vt = g_base + 0x8b5d768;
    int vt_ok = readable((void *)vt, 48);
    uintptr_t slots[6] = {0};
    if (vt_ok) memcpy(slots, (void *)vt, 48);

    fprintf(f, "{\"base\":\"0x%llx\",\"imageSize\":\"0x%x\",\"postVtable\":\"0x%llx\",\"postVtableReadable\":%d,",
            (unsigned long long)g_base, (unsigned)nt->OptionalHeader.SizeOfImage,
            (unsigned long long)vt, vt_ok);
    fprintf(f, "\"slots\":[\"0x%llx\",\"0x%llx\",\"0x%llx\",\"0x%llx\",\"0x%llx\",\"0x%llx\"],",
            (unsigned long long)(slots[0] - g_base), (unsigned long long)(slots[1] - g_base),
            (unsigned long long)(slots[2] - g_base), (unsigned long long)(slots[3] - g_base),
            (unsigned long long)(slots[4] - g_base), (unsigned long long)slots[5]);

    // 扫 .data 里所有指针，验证 root → +0x2c8 → manager → vtable[5]
    fprintf(f, "\"candidates\":[");
    int found = 0;
    for (uintptr_t slot = data_lo; slot + 8 <= data_hi && found < 12; slot += 8) {
        if (!readable((void *)slot, 8)) continue;
        uintptr_t root = *(uintptr_t *)slot;
        if (root < 0x10000 || (root & 7) || !readable((void *)root, 0x2d0)) continue;
        uintptr_t root_vt = *(uintptr_t *)root;
        if (!in_range(root_vt, rdata_lo, rdata_hi)) continue;
        uintptr_t mgr = *(uintptr_t *)(root + 0x2c8);
        if (mgr < 0x10000 || !readable((void *)mgr, 0x40)) continue;
        uintptr_t mgr_vt = *(uintptr_t *)mgr;
        if (!in_range(mgr_vt, rdata_lo, rdata_hi)) continue;
        if (!readable((void *)(mgr_vt + 0x30), 0x30)) continue;
        uintptr_t disp = *(uintptr_t *)(mgr_vt + 0x28);
        if (!in_range(disp, text_lo, text_hi)) continue;
        if (found) fprintf(f, ",");
        fprintf(f, "{\"global\":\"0x%llx\",\"root\":\"0x%llx\",\"rootVtable\":\"0x%llx\",\"manager\":\"0x%llx\","
                   "\"managerVtable\":\"0x%llx\",\"dispatch\":\"0x%llx\"}",
                (unsigned long long)(slot - g_base), (unsigned long long)root,
                (unsigned long long)(root_vt - g_base), (unsigned long long)mgr,
                (unsigned long long)(mgr_vt - g_base), (unsigned long long)(disp - g_base));
        found++;
    }
    fprintf(f, "],\"count\":%d}", found);
    fclose(f);
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE module, DWORD reason, LPVOID unused) {
    (void)unused;
    if (reason == DLL_PROCESS_ATTACH) DisableThreadLibraryCalls(module);
    return TRUE;
}
