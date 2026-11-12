// WeChat 朋友圈原生链路离线探针：只观测，不修改微信逻辑、不发送任何请求。
// 注入 Weixin.exe 后按配置对指定 RVA 安装 MinHook，记录参数/对象 vtable/调用栈。
#define WIN32_LEAN_AND_MEAN
#define _CRT_SECURE_NO_WARNINGS
#include <windows.h>
#include <psapi.h>
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include "MinHook.h"

#pragma comment(lib, "psapi.lib")

#define MAX_HOOKS 8
#define LOG_MAX  (4 * 1024 * 1024)

static HMODULE g_exe;
static uintptr_t g_base;
static ULONG_PTR g_size;
static SRWLOCK g_lock = SRWLOCK_INIT;
static char *g_log;
static size_t g_logLen;
static wchar_t g_logPath[MAX_PATH];

typedef void *(*Fn4)(void *, void *, void *, void *);
typedef void (*FnVoid)(void);

static void *g_target[MAX_HOOKS];
static void *g_tramp[MAX_HOOKS];
static int g_hookCount;

static int InImage(uintptr_t p) {
    return p >= g_base && p < g_base + g_size;
}

static int InRange(uintptr_t p, uintptr_t lo, uintptr_t hi) {
    return p >= lo && p < hi;
}

static void LogRaw(const char *s, int n) {
    AcquireSRWLockExclusive(&g_lock);
    if (g_log && g_logLen + n < LOG_MAX) {
        memcpy(g_log + g_logLen, s, n);
        g_logLen += n;
        g_log[g_logLen] = 0;
    }
    ReleaseSRWLockExclusive(&g_lock);
}

static void Logf(const char *fmt, ...) {
    char buf[2048];
    va_list ap;
    va_start(ap, fmt);
    int n = _vsnprintf_s(buf, sizeof(buf) - 2, _TRUNCATE, fmt, ap);
    va_end(ap);
    if (n <= 0) return;
    buf[n++] = '\n';
    buf[n] = 0;
    LogRaw(buf, n);
}

static void FlushLog(void) {
    if (!g_log || !g_logPath[0]) return;
    // 必须在锁内完成"取长度 + 归零"，否则多线程会读到半截缓冲区并越界（曾导致 WeChat 0xC0000409）
    AcquireSRWLockExclusive(&g_lock);
    size_t n = g_logLen;
    g_logLen = 0;
    if (g_log) g_log[0] = 0;
    ReleaseSRWLockExclusive(&g_lock);
    if (!n) return;
    HANDLE h = CreateFileW(g_logPath, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL,
                           OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return;
    DWORD wrote = 0;
    size_t off = 0;
    while (off < n) {
        DWORD chunk = (DWORD)((n - off) > 0x10000 ? 0x10000 : (n - off));
        if (!WriteFile(h, g_log + off, chunk, &wrote, NULL) || !wrote) break;
        off += wrote;
    }
    CloseHandle(h);
}

static void HexDump(const char *tag, const unsigned char *p, int n) {
    char line[200];
    for (int i = 0; i < n; i += 16) {
        int off = _snprintf_s(line, sizeof(line), _TRUNCATE, "%s+%03x ", tag, i);
        for (int j = 0; j < 16 && i + j < n; j++)
            off += _snprintf_s(line + off, sizeof(line) - off, _TRUNCATE, "%02x", p[i + j]);
        LogRaw(line, (int)strlen(line));
        LogRaw("\n", 1);
    }
}

static int Readable(const void *p, size_t n) {
    MEMORY_BASIC_INFORMATION m;
    if (!p || !n) return 0;
    if (!VirtualQuery(p, &m, sizeof(m))) return 0;
    if (m.State != MEM_COMMIT) return 0;
    if (m.Protect & (PAGE_NOACCESS | PAGE_GUARD)) return 0;
    uintptr_t a = (uintptr_t)p;
    return a + n <= (uintptr_t)m.BaseAddress + m.RegionSize;
}

// 判断一个 qword 是否像"指向 Weixin 模块内的函数指针"
static int LooksLikeCode(uintptr_t v) {
    return InImage(v) && v >= g_base + 0x1000 && v < g_base + 0x6900000;
}

static void DescribeObject(const char *who, void *obj) {
    uintptr_t o = (uintptr_t)obj;
    if (!Readable(obj, 0x30)) {
        Logf("%s obj=%p (unreadable)", who, obj);
        return;
    }
    uintptr_t *q = (uintptr_t *)obj;
    uintptr_t vt = q[0];
    if (InImage(vt)) {
        uintptr_t *e = (uintptr_t *)vt;
        if (Readable(e, 6 * sizeof(uintptr_t))) {
            Logf("%s obj=%p vtable_rva=0x%llx entries=[%s0x%llx 0x%llx 0x%llx 0x%llx 0x%llx]",
                 who, obj, (unsigned long long)(vt - g_base),
                 LooksLikeCode(e[0]) ? "" : "?",
                 (unsigned long long)(e[0] >= g_base ? e[0] - g_base : e[0]),
                 (unsigned long long)(e[1] >= g_base ? e[1] - g_base : e[1]),
                 (unsigned long long)(e[2] >= g_base ? e[2] - g_base : e[2]),
                 (unsigned long long)(e[3] >= g_base ? e[3] - g_base : e[3]),
                 (unsigned long long)(e[4] >= g_base ? e[4] - g_base : e[4]));
        }
    } else {
        Logf("%s obj=%p first_qword=%p (not a module vtable)", who, obj, (void *)vt);
    }
    HexDump("  obj", (const unsigned char *)obj, 0x100);
    // 逐个导出版 vtable 函数入口机器码：可据此识别 lea rax,[rcx+imm] 形式的访问器
    if (InImage(vt)) {
        uintptr_t *e = (uintptr_t *)vt;
        for (int i = 0; i < 5; i++) {
            if (!LooksLikeCode(e[i])) continue;
            if (!Readable((void *)e[i], 16)) continue;
            char tag[48];
            _snprintf_s(tag, sizeof(tag), _TRUNCATE, "  vt[%d]@0x%llx", i,
                        (unsigned long long)(e[i] - g_base));
            HexDump(tag, (const unsigned char *)e[i], 16);
        }
    }
    // 常见 protobuf 缓冲位置：+0xa8 / +0xb0
    for (int off = 0xa0; off <= 0xb0; off += 8) {
        uintptr_t a = *(uintptr_t *)((char *)obj + off);
        uintptr_t b = *(uintptr_t *)((char *)obj + off + 8);
        if (!a || !Readable((void *)a, 16)) continue;
        if (b > 0 && b < 0x10000) {
            Logf("  +0x%x ptr=%p len=%llu preview=", off, (void *)a, (unsigned long long)b);
            if (Readable((void *)a, b > 32 ? 32 : (size_t)b)) {
                char s[160], *w = s;
                int n = (int)(b > 32 ? 32 : b);
                for (int i = 0; i < n; i++) {
                    unsigned char c = ((unsigned char *)a)[i];
                    w += sprintf(w, "%02x", c);
                }
                *w = 0;
                LogRaw(s, (int)strlen(s));
                LogRaw("\n", 1);
            }
        }
    }
}

static void LogStack(const char *who) {
    uintptr_t *sp = (uintptr_t *)_AddressOfReturnAddress();
    Logf("%s stack:", who);
    for (int i = 0; i < 24; i++) {
        uintptr_t v = sp[i];
        if (LooksLikeCode(v)) Logf("   [sp+%02x] 0x%llx", i * 8, (unsigned long long)(v - g_base));
    }
}

#define DETOUR(n, idx)                                                       \
    static void *Detour##n(void *a, void *b, void *c, void *d) {              \
        Fn4 orig = (Fn4)g_tramp[idx];                                         \
        __try {                                                               \
            Logf("== HIT hook#%d target_rva=0x%llx caller_rva=0x%llx", idx,    \
                 (unsigned long long)((uintptr_t)g_target[idx] - g_base),      \
                 (unsigned long long)((uintptr_t)_ReturnAddress() - g_base));  \
            Logf("   a=%p b=%p c=%p d=%p", a, b, c, d);                        \
            if (InImage((uintptr_t)a)) DescribeObject("  arg1", a);            \
            if (InImage((uintptr_t)b)) DescribeObject("  arg2", b);            \
            LogStack("  ");                                                    \
            FlushLog();                                                        \
        } __except (EXCEPTION_EXECUTE_HANDLER) {                               \
            Logf("!! detour fault");                                           \
        }                                                                      \
        return orig ? orig(a, b, c, d) : NULL;                                 \
    }

