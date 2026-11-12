// 朋友圈原生投递组件 · 微信 4.1.10.27（wechatwb 内置核心）
// 复刻 waaakong/xiaoyu 的 moments-native 思路：自建 SNS CGI 任务对象 → 填报文 → 交给微信自己的网络管理器派发。
// 不 patch 客户端代码、不做 UI 兜底、一次进程只发一条。
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "bcrypt.lib")
#include <bcrypt.h>

/* 运行期解析系统临时目录，不把任何机器上的用户路径写进源码 */
static const wchar_t *temp_file(const wchar_t *name) {
    static wchar_t paths[4][MAX_PATH + 64];
    static int slot;
    wchar_t dir[MAX_PATH];
    if (!GetTempPathW(MAX_PATH, dir)) return name;
    slot = (slot + 1) % 4;
    _snwprintf_s(paths[slot], MAX_PATH + 64, _TRUNCATE, L"%s%s", dir, name);
    return paths[slot];
}

/* ---- 已定位常量（RVA，ImageBase 0x180000000，ImageSize 0xaf0e000） ---- */
#define IMAGE_SIZE          0xaf0e000u
#define RVA_POST_VTABLE     0x8b5d768u   /* slot0/1/2/3/4/5 */
#define RVA_POST_CTOR       0x4eb3c50u   /* (this, info) */
#define RVA_POST_INFO       0x8b5d2f0u   /* 16B 模板，首字节 0xD1 */
#define RVA_ALLOCATE        0x680d0fcu   /* operator new */
#define RVA_FREE            0x680d140u   /* operator delete */
#define RVA_PROTO_PARSE     0x5d9f00u    /* MessageLite::ParseFromString(msg, std::string*) */
#define TASK_SIZE           0x2b8u
#define REQ_OFFSET          0xf0u
#define RVA_ROOT_GLOBAL     0xa83ab20u   /* 数据段里指向 root 的槽 */
#define RVA_ROOT_VTABLE     0x81b1c18u
#define RVA_MANAGER_VTABLE  0x82214f8u
#define RVA_DISPATCH        0x304f80u    /* manager vtable[5] */
#define RVA_HOLDER_DATA     0x5da7a0u    /* holder->data(this, 0) */
#define RVA_HOLDER_SIZE     0x5da7d0u    /* holder->size(this) */
#define BUILD_TAG           "r8"
#define ENDPOINT            "/cgi-bin/micromsg-bin/mmsnspost"
#define CGI_ID              209
#define PORT_BASE           32000
#define PORT_SPAN           10
#define PORT_FILE           temp_file(L"wb-moments-port.txt")
#define CONFIG_FILE         temp_file(L"wb-moments-token.txt")
#define SELFTEST_FILE       temp_file(L"wb-moments-selftest.json")

static char g_expect[160];    /* 期望 wxid（加载器写下的第三行），空=不校验 */
static int mem_ok(const void *p, size_t n);

/* 每次请求都读配置：LoadLibraryW 对已加载模块不会再触发 DllMain，
   靠“启动时读一次”没法换令牌，只能让服务端自己每次读。 */
static int read_config(char *token, size_t tcap, char *approved, size_t acap) {
    FILE *f = NULL;
    token[0] = 0;
    approved[0] = 0;
    _wfopen_s(&f, CONFIG_FILE, L"rb");
    if (!f) return 0;
    if (!fgets(token, (int)tcap, f)) { fclose(f); return 0; }
    token[strcspn(token, "\r\n")] = 0;
    if (fgets(approved, (int)acap, f)) approved[strcspn(approved, "\r\n")] = 0;
    g_expect[0] = 0;
    if (fgets(g_expect, sizeof(g_expect), f)) g_expect[strcspn(g_expect, "\r\n")] = 0;
    fclose(f);
    return (int)strlen(token);
}
static unsigned char *g_core;
static char g_token[160];
static char g_approved[65];
static char g_reqid[37];   /* 加载器写下的“本次授权正文”的 sha256；空=不校验 */
static volatile LONG g_running, g_sent, g_parse_only;
static SOCKET g_listener = INVALID_SOCKET;
/* 任务完成回调：网络层回来时会无条件调用 task+0xd0 指向的 std::function（对象在 task+0x98）。
   不装就是空指针调用 —— 这就是上次投递后闪退的原因。 */
