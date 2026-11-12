"""朋友圈标定采集：被动监听，不挂钩子、不改微信逻辑。

用法（微信需登录、桌面需解锁）：
    python capture.py WBCALIB-20261109
然后立刻在微信里手动发一条朋友圈，正文包含同样的标记文本。
脚本会在后台轮询日志，抓到就打印对象结构；60 秒内没抓到会提示重试。
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import inject  # noqa: E402


def main():
    marker = sys.argv[1] if len(sys.argv) > 1 else 'WBCALIB-20261109'
    pids = inject.find_pid()
    if not pids:
        raise SystemExit('未找到 Weixin.exe，请先启动微信')
    pid = pids[0]
    base = inject.module_base(pid)
    if not base:
        print('探测模块未加载，正在注入…')
        inject.inject(pid)
        time.sleep(0.5)
        if not inject.module_base(pid):
            raise SystemExit('注入失败')
    start = 0
    if os.path.isfile(inject.LOG):
        start = os.path.getsize(inject.LOG)
    ret = inject.call(pid, 'ProbeWatchStart', marker)
    if ret != 0:
        raise SystemExit('ProbeWatchStart 返回 %s（可能已在监听）' % ret)
    print('已开始监听标记 %r，请在 60 秒内手动发一条包含该标记的朋友圈…' % marker)
    deadline = time.time() + 70
    captured = False
    while time.time() < deadline:
        time.sleep(2)
        if not os.path.isfile(inject.LOG):
            continue
        with open(inject.LOG, 'r', encoding='utf-8', errors='replace') as f:
            f.seek(start)
            fresh = f.read()
        if 'watch captured' in fresh:
            captured = True
            print(fresh)
            break
    if not captured:
        inject.call(pid, 'ProbeWatchStop')
        print('未捕获到标记。确认：①桌面已解锁 ②朋友圈正文含 %r ③发送时勿关闭微信' % marker)
        return 1
    print('=== 采集完成，把上面的 vtable_rva 与各 vt[i] 机器码发我即可继续 ===')
    return 0


if __name__ == '__main__':
    sys.exit(main() or 0)
