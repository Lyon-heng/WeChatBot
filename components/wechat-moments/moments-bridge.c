// 朋友圈原生组件（wechat-moments）：在微信进程内提供只监听 127.0.0.1 的 HTTP 投递口。
//
// 设计原则（与 shiyu 的 moments-bridge 一致，不抄代码，只照规则）：
//   1. 一次加载只放行一条内容：加载时把正文哈希写进配置，/submit 先算哈希再比对；
//   2. 一次提交只尝试一次：第二次直接 409，超时/未知结果不重发；
//   3. 常量不全就拒绝执行，绝不猜地址；
//   4. 只有 127.0.0.1 + Bearer 令牌，拒绝带 Origin 的请求（防浏览器跨站打进来）。
//
// 编译：build.bat（MSVC），加 WM_OFFLINE_TEST 得到不调用微信的模拟组件，用于协议自测。
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#include <bcrypt.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "profile.h"

typedef struct {
    uint32_t magic;          // 'WXM2'
    uint32_t bytes;          // sizeof(StartConfig)
    uint32_t pid;
    uint32_t port;
    char token[65];
    char account[129];       // wxid_xxx_abcd
    char wxid[129];
    char approved_hash[65];  // 本条正文报文的小写 sha256
} StartConfig;

typedef struct {
    uint32_t magic;          // 0x314d5958 发布 / 0x334d5958 只读
    char id[36];
    uint32_t length;
} Request;

#define WM_MAGIC_POST 0x314d5958u
#define WM_MAGIC_DETAIL 0x334d5958u
#define WM_MAX_PACKET 32044u

static StartConfig config;
static volatile LONG running = 0, admitted = 0, submitted = 0, received = 0, completed = 0, destroyed = 0;
static SOCKET listener = INVALID_SOCKET;
static char request_id[37];
static uint64_t object_id;
static LONG return_code = 0x7fffffff;
static unsigned char response_bytes[65536];
static unsigned response_size;

#ifdef WM_OFFLINE_TEST
static const char *offline_flag = "true";
#else
static const char *offline_flag = "false";
#endif

/* ------------------------------------------------------------------ 基础工具 */

static uintptr_t core_base(void) {
    HMODULE module = GetModuleHandleA("Weixin.dll");
    return (uintptr_t)module;
}

static int sha256_hex(const void *data, unsigned size, char out[65]) {
    BCRYPT_ALG_HANDLE alg = NULL;
    unsigned char hash[32];
    if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, NULL, 0) != 0) return 0;
    NTSTATUS status = BCryptHash(alg, NULL, 0, (PUCHAR)data, size, hash, 32);
    BCryptCloseAlgorithmProvider(alg, 0);
    if (status != 0) return 0;
    for (unsigned i = 0; i < 32; i++) sprintf(out + i * 2, "%02x", hash[i]);
    out[64] = 0;
    return 1;
}

/* 核对正在运行的 Weixin.dll 文件哈希，避免把组件装到别的微信版本上。 */
static int verify_core_file(void) {
    HMODULE module = GetModuleHandleA("Weixin.dll");
    if (!module) return 0;
    wchar_t path[MAX_PATH * 2];
    DWORD length = GetModuleFileNameW(module, path, (DWORD)(sizeof(path) / sizeof(path[0])));
    if (!length) return 0;
    HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, 0, NULL);
    if (file == INVALID_HANDLE_VALUE) return 0;
    BCRYPT_ALG_HANDLE alg = NULL;
    BCRYPT_HASH_HANDLE hash = NULL;
    unsigned char digest[32];
    char hex[65];
    int ok = 0;
    if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, NULL, 0) != 0) goto done;
    if (BCryptCreateHash(alg, &hash, NULL, 0, NULL, 0, 0) != 0) goto done;
    {
        static unsigned char buffer[1 << 20];
        DWORD read = 0;
        while (ReadFile(file, buffer, sizeof(buffer), &read, NULL) && read > 0) {
            if (BCryptHashData(hash, buffer, read, 0) != 0) goto done;
        }
    }
    if (BCryptFinishHash(hash, digest, 32, 0) != 0) goto done;
    for (unsigned i = 0; i < 32; i++) sprintf(hex + i * 2, "%02x", digest[i]);
    hex[64] = 0;
    ok = memcmp(hex, WM_CORE_SHA256, 64) == 0;
