"""朋友圈原生组件加载器（微信 4.1.10.27 / wechatwb 内置核心）。

一次加载只授权一包正文：
  1. 读定稿报文 → 算 sha256（approvedHash）
  2. 找到加载了 Weixin.dll 的那个微信进程
  3. 写组件配置（令牌 + 授权哈希）到 %TEMP%\\wb-moments-token.txt
  4. 注入 wb_moments.dll 并调用 WbMomentsStart
  5. 健康核验后写 session.json，插件按它投递

用法：
  python load.py --packet proposal/packet.bin [--pid 15176] [--port 31990]
"""
import argparse
import ctypes
import hashlib
import json
import os
import secrets
import sys
import time
import urllib.request
from ctypes import wintypes
from pathlib import Path

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
k32.OpenProcess.restype = wintypes.HANDLE
k32.CloseHandle.argtypes = [wintypes.HANDLE]

HERE = Path(__file__).resolve().parent
CONFIG = Path(os.environ.get("TEMP", r"C:\Users\Administrator\AppData\Local\Temp")) / "wb-moments-token.txt"


def core_pids():
    """加载了 Weixin.dll 的进程：复用 inject.py 里已经验证过的 tasklist + EnumProcessModulesEx。"""
    sys.path.insert(0, str(HERE))
    import inject as inj
    out = []
    for pid in inj.find_pid("Weixin.exe"):
        handle = k32.OpenProcess(0x1F0FFF, False, pid)
        if not handle:
            continue
        try:
            if inj.find_remote_module(handle, "Weixin.dll"):
                out.append(pid)
        finally:
            k32.CloseHandle(handle)
    return out


def inject(pid, dll, export):
    sys.path.insert(0, str(HERE.parent / "wechat-moments"))
    import inject as inj  # 复用已有的注入实现
    return inj.inject(pid, str(dll), [export], 0)


def health(port, token):
    request = urllib.request.Request(f"http://127.0.0.1:{port}/health",
                                     headers={"Authorization": "Bearer " + token})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=5) as response:
        return json.load(response)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--packet", required=True, help="定稿报文文件（44 字节头 + protobuf）")
    parser.add_argument("--pid", type=int, default=0)
    parser.add_argument("--port", type=int, default=31984)
    parser.add_argument("--dll", default=str(HERE / "bin/wb_moments_r1.dll"))
    parser.add_argument("--root", default=str(HERE.parents[1]), help="工作区根（写 session.json）")
    parser.add_argument("--wxid", default="")
    parser.add_argument("--account-dir", default="")
    parser.add_argument("--result", default="", help="结果写这个 JSON 文件（给 Node 轮询用，避免管道阻塞）")
    args = parser.parse_args()

    def finish(payload, code=0):
        if args.result:
            Path(args.result).write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return code

    try:
        return _run(args, finish)
    except SystemExit as error:
        return finish({"ok": False, "error": str(error)}, 1)
    except Exception as error:  # noqa: BLE001
        return finish({"ok": False, "error": f"{type(error).__name__}: {error}"}, 1)


def _run(args, finish):
    packet = Path(args.packet).read_bytes()
    if len(packet) < 44:
        raise SystemExit("报文太短：至少要有 44 字节头")
    approved = hashlib.sha256(packet).hexdigest()
    token = secrets.token_hex(32)
    CONFIG.write_text(token + "\n" + approved + "\n", encoding="utf-8")

    pid = args.pid or (core_pids() or [0])[0]
    if not pid:
        raise SystemExit("没找到加载了 Weixin.dll 的微信进程")

    dll = Path(args.dll)
    if not dll.is_file():
        raise SystemExit(f"组件不存在：{dll}")
    report = inject(pid, dll, "WbMomentsStart")
    returns = [step.get("return") for step in report.get("steps", []) if "return" in step]
    if not returns or returns[-1] not in (0, 1):
        raise SystemExit(f"组件启动失败：{json.dumps(report, ensure_ascii=False)}")

    info = {}
    for _ in range(20):
        time.sleep(0.25)
        try:
            info = health(args.port, token)
            break
        except Exception:
            continue
    if not info.get("build") or not info.get("manager"):
        raise SystemExit(f"健康核验未通过：{info or '无响应'}")

    session = {
        "pid": pid,
        "port": args.port,
        "token": token,
        "approvedHash": approved,
        "accountDirectory": args.account_dir,
        "wxid": args.wxid,
        "dllPath": str(dll),
        "dllSha256": hashlib.sha256(dll.read_bytes()).hexdigest(),
        "healthVerified": True,
        "operation": "post",
        "proposalId": approved[:12],
        "loaded": True,
    }
    target = Path(args.root) / "state/moments-native/session.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(session, ensure_ascii=False, indent=2), encoding="utf-8")
    return finish({"ok": True, "pid": pid, "port": args.port, "session": str(target),
                   "approvedHash": approved, "health": info})


if __name__ == "__main__":
    main()