DETOUR(0, 0)
DETOUR(1, 1)
DETOUR(2, 2)
DETOUR(3, 3)
DETOUR(4, 4)
DETOUR(5, 5)
DETOUR(6, 6)
DETOUR(7, 7)

static void *g_detours[MAX_HOOKS] = {(void *)Detour0, (void *)Detour1, (void *)Detour2, (void *)Detour3,
                                     (void *)Detour4, (void *)Detour5, (void *)Detour6, (void *)Detour7};

__declspec(dllexport) int __cdecl ProbeStart(void) {
    char cfg[MAX_PATH * 2];
    lstrcpynA(cfg, "probe.config", sizeof(cfg));
    // 配置与 DLL 同目录
    GetModuleFileNameA((HMODULE)g_exe, cfg, sizeof(cfg));  // 占位，稍后覆盖
    char self[MAX_PATH];
    GetModuleFileNameA((HMODULE)(void *)ProbeStart, self, sizeof(self));
    char *slash = strrchr(self, '\\');
    if (slash) *(slash + 1) = 0;
    lstrcatA(self, "probe.config");

    FILE *f = fopen(self, "r");
    if (!f) {
        Logf("config not found: %s", self);
        FlushLog();
        return -1;
    }
    if (MH_Initialize() != MH_OK) {
        Logf("MH_Initialize failed");
        FlushLog();
        return -2;
    }
    char line[256];
    while (fgets(line, sizeof(line), f) && g_hookCount < MAX_HOOKS) {
        unsigned long long rva = 0;
        if (sscanf(line, "hook=0x%llx", &rva) != 1) continue;
        if (!rva || rva >= g_size) continue;
        void *target = (void *)(g_base + rva);
        if (MH_CreateHook(target, g_detours[g_hookCount], &g_tramp[g_hookCount]) != MH_OK) {
            Logf("MH_CreateHook failed rva=0x%llx", rva);
            continue;
        }
        if (MH_EnableHook(target) != MH_OK) {
            Logf("MH_EnableHook failed rva=0x%llx", rva);
            continue;
        }
        g_target[g_hookCount] = target;
        Logf("hooked rva=0x%llx trampoline=%p", rva, g_tramp[g_hookCount]);
        g_hookCount++;
    }
    fclose(f);
    Logf("ProbeStart done hooks=%d base=%p size=0x%llx", g_hookCount, (void *)g_base, (unsigned long long)g_size);
    FlushLog();
    return g_hookCount;
}

