# 加载器：把朋友圈组件按 PID 注入微信进程。
#
# 安全默认：不带 --load 时只做体检（进程、核心哈希、端口、DLL 哈希），不注入。
# 注入需要显式 --load --confirm-sha256 <DLL哈希> --content-sha256 <报文哈希>，
# 且同一个微信进程只允许加载一次（记录写在 session.json，先写后加载，失败不复试）。
import argparse
import ctypes
import hashlib
import json
import secrets
import socket
import struct
import sys
import time
import urllib.request
from pathlib import Path

CORE_SHA = 'f487e4f56930456a25fb0d7b058c77e2dcd364e268d49bdfff4dc0e3be26ba36'
HERE = Path(__file__).resolve().parent
SESSION = HERE / 'session.json'
k = ctypes.WinDLL('kernel32', use_last_error=True)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def find_wechat():
    """找正在运行的 Weixin.exe（本应用用的是内置 4.1.10.27）。"""
    import subprocess
    out = subprocess.run(['tasklist', '/FI', 'IMAGENAME eq Weixin.exe', '/FO', 'CSV', '/NH'],
                         capture_output=True, text=True, encoding='utf-8', errors='replace').stdout
    rows = []
    for line in out.splitlines():
        parts = [p.strip('"') for p in line.split('","')]
        if len(parts) >= 2 and parts[0].lower() == 'weixin.exe':
            rows.append(int(parts[1]))
    return rows


def module_path(pid, name='Weixin.dll'):
    """用 QueryFullProcessImageName 拿主模块路径；拿不到就返回 None。"""
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    handle = k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return None
    try:
        size = ctypes.c_ulong(32768)
        buffer = ctypes.create_unicode_buffer(size.value)
        if not k.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
            return None
        return buffer.value
    finally:
        k.CloseHandle(handle)


def health(port, token, timeout=3):
    request = urllib.request.Request(f'http://127.0.0.1:{port}/health',
                                     headers={'Authorization': 'Bearer ' + token})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=timeout) as response:
        return json.load(response)


def check(args):
    report = {'ok': False}
    pids = find_wechat()
    if not pids:
        report['error'] = '没有找到运行中的 Weixin.exe，请先启动微信'
        return report
    report['pids'] = pids
    pid = pids[0]
    exe = module_path(pid)
    report['exe'] = exe
    core = None
    if exe:
        direct = Path(exe).parent / 'Weixin.dll'
        if direct.exists():
            core = str(direct)
        else:
            found = sorted(Path(exe).parent.glob('*/Weixin.dll'))
            core = str(found[0]) if found else None
    report['core'] = core
    if core and Path(core).exists():
        actual = digest(core)
        report['coreSha256'] = actual
        report['coreMatched'] = actual == CORE_SHA
    dll = Path(args.dll)
    if dll.exists():
        report['dllSha256'] = digest(dll)
        report['dllMatched'] = args.confirm_sha256 is None or report['dllSha256'] == args.confirm_sha256
    else:
        report['error'] = f'找不到 DLL：{dll}'
        return report
    previous = json.loads(SESSION.read_text('utf-8')) if SESSION.exists() else None
    if previous and previous.get('pid') == pid:
        report['error'] = '这个微信进程已经加载过一次（session.json 有记录），不重复注入；重启微信后再试'
        return report
    report['ok'] = bool(report.get('coreMatched')) and bool(report.get('dllMatched'))
    if not report.get('coreMatched'):
        report['error'] = '微信核心哈希与组件目标版本不符，拒绝加载'
    return report


def load(args):
    """注入流程尚未完成：缺 Start 调用、健康核验与失败回滚。
    在常量（profile.h）全部验证通过之前，这里不提供真实注入，避免把未验证的调用打进微信。
    """
    report = check(args)
    report['ok'] = False
    report['blocked'] = '注入功能未完成：常量尚未定位，Start/验收步骤还没实现。当前只能 --check（默认）。'
    return report


def main():
    parser = argparse.ArgumentParser(description='朋友圈组件加载器')
    parser.add_argument('--dll', default=str(HERE / 'build/WeChatMoments.dll'))
    parser.add_argument('--port', type=int, default=11347)
    parser.add_argument('--account', default='')
    parser.add_argument('--wxid', default='')
    parser.add_argument('--confirm-sha256', default=None)
    parser.add_argument('--content-sha256', default=None)
    parser.add_argument('--load', action='store_true', help='真正注入（默认只体检）')
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        raise SystemExit('端口无效')
    print(json.dumps(check(args) if not args.load else load(args), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
