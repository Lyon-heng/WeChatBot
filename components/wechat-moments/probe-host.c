// 探针自测宿主：加载 probe.dll，调用自测，打印捕获到的读取次数。不涉及微信。
#include <windows.h>
#include <stdio.h>

typedef LONG (WINAPI *SelfTest)(void);

int main(void) {
    HMODULE module = LoadLibraryA("build/moments-probe.dll");
    if (!module) { printf("load failed: %lu\n", GetLastError()); return 1; }
    SelfTest run = (SelfTest)GetProcAddress(module, "WeChatMomentsProbeSelfTest");
    if (!run) { printf("export missing\n"); return 2; }
    printf("loaded, calling selftest\n"); fflush(stdout);
    LONG captured = run();
    typedef void *(WINAPI *LastRip)(void);
    LastRip last = (LastRip)GetProcAddress(module, "WeChatMomentsProbeLastRip");
    printf("captured=%ld lastRip=0x%p\n", captured, last ? last() : NULL);
    return captured > 0 ? 0 : 3;
}