__declspec(dllexport) int __cdecl ProbeStop(void) {
    for (int i = 0; i < g_hookCount; i++) {
        if (g_target[i]) {
            MH_DisableHook(g_target[i]);
            MH_RemoveHook(g_target[i]);
        }
    }
    g_hookCount = 0;
    MH_Uninitialize();
    Logf("ProbeStop done");
    FlushLog();
    return 0;
}

// 在进程内搜索一段 UTF-8 文本，回溯寻找"对象头"(vtable 指向模块内的对象)
__declspec(dllexport) int __cdecl ProbeScanText(const char *utf8) {
    if (!utf8 || !*utf8) return -1;
    size_t needle = strlen(utf8);
    if (needle > 900) return -2;
    uintptr_t addr = 0x10000;
    int found = 0;
    Logf("scan text len=%llu", (unsigned long long)needle);
    while (addr < 0x7FFFFFFE0000ULL) {
        MEMORY_BASIC_INFORMATION m;
        if (!VirtualQuery((LPCVOID)addr, &m, sizeof(m))) break;
        uintptr_t regionEnd = (uintptr_t)m.BaseAddress + m.RegionSize;
        int ok = m.State == MEM_COMMIT && !(m.Protect & (PAGE_NOACCESS | PAGE_GUARD)) &&
                 (m.Protect & (PAGE_READONLY | PAGE_READWRITE | PAGE_WRITECOPY |
                               PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY));
        if (ok && m.RegionSize < 0x8000000) {
            const unsigned char *p = (const unsigned char *)m.BaseAddress;
            size_t n = m.RegionSize;
            for (size_t i = 0; i + needle <= n; i++) {
                if (p[i] != (unsigned char)utf8[0]) continue;
                if (memcmp(p + i, utf8, needle) != 0) continue;
                uintptr_t hit = (uintptr_t)(p + i);
                Logf("TEXT hit addr=%p", (void *)hit);
                // 回溯最多 0x600 字节寻找对象头
                for (int back = 8; back <= 0x600; back += 8) {
                    uintptr_t cand = hit - back;
                    if (!Readable((void *)cand, 0x18)) break;
                    uintptr_t vt = *(uintptr_t *)cand;
                    if (!InImage(vt)) continue;
                    uintptr_t *e = (uintptr_t *)vt;
                    if (!Readable(e, 5 * sizeof(uintptr_t))) continue;
                    if (!LooksLikeCode(e[0]) || !LooksLikeCode(e[1])) continue;
                    char tag[64];
                    _snprintf_s(tag, sizeof(tag), _TRUNCATE, " candidate-0x%x", back);
                    DescribeObject(tag, (void *)cand);
                    Logf("  vtable_rva=0x%llx  object_rva=0x%llx", (unsigned long long)(vt - g_base),
                         (unsigned long long)(cand - g_base));
                    found++;
                    break;
                }
                if (++found >= 12) break;
            }
        }
        if (regionEnd <= addr) break;
        addr = regionEnd;
    }
    Logf("scan done candidates=%d", found);
    FlushLog();
    return found;
}

// 纯只读：在 .data 里找 "操作对象 -> manager -> 派发函数" 的两级结构
__declspec(dllexport) int __cdecl ProbeFindManager(void) {
    if (!g_base) return -1;
    // Weixin.dll 4.1.10.27: .data 区间
    uintptr_t lo = g_base + 0xa057000, hi = g_base + 0xa8a8000;
    if (hi > g_base + g_size) hi = g_base + g_size;
    int found = 0;
    Logf("MGR scan start");
    for (uintptr_t p = lo; p + 0x18 <= hi; p += 8) {
        uintptr_t v = *(uintptr_t *)p;
        if (v < 0x10000 || v > 0x7FFFFFFE0000ULL) continue;
        if (!Readable((void *)v, 0x18)) continue;
        uintptr_t vt = *(uintptr_t *)v;
        if (!InImage(vt) || !Readable((void *)vt, 8 * sizeof(uintptr_t))) continue;
        uintptr_t *e = (uintptr_t *)vt;
        int ok = 1;
        for (int i = 0; i < 5; i++) if (!LooksLikeCode(e[i])) { ok = 0; break; }
        if (!ok) continue;
        uintptr_t m = *(uintptr_t *)(v + 8);
        if (m < 0x10000 || !Readable((void *)m, 0x10)) continue;
        uintptr_t vtM = *(uintptr_t *)m;
        if (!InImage(vtM) || !Readable((void *)vtM, 8 * sizeof(uintptr_t))) continue;
        uintptr_t *eM = (uintptr_t *)vtM;
        int ok2 = 1;
        for (int i = 0; i < 5; i++) if (!LooksLikeCode(eM[i])) { ok2 = 0; break; }
        if (!ok2) continue;
        int hit = 0;
        const unsigned char *fn = (const unsigned char *)eM[5];
        if (LooksLikeCode(eM[5]) && Readable((void *)fn, 96)) {
            for (int i = 0; i + 2 < 96; i++) {
                if (fn[i] == 0xFF && (fn[i + 1] == 0x50 || fn[i + 1] == 0x52 || fn[i + 1] == 0x51) &&
                    (fn[i + 2] == 0x18 || fn[i + 2] == 0x20 || fn[i + 2] == 0x30)) { hit = 1; break; }
            }
        }
        Logf("MGR cand global=0x%llx obj=%p objVt=0x%llx mgr=%p mgrVt=0x%llx dispatch=0x%llx hit=%d",
             (unsigned long long)(p - g_base), (void *)v, (unsigned long long)(vt - g_base),
             (void *)m, (unsigned long long)(vtM - g_base),
             (unsigned long long)(eM[5] >= g_base ? eM[5] - g_base : eM[5]), hit);
        if (hit) found++;
        if (found >= 40) break;
    }
    Logf("MGR scan done hits=%d", found);
    FlushLog();
    return found;
}