static volatile LONG g_completed, g_destroyed, g_has_ret, g_onresp;
static unsigned g_last_size;
static void *g_last_holder;
static int g_ret;
static unsigned long long g_objid;
static unsigned char *g_resp;
static unsigned g_resp_len;
static void *g_task;
static uintptr_t g_orig[6], g_owned[6], g_completion[6];

static void *completion_copy(void *self, void *where) { (void)self; *(uintptr_t **)where = g_completion; return where; }
static unsigned char completion_call(void *self, void **value, int *transport, int *cgi) {
    (void)self; (void)transport; (void)cgi;
    if (!value || *value != g_task) return 0;
    InterlockedExchange(&g_completed, 1);
    return 1;           /* 返回 true：任务销毁交回真实管理器 */
}
static int varint(const unsigned char *s, unsigned n, unsigned *at, unsigned long long *v) {
    *v = 0;
    for (unsigned i = 0; i < 10 && *at < n; i++) {
        unsigned c = s[(*at)++];
        if (i == 9 && c > 1) return 0;
        *v |= (unsigned long long)(c & 127) << (7 * i);
        if (!(c & 128)) return 1;
    }
    return 0;
}

/* SnsPostResponse：1 = BaseResponse{1: ret}，2 = SnsObject{1: objectId} */
static void parse_resp(const unsigned char *s, unsigned n) {
    unsigned at = 0;
    while (at < n) {
        unsigned long long tag;
        if (!varint(s, n, &at, &tag)) return;
        unsigned key = (unsigned)(tag >> 3), wire = (unsigned)(tag & 7);
        if (wire == 0) { unsigned long long v; if (!varint(s, n, &at, &v)) return; continue; }
        if (wire == 2) {
            unsigned long long len;
            if (!varint(s, n, &at, &len) || len > n - at) return;
            if (key == 1 || key == 2) {
                const unsigned char *sub = s + at;
                unsigned sn = (unsigned)len, a2 = 0;
                while (a2 < sn) {
                    unsigned long long t2;
                    if (!varint(sub, sn, &a2, &t2)) break;
                    unsigned k2 = (unsigned)(t2 >> 3), w2 = (unsigned)(t2 & 7);
                    if (w2 == 0) {
                        unsigned long long v;
                        if (!varint(sub, sn, &a2, &v)) break;
                        if (k2 == 1) { if (key == 1) { g_ret = (int)v; g_has_ret = 1; } else g_objid = v; }
                    } else if (w2 == 2) {
                        unsigned long long l2;
                        if (!varint(sub, sn, &a2, &l2) || l2 > sn - a2) break;
                        a2 += (unsigned)l2;
                    } else if (w2 == 1) { if (a2 + 8 > sn) break; a2 += 8; }
                    else if (w2 == 5) { if (a2 + 4 > sn) break; a2 += 4; }
                    else break;
                }
            }
            at += (unsigned)len;
            continue;
        }
        if (wire == 1) { if (at + 8 > n) return; at += 8; }
        else if (wire == 5) { if (at + 4 > n) return; at += 4; }
        else return;
    }
}

static int sha256_hex(const unsigned char *data, unsigned len, char out[65]) {
    BCRYPT_ALG_HANDLE alg = NULL;
    unsigned char hash[32];
    if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, NULL, 0)) return 0;
    NTSTATUS st = BCryptHash(alg, NULL, 0, (PUCHAR)data, len, hash, 32);
    BCryptCloseAlgorithmProvider(alg, 0);
    if (st) return 0;
    for (int i = 0; i < 32; i++) sprintf(out + i * 2, "%02x", hash[i]);
    out[64] = 0;
    return 1;
}

/* 从报文里取出 <username>；找到返回 1。给护栏和 /probe 共用。 */
static int packet_account_find(const unsigned char *p, unsigned n, char *out, size_t cap) {
    static const char tag[] = "<username>";
    const unsigned tl = sizeof(tag) - 1;
    out[0] = 0;
    for (unsigned i = 0; i + tl + 1 < n; i++) {
        if (memcmp(p + i, tag, tl)) continue;
        unsigned j = i + tl, k = 0;
        while (j < n && p[j] != '<' && k < cap - 1) out[k++] = (char)p[j++];
        out[k] = 0;
        return 1;
    }
    return 0;
}

