// 极简注入器：把一个 DLL 塞进加载了 Weixin.dll 的微信进程，只调 LoadLibraryW。
// 组件在 DllMain 里自启动，所以这里不需要远程 GetProcAddress，也不用跨进程传字符串以外的参数。
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <psapi.h>
#include <tlhelp32.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

#pragma comment(lib, "psapi.lib")

#define OUT_MAX 4096

static int write_out(const wchar_t *path, const char *json) {
    FILE *f = NULL;
    _wfopen_s(&f, path, L"wb");
    if (!f) return 0;
    fputs(json, f);
    fclose(f);
    return 1;
}

static int has_core(DWORD pid) {
    HANDLE h = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, pid);
    if (!h) return 0;
    HMODULE mods[1024];
    DWORD needed = 0;
    int found = 0;
    if (EnumProcessModulesEx(h, mods, sizeof(mods), &needed, LIST_MODULES_ALL)) {
        DWORD count = needed / sizeof(HMODULE);
        if (count > 1024) count = 1024;
        for (DWORD i = 0; i < count && !found; i++) {
            wchar_t name[MAX_PATH] = {0};
            if (GetModuleBaseNameW(h, mods[i], name, MAX_PATH) && !_wcsicmp(name, L"Weixin.dll")) found = 1;
        }
    }
    CloseHandle(h);
    return found;
}

static DWORD find_pid(void) {
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE) return 0;
    PROCESSENTRY32W pe;
    pe.dwSize = sizeof(pe);
    DWORD pid = 0;
    if (Process32FirstW(snap, &pe)) {
        do {
            if (_wcsicmp(pe.szExeFile, L"Weixin.exe")) continue;
            if (has_core(pe.th32ProcessID)) { pid = pe.th32ProcessID; break; }
        } while (Process32NextW(snap, &pe));
    }
    CloseHandle(snap);
    return pid;
}

int wmain(int argc, wchar_t **argv) {
    const wchar_t *dll = NULL, *out = NULL;
    DWORD pid = 0;
    for (int i = 1; i < argc; i++) {
        if (!wcscmp(argv[i], L"--dll") && i + 1 < argc) dll = argv[++i];
        else if (!wcscmp(argv[i], L"--out") && i + 1 < argc) out = argv[++i];
        else if (!wcscmp(argv[i], L"--pid") && i + 1 < argc) pid = (DWORD)_wtoi(argv[++i]);
    }
    if (!dll || !out) return 2;
    if (!pid) pid = find_pid();
    char buf[OUT_MAX];
    if (!pid) {
        write_out(out, "{\"ok\":false,\"error\":\"no-wechat-process\"}");
        return 3;
    }
    HANDLE h = OpenProcess(PROCESS_CREATE_THREAD | PROCESS_QUERY_INFORMATION | PROCESS_VM_OPERATION |
                           PROCESS_VM_WRITE | PROCESS_VM_READ, FALSE, pid);
    if (!h) {
        snprintf(buf, sizeof(buf), "{\"ok\":false,\"pid\":%lu,\"error\":\"open-process-%lu\"}",
                 (unsigned long)pid, (unsigned long)GetLastError());
        write_out(out, buf);
        return 4;
    }
    SIZE_T bytes = (wcslen(dll) + 1) * sizeof(wchar_t);
    void *remote = VirtualAllocEx(h, NULL, bytes, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!remote) { CloseHandle(h); write_out(out, "{\"ok\":false,\"error\":\"alloc\"}"); return 5; }
    if (!WriteProcessMemory(h, remote, dll, bytes, NULL)) {
        CloseHandle(h); write_out(out, "{\"ok\":false,\"error\":\"write\"}"); return 6;
    }
    HMODULE k32 = GetModuleHandleW(L"kernel32.dll");
    FARPROC load = GetProcAddress(k32, "LoadLibraryW");
    if (!load) { CloseHandle(h); write_out(out, "{\"ok\":false,\"error\":\"no-loadlibrary\"}"); return 7; }
    HANDLE th = CreateRemoteThread(h, NULL, 0, (LPTHREAD_START_ROUTINE)load, remote, 0, NULL);
    if (!th) { CloseHandle(h); write_out(out, "{\"ok\":false,\"error\":\"thread\"}"); return 8; }
    WaitForSingleObject(th, 15000);
    DWORD module = 0;
    GetExitCodeThread(th, &module);
    CloseHandle(th);
    VirtualFreeEx(h, remote, 0, MEM_RELEASE);
    CloseHandle(h);
    if (!module) {
        snprintf(buf, sizeof(buf), "{\"ok\":false,\"pid\":%lu,\"error\":\"loadlibrary-failed\"}", (unsigned long)pid);
        write_out(out, buf);
        return 9;
    }
    snprintf(buf, sizeof(buf), "{\"ok\":true,\"pid\":%lu,\"module\":\"0x%llx\"}",
             (unsigned long)pid, (unsigned long long)module);
    write_out(out, buf);
    return 0;
}
