"""Weixin.dll 4.2.0.12 静态定位工具（只读 PE，不加载 DLL、不碰进程）。

用法：python analyze4212.py <step>
所有地址都输出为 RVA（相对 ImageBase）。
"""
import hashlib
import struct
import sys
from pathlib import Path

import pefile

CORE = Path(r"C:\Program Files\Tencent\Weixin\4.2.0.12\Weixin.dll")
EXPECT = "2b3677c3f932daaa"

pe = pefile.PE(str(CORE), fast_load=True)
BASE = pe.OPTIONAL_HEADER.ImageBase
IMAGESIZE = pe.OPTIONAL_HEADER.SizeOfImage
raw = CORE.read_bytes()
SECTIONS = [(s.Name.rstrip(b"\x00").decode(), s.VirtualAddress, s.Misc_VirtualSize, s.PointerToRawData, s.SizeOfRawData) for s in pe.sections]


def sec_of(rva):
    for name, va, vsz, off, rsz in SECTIONS:
        if va <= rva < va + max(vsz, rsz):
            return name
    return None


def read(rva, n):
    for name, va, vsz, off, rsz in SECTIONS:
        if va <= rva < va + max(vsz, rsz):
            start = off + (rva - va)
            return raw[start:start + n]
    return b""


def to_rva(off):
    for name, va, vsz, o, rsz in SECTIONS:
        if o <= off < o + rsz:
            return va + (off - o)
    return None


def find(pat):
    out, i = [], -1
    while True:
        i = raw.find(pat, i + 1)
        if i < 0:
            break
        r = to_rva(i)
        if r is not None:
            out.append(r)
    return out


def qword(rva):
    return struct.unpack("<Q", read(rva, 8))[0]


def refs_to(addr, sections=(".rdata", ".data")):
    """在指定节里找 8 字节绝对指针 == addr。"""
    pat = struct.pack("<Q", addr)
    out = []
    i = -1
    while True:
        i = raw.find(pat, i + 1)
        if i < 0:
            break
        r = to_rva(i)
        if r is not None and sec_of(r) in sections:
            out.append(r)
    return out


def rip_refs(target_rva):
    """扫描 .text 里可能的 rip 相对引用（lea/mov 的 disp32 指向 target）。"""
    out = []
    for name, va, vsz, off, rsz in SECTIONS:
        if name != ".text":
            continue
        blob = raw[off:off + rsz]
        tgt = target_rva
        # 通用：对每个 4 字节位置，检查 field_end + disp == target
        for pos in range(len(blob) - 4):
            disp = struct.unpack_from("<i", blob, pos)[0]
            end = va + pos + 4
            if end + disp == tgt:
                out.append(va + pos)
    return out


def hexdump(rva, n=32):
    d = read(rva, n)
    return d.hex()


def main():
    step = sys.argv[1] if len(sys.argv) > 1 else "info"
    print(f"core    : {CORE}")
    print(f"sha256  : {hashlib.sha256(raw).hexdigest()}")
    print(f"base    : {BASE:#x}  imagesize: {IMAGESIZE:#x}  filesize: {len(raw):#x}")
    for name, va, vsz, off, rsz in SECTIONS:
        print(f"  {name:<8} rva={va:#010x} vsz={vsz:#010x} raw={off:#010x} {rsz:#010x}")

    if step == "acc":
        for tag, pat in [("req +0xa8", bytes.fromhex("488d81a8000000c3")),
                         ("res +0x248", bytes.fromhex("488d8148020000c3"))]:
            hits = find(pat)
            print(f"{tag:<12} {len(hits)} hit(s): " + ", ".join(hex(h) for h in hits[:10]))


if __name__ == "__main__":
    main()


import numpy as np

_TEXT = next(s for s in SECTIONS if s[0] == ".text")
_TRAW = raw[_TEXT[3]:_TEXT[3] + _TEXT[4]]
_VIEWS = []
for _o in range(4):
    _cnt = ((len(_TRAW) - _o) // 4) * 4
    _v = np.frombuffer(_TRAW, dtype=np.int32, count=_cnt // 4, offset=_o)
    _d = np.int64(_TEXT[1] + _o) + np.arange(_v.size, dtype=np.int64) * 4 + 4
    _VIEWS.append((_v, _d))


def xrefs_fast(target, chunk=16_000_000):
    """返回 .text 中所有 rip 相对引用 target 的 disp32 所在 RVA（指令起始约在此-3）。"""
    out = []
    for v, d in _VIEWS:
        for start in range(0, v.size, chunk):
            seg = v[start:start + chunk].astype(np.int64)
            hit = np.nonzero(seg + d[start:start + chunk] == target)[0]
            out.extend(int(d[start + h]) - 4 for h in hit)
    return sorted(out)


# ---- .pdata 函数边界 ----
import bisect as _bisect

_pd = next(s for s in SECTIONS if s[0] == ".pdata")
_praw = raw[_pd[3]:_pd[3] + _pd[4]]
_FUNCS = []
for _i in range(0, len(_praw) - 11, 12):
    _b, _e, _u = struct.unpack_from("<III", _praw, _i)
    if _b and _e > _b:
        _FUNCS.append((_b, _e))
_FUNCS.sort()
_FSTART = [f[0] for f in _FUNCS]


def func_of(rva):
    i = _bisect.bisect_right(_FSTART, rva) - 1
    if i < 0:
        return None
    b, e = _FUNCS[i]
    return (b, e) if b <= rva < e else None


def disas(rva, n=0x100, count=400):
    import capstone
    md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)
    md.detail = True
    code = read(rva, n)
    out = []
    for ins in md.disasm(code, BASE + rva):
        out.append((ins.address - BASE, ins.mnemonic, ins.op_str, ins))
        if len(out) >= count:
            break
    return out


def fmt(rows):
    return "\n".join(f"{a:#x}  {m} {o}" for a, m, o, _ in rows)


def calls_to(target):
    """返回所有 call rel32 到 target 的指令 RVA。"""
    out = []
    for v, d in _VIEWS:
        relpos = d - 5  # call 起始 = disp_pos - 1 - 4
        # disp 位于 call+1，因此 disp_pos = call+1 → call = disp_pos-1
        seg = v.astype(np.int64)
        # 条件：该 disp 前的字节是 0xE8，且 call+5+disp == target
        hit = np.nonzero(seg + d == target)[0]
        for h in hit:
            p = int(relpos[h])           # 候选 call 起始（disp_pos-5 → 即 call+... 见下）
            # 重新按真实布局计算：disp 位于 call+1..call+4
            call = int(d[h]) - 4 - 1
            if call >= 0 and read(call, 1) == b"\xe8" and (call + 5 + struct.unpack("<i", read(call + 1, 4))[0]) == target:
                out.append(call)
    return sorted(set(out))
