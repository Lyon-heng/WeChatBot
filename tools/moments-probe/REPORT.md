# 微信 4.1.10.27 朋友圈原生发布：逆向结项报告

日期：2026-11-09
目标版本：便携版 `Weixin.exe` 4.1.10.27（`state/hook/wechat-4.1.10.27/`）
核心文件：`4.1.10.27/Weixin.dll`，SHA-256 `f487e4f56930456a25fb0d7b058c77e2dcd364e268d49bdfff4dc0e3be26ba36`

## 结论

链路已定位到「派发前一步」，**未打通最后一环**，因此**没有可用的原生发布实现**。

- 已完成：命令号定位、发送器、任务类（构造/vtable/请求与响应位置）、分配器、端点常量、manager 实例。
- 缺一环：把自建 protobuf 灌入请求对象（`task+0xf0`）的解析入口。
- 原因：该客户端的 protobuf 消息**不使用标准 C++ vtable**，而是「类型描述符表 + 32 位相对偏移」，按虚拟槽位找 `ParseFromArray` 不成立。

## 定位方法（可复现）

1. **命令号立即数扫描**（关键突破）：搜 `c7 45 <disp> d1 00 00 00`（`mov dword ptr [rbp+disp], 0xD1`）与 `0xD2`，一次命中发表/详情入口。字符串 xref 全部为空，此路不通。
2. **RIP 相对地址必须用程序算**：`addr + insn_size + disp`。手工算错过一次，把 `.data` 的全局算进 `.pdata`，读出一串垃圾值。
3. **vtable 有两种编码**：任务类 vtable 是 8 字节绝对地址；protobuf 消息的「vtable」是 32 位相对偏移（`0x7ad` 之类）。混用会读出全零。
4. **只读校验**：所有内存读取先过 `VirtualQuery` 的 `MEM_COMMIT / !PAGE_GUARD / 可读`，再包 `__try/__except`。

## 已验证偏移（4.1.10.27，模块相对 RVA）

### 发表链路

| 名称 | RVA | 说明 |
|---|---|---|
| 发表发送器 | `0x4eb3910` | 全库唯一；构造 info → 建任务 → 序列化 → 派发 |
| 命令号 | `209` | 写入 `info+0x10` |
| 端点字符串 | `0x8b5da6c` | `/cgi-bin/micromsg-bin/mmsnspost`，长度 31 |
| 任务构造函数 | `0x4eb3c50` | `ctor(task, info)`；尺寸 `0x2b8` |
| 任务 vtable | `0x8b5d768` | `[0]0x4eb3f80 [1]0x4eb3e50 [2]0x4eb3f40 [3]0x103f30 [4]0x3993a90` |
| `vt[3]` | `0x103f30` | `lea rax,[rcx+0xf0]; ret` → **请求对象** |
| `vt[4]` | `0x3993a90` | `lea rax,[rcx+0x290]; ret` → **响应对象** |
| 请求消息构造 | `0x4da2bb0` | 消息头指针 → `0x8b7df78`（压缩表） |
| 响应消息构造 | `0x4da2cd0` | |
| 分配器 | `0x680d0fc` | 任务 `0x2b8`、端点缓冲 `0x20` 都用它 |
| 序列化 | `0x4dbf670` | `(requestObj, timelineObj)` |
| 派发 | `manager + 0x28` | `call [rax+0x28]`，参数 `(manager, task)` |

### info 结构（栈上，基址 = `rbp-0x50`）

| 偏移 | 值 |
|---|---|
| `+0x00` | 16 字节常量前缀（`movaps` 自 `0x8b5d2f0` 附近） |
| `+0x10` | `209`（uint32 命令号） |
| `+0x18` | 端点缓冲指针（堆上 32 字节） |
| `+0x28` | `31`（长度） |
| `+0x30` | `31`（容量） |
| `+0x38` | `1`（标志字节） |

### manager

```
0x410c0()            → mov rax,[0xA83AB20]; ret      ; 单例访问器
root   = *(0xA83AB20)                                 ; vt = 0x81b1c18
manager= *(root + 0x2c8)                              ; vt = 0x82214f8
dispatch = manager->vt[5] = 0x304f80
```