// 纯只读：读取 0x410c0 单例访问器背后的全局指针，并导出其 vtable
__declspec(dllexport) int __cdecl ProbeSingleton(void) {
    if (!g_base) return -1;
    uintptr_t slot = g_base + 0xA83AB20;
    if (!Readable((void *)slot, 8)) { Logf("SGL slot unreadable"); FlushLog(); return -2; }
    uintptr_t obj = *(uintptr_t *)slot;
    Logf("SGL global_rva=0xabba520 obj=%p", (void *)obj);
    if (!obj || !Readable((void *)obj, 0x30)) { Logf("SGL obj unreadable"); FlushLog(); return -3; }
    uintptr_t vt = *(uintptr_t *)obj;
    Logf("SGL vtable=%p rva=0x%llx", (void *)vt, (unsigned long long)(InImage(vt) ? vt - g_base : 0));
    if (InImage(vt) && Readable((void *)vt, 8 * sizeof(uintptr_t))) {
        uintptr_t *e = (uintptr_t *)vt;
        for (int i = 0; i < 8; i++)
            Logf("SGL vt[%d]=0x%llx", i, (unsigned long long)(e[i] >= g_base ? e[i] - g_base : e[i]));
        if (LooksLikeCode(e[5]) && Readable((void *)e[5], 64)) {
            const unsigned char *fn = (const unsigned char *)e[5];
            Logf("SGL vt[5] head=%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x",
                 fn[0], fn[1], fn[2], fn[3], fn[4], fn[5], fn[6], fn[7],
                 fn[8], fn[9], fn[10], fn[11], fn[12], fn[13], fn[14], fn[15]);
        }
    }
    FlushLog();
    return (int)(obj ? 1 : 0);
}

// 纯只读：扫描单例对象字段，找出"字段指向的对象其 vtable 像接口"的候选（找 manager）
__declspec(dllexport) int __cdecl ProbeDumpFields(void) {
    if (!g_base) return -1;
    uintptr_t obj = *(uintptr_t *)(g_base + 0xA83AB20);
    if (!obj || !Readable((void *)obj, 0x40)) { Logf("FLDS obj unreadable"); FlushLog(); return -2; }
    Logf("FLDS obj=%p", (void *)obj);
    int n = 0;
    for (int off = 0; off <= 0x400; off += 8) {
        if (!Readable((void *)(obj + off), 8)) break;
        uintptr_t p = *(uintptr_t *)(obj + off);
        if (p < 0x10000 || p > 0x7FFFFFFE0000ULL) continue;
        if (!Readable((void *)p, 0x10)) continue;
        uintptr_t vt = *(uintptr_t *)p;
        if (!InImage(vt) || !Readable((void *)vt, 8 * sizeof(uintptr_t))) continue;
        uintptr_t *e = (uintptr_t *)vt;
        int ok = 1;
        for (int i = 0; i < 5; i++) if (!LooksLikeCode(e[i])) { ok = 0; break; }
        if (!ok) continue;
        const unsigned char *fn = LooksLikeCode(e[5]) && Readable((void *)e[5], 16) ? (const unsigned char *)e[5] : NULL;
        Logf("FLDS +0x%03x obj=%p vt=0x%llx vt5=0x%llx head=%s", off, (void *)p,
             (unsigned long long)(vt - g_base),
             (unsigned long long)(e[5] >= g_base ? e[5] - g_base : e[5]),
             fn ? "yes" : "-");
        if (fn) {
            char hex[64]; int w = 0;
            for (int i = 0; i < 12; i++) w += _snprintf_s(hex + w, sizeof(hex) - w, _TRUNCATE, "%02x", fn[i]);
            Logf("      vt5 bytes=%s", hex);
        }
        n++;
    }
    Logf("FLDS done candidates=%d", n);
    FlushLog();
    return n;
}

__declspec(dllexport) int __cdecl ProbePing(void) {
    Logf("ping from %lu", GetCurrentProcessId());
    FlushLog();
    return (int)(g_base ? 1 : 0);
}

// ---- 被动监听：后台反复扫描私有内存，命中标记文本即抓取对象结构（不挂钩子、零侵入） ----
static volatile LONG g_watchRun;
static char g_watchText[256];

