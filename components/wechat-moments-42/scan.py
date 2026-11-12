"""在微信进程里只读搜索指定字节串，把命中处上下文 dump 出来。

用法：
  python scan.py --pid 15176 --needle "WBCAP-1514-9F3K" --out cap.bin
不注入、不写内存，只 VirtualQueryEx + ReadProcessMemory。
"""
import argparse
import ctypes
import json
import sys
from ctypes import wintypes

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
k32.OpenProcess.restype = wintypes.HANDLE
k32.VirtualQueryEx.restype = ctypes.c_size_t
k32.ReadProcessMemory.restype = wintypes.BOOL

PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010
MEM_COMMIT = 0x1000
PAGE_GUARD = 0x100
PAGE_NOACCESS = 0x01


class MEMORY_BASIC_INFORMATION64(ctypes.Structure):
    _fields_ = [("BaseAddress", ctypes.c_ulonglong), ("AllocationBase", ctypes.c_ulonglong),
                ("AllocationProtect", wintypes.DWORD), ("__alignment1", wintypes.DWORD),
                ("RegionSize", ctypes.c_ulonglong), ("State", wintypes.DWORD),
                ("Protect", wintypes.DWORD), ("Type", wintypes.DWORD), ("__alignment2", wintypes.DWORD)]


def regions(h):
    addr = 0
    max_addr = 0x7FFFFFFFFFFF
    info = MEMORY_BASIC_INFORMATION64()
    while addr < max_addr:
        got = k32.VirtualQueryEx(h, ctypes.c_void_p(addr), ctypes.byref(info), ctypes.sizeof(info))
        if not got:
            break
        base = info.BaseAddress
        size = info.RegionSize
        if info.State == MEM_COMMIT and not (info.Protect & (PAGE_GUARD | PAGE_NOACCESS)):
            yield base, size
        nxt = base + size
        if nxt <= addr:
            break
        addr = nxt


def read(h, addr, size):
    buf = ctypes.create_string_buffer(size)
    got = ctypes.c_size_t(0)
    if k32.ReadProcessMemory(h, ctypes.c_void_p(addr), buf, size, ctypes.byref(got)):
        return buf.raw[: got.value]
    return b""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pid", type=int, required=True)
    ap.add_argument("--needle", required=True)
    ap.add_argument("--out", default="cap.bin")
    ap.add_argument("--before", type=int, default=0x600)
    ap.add_argument("--after", type=int, default=0x600)
    args = ap.parse_args()

    needle = args.needle.encode("utf-8")
    h = k32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, args.pid)
    if not h:
        raise SystemExit("打不开进程（权限或 pid 不对）")

    hits = []
    for base, size in regions(h):
        if size > 512 * 1024 * 1024:
            continue
        data = read(h, base, size)
        if not data:
            continue
        start = 0
        while True:
            i = data.find(needle, start)
            if i < 0:
                break
            addr = base + i
            lo = max(0, i - args.before)
            hi = min(len(data), i + len(needle) + args.after)
            hits.append({"address": addr, "region": base, "offset": i, "data": data[lo:hi].hex()})
            start = i + 1
            if len(hits) >= 40:
                break
        if len(hits) >= 40:
            break

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump({"pid": args.pid, "needle": args.needle, "hits": hits}, f)
    print(json.dumps({"pid": args.pid, "hits": len(hits),
                      "addresses": [hex(x["address"]) for x in hits[:10]]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
