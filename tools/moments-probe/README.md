# 朋友圈原生链路标定探针

用来把参考项目 [waaakong/xiaoyu](https://github.com/waaakong/xiaoyu) 的「原生 SNS 发包」思路移植到本机微信 **4.1.10.27**。

参考项目的 DLL 硬编码了 4.2.0.13 的十几个私有偏移，本机版本不同，静态扫描无法唯一确定（详见 `.workbuddy/memory/2026-11-09.md`）。所以先做一次**被动标定**：在你手动发一条朋友圈时，把真实的 SNS 任务对象结构抓下来。

## 安全性

- 探针只读：不做 Inline Hook 时**完全不改微信任何代码**，只在私有内存里做 `memchr/memcmp` 扫描。
- 不发送任何网络请求，不读取聊天内容，只匹配你指定的那一条标记文本。
- 采集完成后 DLL 可随微信退出自然卸载；不写注册表、不持久化。

## 文件

| 文件 | 说明 |
|---|---|
| `probe.c` | 探针源码（MinHook 观测 + 内存扫描 + 被动监听） |
| `build_probe.bat` | 用 MSVC 构建 DLL，可传输出名如 `build_probe.bat wbprobe_new.dll` |
| `inject.py` | 注入 / 调用导出 / 看日志 |
| `capture.py` | 一条命令完成「注入 + 监听 + 抓取」 |
| `wbprobe3.dll` | 已构建产物（x64） |

导出函数：`ProbePing`、`ProbeStart`（按 `probe.config` 装钩子）、`ProbeStop`、`ProbeScanText`、`ProbeWatchStart` / `ProbeWatchStop`。

## 标定流程

1. 解锁 Windows 桌面（远程桌面需连上且不锁屏）。
2. 运行：

```bat
python capture.py WBCALIB-20261109
```

3. 在微信里手动发一条朋友圈，正文里带上 `WBCALIB-20261109`（纯 ASCII）。
4. 脚本抓到后会打印：对象地址、`vtable_rva`、vtable 前 5 项、每一项前 16 字节机器码、对象前 0x100 字节。

日志位置：`%LOCALAPPDATA%\WeChatMomentsProbe\probe.log`

## 从采集结果能得到什么

- `vtable_rva` → 静态反查 `lea rax,[rip+X]` 即得构造函数（4.1.10.27 的 `XY_POST_CTOR`）。
- `vt[3]` 的机器码若是 `488d81a8000000c3`，说明请求 protobuf 在对象 `+0xa8`，那份就是 `XY_PROTO_PARSE` 的目标缓冲。
- `vt[4]` 对应的响应缓冲偏移（4.2.0.13 是 `+0x248`）。
- 对象里出现的 cmd id（`0xd1` = 209）与端点字符串，用来确认确实是 SNS 发表任务。

拿到这些后再补 `manager dispatch` 与 `allocator`，就可以按参考项目的结构写 4.1.10.27 的 profile，实现真正不依赖界面的自动发布。