static int ScanOnce(const char *utf8, int maxHits) {
    size_t needle = strlen(utf8);
    uintptr_t addr = 0x10000;
    int found = 0;
    while (addr < 0x7FFFFFFE0000ULL && g_watchRun) {
        MEMORY_BASIC_INFORMATION m;
        if (!VirtualQuery((LPCVOID)addr, &m, sizeof(m))) break;
        uintptr_t regionEnd = (uintptr_t)m.BaseAddress + m.RegionSize;
        // 只看私有可读内存：任务对象与 protobuf 缓冲都在这里
        int ok = m.State == MEM_COMMIT && m.Type == MEM_PRIVATE &&
                 !(m.Protect & (PAGE_NOACCESS | PAGE_GUARD)) &&
                 (m.Protect & (PAGE_READONLY | PAGE_READWRITE | PAGE_WRITECOPY));
        if (ok && m.RegionSize <= 0x4000000) {
            const unsigned char *p = (const unsigned char *)m.BaseAddress;
            size_t n = m.RegionSize;
            const unsigned char *end = p + n - needle;
            for (const unsigned char *cur = p; cur <= end;) {
                const unsigned char *hit = (const unsigned char *)memchr(cur, utf8[0], (size_t)(end - cur) + 1);
                if (!hit) break;
                if (memcmp(hit, utf8, needle) != 0) {
                    cur = hit + 1;
                    continue;
                }
                uintptr_t a = (uintptr_t)hit;
                Logf("WATCH hit addr=%p", (void *)a);
                HexDump(" context", (const unsigned char *)(a > 0x100 && Readable((void *)(a - 0x100), 0x100 + needle + 0x100) ? a - 0x100 : a),
                        a > 0x100 ? 0x100 + (int)needle + 0x100 : (int)needle);
                for (int back = 8; back <= 0x800; back += 8) {
                    uintptr_t cand = a - back;
                    if (!Readable((void *)cand, 0x18)) break;
                    uintptr_t vt = *(uintptr_t *)cand;
                    if (!InImage(vt)) continue;
                    uintptr_t *e = (uintptr_t *)vt;
                    if (!Readable(e, 6 * sizeof(uintptr_t))) continue;
                    if (!LooksLikeCode(e[0]) || !LooksLikeCode(e[1])) continue;
                    char tag[64];
                    _snprintf_s(tag, sizeof(tag), _TRUNCATE, " WATCH-OBJ-0x%x", back);
                    DescribeObject(tag, (void *)cand);
                    Logf("  -> vtable_rva=0x%llx object_rva=0x%llx",
                         (unsigned long long)(vt - g_base), (unsigned long long)(cand - g_base));
                    found++;
                    break;
                }
                if (++found >= maxHits) return found;
                cur = hit + needle;
            }
        }
        if (regionEnd <= addr) break;
        addr = regionEnd;
    }
    return found;
}

static DWORD WINAPI WatchThread(void *unused) {
    (void)unused;
    Logf("watch start text=\"%s\"", g_watchText);
    FlushLog();
    int rounds = 0;
    while (g_watchRun && rounds < 300) {
        int hits = ScanOnce(g_watchText, 4);
        if (hits > 0) {
            Logf("watch captured hits=%d round=%d", hits, rounds);
            FlushLog();
            g_watchRun = 0;
            break;
        }
        rounds++;
        Sleep(250);
    }
    if (g_watchRun) {
        Logf("watch timeout rounds=%d (未捕获)", rounds);
        g_watchRun = 0;
    }
    FlushLog();
    return 0;
}

__declspec(dllexport) int __cdecl ProbeWatchStart(const char *utf8) {
    if (!utf8 || !*utf8 || strlen(utf8) > 200) return -1;
    if (g_watchRun) return -2;
    lstrcpynA(g_watchText, utf8, sizeof(g_watchText));
    g_watchRun = 1;
    HANDLE t = CreateThread(NULL, 0, WatchThread, NULL, 0, NULL);
    if (!t) {
        g_watchRun = 0;
        return -3;
    }
    CloseHandle(t);
    return 0;
}

__declspec(dllexport) int __cdecl ProbeWatchStop(void) {
    g_watchRun = 0;
    Logf("watch stop requested");
    FlushLog();
    return 0;
}

// ---- 反向持有关系定位：文本 -> 谁指向它 -> 谁的 vtable 是任务类 ----
static int FindOwnersOnce(const char *utf8, int maxHits) {
    size_t needle = strlen(utf8);
    uintptr_t addr = 0x10000;
    uintptr_t ranges[8][2];
    int nRange = 0;

    // 第一遍：收集文本命中地址
    while (addr < 0x7FFFFFFE0000ULL && nRange < maxHits) {
        MEMORY_BASIC_INFORMATION m;
        if (!VirtualQuery((LPCVOID)addr, &m, sizeof(m))) break;
        uintptr_t regionEnd = (uintptr_t)m.BaseAddress + m.RegionSize;
        int ok = m.State == MEM_COMMIT && m.Type == MEM_PRIVATE &&
                 !(m.Protect & (PAGE_NOACCESS | PAGE_GUARD)) &&
                 (m.Protect & (PAGE_READONLY | PAGE_READWRITE | PAGE_WRITECOPY));
        if (ok && m.RegionSize <= 0x4000000) {
            const unsigned char *p = (const unsigned char *)m.BaseAddress;
            const unsigned char *end = p + m.RegionSize - needle;
            for (const unsigned char *cur = p; cur <= end;) {
                const unsigned char *h = (const unsigned char *)memchr(cur, utf8[0], (size_t)(end - cur) + 1);
                if (!h) break;
                if (memcmp(h, utf8, needle)) { cur = h + 1; continue; }
                Logf("OWN text@%p", (void *)h);
                ranges[nRange][0] = (uintptr_t)h > 0x4000 ? (uintptr_t)h - 0x4000 : 0x10000;
                ranges[nRange][1] = (uintptr_t)h + 0x40;
                nRange++;
                if (nRange >= maxHits) break;
                cur = h + needle;
            }
        }
        if (regionEnd <= addr) break;
        addr = regionEnd;
    }

    // 第二遍：找持有指向这些地址的指针的位置
    int owners = 0;
    for (int i = 0; i < nRange; i++) {
        uintptr_t lo = ranges[i][0], hi = ranges[i][1];
        addr = 0x10000;
        while (addr < 0x7FFFFFFE0000ULL) {
            MEMORY_BASIC_INFORMATION m;
            if (!VirtualQuery((LPCVOID)addr, &m, sizeof(m))) break;
            uintptr_t regionEnd = (uintptr_t)m.BaseAddress + m.RegionSize;
            int ok = m.State == MEM_COMMIT && m.Type == MEM_PRIVATE &&
                     !(m.Protect & (PAGE_NOACCESS | PAGE_GUARD)) &&
                     (m.Protect & (PAGE_READONLY | PAGE_READWRITE | PAGE_WRITECOPY));
            if (ok && m.RegionSize <= 0x4000000) {
                uintptr_t *q = (uintptr_t *)m.BaseAddress;
                size_t cnt = m.RegionSize / 8;
                for (size_t k = 0; k < cnt; k++) {
                    uintptr_t v = q[k];
                    if (v < lo || v >= hi) continue;
                    uintptr_t holder = (uintptr_t)&q[k];
                    Logf("  OWN pointer@%p -> %p (text-0x%llx)", (void *)holder, (void *)v,
                         (unsigned long long)((intptr_t)v - (intptr_t)ranges[i][0]));
                    for (int back = 8; back <= 0x400; back += 8) {
                        uintptr_t cand = holder - back;
                        if (!Readable((void *)cand, 0x18)) break;
                        uintptr_t vt = *(uintptr_t *)cand;
                        if (!InImage(vt)) continue;
                        uintptr_t *e = (uintptr_t *)vt;
                        if (!Readable(e, 6 * sizeof(uintptr_t))) continue;
                        if (!LooksLikeCode(e[0]) || !LooksLikeCode(e[1])) continue;
                        char tag[64];
                        _snprintf_s(tag, sizeof(tag), _TRUNCATE, "  OWN-OBJ-0x%x", back);
                        DescribeObject(tag, (void *)cand);
                        Logf("    -> vtable_rva=0x%llx", (unsigned long long)(vt - g_base));
                        owners++;
                        break;
                    }
                    if (owners > 40) { FlushLog(); return owners; }
                }
            }
            if (regionEnd <= addr) break;
            addr = regionEnd;
        }
    }
    Logf("OWN done regions=%d owners=%d", nRange, owners);
    FlushLog();
    return owners;
}