done:
    if (hash) BCryptDestroyHash(hash);
    if (alg) BCryptCloseAlgorithmProvider(alg, 0);
    CloseHandle(file);
    return ok;
}

static int exact_build(void) {
#ifdef WM_OFFLINE_TEST
    return 1;  // 模拟组件不校验微信，但也永远不调用微信
#else
    return verify_core_file();
#endif
}

/* 账号核验：要求 wxid 与加载时一致，且账号目录以 wxid_ 开头。 */
static int account_verified(void) {
    if (!config.wxid[0] || !config.account[0]) return 0;
    size_t length = strlen(config.wxid);
    if (length < 6 || strncmp(config.wxid, "wxid_", 5) != 0) return 0;
    return strncmp(config.account, config.wxid, length) == 0 && config.account[length] == '_';
}

/* ------------------------------------------------------------------ 报文校验 */

static int validate_request(const void *data, unsigned size) {
    if (!data || size < sizeof(Request)) return 0;
    const Request *request = (const Request *)data;
    if ((request->magic != WM_MAGIC_POST && request->magic != WM_MAGIC_DETAIL) || !request->length) return 0;
    if (request->length > WM_MAX_PACKET || size != sizeof(Request) + request->length) return 0;
    for (unsigned i = 0; i < 36; i++) {
        char c = request->id[i];
        if (i == 8 || i == 13 || i == 18 || i == 23) { if (c != '-') return 0; }
        else if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return 0;
    }
    return 1;
}

/* ------------------------------------------------------------------ 原生投递 */

/*
 * 真正的调用链在常量齐全后才生效。结构与 xiaoyu 的 4.2.0.13 实现同形：
 *   1) 用微信分配器申请任务对象（post 0x270 / detail 0xf0）
 *   2) 填 CGI 信息块：拷贝 16 字节模板 → CGI 号 → endpoint 指针 → 长度 → 63 → 1
 *   3) 调该对象的构造函数，拿到 vtable
 *   4) 逐一比对 vtable 里的函数指针，任何一项不符就整包丢弃
 *   5) 原生 protobuf 解析 → 交给网络管理器派发
 *   6) 从响应 holder 取回 BaseResponse.ret 与 SnsObject.id
 * 目前第 3～6 步需要的地址还没定位完，所以函数在校验失败时直接返回 0。
 */
static int submit_native(const Request *request) {
#ifdef WM_OFFLINE_TEST
    (void)request;
    return 0;
#else
    if (!exact_build() || !account_verified() || !WM_READY()) return 0;
    uintptr_t base = core_base();
    if (!base) return 0;

    const int detail = request->magic == WM_MAGIC_DETAIL;
    const uintptr_t info_at = base + (detail ? WM_DETAIL_INFO : WM_POST_INFO);
    const uintptr_t ctor = base + (detail ? WM_DETAIL_CTOR : WM_POST_CTOR);
    const uintptr_t expected_vtable = base + (detail ? WM_DETAIL_VTABLE : WM_POST_VTABLE);
    const uintptr_t allocate = base + WM_ALLOCATE;

    void *memory = ((void *(*)(size_t))allocate)(detail ? WM_DETAIL_OBJECT_SIZE : WM_POST_OBJECT_SIZE);
    if (!memory) return 0;

    unsigned char info[64];
    memset(info, 0, sizeof(info));
    memcpy(info, (const void *)info_at, 16);
    char endpoint[64];
    strcpy(endpoint, detail ? WM_CGI_MMSNSOBJECTDETAIL : WM_CGI_MMSNSPOST);
    *(uint32_t *)(info + 16) = detail ? WM_CGI_ID_DETAIL : WM_CGI_ID_POST;
    *(void **)(info + 24) = endpoint;
    *(uint64_t *)(info + 40) = strlen(endpoint);
    *(uint64_t *)(info + 48) = 63;
    info[56] = 1;

    ((void (*)(void *, void *))ctor)(memory, info);
    uintptr_t *table = *(uintptr_t **)memory;
    if (!table || (uintptr_t)table != expected_vtable || table[5] != 1) {
        ((void (*)(void *, unsigned))(table ? table[0] : NULL))(memory, 1);
        return 0;
    }
    if (!((unsigned char (*)(void *, const void *, int))(base + WM_PROTO_PARSE))(
            (char *)memory + 0xa8, request + 1, (int)request->length)) {
        ((void (*)(void *, unsigned))table[0])(memory, 1);
        return 0;
    }

    InterlockedExchange(&submitted, 1);
    /* 派发需要 manager 与 response 回调：常量定位完成后在这里接上（见 README 阶段 3）。 */
    return 1;
#endif
}