/* 报文里的 <username> 必须等于当前登录号，否则服务端会回 201「发送失败」。 */
static int packet_account_ok(const unsigned char *p, unsigned n, const char *expect) {
    char got[160];
    if (!packet_account_find(p, n, got, sizeof(got))) return 0;
    return strcmp(got, expect) == 0;
}

static int on_response(void *task, void *holder) {
    InterlockedIncrement(&g_onresp);
    g_last_holder = holder;
    int ok = ((unsigned char (*)(void *, void *))g_orig[2])(task, holder);
    if (task == g_task && holder) {
        unsigned size = ((unsigned (*)(void *))(g_core + RVA_HOLDER_SIZE))(holder);
        const void *data = ((void *(*)(void *, int))(g_core + RVA_HOLDER_DATA))(holder, 0);
        g_last_size = size;
        if (size && size <= 65536 && mem_ok(data, size)) {
            unsigned char *copy = (unsigned char *)HeapAlloc(GetProcessHeap(), 0, size);
            if (copy) {
                memcpy(copy, data, size);
                if (g_resp) HeapFree(GetProcessHeap(), 0, g_resp);
                g_resp = copy;
                g_resp_len = size;
                parse_resp(g_resp, g_resp_len);
                InterlockedExchange(&g_completed, 1);
            }
        }
    }
    return ok;
}

static void *completion_type(void *self) { (void)self; return NULL; }
static void completion_delete(void *self, unsigned char dealloc) { (void)self; (void)dealloc; }
static void install_completion(void *m) {
    g_completion[0] = (uintptr_t)completion_copy;
    g_completion[1] = (uintptr_t)completion_copy;
    g_completion[2] = (uintptr_t)completion_call;
    g_completion[3] = (uintptr_t)completion_type;
    g_completion[4] = (uintptr_t)completion_delete;
    g_completion[5] = (uintptr_t)completion_type;
    *(uintptr_t **)((char *)m + 0x98) = g_completion;
    *(void **)((char *)m + 0xd0) = (char *)m + 0x98;
}
static void *on_destroy(void *p, unsigned flags) {
    InterlockedExchange(&g_destroyed, 1);
    return ((void *(*)(void *, unsigned))g_orig[0])(p, flags);
}

static int mem_ok(const void *p, size_t n) {
    MEMORY_BASIC_INFORMATION m;
    uintptr_t a = (uintptr_t)p;
    if (!p || !n || !VirtualQuery(p, &m, sizeof(m))) return 0;
    if (m.State != MEM_COMMIT || (m.Protect & (PAGE_NOACCESS | PAGE_GUARD))) return 0;
    return a >= (uintptr_t)m.BaseAddress && n <= (uintptr_t)m.BaseAddress + m.RegionSize - a;
}

static int exact_build(void) {
    g_core = (unsigned char *)GetModuleHandleW(L"Weixin.dll");
    if (!g_core) return 0;
    const IMAGE_DOS_HEADER *dos = (const IMAGE_DOS_HEADER *)g_core;
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) return 0;
    const IMAGE_NT_HEADERS64 *nt = (const IMAGE_NT_HEADERS64 *)(g_core + dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE || nt->FileHeader.Machine != IMAGE_FILE_MACHINE_AMD64) return 0;
    if (nt->OptionalHeader.SizeOfImage != IMAGE_SIZE) return 0;
    /* SNS 任务虚表逐项校验：错一项就说明这不是 4.1.10.27 */
    const uintptr_t *t = (const uintptr_t *)(g_core + RVA_POST_VTABLE);
    static const uint32_t want[6] = {0x4eb3f80u, 0x4eb3e50u, 0x4eb3f40u, 0x103f30u, 0x3993a90u, 1u};
    if (!mem_ok(t, 48)) return 0;
    for (int i = 0; i < 6; i++) {
        uintptr_t v = i == 5 ? t[5] : t[i] - (uintptr_t)g_core;
        if (v != want[i]) return 0;
    }
    return 1;
}

/* root → +0x2c8 → manager；三者都必须是可读对象且虚表对得上 */
static void *manager(void) {
    void *root = *(void **)(g_core + RVA_ROOT_GLOBAL);
    if (!mem_ok(root, 0x2d0)) return NULL;
    if (*(uintptr_t *)root != (uintptr_t)g_core + RVA_ROOT_VTABLE) return NULL;
    void *m = *(void **)((char *)root + 0x2c8);
    if (!mem_ok(m, 0x40)) return NULL;
    const uintptr_t *vt = *(const uintptr_t **)m;
    if ((uintptr_t)vt != (uintptr_t)g_core + RVA_MANAGER_VTABLE) return NULL;
    if (vt[5] != (uintptr_t)g_core + RVA_DISPATCH) return NULL;
    return m;
}

