# 静态分析：为 4.1.10.27 定位朋友圈（SNS）调用链的候选地址。
#
# 只读：把 Weixin.dll 当数据解析，不加载、不注入、不连微信。
# 输出的是“候选”，不是结论——每个候选都要在组件里靠 vtable 逐项比对 + 只读对象验收才算数。
import json
import sys
from pathlib import Path

import capstone
import pefile

KEYWORDS = [b'/cgi-bin/micromsg-bin/mmsnspost', b'mmsnspost', b'SnsPublishTask', b'SnsPublishPanel', b'TimelineObject']


def load(path):
    pe = pefile.PE(str(path), fast_load=True)
    pe.parse_data_directories(directories=[pefile.DIRECTORY_ENTRY['IMAGE_DIRECTORY_ENTRY_EXCEPTION']])
    image = pe.OPTIONAL_HEADER.ImageBase
    text = next(s for s in pe.sections if s.Characteristics & 0x20000000)
    return pe, image, text


def find_strings(pe):
    hits = []
    for section in pe.sections:
        if section.Characteristics & 0x20000000:
            continue
        blob = section.get_data()
        for keyword in KEYWORDS:
            at = blob.find(keyword)
            while at >= 0:
                hits.append({'rva': section.VirtualAddress + at, 'rva_hex': hex(section.VirtualAddress + at),
                             'text': blob[at:at + 80].split(b'\0')[0].decode('utf-8', 'replace')})
                at = blob.find(keyword, at + 1)
    return hits


def find_xrefs(pe, text, targets):
    """在 .text 里找 lea/mov r64, [rip+disp] 指向目标字符串的位置。"""
    blob = text.get_data()
    base = text.VirtualAddress
    md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)
    md.detail = True
    xrefs = {}
    wanted = {t for t in targets}
    # 先粗筛候选字节，再反汇编确认，避免整段线性反汇编 100MB
    for match in range(len(blob) - 8):
        if blob[match] not in (0x48, 0x4C):
            continue
        if blob[match + 1] not in (0x8D, 0x8B):
            continue
        if blob[match + 2] & 0xC7 != 0x05:
            continue
        for insn in md.disasm(blob[match:match + 7], base + match):
            for op in insn.operands:
                if op.type == capstone.x86.X86_OP_MEM and op.mem.base == capstone.x86.X86_REG_RIP:
                    target = insn.address + insn.size + op.mem.disp
                    if target in wanted:
                        xrefs.setdefault(target, []).append(insn.address)
            break
    return xrefs


def context(text, at, count=24):
    """反汇编目标附近的指令，列出 CALL / LEA 目标，方便顺着调用图往下走。"""
    blob = text.get_data()
    base = text.VirtualAddress
    start = max(0, at - base - 96)
    md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)
    md.detail = True
    rows = []
    for insn in md.disasm(blob[start:start + 320], base + start):
        if insn.address > at + 96:
            break
        note = ''
        if insn.mnemonic == 'call':
            note = 'CALL ' + insn.op_str
        elif insn.mnemonic in ('lea', 'mov') and 'rip' in insn.op_str:
            note = insn.mnemonic + ' ' + insn.op_str
        if note:
            rows.append({'at': hex(insn.address), 'insn': note})
        if len(rows) >= count:
            break
    return rows


def main(path, out):
    pe, image, text = load(path)
    strings = find_strings(pe)
    targets = {s['rva'] for s in strings}
    xrefs = find_xrefs(pe, text, targets)
    report = []
    for item in strings:
        entries = []
        for at in xrefs.get(item['rva'], [])[:4]:
            entries.append({'xref': hex(at), 'context': context(text, at)})
        report.append({**item, 'imageBase': hex(image), 'xrefs': entries})
    Path(out).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'字符串命中 {len(strings)} 个，其中被代码引用 {sum(1 for r in report if r["xrefs"])} 个')
    for item in report:
        if item['xrefs']:
            print(f"  0x{item['rva']:X} {item['text'][:40]!r} → {len(item['xrefs'])} 处引用")
            for entry in item['xrefs'][:2]:
                for row in entry['context'][:6]:
                    print(f"      {row['at']}  {row['insn']}")


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
