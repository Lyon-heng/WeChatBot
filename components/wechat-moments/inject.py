# 通用注入器：把指定 DLL 注入到指定进程并调用一个无参导出。
#
# 只用于我们自己的组件与探针（WeChatMoments*.dll / moments-probe.dll）。
# 设计上刻意做得很窄：DLL 固定、导出必须显式指定、不做参数传递（远端线程只传一个指针，
# 传字符串会引出跨进程内存管理的坑）。
import argparse
import ctypes
import ctypes.wintypes as wt
import json
import subprocess
import sys
from pathlib import Path

k32 = ctypes.WinDLL('kernel32', use_last_error=True)
k32.OpenProcess.argtypes = [wt.DWORD, wt.BOOL, wt.DWORD]
k32.OpenProcess.restype = wt.HANDLE
k32.VirtualAllocEx.argtypes = [wt.HANDLE, wt.LPVOID, ctypes.c_size_t, wt.DWORD, wt.DWORD]
k32.VirtualAllocEx.restype = wt.LPVOID
k32.WriteProcessMemory.argtypes = [wt.HANDLE, wt.LPVOID, wt.LPCVOID, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
k32.WriteProcessMemory.restype = wt.BOOL
k32.CreateRemoteThread.argtypes = [wt.HANDLE, wt.LPVOID, ctypes.c_size_t, wt.LPVOID, wt.LPVOID, wt.DWORD, wt.LPDWORD]
k32.CreateRemoteThread.restype = wt.HANDLE
k32.WaitForSingleObject.argtypes = [wt.HANDLE, wt.DWORD]
k32.WaitForSingleObject.restype = wt.DWORD
k32.GetExitCodeThread.argtypes = [wt.HANDLE, ctypes.POINTER(wt.DWORD)]
k32.GetExitCodeThread.restype = wt.BOOL
k32.GetModuleHandleW.argtypes = [wt.LPCWSTR]
k32.GetModuleHandleW.restype = wt.HMODULE
k32.GetProcAddress.argtypes = [wt.HMODULE, wt.LPCSTR]
k32.GetProcAddress.restype = wt.LPVOID
k32.CloseHandle.argtypes = [wt.HANDLE]
psapi = ctypes.WinDLL('psapi', use_last_error=True)
psapi.EnumProcessModulesEx.argtypes = [wt.HANDLE, ctypes.POINTER(wt.HMODULE), wt.DWORD, ctypes.POINTER(wt.DWORD), wt.DWORD]
psapi.EnumProcessModulesEx.restype = wt.BOOL
psapi.GetModuleBaseNameW.argtypes = [wt.HANDLE, wt.HMODULE, wt.LPWSTR, wt.DWORD]
psapi.GetModuleBaseNameW.restype = wt.DWORD

PROCESS_ALL = 0x1F0FFF
MEM_COMMIT_RESERVE = 0x3000
PAGE_READWRITE = 0x04


def find_pid(image):
    out = subprocess.run(['tasklist', '/FI', f'IMAGENAME eq {image}', '/FO', 'CSV', '/NH'],
                         capture_output=True, text=True, encoding='utf-8', errors='replace').stdout
    rows = []
    for line in out.splitlines():
        parts = [p.strip('"') for p in line.split('","')]
        if len(parts) >= 2 and parts[0].lower() == image.lower():
            rows.append(int(parts[1]))
    return rows


def remote_call(handle, address, argument=None, timeout=8000):
    """在目标进程里起一个线程执行 address(argument)，返回线程退出码。"""
    thread = k32.CreateRemoteThread(handle, None, 0, ctypes.c_void_p(address),
                                    ctypes.c_void_p(argument or 0), 0, None)
    if not thread:
        raise OSError(f'CreateRemoteThread 失败：{ctypes.get_last_error()}')
    try:
        k32.WaitForSingleObject(thread, timeout)
        code = wt.DWORD(0)
        k32.GetExitCodeThread(thread, ctypes.byref(code))
        return code.value
    finally:
        k32.CloseHandle(thread)


def find_remote_module(handle, name):
    """列出目标进程模块，按文件名找到基址（64 位，不能用线程退出码代替）。"""
    LIST_MODULES_ALL = 0x03
    needed = wt.DWORD(0)
    psapi.EnumProcessModulesEx(handle, None, 0, ctypes.byref(needed), LIST_MODULES_ALL)
    if not needed.value:
        return 0
    count = needed.value // ctypes.sizeof(wt.HMODULE)
    array = (wt.HMODULE * count)()
    if not psapi.EnumProcessModulesEx(handle, array, needed.value, ctypes.byref(needed), LIST_MODULES_ALL):
        return 0
    buffer = ctypes.create_unicode_buffer(260)
    for module in array[:needed.value // ctypes.sizeof(wt.HMODULE)]:
        if psapi.GetModuleBaseNameW(handle, module, buffer, 260) and buffer.value.lower() == name.lower():
            return module or 0
    return 0


def inject(pid, dll, exports, use_arg=None):
    dll = Path(dll).resolve()
    if not dll.exists():
        raise SystemExit(f'找不到 DLL：{dll}')
    handle = k32.OpenProcess(PROCESS_ALL, False, pid)
    if not handle:
        raise SystemExit(f'打不开进程 {pid}（权限不足？试试管理员身份）：{ctypes.get_last_error()}')
    report = {'pid': pid, 'dll': str(dll), 'steps': []}
    try:
        path_bytes = str(dll).encode('utf-16-le') + b'\0\0'
        remote_path = k32.VirtualAllocEx(handle, None, len(path_bytes), MEM_COMMIT_RESERVE, PAGE_READWRITE)
        if not remote_path:
            raise SystemExit('分配远端内存失败')
        written = ctypes.c_size_t(0)
        if not k32.WriteProcessMemory(handle, ctypes.c_void_p(remote_path), path_bytes, len(path_bytes), ctypes.byref(written)):
            raise SystemExit('写入 DLL 路径失败')
        load_library = k32.GetProcAddress(k32.GetModuleHandleW('kernel32'), b'LoadLibraryW')
        remote_call(handle, load_library, remote_path)
        module_base = find_remote_module(handle, dll.name)
        report['steps'].append({'loadLibrary': hex(module_base) if module_base else 'not-found'})
        if not module_base:
            report['error'] = '注入后没能在目标进程模块列表里找到该 DLL'
            return report

        local = ctypes.WinDLL(str(dll))
        for name in exports:
            try:
                local_address = ctypes.cast(getattr(local, name), ctypes.c_void_p).value
            except AttributeError:
                report['steps'].append({'export': name, 'error': '导出不存在'})
                continue
            local_base = ctypes.cast(local._handle, ctypes.c_void_p).value
            remote_address = module_base + (local_address - local_base)
            report['steps'].append({'export': name, 'address': hex(remote_address), 'base': hex(module_base)})
            code = remote_call(handle, remote_address, use_arg)
            report['steps'].append({'export': name, 'return': code})
        return report
    finally:
        k32.CloseHandle(handle)


def main():
    parser = argparse.ArgumentParser(description='把组件/探针注入到指定进程并调用导出')
    parser.add_argument('--image', default='', help='按进程名找 PID，例如 Weixin.exe')
    parser.add_argument('--pid', type=int, default=0)
    parser.add_argument('--dll', required=True)
    parser.add_argument('--exports', default='', help='逗号分隔的导出名，按顺序调用')
    parser.add_argument('--check', action='store_true', help='只打印将要做什么，不注入')
    parser.add_argument('--arg', default='0', help='传给导出的单个整数参数（支持 0x 前缀）')
    args = parser.parse_args()

    pids = [args.pid] if args.pid else find_pid(args.image) if args.image else []
    if not pids:
        raise SystemExit('没有找到目标进程')
    exports = [x for x in (args.exports or '').split(',') if x]
    plan = {'pid': pids[0], 'dll': args.dll, 'exports': exports}
    if args.check:
        print(json.dumps({**plan, 'check': True}, ensure_ascii=False, indent=2))
        return
    try:
        report = inject(pids[0], args.dll, exports, int(args.arg, 0))
    except Exception as error:  # 出错也要把已完成的步骤打出来，方便定位
        print(json.dumps({'error': str(error)}, ensure_ascii=False, indent=2))
        raise SystemExit(1)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