/* 建任务 → 填报文 → 派发。返回 1 表示已交给网络层（不等于服务端已受理）。 */
static int submit(const unsigned char *packet, unsigned len) {
    if (!exact_build()) return -1;
    void *m = manager();
    if (!m) return -2;
    if (len > 32000) return -3;
    /* 报文头：魔数 XYM1 + 36 字节请求标识 + protobuf 长度；解析只吃后面的 protobuf */
    if (len >= 44) {
        uint32_t magic = *(const uint32_t *)packet;
        uint32_t body = *(const uint32_t *)(packet + 40);
        if (magic != 0x314d5958u || body != len - 44) return -3;
        memcpy(g_reqid, packet + 4, 36);
        g_reqid[36] = 0;
        packet += 44;
        len -= 44;
    }

    unsigned char info[0x40];
    memcpy(info, g_core + RVA_POST_INFO, 16);
    *(uint32_t *)(info + 0x10) = CGI_ID;
    *(uint32_t *)(info + 0x14) = 0;
    *(void **)(info + 0x18) = (void *)ENDPOINT;
    *(uint64_t *)(info + 0x20) = 0;
    *(uint64_t *)(info + 0x28) = sizeof(ENDPOINT) - 1;
    *(uint64_t *)(info + 0x30) = sizeof(ENDPOINT) - 1;
    info[0x38] = 1;

    void *task = ((void *(*)(size_t))(g_core + RVA_ALLOCATE))(TASK_SIZE);
    if (!task) return -4;
    ((void (*)(void *, void *))(g_core + RVA_POST_CTOR))(task, info);

    const uintptr_t *vt = *(const uintptr_t **)task;
    if ((uintptr_t)vt != (uintptr_t)g_core + RVA_POST_VTABLE || vt[5] != 1) {
        ((void (*)(void *, unsigned))(g_core + RVA_FREE))(task, 0);
        return -5;
    }
    /* MSVC std::string：+0 指针 / +0x10 长度 / +0x18 容量（>=16 时走堆） */
    struct { const void *ptr; uint64_t pad; uint64_t size; uint64_t cap; } text;
    text.ptr = packet;
    text.pad = 0;
    text.size = len;
    text.cap = len;
    if (!((unsigned char (*)(void *, void *))(g_core + RVA_PROTO_PARSE))((char *)task + REQ_OFFSET, &text)) {
        ((void (*)(void *, void *))vt[0])(task, (void *)1);
        return -6;
    }
    if (!len) { ((void (*)(void *, void *))vt[0])(task, (void *)1); return 7; } /* 7=空报文解析成功 */
    if (g_parse_only) { ((void (*)(void *, void *))vt[0])(task, (void *)1); return 8; } /* 8=解析成功但未派发 */
    /* 每次投递前清空上一次的回执：组件常驻同一进程，
       不清就会把上一条的 ret / objectId 当成这一条的结果返回（实测踩过）。 */
    InterlockedExchange(&g_completed, 0);
    InterlockedExchange(&g_destroyed, 0);
    InterlockedExchange(&g_has_ret, 0);
    InterlockedExchange(&g_onresp, 0);
    g_ret = 0;
    g_objid = 0;
    g_last_size = 0;
    if (g_resp) { HeapFree(GetProcessHeap(), 0, g_resp); g_resp = NULL; }
    g_resp_len = 0;

    /* 装上完成回调 + 析构钩子，再派发 */
    memcpy(g_orig, vt, 48);
    memcpy(g_owned, g_orig, 48);
    g_owned[0] = (uintptr_t)on_destroy;
    g_owned[2] = (uintptr_t)on_response;
    g_task = task;
    *(uintptr_t **)task = g_owned;
    install_completion(task);
    ((void (*)(void *, void *))(g_core + RVA_DISPATCH))(m, task);
    return 1;
}

static void reply(SOCKET s, int code, const char *body) {
    char head[256];
    int n = snprintf(head, sizeof(head),
                     "HTTP/1.1 %d X\r\nContent-Type: application/json\r\nCache-Control: no-store\r\n"
                     "Connection: close\r\nContent-Length: %u\r\n\r\n", code, (unsigned)strlen(body));
    send(s, head, n, 0);
    send(s, body, (int)strlen(body), 0);
}

