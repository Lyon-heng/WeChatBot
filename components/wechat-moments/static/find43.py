"""按“小鱼方案”的结构，在一份 Weixin.dll 上把朋友圈原生发送所需的常量推一遍。

用法：
    set WX_CORE=C:\\path\\to\\Weixin.dll
    python find43.py

纯只读：pefile 解析 PE + capstone 反汇编，不加载 DLL、不注入、不打开进程。
输出是证据，不是结论——每一条都带“为什么这么认为”，换核心必须重跑。
"""
import corelib as C


def accessors():
    """所有 `lea rax,[rcx+imm32]; ret` 小函数 → {rva: imm}。"""
    out, i = {}, -1
    while True:
        i = C.raw.find(b"\x48\x8d\x81", i + 1)
        if i < 0:
            break
        if C.raw[i + 7:i + 8] == b"\xc3":
            rva = C.to_rva(i)
            if rva:
                import struct
                out[rva] = struct.unpack_from("<i", C.raw, i + 3)[0]
    return out


def find_task_vtable():
    """找 SNS CGI 任务虚表：slot5==1，slot3/slot4 是两个偏移访问器且相差 0x1a0。"""
    acc = accessors()
    va, vsz, off, rsz = C.SEC[".rdata"]
    import numpy as np
    blob = C.raw[off:off + rsz]
    n = len(blob) // 8
    q = np.frombuffer(blob[:n * 8], dtype=np.uint64)
    found = []
    for p in range(0, n - 5):
        if q[p + 5] != 1:
            continue
        a3, a4 = int(q[p + 3]) - C.BASE, int(q[p + 4]) - C.BASE
        if a3 in acc and a4 in acc and 0x100 < acc[a4] - acc[a3] < 0x400:
            found.append((va + p * 8, [int(q[p + k]) - C.BASE for k in range(6)], acc[a3], acc[a4]))
    return found


def main():
    C.summary()
    print()
    cands = find_task_vtable()
    print(f"任务虚表候选：{len(cands)}")
    for vt, slots, o3, o4 in cands:
        st = C.read(slots[0], 4).hex()
        print(f"  {vt:#x} slots={[hex(s) for s in slots]} off3={o3:#x} off4={o4:#x} dtor={st}")
    print()
    print("下一步：对每个候选跑 xrefs(vt) 找写虚表的构造函数，再 calls_to(ctor) 找工厂，")
    print("工厂里 mov ecx,<size> + call 就是分配器，movaps/movups 取的 16 字节就是 info 模板。")


if __name__ == "__main__":
    main()