__declspec(dllexport) int __cdecl ProbeFindOwners(const char *utf8) {
    if (!utf8 || !*utf8 || strlen(utf8) > 200) return -1;
    return FindOwnersOnce(utf8, 8);
}

// 判断某函数是否是 "lea rax,[rcx+imm] / mov rax,[rcx+imm]" 形式的对象内访问器
static int AccessorImm(uintptr_t fn, unsigned *immOut) {
    if (!LooksLikeCode(fn) || !Readable((void *)fn, 8)) return 0;
    const unsigned char *b = (const unsigned char *)fn;
    if (b[0] == 0x48 && b[1] == 0x8d && b[2] == 0x81) {
        unsigned imm = *(unsigned *)(b + 3);
        if (imm >= 0x40 && imm <= 0x800) { *immOut = imm; return 1; }
    }
    if (b[0] == 0x48 && b[1] == 0x8b && b[2] == 0x81) {
        unsigned imm = *(unsigned *)(b + 3);
        if (imm >= 0x40 && imm <= 0x800) { *immOut = imm; return 1; }
    }
    return 0;
}

// 任务类判定：vtable 至少 5 项，且第 4/5 项是指向对象内部的访问器
static int IsTaskVtable(uintptr_t vt, unsigned *reqOff, unsigned *resOff) {
    if (!InImage(vt) || !Readable((void *)vt, 6 * sizeof(uintptr_t))) return 0;
    uintptr_t *e = (uintptr_t *)vt;
    if (!LooksLikeCode(e[0]) || !LooksLikeCode(e[1])) return 0;
    unsigned a = 0, b = 0;
    int hasA = AccessorImm(e[3], &a);
    int hasB = AccessorImm(e[4], &b);
    if (hasA) *reqOff = a;
    if (hasB) *resOff = b;
    return hasA || hasB;
}

// 单轮精确搜索：文本 -> 持有者 -> vtable 符合任务类 -> 命中
static int HuntOnce(const char *utf8) {
    size_t needle = strlen(utf8);
    uintptr_t ranges[8][2];
    int nRange = 0, found = 0;
    uintptr_t addr = 0x10000;
    while (addr < 0x7FFFFFFE0000ULL && nRange < 8) {
        MEMORY_BASIC_INFORMATION m;
        if (!VirtualQuery((LPCVOID)addr, &m, sizeof(m))) break;
        uintptr_t regionEnd = (uintptr_t)m.BaseAddress + m.RegionSize;
        int ok = m.State == MEM_COMMIT && m.Type == MEM_PRIVATE &&
                 !(m.Protect & (PAGE_NOACCESS | PAGE_GUARD)) &&
                 (m.Protect & (PAGE_READONLY | PAGE_READWRITE | PAGE_WRITECOPY));
        if (ok && m.RegionSize <= 0x4000000) {
            const unsigned char *p = (const unsigned char *)m.BaseAddress;
            const unsigned char *end = p + m.RegionSize - needle;
            for (const unsigned char *cur = p; cur <= end;) {
                const unsigned char *h = (const unsigned char *)memchr(cur, utf8[0], (size_t)(end - cur) + 1);
                if (!h) break;
                if (memcmp(h, utf8, needle)) { cur = h + 1; continue; }
                ranges[nRange][0] = (uintptr_t)h > 0x8000 ? (uintptr_t)h - 0x8000 : 0x10000;
                ranges[nRange][1] = (uintptr_t)h + 0x80;
                nRange++;
                if (nRange >= 8) break;
                cur = h + needle;
            }
        }
        if (regionEnd <= addr) break;
        addr = regionEnd;
    }
    if (!nRange) return 0;

    for (int i = 0; i < nRange; i++) {
        uintptr_t lo = ranges[i][0], hi = ranges[i][1];
        addr = 0x10000;
        while (addr < 0x7FFFFFFE0000ULL && !found) {
            MEMORY_BASIC_INFORMATION m;
            if (!VirtualQuery((LPCVOID)addr, &m, sizeof(m))) break;
            uintptr_t regionEnd = (uintptr_t)m.BaseAddress + m.RegionSize;
            int ok = m.State == MEM_COMMIT && m.Type == MEM_PRIVATE &&
                     !(m.Protect & (PAGE_NOACCESS | PAGE_GUARD)) &&
                     (m.Protect & (PAGE_READONLY | PAGE_READWRITE | PAGE_WRITECOPY));
            if (ok && m.RegionSize <= 0x4000000) {
                uintptr_t *q = (uintptr_t *)m.BaseAddress;
                size_t cnt = m.RegionSize / 8;
                for (size_t k = 0; k < cnt; k++) {
                    uintptr_t v = q[k];
                    if (v < lo || v >= hi) continue;
                    uintptr_t holder = (uintptr_t)&q[k];
                    for (int back = 8; back <= 0x600; back += 8) {
                        uintptr_t cand = holder - back;
                        if (!Readable((void *)cand, 0x18)) break;
                        uintptr_t vt = *(uintptr_t *)cand;
                        uintptr_t *e = (uintptr_t *)vt;
                        unsigned req = 0, res = 0;
                        if (!Readable(e, 6 * sizeof(uintptr_t))) continue;
                        if (!LooksLikeCode(e[0]) || !LooksLikeCode(e[1])) continue;
                        if (!IsTaskVtable(vt, &req, &res)) continue;
                        Logf("=== TARGET object=%p vtable_rva=0x%llx reqOff=0x%x resOff=0x%x",
                             (void *)cand, (unsigned long long)(vt - g_base), req, res);
                        DescribeObject(" TARGET", (void *)cand);
                        Logf(" TARGET vt[0..4]=0x%llx 0x%llx 0x%llx 0x%llx 0x%llx",
                             (unsigned long long)(e[0] - g_base), (unsigned long long)(e[1] - g_base),
                             (unsigned long long)(e[2] - g_base), (unsigned long long)(e[3] - g_base),
                             (unsigned long long)(e[4] - g_base));
                        FlushLog();
                        found = 1;
                        break;
                    }
                    if (found) break;
                }
            }
            if (regionEnd <= addr) break;
            addr = regionEnd;
        }
        if (found) break;
    }
    return found;
}