static void serve(SOCKET s) {
    char buf[40000];
    int n = 0, head = 0, cl = 0, auth = 0;
    while (n < 8192) {
        int k = recv(s, buf + n, 8192 - n, 0);
        if (k <= 0) return;
        n += k;
        buf[n] = 0;
        char *end = strstr(buf, "\r\n\r\n");
        if (end) { head = (int)(end - buf) + 4; break; }
    }
    if (!head) return;
    g_parse_only = 0;
    char token[160], approved[80];
    if (!read_config(token, sizeof(token), approved, sizeof(approved))) { reply(s, 503, "{\"error\":\"no-config\"}"); return; }
    if (strcmp(approved, g_approved)) {          /* 换了一包：放开单条闸门 */
        strncpy(g_approved, approved, sizeof(g_approved) - 1);
        g_approved[sizeof(g_approved) - 1] = 0;
        InterlockedExchange(&g_sent, 0);
    }
    char expect[80];
    snprintf(expect, sizeof(expect), "Bearer %s", token);
    char *line = strstr(buf, "\r\n");
    while (line && line[2] != '\r') {
        line += 2;
        char *end = strstr(line, "\r\n");
        if (!end) break;
        *end = 0;
        if (!_strnicmp(line, "Authorization:", 14)) {
            char *v = line + 14;
            while (*v == ' ') v++;
            if (!strcmp(v, expect)) auth = 1;
        }
        if (!_strnicmp(line, "X-Parse-Only:", 13)) g_parse_only = 1;
        if (!_strnicmp(line, "Content-Length:", 15)) cl = atoi(line + 15);
        *end = '\r';
        line = end;
    }
    if (!auth) { reply(s, 403, "{\"error\":\"denied\"}"); return; }
    if (!strncmp(buf, "GET /resp", 9)) {
        if (!g_resp_len) { reply(s, 409, "{\"error\":\"no-response\"}"); return; }
        char *body = (char *)HeapAlloc(GetProcessHeap(), 0, g_resp_len * 2 + 24);
        if (!body) { reply(s, 500, "{\"error\":\"oom\"}"); return; }
        strcpy(body, "{\"hex\":\"");
        unsigned off = (unsigned)strlen(body);
        for (unsigned i = 0; i < g_resp_len; i++) sprintf(body + off + i * 2, "%02x", g_resp[i]);
        strcat(body, "\"}");
        reply(s, 200, body);
        HeapFree(GetProcessHeap(), 0, body);
        return;
    }
    if (!strncmp(buf, "GET /health", 11)) {
        char out[560];
        snprintf(out, sizeof(out),
                 "{\"integration\":\"XiaoyuMoments-1\",\"buildTag\":\"%s\",\"pid\":%lu,\"build\":%s,\"manager\":%s,\"sent\":%ld,"
                 "\"offlineTest\":false,\"verified\":%s,\"limit\":1,\"images\":false,\"video\":false,"
                 "\"expect\":\"%s\",\"approved\":\"%.8s\",\"guard\":%s,"
                 "\"onresp\":%ld,\"lastSize\":%u,\"respBytes\":%u,\"completed\":%s,\"destroyed\":%s,\"hasRet\":%s,\"ret\":%d,\"objid\":\"%llu\"}",
                 BUILD_TAG, (unsigned long)GetCurrentProcessId(), exact_build() ? "true" : "false",
                 (exact_build() && manager()) ? "true" : "false", g_sent,
                 (exact_build() && manager()) ? "true" : "false",
                 g_expect, g_approved, g_expect[0] ? "true" : "false",
                 g_onresp, g_last_size, g_resp_len,
                 g_completed ? "true" : "false", g_destroyed ? "true" : "false",
                 g_has_ret ? "true" : "false", g_ret, g_objid);
        reply(s, 200, out);
        return;
    }
    if (!strncmp(buf, "POST /probe", 11)) {   /* 诊断：只解析报文里的账号，绝不投递 */
        char found[160];
        int has = packet_account_find((const unsigned char *)buf + head, (unsigned)cl, found, sizeof(found));
        char out[420];
        snprintf(out, sizeof(out),
                 "{\"buildTag\":\"%s\",\"expect\":\"%s\",\"found\":\"%s\",\"hasUsername\":%s,\"match\":%s}",
                 BUILD_TAG, g_expect, found, has ? "true" : "false",
                 (has && g_expect[0] && !strcmp(found, g_expect)) ? "true" : "false");
        reply(s, 200, out);
        return;
    }
    if (strncmp(buf, "POST /submit", 12)) { reply(s, 404, "{\"error\":\"route\"}"); return; }
    if (cl > 32000 || head + cl >= (int)sizeof(buf)) { reply(s, 400, "{\"error\":\"size\"}"); return; }
    if (cl == 0) { /* 诊断：空报文解析，验证解析函数与消息对象本身 */ 
        int r = submit(NULL, 0);
        char out[96]; snprintf(out, sizeof(out), "{\"emptyParse\":%d}", r);
        reply(s, 200, out); return;
    }
    if (cl < 44) { reply(s, 400, "{\"error\":\"size\"}"); return; }
    while (n < head + cl) {
        int k = recv(s, buf + n, head + cl - n, 0);
        if (k <= 0) return;
        n += k;
    }
    if (g_approved[0]) {   /* 一包一授权：只放行加载器哈希过的那一包 */
        char digest[65];
        if (!sha256_hex((const unsigned char *)buf + head, (unsigned)cl, digest) || strcmp(digest, g_approved)) {
            reply(s, 403, "{\"error\":\"unapproved-content\"}");
            return;
        }
    }
    if (g_expect[0] && !packet_account_ok((const unsigned char *)buf + head, (unsigned)cl, g_expect)) {
        reply(s, 403, "{\"error\":\"account-mismatch\"}");
        return;
    }
    if (InterlockedCompareExchange(&g_sent, 1, 0)) {
        reply(s, 409, "{\"error\":\"already-attempted-do-not-retry\"}");
        return;
    }
    int r = submit((const unsigned char *)buf + head, (unsigned)cl);
    if (r != 1) InterlockedExchange(&g_sent, 0); /* 未提交成功就放开，允许再试；已提交则永久锁定 */
    char out[160];
    if (r == 1) {   /* 等完成回调，最多 8 秒；回执没接，只能说“任务已完成/已释放” */
        DWORD until = GetTickCount() + 8000;
        while ((LONG)(until - GetTickCount()) > 0 && (!g_completed || !g_destroyed)) Sleep(20);
        if (g_has_ret) {
            snprintf(out, sizeof(out), "{\"id\":\"%s\",\"state\":\"%s\",\"ret\":%d,\"objectId\":\"%llu\",\"completed\":%s,\"destroyed\":%s}",
                     g_reqid, (g_ret == 0 && g_objid) ? "server-accepted" : "server-rejected", g_ret, g_objid,
                     g_completed ? "true" : "false", g_destroyed ? "true" : "false");
        } else {
            snprintf(out, sizeof(out), "{\"id\":\"%s\",\"state\":\"submitted\",\"completed\":%s,\"destroyed\":%s,\"respBytes\":%u}",
                     g_reqid, g_completed ? "true" : "false", g_destroyed ? "true" : "false", g_resp_len);
        }
    } else {
        snprintf(out, sizeof(out), "{\"state\":\"%s\",\"code\":%d}",
                 r == -1 ? "build-mismatch" : r == -2 ? "no-manager" : "not-submitted", r);
    }
    reply(s, 200, out);
}

