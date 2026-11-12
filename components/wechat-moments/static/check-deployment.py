#!/usr/bin/env python
"""部署清单一致性检查。

启动器（app/resources/app/deployment.cjs）会按 deployment.json 的 files 列表逐个
readFileSync 复制到工作区。清单里只要有一个文件不存在，启动就会直接失败：
    ENOENT: no such file or directory, open '...\\xxx.dll'

用法：
    python check-deployment.py            # 默认查 app/resources/project
    python check-deployment.py <project_dir>

检查三件事：
1. files 里每个路径都存在且是普通文件
2. sourceHashes 里每个路径都存在，且 sha256 与文件一致
3. 提示 files 与 sourceHashes 的条目差（不是错误，仅提示）
"""
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def locate():
    """从脚本位置向上找清单，不写死层级（脚本放哪都能跑）。
    优先找启动器真正读取的那份：<root>/app/resources/project/deployment.json，
    找不到再退回任意一层目录下的 deployment.json。"""
    base = HERE
    for _ in range(8):
        candidate = os.path.join(base, "app", "resources", "project")
        if os.path.exists(os.path.join(candidate, "deployment.json")):
            return candidate
        base = os.path.dirname(base)
    base = HERE
    for _ in range(8):
        if os.path.exists(os.path.join(base, "deployment.json")):
            return base
        base = os.path.dirname(base)
    return HERE


def main(argv):
    root = os.path.abspath(argv[1]) if len(argv) > 1 else locate()
    manifest = os.path.join(root, "deployment.json")
    if not os.path.exists(manifest):
        print("找不到清单:", manifest)
        return 2

    data = json.load(open(manifest, encoding="utf-8"))
    files = data.get("files", [])
    hashes = data.get("sourceHashes", {})

    missing = [f for f in files if not os.path.isfile(os.path.join(root, f))]
    bad_hash = []
    gone_hash = []
    for rel, want in hashes.items():
        path = os.path.join(root, rel)
        if not os.path.isfile(path):
            gone_hash.append(rel)
            continue
        got = hashlib.sha256(open(path, "rb").read()).hexdigest()
        if got != want:
            bad_hash.append((rel, want[:12], got[:12]))

    print(f"清单: {manifest}")
    print(f"files {len(files)} 项 / sourceHashes {len(hashes)} 项")
    print(f"缺失文件: {len(missing)}")
    for item in missing:
        print("   MISS", item)
    print(f"哈希表指向不存在文件: {len(gone_hash)}")
    for item in gone_hash:
        print("   GONE", item)
    print(f"哈希不符: {len(bad_hash)}")
    for rel, want, got in bad_hash:
        print(f"   DIFF {rel}  {want} -> {got}")

    only_files = [f for f in files if f not in hashes]
    print(f"（提示）没有哈希记录的 files 条目: {len(only_files)}")
    for item in only_files[:8]:
        print("   NOHASH", item)

    return 0 if not missing and not gone_hash else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