static DWORD WINAPI HuntThread(void *unused) {
    (void)unused;
    Logf("hunt start text=\"%s\"", g_watchText);
    FlushLog();
    int rounds = 0;
    while (g_watchRun && rounds < 240) {
        int hit = 0;
        __try { hit = HuntOnce(g_watchText); }
        __except (EXCEPTION_EXECUTE_HANDLER) { Logf("hunt fault round=%d", rounds); }
        rounds++;
        if (hit) {
            Logf("hunt captured round=%d", rounds);
            FlushLog();
            g_watchRun = 0;
            return 0;
        }
    }
    Logf("hunt timeout rounds=%d", rounds);
    FlushLog();
    g_watchRun = 0;
    return 0;
}

__declspec(dllexport) int __cdecl ProbeHunt(const char *utf8) {
    if (!utf8 || !*utf8 || strlen(utf8) > 200) return -1;
    if (g_watchRun) return -2;
    lstrcpynA(g_watchText, utf8, sizeof(g_watchText));
    g_watchRun = 1;
    HANDLE t = CreateThread(NULL, 0, HuntThread, NULL, 0, NULL);
    if (!t) { g_watchRun = 0; return -3; }
    CloseHandle(t);
    return 0;
}

/* ================= 堆分配追踪：精确捕获 protobuf 缓冲 ================= */
#define RING_SIZE 8192
typedef struct { void *p; size_t n; } AllocRec;
static AllocRec g_ring[RING_SIZE];
static volatile LONG g_ringIdx;
static volatile LONG g_allocArmed;
static PVOID(NTAPI *g_realAlloc)(PVOID, ULONG, SIZE_T);
static void *g_allocTarget;
static __declspec(thread) int t_inAlloc;

static PVOID NTAPI DetourRtlAllocateHeap(PVOID heap, ULONG flags, SIZE_T size) {
    PVOID r = g_realAlloc(heap, flags, size);
    if (r && !t_inAlloc && size && size <= 0x40000) {
        LONG i = InterlockedIncrement(&g_ringIdx) & (RING_SIZE - 1);
        g_ring[i].p = r;
        g_ring[i].n = size;
    }
    return r;
}

// 在 [lo,hi) 范围内找持有该地址的容器，并判断其 vtable 是否为任务类
static int ScanOwnersOf(uintptr_t lo, uintptr_t hi) {
    uintptr_t addr = 0x10000;
    while (addr < 0x7FFFFFFE0000ULL) {
        MEMORY_BASIC_INFORMATION m;
        if (!VirtualQuery((LPCVOID)addr, &m, sizeof(m))) break;
        uintptr_t regionEnd = (uintptr_t)m.BaseAddress + m.RegionSize;
        int ok = m.State == MEM_COMMIT && m.Type == MEM_PRIVATE &&
                 !(m.Protect & (PAGE_NOACCESS | PAGE_GUARD)) &&
                 (m.Protect & (PAGE_READONLY | PAGE_READWRITE | PAGE_WRITECOPY));
        if (ok && m.RegionSize <= 0x4000000) {
            uintptr_t *q = (uintptr_t *)m.BaseAddress;
            size_t cnt = m.RegionSize / 8;
            for (size_t k = 0; k < cnt; k++) {
                uintptr_t v = q[k];
                if (v < lo || v >= hi) continue;
                uintptr_t holder = (uintptr_t)&q[k];
                for (int back = 8; back <= 0x600; back += 8) {
                    uintptr_t cand = holder - back;
                    if (!Readable((void *)cand, 0x18)) break;
                    uintptr_t vt = *(uintptr_t *)cand;
                    uintptr_t *e = (uintptr_t *)vt;
                    unsigned req = 0, res = 0;
                    if (!Readable(e, 6 * sizeof(uintptr_t))) continue;
                    if (!LooksLikeCode(e[0]) || !LooksLikeCode(e[1])) continue;
                    if (!IsTaskVtable(vt, &req, &res)) continue;
                    Logf("=== TARGET object=%p vtable_rva=0x%llx reqOff=0x%x resOff=0x%x",
                         (void *)cand, (unsigned long long)(vt - g_base), req, res);
                    DescribeObject(" TARGET", (void *)cand);
                    Logf(" TARGET vt[0..4]=0x%llx 0x%llx 0x%llx 0x%llx 0x%llx",
                         (unsigned long long)(e[0] - g_base), (unsigned long long)(e[1] - g_base),
                         (unsigned long long)(e[2] - g_base), (unsigned long long)(e[3] - g_base),
                         (unsigned long long)(e[4] - g_base));
                    FlushLog();
                    return 1;
                }
            }
        }
        if (regionEnd <= addr) break;
        addr = regionEnd;
    }
    return 0;
}