static DWORD WINAPI server(void *unused) {
    (void)unused;
    WSADATA w;
    if (WSAStartup(MAKEWORD(2, 2), &w)) return 1;
    /* 端口不写死：老实例可能还占着上一个端口，这里从 PORT_BASE 往上找一个空的，
       把实际端口写进 PORT_FILE，加载器读它就知道该跟谁说话（不用再逐版本换端口）。 */
    SOCKET l = INVALID_SOCKET;
    int bound = 0;
    for (int p = PORT_BASE; p < PORT_BASE + PORT_SPAN; p++) {
        SOCKET cand = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
        if (cand == INVALID_SOCKET) continue;
        BOOL ex = TRUE;
        setsockopt(cand, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, (const char *)&ex, sizeof(ex));
        struct sockaddr_in a = {0};
        a.sin_family = AF_INET;
        a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        a.sin_port = htons((unsigned short)p);
        if (bind(cand, (struct sockaddr *)&a, sizeof(a)) == 0 && listen(cand, 4) == 0) { l = cand; bound = p; break; }
        closesocket(cand);
    }
    if (!bound) return 2;
    g_listener = l;
    {
        FILE *pf = NULL;
        _wfopen_s(&pf, PORT_FILE, L"wb");
        if (pf) { fprintf(pf, "%d\n", bound); fclose(pf); }
    }
    while (g_running) {
        SOCKET s = accept(l, NULL, NULL);
        if (s == INVALID_SOCKET) break;
        DWORD t = 15000;
        setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, (const char *)&t, sizeof(t));
        serve(s);
        closesocket(s);
    }
    g_listener = INVALID_SOCKET;
    closesocket(l);
    WSACleanup();
    return 0;
}