/* ------------------------------------------------------------------ HTTP 服务 */

static int send_all(SOCKET socket, const char *data, int size) {
    while (size > 0) {
        int sent = send(socket, data, size, 0);
        if (sent <= 0) return 0;
        data += sent;
        size -= sent;
    }
    return 1;
}

static void reply(SOCKET socket, int code, const char *body) {
    char head[256];
    int size = snprintf(head, sizeof(head),
        "HTTP/1.1 %d Result\r\nContent-Type: application/json\r\nCache-Control: no-store\r\n"
        "Connection: close\r\nContent-Length: %u\r\n\r\n", code, (unsigned)strlen(body));
    if (send_all(socket, head, size)) send_all(socket, body, (int)strlen(body));
}

static void result_json(char *out, unsigned cap) {
    const char *state = (received && completed && destroyed)
        ? ((return_code == 0 && object_id) ? "server-accepted" : "server-rejected")
        : (submitted ? "unknown" : (admitted ? "not-submitted" : "idle"));
    snprintf(out, cap,
        "{\"id\":\"%s\",\"state\":\"%s\",\"ret\":%ld,\"objectId\":\"%llu\",\"submitted\":%s,"
        "\"taskCompleted\":%s,\"taskDestroyed\":%s}",
        request_id, state, return_code, (unsigned long long)object_id,
        submitted ? "true" : "false", completed ? "true" : "false", destroyed ? "true" : "false");
}

static void serve(SOCKET socket) {
    char data[40000];
    unsigned total = 0, header_bytes = 0, body_length = 0;
    while (total < 8192) {
        int got = recv(socket, data + total, (int)(8192 - total), 0);
        if (got <= 0) return;
        total += (unsigned)got;
        data[total] = 0;
        char *end = strstr(data, "\r\n\r\n");
        if (end) { header_bytes = (unsigned)(end - data) + 4; break; }
    }
    if (!header_bytes) return;

    char headers[8193];
    memcpy(headers, data, header_bytes);
    headers[header_bytes] = 0;

    int auth_count = 0, has_origin = 0, invalid = 0;
    char expected[80];
    snprintf(expected, sizeof(expected), "Bearer %s", config.token);

    char *line = strstr(headers, "\r\n");
    while (line && line[2] != '\r') {
        line += 2;
        char *end = strstr(line, "\r\n");
        if (!end) break;
        *end = 0;
        if (!_strnicmp(line, "Authorization:", 14)) {
            char *value = line + 14;
            while (*value == ' ') value++;
            if (auth_count || strcmp(value, expected)) invalid = 1;
            auth_count++;
        }
        if (!_strnicmp(line, "Origin:", 7)) has_origin = 1;
        if (!_strnicmp(line, "Transfer-Encoding:", 18)) invalid = 1;
        if (!_strnicmp(line, "Content-Length:", 15)) {
            char *value = line + 15, *last;
            while (*value == ' ') value++;
            unsigned long parsed = strtoul(value, &last, 10);
            if (body_length || last == value || *last || parsed > WM_MAX_PACKET + 44) invalid = 1;
            body_length = (unsigned)parsed;
        }
        *end = '\r';
        line = end;
    }
    if (auth_count != 1 || has_origin || invalid) { reply(socket, 403, "{\"error\":\"denied\"}"); return; }

    char out[900];
    if (!strncmp(data, "GET /health", 11)) {
        snprintf(out, sizeof(out),
            "{\"integration\":\"wechatwb-moments-1\",\"version\":\"%s\",\"pid\":%lu,"
            "\"accountDirectory\":\"%s\",\"offlineTest\":%s,\"verified\":%s,\"limit\":1,"
            "\"attempts\":%ld,\"constantsReady\":%s,\"images\":false,\"video\":false}",
            WM_WECHAT_VERSION, GetCurrentProcessId(), config.account, offline_flag,
            (exact_build() && account_verified()) ? "true" : "false", admitted,
            WM_READY() ? "true" : "false");
        reply(socket, 200, out);
        return;
    }
    if (!strncmp(data, "GET /result", 11)) { result_json(out, sizeof(out)); reply(socket, 200, out); return; }
    if (!strncmp(data, "GET /object", 11)) {
        if (!response_size) { reply(socket, 200, "{\"protobufHex\":\"\"}"); return; }
        static char hex[70000];
        unsigned at = 0;
        for (unsigned i = 0; i < response_size && at + 3 < sizeof(hex); i++)
            at += (unsigned)sprintf(hex + at, "%02x", response_bytes[i]);
        hex[at] = 0;
        char *body = (char *)malloc(at + 32);
        if (!body) { reply(socket, 500, "{\"error\":\"oom\"}"); return; }
        sprintf(body, "{\"protobufHex\":\"%s\"}", hex);
        reply(socket, 200, body);
        free(body);
        return;
    }
    if (!strncmp(data, "POST /submit", 12)) {
        if (header_bytes + body_length > total) {
            while (total < header_bytes + body_length) {
                int got = recv(socket, data + total, (int)(header_bytes + body_length - total), 0);
                if (got <= 0) break;
                total += (unsigned)got;
            }
        }
        if (!body_length || header_bytes + body_length > total) { reply(socket, 400, "{\"error\":\"truncated\"}"); return; }
        unsigned char *body = (unsigned char *)data + header_bytes;
        if (!validate_request(body, body_length)) { reply(socket, 400, "{\"error\":\"bad-packet\"}"); return; }
        if (InterlockedCompareExchange(&admitted, 1, 0)) {
            reply(socket, 409, "{\"error\":\"already-attempted-do-not-retry\"}");
            return;
        }
        char hash[65];
        if (!sha256_hex(body, body_length, hash) || strcmp(hash, config.approved_hash) != 0) {
            InterlockedExchange(&admitted, 0);
            reply(socket, 403, "{\"error\":\"content-not-approved\"}");
            return;
        }
        const Request *request = (const Request *)body;
        memcpy(request_id, request->id, 36);
        request_id[36] = 0;
        submit_native(request);
        DWORD until = GetTickCount() + 8000;
        while (submitted && (!received || !completed || !destroyed) && (LONG)(until - GetTickCount()) > 0) Sleep(20);
        result_json(out, sizeof(out));
        reply(socket, 200, out);
        return;
    }
    reply(socket, 404, "{\"error\":\"not-found\"}");
}