static DWORD WINAPI AllocHuntThread(void *unused) {
    (void)unused;
    size_t needle = strlen(g_watchText);
    Logf("allochunt start text=\"%s\"", g_watchText);
    FlushLog();
    DWORD deadline = GetTickCount() + 1200000;
    int captured = 0;
    while (g_watchRun && (LONG)(deadline - GetTickCount()) > 0 && !captured) {
        LONG top = g_ringIdx;
        for (LONG i = top - 2048; i <= top && !captured; i++) {
            if (i < 0) continue;
            AllocRec rec = g_ring[i & (RING_SIZE - 1)];
            if (!rec.p || rec.n < needle || rec.n > 0x40000) continue;
            if (!Readable(rec.p, rec.n)) continue;
            const unsigned char *p = (const unsigned char *)rec.p;
            for (size_t off = 0; off + needle <= rec.n; off++) {
                if (p[off] != (unsigned char)g_watchText[0]) continue;
                if (memcmp(p + off, g_watchText, needle)) continue;
                Logf("ALLOC hit block=%p size=0x%llx off=0x%llx", rec.p, (unsigned long long)rec.n,
                     (unsigned long long)off);
                HexDump(" block", p, (int)(rec.n > 0x180 ? 0x180 : rec.n));
                FlushLog();
                int got = 0;
                __try { got = ScanOwnersOf((uintptr_t)rec.p, (uintptr_t)rec.p + rec.n); }
                __except (EXCEPTION_EXECUTE_HANDLER) { Logf("allochunt owner-scan fault"); FlushLog(); }
                if (got) captured = 1;
                break;
            }
        }
        if (!captured) Sleep(40);
    }
    if (g_allocTarget) {
        MH_DisableHook(g_allocTarget);
        MH_RemoveHook(g_allocTarget);
        g_allocTarget = NULL;
    }
    g_watchRun = 0;
    Logf("allochunt done captured=%d", captured);
    FlushLog();
    return 0;
}

__declspec(dllexport) int __cdecl ProbeAllocHunt(const char *utf8) {
    if (!utf8 || !*utf8 || strlen(utf8) > 200) return -1;
    if (g_watchRun) return -2;
    HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    if (!ntdll) return -4;
    g_realAlloc = (PVOID(NTAPI *)(PVOID, ULONG, SIZE_T))GetProcAddress(ntdll, "RtlAllocateHeap");
    if (!g_realAlloc) return -5;
    if (MH_Initialize() != MH_OK) return -6;
    void *target = (void *)g_realAlloc;
    if (MH_CreateHook(target, (void *)DetourRtlAllocateHeap, (void **)&g_realAlloc) != MH_OK)
        return -7;
    if (MH_EnableHook(target) != MH_OK) return -8;
    g_allocTarget = target;
    lstrcpynA(g_watchText, utf8, sizeof(g_watchText));
    g_ringIdx = 0;
    g_watchRun = 1;
    HANDLE t = CreateThread(NULL, 0, AllocHuntThread, NULL, 0, NULL);
    if (!t) { g_watchRun = 0; return -9; }
    CloseHandle(t);
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE mod, DWORD reason, LPVOID unused) {
    (void)unused;
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(mod);
        g_exe = GetModuleHandleW(NULL);
        HMODULE wx = GetModuleHandleW(L"Weixin.dll");
        if (!wx) wx = GetModuleHandleW(L"WeChatWin.dll");
        if (wx) {
            g_base = (uintptr_t)wx;
            MODULEINFO mi;
            if (GetModuleInformation(GetCurrentProcess(), wx, &mi, sizeof(mi))) g_size = mi.SizeOfImage;
        }
        wchar_t dir[MAX_PATH];
        DWORD n = GetEnvironmentVariableW(L"LOCALAPPDATA", dir, MAX_PATH);
        if (n) {
            lstrcatW(dir, L"\\WeChatMomentsProbe");
            CreateDirectoryW(dir, NULL);
            lstrcpynW(g_logPath, dir, MAX_PATH);
            lstrcatW(g_logPath, L"\\probe.log");
        }
        g_log = (char *)VirtualAlloc(NULL, LOG_MAX, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
        if (g_log) g_log[0] = 0;
        Logf("probe attached pid=%lu weixin=%p size=0x%llx", GetCurrentProcessId(), (void *)g_base,
             (unsigned long long)g_size);
        FlushLog();
    }
    return TRUE;
}