/* 只读自检：不派发、不发请求。结果写文件，便于注入端读取。 */
__declspec(dllexport) DWORD WINAPI WbMomentsSelfTest(void *unused) {
    (void)unused;
    FILE *f = NULL;
    _wfopen_s(&f, SELFTEST_FILE, L"wb");
    if (!f) return 1;
    int build = exact_build(), mgr = build ? (manager() != NULL) : 0;
    fprintf(f, "{\"build\":%s,\"manager\":%s,\"base\":\"0x%llx\"", build ? "true" : "false",
            mgr ? "true" : "false", (unsigned long long)(uintptr_t)g_core);
    if (build) {
        const uintptr_t *t = (const uintptr_t *)(g_core + RVA_POST_VTABLE);
        fprintf(f, ",\"slots\":[\"0x%llx\",\"0x%llx\",\"0x%llx\",\"0x%llx\",\"0x%llx\",\"%llu\"]",
                (unsigned long long)(t[0] - (uintptr_t)g_core), (unsigned long long)(t[1] - (uintptr_t)g_core),
                (unsigned long long)(t[2] - (uintptr_t)g_core), (unsigned long long)(t[3] - (uintptr_t)g_core),
                (unsigned long long)(t[4] - (uintptr_t)g_core), (unsigned long long)t[5]);
    }
    fprintf(f, "}");
    fclose(f);
    return 0;
}

__declspec(dllexport) DWORD WINAPI WbMomentsStart(void *unused) {
    (void)unused;
    if (g_running) {          /* 已经在跑：不重开监听，只换令牌与授权哈希，并把单条闸门放开 */
        FILE *rf = NULL;
        _wfopen_s(&rf, CONFIG_FILE, L"rb");
        if (!rf) return 2;
        if (!fgets(g_token, sizeof(g_token), rf)) { fclose(rf); return 3; }
        g_token[strcspn(g_token, "\r\n")] = 0;
        g_approved[0] = 0;
        if (fgets(g_approved, sizeof(g_approved), rf)) g_approved[strcspn(g_approved, "\r\n")] = 0;
        fclose(rf);
        InterlockedExchange(&g_sent, 0);
        return 0;
    }
    FILE *f = NULL;
    _wfopen_s(&f, CONFIG_FILE, L"rb");
    if (!f) return 2;
    if (!fgets(g_token, sizeof(g_token), f)) { fclose(f); return 3; }
    fclose(f);
    g_token[strcspn(g_token, "\r\n")] = 0;
    if (fgets(g_approved, sizeof(g_approved), f)) g_approved[strcspn(g_approved, "\r\n")] = 0;
    if (strlen(g_token) < 16) return 4;
    if (!exact_build() || !manager()) return 5;
    HMODULE pin;
    GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
                       (LPCWSTR)WbMomentsStart, &pin);
    g_running = 1;
    HANDLE h = CreateThread(NULL, 0, server, NULL, 0, NULL);
    if (!h) { g_running = 0; return 6; }
    CloseHandle(h);
    return 0;
}

static DWORD WINAPI boot(void *unused) {
    (void)unused;
    WbMomentsStart(NULL);      /* 读配置（令牌+授权哈希），起本地服务 */
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE module, DWORD reason, LPVOID unused) {
    (void)unused;
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(module);
        /* 自启动：注入端只需要 LoadLibraryW，不用再远程调导出，
           少一层跨进程调用，注入器可以做得极简。 */
        HANDLE t = CreateThread(NULL, 0, boot, NULL, 0, NULL);
        if (t) CloseHandle(t);
    }
    return TRUE;
}
