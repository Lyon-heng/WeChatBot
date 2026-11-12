"""WeChat 朋友圈探针注入器（只读观测）。

用法：
  python inject.py inject                 注入 wbprobe.dll（不装钩子）
  python inject.py call ProbePing         调用导出函数（无参）
  python inject.py call ProbeStart        按 probe.config 安装钩子
  python inject.py call ProbeStop         卸载钩子
  python inject.py scan "文本"            在微信进程内搜文本并回溯对象头
  python inject.py log [行数]             查看探针日志
"""
import ctypes
import ctypes.wintypes as wt
import os
import sys
import time

import pefile

DLL = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'wbprobe.dll')
LOG = os.path.join(os.environ.get('LOCALAPPDATA', ''), 'WeChatMomentsProbe', 'probe.log')

k32 = ctypes.WinDLL('kernel32', use_last_error=True)
k32.OpenProcess.restype = wt.HANDLE
k32.OpenProcess.argtypes = [wt.DWORD, wt.BOOL, wt.DWORD]
k32.VirtualAllocEx.restype = ctypes.c_void_p
k32.VirtualAllocEx.argtypes = [wt.HANDLE, ctypes.c_void_p, ctypes.c_size_t, wt.DWORD, wt.DWORD]
k32.WriteProcessMemory.argtypes = [wt.HANDLE, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t,
                                   ctypes.POINTER(ctypes.c_size_t)]
k32.CreateRemoteThread.restype = wt.HANDLE
k32.CreateRemoteThread.argtypes = [wt.HANDLE, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p,
                                   ctypes.c_void_p, wt.DWORD, ctypes.POINTER(wt.DWORD)]
k32.GetModuleHandleW.restype = ctypes.c_void_p
k32.GetProcAddress.restype = ctypes.c_void_p
k32.GetProcAddress.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
k32.WaitForSingleObject.argtypes = [wt.HANDLE, wt.DWORD]
k32.GetExitCodeThread.argtypes = [wt.HANDLE, ctypes.POINTER(wt.DWORD)]
k32.CloseHandle.argtypes = [wt.HANDLE]

PROCESS_ALL = 0x1F0FFF
MEM_COMMIT_RESERVE = 0x3000
PAGE_RW = 0x04


def find_pid(name='Weixin.exe'):
    out = os.popen('tasklist /FI "IMAGENAME eq %s" /FO CSV /NH' % name).read()
    pids = []
    for line in out.splitlines():
        parts = [p.strip('"') for p in line.split('","')]
        if len(parts) >= 2 and parts[0].lower() == name.lower():
            try:
                pids.append(int(parts[1]))
            except ValueError:
                pass
    return pids


def export_rva(name):
    pe = pefile.PE(DLL, fast_load=True)
    pe.parse_data_directories(directories=[pefile.DIRECTORY_ENTRY['IMAGE_DIRECTORY_ENTRY_EXPORT']])
    for exp in pe.DIRECTORY_ENTRY_EXPORT.symbols:
        if exp.name and exp.name.decode() == name:
            return exp.address
    raise SystemExit('导出未找到: ' + name)


def module_base(pid, modname=None):
    modname = modname or os.path.basename(DLL)
    TH32CS_SNAPMODULE = 0x8
    TH32CS_SNAPMODULE32 = 0x10

    class MODULEENTRY32(ctypes.Structure):
        _fields_ = [('dwSize', wt.DWORD), ('th32ModuleID', wt.DWORD), ('th32ProcessID', wt.DWORD),
                    ('GlblcntUsage', wt.DWORD), ('ProccntUsage', wt.DWORD),
                    ('modBaseAddr', ctypes.c_void_p), ('modBaseSize', wt.DWORD),
                    ('hModule', wt.HMODULE), ('szModule', ctypes.c_char * 256),
                    ('szExePath', ctypes.c_char * 260)]

    snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid)
    if snap == wt.HANDLE(-1).value:
        return None
    me = MODULEENTRY32()
    me.dwSize = ctypes.sizeof(me)
    ok = k32.Module32First(snap, ctypes.byref(me))
    found = None
    while ok:
        if me.szModule.decode(errors='ignore').lower() == modname.lower():
            found = me.modBaseAddr
            break
        ok = k32.Module32Next(snap, ctypes.byref(me))
    k32.CloseHandle(snap)
    return found


