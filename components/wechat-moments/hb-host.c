// 硬件断点探针的本地自测宿主：加载 DLL、调用自测、打印捕获条数。不涉及微信。
#include <windows.h>
#include <stdio.h>

typedef LONG (WINAPI *SelfTest)(void);

int main(void) {
    HMODULE module = LoadLibraryA("build/moments-hwbreak.dll");
    if (!module) { printf("load failed: %lu\n", GetLastError()); return 1; }
    SelfTest run = (SelfTest)GetProcAddress(module, "HbSelfTest");
    if (!run) { printf("export missing\n"); return 2; }
    printf("calling selftest\n"); fflush(stdout);
    LONG captured = run();
    printf("captured=%ld\n", captured);
    return captured > 0 ? 0 : 3;
}
