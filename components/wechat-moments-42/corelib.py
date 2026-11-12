"""Weixin.dll 静态分析基础库（只读 PE）。

通过环境变量 WX_CORE 指定核心文件；所有地址为 RVA。
"""
import bisect
import hashlib
import os
import struct
import sys
from pathlib import Path

import numpy as np
import pefile
import capstone

CORE_PATH = Path(os.environ.get("WX_CORE", r"C:\Program Files\Tencent\Weixin\4.2.0.12\Weixin.dll"))
pe = pefile.PE(str(CORE_PATH), fast_load=True)
BASE = pe.OPTIONAL_HEADER.ImageBase
IMAGESIZE = pe.OPTIONAL_HEADER.SizeOfImage
raw = CORE_PATH.read_bytes()
SHA256 = hashlib.sha256(raw).hexdigest()
SECTIONS = [
    (s.Name.rstrip(b"\x00").decode(), s.VirtualAddress, s.Misc_VirtualSize, s.PointerToRawData, s.SizeOfRawData)
    for s in pe.sections
]
SEC = {n: (va, vsz, off, rsz) for n, va, vsz, off, rsz in SECTIONS}


def read(rva, n):
    for name, va, vsz, off, rsz in SECTIONS:
        if va <= rva < va + max(vsz, rsz):
            start = off + (rva - va)
            return raw[start:start + n]
    return b""


def qword(rva):
    return struct.unpack("<Q", read(rva, 8))[0]


def dword(rva):
    return struct.unpack("<I", read(rva, 4))[0]


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


_TEXT = SEC[".text"]
_TRAW = raw[_TEXT[2]:_TEXT[2] + _TEXT[3]]
_VIEWS = []
for _o in range(4):
    _cnt = ((len(_TRAW) - _o) // 4) * 4
    _v = np.frombuffer(_TRAW, dtype=np.int32, count=_cnt // 4, offset=_o)
    _d = np.int64(_TEXT[0] + _o) + np.arange(_v.size, dtype=np.int64) * 4 + 4
    _VIEWS.append((_v, _d))


def xrefs(target, chunk=16_000_000):
    """rip 相对引用 target 的 disp32 位置（指令起始通常为 该值-3）。"""
    out = []
    for v, d in _VIEWS:
        for start in range(0, v.size, chunk):
            seg = v[start:start + chunk].astype(np.int64)
            hit = np.nonzero(seg + d[start:start + chunk] == target)[0]
            out.extend(int(d[start + h]) - 4 for h in hit)
    return sorted(out)


def calls_to(target):
    out = []
    for v, d in _VIEWS:
        seg = v.astype(np.int64)
        for h in np.nonzero(seg + d == target)[0]:
            call = int(d[h]) - 5
            if call >= 0 and read(call, 1) == b"\xe8":
                if call + 5 + struct.unpack("<i", read(call + 1, 4))[0] == target:
                    out.append(call)
    return sorted(set(out))


_pd = SEC[".pdata"]
_praw = raw[_pd[2]:_pd[2] + _pd[3]]
_FUNCS = []
for _i in range(0, len(_praw) - 11, 12):
    _b, _e, _u = struct.unpack_from("<III", _praw, _i)
    if _b and _e > _b and _b < IMAGESIZE:
        _FUNCS.append((_b, _e))
_FUNCS.sort()
_FSTART = [f[0] for f in _FUNCS]


def func_of(rva):
    i = bisect.bisect_right(_FSTART, rva) - 1
    if i < 0:
        return None
    b, e = _FUNCS[i]
    return (b, e) if b <= rva < e else None


_md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)
_md.detail = True


def disas(rva, n=0x200, count=4000):
    rows = []
    for ins in _md.disasm(read(rva, n), BASE + rva):
        rows.append((ins.address - BASE, ins.mnemonic, ins.op_str, ins))
        if len(rows) >= count:
            break
    return rows


def fmt(rows):
    return "\n".join(f"{a:#x}  {m} {o}" for a, m, o, _ in rows)


def qrefs(addr, sections=(".rdata", ".data")):
    """绝对 qword 指针等于 addr 的位置（vtable / 指针表）。"""
    pat = struct.pack("<Q", addr)
    out, i = [], -1
    while True:
        i = raw.find(pat, i + 1)
        if i < 0:
            break
        r = to_rva(i)
        if r is not None:
            for name, va, vsz, off, rsz in SECTIONS:
                if va <= r < va + max(vsz, rsz) and name in sections:
                    out.append(r)
    return out


def rip_target(ins):
    """指令里唯一的 rip 相对操作数目标 RVA。"""
    for op in ins.operands:
        if op.type == capstone.x86.X86_OP_MEM and op.mem.base == capstone.x86.X86_REG_RIP:
            return ins.address + ins.size + op.mem.disp - BASE
    return None


def summary():
    print(f"core   : {CORE_PATH}")
    print(f"sha256 : {SHA256}")
    print(f"base   : {BASE:#x}  imagesize: {IMAGESIZE:#x}  size: {len(raw):#x}")