static DWORD WINAPI server_thread(void *unused) {
    (void)unused;
    WSADATA winsock;
    if (WSAStartup(MAKEWORD(2, 2), &winsock)) return 1;
    listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    BOOL exclusive = TRUE;
    setsockopt(listener, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, (const char *)&exclusive, sizeof(exclusive));
    struct sockaddr_in address;
    memset(&address, 0, sizeof(address));
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    address.sin_port = htons((u_short)config.port);
    if (bind(listener, (struct sockaddr *)&address, sizeof(address)) || listen(listener, 2)) {
        closesocket(listener);
        listener = INVALID_SOCKET;
        return 2;
    }
    while (running) {
        SOCKET client = accept(listener, NULL, NULL);
        if (client == INVALID_SOCKET) break;
        DWORD timeout = 10000;
        setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, (const char *)&timeout, sizeof(timeout));
        serve(client);
        closesocket(client);
    }
    WSACleanup();
    return 0;
}

__declspec(dllexport) DWORD WINAPI WeChatMomentsStart(void *data) {
    if (running || !data) return 1;
    StartConfig *incoming = (StartConfig *)data;
    if (incoming->magic != 0x324D5857 /* 'WXM2' */ || incoming->bytes != sizeof(StartConfig) ||
        incoming->pid != GetCurrentProcessId() || incoming->port < 1024 || incoming->port > 65535 ||
        strnlen(incoming->token, 65) != 64 || strnlen(incoming->approved_hash, 65) != 64) return 2;
    config = *incoming;
    if (!exact_build() || !account_verified()) return 3;
    HMODULE pin;
    GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
                       (LPCWSTR)WeChatMomentsStart, &pin);
    running = 1;
    HANDLE thread = CreateThread(NULL, 0, server_thread, NULL, 0, NULL);
    if (!thread) { running = 0; return 4; }
    CloseHandle(thread);
    return 0;
}

__declspec(dllexport) DWORD WINAPI WeChatMomentsStop(void *unused) {
    (void)unused;
    running = 0;
    if (listener != INVALID_SOCKET) { shutdown(listener, SD_BOTH); closesocket(listener); listener = INVALID_SOCKET; }
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE module, DWORD reason, LPVOID reserved) {
    (void)module; (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) DisableThreadLibraryCalls(module);
    return TRUE;
}
