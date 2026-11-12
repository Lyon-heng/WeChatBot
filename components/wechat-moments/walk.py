# 调用图漫游：给定一个地址，用 .pdata 拿到精确函数边界，反汇编整函数，
# 列出 CALL 目标（含目标函数大小）、LEA/MOV 指向的字符串、以及疑似 vtable 的数组。
#
# 只读，不加载、不注入。用法：
#   python walk.py <Weixin.dll> <地址> [--depth 2]
import argparse
import bisect
import json
import sys
from pathlib import Path

import capstone
import pefile

md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)
md.detail = True


class Image:
    def __init__(self, path):
        self.pe = pefile.PE(str(path), fast_load=True)
        self.pe.parse_data_directories(
            directories=[pefile.DIRECTORY_ENTRY['IMAGE_DIRECTORY_ENTRY_EXCEPTION']])
        self.base = self.pe.OPTIONAL_HEADER.ImageBase
        self.sections = [(s.Name.rstrip(b'\0').decode('latin1'), s.VirtualAddress,
                          s.Misc_VirtualSize, s.PointerToRawData, s.SizeOfRawData, s.get_data())
                         for s in self.pe.sections]
        self.text = next(s for s in self.sections if self.pe.sections[
            [x[0] for x in self.sections].index(s[0])].Characteristics & 0x20000000)
        self.funcs = []
        try:
            for entry in self.pe.DIRECTORY_ENTRY_EXCEPTION:
                start = entry.struct.BeginAddress
                end = entry.struct.EndAddress
                if 0 < start < end:
                    self.funcs.append((start, end))
            self.funcs.sort()
            self.starts = [f[0] for f in self.funcs]
        except Exception:
            pass

    def containing(self, rva):
        if not self.funcs:
            return None
        i = bisect.bisect_right(self.starts, rva) - 1
        if i < 0:
            return None
        start, end = self.funcs[i]
        return (start, end) if start <= rva < end else None

    def read(self, rva, size=64):
        for name, va, vsize, rawptr, rawsize, blob in self.sections:
            if va <= rva < va + rawsize:
                at = rva - va
                return blob[at:at + size]
        return b''

    def is_text(self, rva):
        return self.text[1] <= rva < self.text[1] + self.text[2]

    def is_rdata(self, rva):
        for name, va, vsize, rawptr, rawsize, blob in self.sections:
            if va <= rva < va + rawsize:
                return name not in ('.text', '.data') and not (va <= rva < va + 1)
        return False

    def string_at(self, rva, size=60):
        raw = self.read(rva, size)
        if not raw:
            return None
        cut = raw.split(b'\0')[0]
        if len(cut) < 3:
            return None
        try:
            text = cut.decode('utf-8')
        except UnicodeDecodeError:
            return None
        printable = sum(1 for ch in text if ch.isprintable())
        return text if printable == len(text) else None

    def vtable_score(self, rva, entries=6):
        """.rdata 里连续指向 .text 的 8 字节指针数组，很像 vtable。"""
        raw = self.read(rva, 8 * entries)
        if len(raw) < 8 * entries:
            return 0
        good = 0
        for i in range(entries):
            ptr = int.from_bytes(raw[i * 8:(i + 1) * 8], 'little') - self.base
            if self.is_text(ptr):
                good += 1
            else:
                break
        return good


def walk(image, rva, depth, seen, out, level=0):
    if depth < 0 or rva in seen:
        return
    seen.add(rva)
    bounds = image.containing(rva)
    if not bounds:
        return
    start, end = bounds
    blob = image.read(start, end - start)
    calls, leas, vtables = [], [], []
    for insn in md.disasm(blob, start):
        if insn.mnemonic in ('call', 'jmp') and insn.operands:
            op = insn.operands[0]
            if op.type == capstone.x86.X86_OP_IMM:
                target = op.imm
                if image.is_text(target):
                    inner = image.containing(target)
                    calls.append({'at': hex(insn.address), 'target': hex(target),
                                  'funcSize': (inner[1] - inner[0]) if inner else 0})
        if insn.mnemonic == 'lea' and len(insn.operands) == 2:
            op = insn.operands[1]
            if op.type == capstone.x86.X86_OP_MEM and op.mem.base == capstone.x86.X86_REG_RIP:
                target = insn.address + insn.size + op.mem.disp
                text = image.string_at(target)
                if text:
                    leas.append({'at': hex(insn.address), 'target': hex(target), 'text': text[:60]})
                score = image.vtable_score(target)
                if score >= 3:
                    vtables.append({'at': hex(insn.address), 'target': hex(target), 'entries': score})
    node = {
        'func': hex(start), 'size': end - start, 'level': level,
        'calls': calls[:40], 'strings': leas[:20], 'vtableCandidates': vtables[:10],
    }
    out.append(node)
    for call in calls[:12]:
        if call['funcSize'] and call['funcSize'] < 0x3000:
            walk(image, int(call['target'], 16), depth - 1, seen, out, level + 1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('dll')
    parser.add_argument('address')
    parser.add_argument('--depth', type=int, default=1)
    parser.add_argument('--out', default='')
    args = parser.parse_args()
    image = Image(args.dll)
    out = []
    walk(image, int(args.address, 16), args.depth, set(), out)
    if args.out:
        Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding='utf-8')
    for node in out:
        pad = '  ' * node['level']
        print(f"{pad}func {node['func']}  size=0x{node['size']:X}")
        for item in node['strings'][:6]:
            print(f"{pad}   str  @{item['at']} -> {item['text']!r}")
        for item in node['vtableCandidates'][:4]:
            print(f"{pad}   vtab @{item['at']} -> {item['target']} ({item['entries']} 项)")
        for item in node['calls'][:8]:
            print(f"{pad}   call @{item['at']} -> {item['target']}  (size 0x{item['funcSize']:X})")


if __name__ == '__main__':
    main()