`root+0x2c8` 与参考项目 `waaakong/xiaoyu` 在 4.2.0.13 上用的偏移一致。

### 其它已确认

| 名称 | RVA |
|---|---|
| 详情接口命令号 | `210`（写入点 `0x2d6c2e0`） |
| 详情发送器 | `0x2d6c2a0` |
| 详情端点 | `/cgi-bin/micromsg-bin/mmsnsobjectdetail` @ `0x87c07ac` |
| 操作对象工厂 | `0x4eb33c0`（alloc `0x68`，`+8` 存 manager 的 shared_ptr） |
| 操作对象 vtable | `0x8b5d6c8` |
| 高层发布函数 | `0x4eb3090(rcx=out, rdx=service, r8=panel+0x20, r9=std::string*)` |
| 其调用者 | `0x4eb2cc0`（`call 0x410c0` 取 service） |
| 单例访问器 | `0x410c0` → 全局 `0xA83AB20` |

## 未解决的一环

需要把「SnsPostRequest」的 protobuf 字节写进 `task+0xf0` 指向的消息对象。

尝试过并失败的路径：

1. 按普通 vtable 槽位找 `ParseFromArray` → 该消息头是压缩表（32 位相对偏移），槽位语义不成立。
2. `0x680e444`（怀疑解析器）→ 实为 `xor edx,edx; jmp 0x680e48c` 的转发桩，第二个参数被丢弃。
3. 直接调用 `0x4eb3910` 需要 `TimelineObject` 实例；构造它同样绕不开消息解析。
4. 只读扫描 `.data` 找 manager → 命中 30+ 候选，但 `vt[5]` 全是 `0x5d99c0`（通用接口槽），最后靠单例字段扫描才定位到 `root+0x2c8`。

## 安全性记录（务必保留）

| 时间 | 触发 | 崩溃原因 | 处理 |
|---|---|---|---|
| 17:24 | `ProbeFindOwners` 只读扫描 | `FlushLog()` 未加锁就复位缓冲区长度，与扫描线程并发写同一块内存 → 越界 `0xC0000409` | 已修复：独占锁内取长度并归零，改循环 `WriteFile` |
| 17:51 | `ProbeAllocHunt` 钩 `RtlAllocateHeap` | 钩 ntdll 热函数 → `0xC0000005` | **已放弃堆钩子** |

**结论：不要在此客户端上做 Inline Hook。** 只读扫描（`VirtualQuery` + `__try`）未直接致崩。

## 微信启动方式（本机）

端口不是写在 ini 里，而是命令行参数：

```
Weixin.exe StartPort=31011 CallBackURL="http://127.0.0.1:8876/unused"
```

工作目录：`data/workspace/state/hook/wechat-4.1.10.27`
token 需与 `state/hook/native-token.txt` 一致。
不带参数启动会绑默认 `30001`，应用连不上。
Hook 鉴权：`Authorization: Bearer <token>`，健康检查 `GET /WeChatAgent/health`。
**从非交互会话启动 GUI 微信会自行退出，必须由用户在桌面双击 `启动微信.cmd`。**

## 如果继续做，下一步建议

1. 从 `0x680e48c`（`0x680e444` 的跳转目标）往下读，确认是否 `MergePartialFromCodedStream` 的通用实现。
2. 找 `0x4da2bb0` 所在模块（`0x4da***`）里与 `0x4dbf670` 相邻的解析函数——同一 TU 的概率高。
3. 退一步：定位 `TimelineObject` 的构造与 setter，用它代替直接灌 protobuf。
4. 若仍不通，考虑换客户端版本（参考项目支持 4.2.0.13）——但现有 Hook 全部版本锁定 4.1.10.27，换版本会导致收发消息失效。

## 产物

- `profile-4.1.10.27.json`：偏移清单
- `probe.c`：只读探针（含 Ping / 扫描 / 单例读取 / 字段扫描）
- `inject.py` / `capture.py`：注入与采集
- `build_probe.bat`：MSVC 构建（需手写 `PATH/INCLUDE/LIB`，`vcvars64.bat` 会调 `reg.exe` 被沙箱拦）
- 分析工具：`%TEMP%/wb-re/wxre.py`（pefile + capstone）