def run_thread(h, addr, arg=None, timeout=15000):
    tid = wt.DWORD()
    th = k32.CreateRemoteThread(h, None, 0, ctypes.c_void_p(addr), ctypes.c_void_p(arg), 0, ctypes.byref(tid))
    if not th:
        raise OSError(ctypes.get_last_error(), 'CreateRemoteThread 失败')
    k32.WaitForSingleObject(th, timeout)
    code = wt.DWORD()
    k32.GetExitCodeThread(th, ctypes.byref(code))
    k32.CloseHandle(th)
    return code.value


def inject(pid):
    dll = DLL
    if not os.path.isfile(dll):
        raise SystemExit('缺少 ' + dll)
    h = k32.OpenProcess(PROCESS_ALL, False, pid)
    if not h:
        raise OSError(ctypes.get_last_error(), 'OpenProcess 失败（可能被保护）')
    try:
        path = dll.encode('utf-16-le') + b'\0\0'
        size = len(path)
        remote = k32.VirtualAllocEx(h, None, size, MEM_COMMIT_RESERVE, PAGE_RW)
        if not remote:
            raise OSError(ctypes.get_last_error(), 'VirtualAllocEx 失败')
        written = ctypes.c_size_t()
        if not k32.WriteProcessMemory(h, ctypes.c_void_p(remote), path, size, ctypes.byref(written)):
            raise OSError(ctypes.get_last_error(), 'WriteProcessMemory 失败')
        local_k32 = k32.GetModuleHandleW('kernel32.dll')
        addr = k32.GetProcAddress(local_k32, b'LoadLibraryW')
        code = run_thread(h, addr, remote)
        base = module_base(pid)
        print('inject exit=%s module_base=%s' % (code, hex(base) if base else 'None'))
        return 0 if base else 1
    finally:
        k32.CloseHandle(h)


def call(pid, name, arg=None):
    base = module_base(pid)
    if not base:
        raise SystemExit('wbprobe.dll 未加载，先 inject')
    h = k32.OpenProcess(PROCESS_ALL, False, pid)
    if not h:
        raise OSError(ctypes.get_last_error(), 'OpenProcess 失败')
    try:
        fn = ctypes.c_void_p(base + export_rva(name))
        argptr = None
        if arg is not None:
            data = arg.encode('utf-8') + b'\0'
            argptr = k32.VirtualAllocEx(h, None, len(data), MEM_COMMIT_RESERVE, PAGE_RW)
            written = ctypes.c_size_t()
            k32.WriteProcessMemory(h, ctypes.c_void_p(argptr), data, len(data), ctypes.byref(written))
        code = run_thread(h, fn.value, argptr, timeout=180000)
        print('%s -> %s' % (name, code))
        return code
    finally:
        k32.CloseHandle(h)


def show_log(lines=60):
    if not os.path.isfile(LOG):
        print('日志不存在:', LOG)
        return
    with open(LOG, 'r', encoding='utf-8', errors='replace') as f:
        content = f.read().splitlines()
    for line in content[-lines:]:
        print(line)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    cmd = sys.argv[1]
    pids = find_pid()
    if not pids:
        raise SystemExit('未找到 Weixin.exe 进程')
    pid = pids[0]
    if cmd == 'inject':
        inject(pid)
    elif cmd == 'call':
        call(pid, sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
    elif cmd == 'scan':
        call(pid, 'ProbeScanText', sys.argv[2])
    elif cmd == 'log':
        show_log(int(sys.argv[2]) if len(sys.argv) > 2 else 60)
    elif cmd == 'pids':
        print(pids)
    else:
        print(__doc__)


if __name__ == '__main__':
    main()
