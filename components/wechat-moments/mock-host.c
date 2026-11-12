// 模拟宿主：把 WeChatMomentsMock.dll 加载到本进程，起服务做协议自测。
// 它不是微信，组件在模拟模式下也永远不会调用微信——只验证 HTTP 协议与报文校验。
#include <windows.h>
#include <stdio.h>
#include <string.h>
#include <stdint.h>

typedef struct {
    uint32_t magic;
    uint32_t bytes;
    uint32_t pid;
    uint32_t port;
    char token[65];
    char account[129];
    char wxid[129];
    char approved_hash[65];
} StartConfig;

typedef DWORD (WINAPI *StartFn)(void *);
typedef DWORD (WINAPI *StopFn)(void *);

static void copy_field(char *target, const char *value, size_t size) {
    strncpy_s(target, size, value, size - 1);
}

int main(int argc, char **argv) {
    if (argc < 7) {
        printf("用法: mock-host.exe <dll> <port> <token> <account> <wxid> <approvedHash>\n");
        return 2;
    }
    const char *dll = argv[1];
    StartConfig config;
    memset(&config, 0, sizeof(config));
    config.magic = 0x324D5857u;
    config.bytes = (uint32_t)sizeof(StartConfig);
    config.pid = GetCurrentProcessId();
    config.port = (uint32_t)atoi(argv[2]);
    copy_field(config.token, argv[3], sizeof(config.token));
    copy_field(config.account, argv[4], sizeof(config.account));
    copy_field(config.wxid, argv[5], sizeof(config.wxid));
    copy_field(config.approved_hash, argv[6], sizeof(config.approved_hash));

    HMODULE module = LoadLibraryA(dll);
    if (!module) { printf("LoadLibrary failed: %lu\n", GetLastError()); return 3; }
    StartFn start = (StartFn)GetProcAddress(module, "WeChatMomentsStart");
    if (!start) { printf("WeChatMomentsStart not found\n"); return 4; }

    DWORD result = start(&config);
    printf("start=%lu pid=%lu port=%u\n", result, GetCurrentProcessId(), config.port);
    fflush(stdout);
    if (result != 0) return 5;

    printf("READY\n");
    fflush(stdout);
    /* 保持进程存活，直到被结束 */
    for (;;) Sleep(1000);
    StopFn stop = (StopFn)GetProcAddress(module, "WeChatMomentsStop");
    if (stop) stop(NULL);
    return 0;
}
