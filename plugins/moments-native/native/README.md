# 原生通道：把「正文」直接交给微信自己发（小鱼方案）

这套办法来自 [waaakong/xiaoyu](https://github.com/waaakong/xiaoyu) 的 `integrations/wechat/moments-native`：
不点界面、不模拟按键，而是在微信进程里**自己造一个 SNS 的 CGI 任务对象**，填进报文，交给它自己的网络管理器派发。

```
写稿 → TimelineObject XML → protobuf（SnsPostRequest）
     → 44 字节头（0x314d5958 + 请求 UUID + 长度）
     → 组件在微信进程里：new 任务(0x2b8) → 构造 → 填报文 → 派发
     → 服务端 ret=0 且返回 objectId 才算受理
```

一次加载只放行**一包内容**（哈希绑定），`/submit` 第二次直接 409：这是防止重发、防止内容被换掉的关键约束，本插件不绕过。

## 为什么必须“按版本一套常量”

组件里的函数地址是写死的。微信换个构建，整个 `.rdata` / `.text` 都会挪位置，地址全错。
所以组件开头先跑 `exact_build()`（ImageSize + 18 处字节指纹）和账号目录核验，对不上就**拒绝加载**——宁可发不出去，也不能把错地址当函数调，那是直接崩客户端。

## 本机：4.1.10.27（wechatwb 内置微信）

核心 `f487e4f56930456a25fb0d7b058c77e2dcd364e268d49bdfff4dc0e3be26ba36`，ImageSize `0xaf0e000`。
下面这些是**静态定位并结构自证**过的（详见 `constants-4.1.10.27.json`）：

| 常量 | 值 | 怎么确认的 |
| --- | --- | --- |
| `POST_VTABLE` | `0x8b5d768` | 6 项虚表、slot5=1；slot3/slot4 是 `lea rax,[rcx+0xf0]` / `[rcx+0x290]` 两个访问器 |
| `POST_CTOR` | `0x4eb3c50` | `mov [rcx],0x8b5d768`，随后在 `+0xf0` 造请求消息、`+0x290` 造回执持有对象 |
| `POST_INFO` | `0x8b5d2f0` | 16 字节模板 `d1 00…00 01 00 00 00`，工厂取它之后紧接着写 cmdId `209` |
| `ALLOCATE` / `FREE` | `0x680d0fc` / `0x680d140` | 工厂 `mov ecx,0x2b8` 后调用，MSVC `operator new` / `delete` |
| `TASK_SIZE` | `0x2b8` | 工厂分配长度 |
| `REQ_OFFSET` / `RES_OFFSET` | `0xf0` / `0x290` | 虚表 slot3 / slot4 的访问器反汇编 |
| `MESSAGE_CTOR` / `MESSAGE_VTABLE` | `0x4da2bb0` / `0x8b3df78` | 前者在 `+0xf0` 被调用；后者紧跟 protobuf 描述串 `micromsg.SnsPostRequest` |
| `HOLDER_CTOR` | `0x4da2cd0` | 在 `+0x290` 被调用，0x28 字节，`+0x18` 指向空串单例 |
| `FACTORY` / `SEND_WRAPPER` | `0x4eb3910` / `0x4eb34d0` | `alloc → ctor → 拷报文 → call [manager_vtable+0x28]` 的完整序列 |

**还差三项**（`constants-4.1.10.27.json` 的 `missing`）：

1. `ROOT_GLOBAL` —— 网络管理器的根全局。派发时 `rcx` 是管理器，它由上层发布链放进参数结构 `P[0]`，还没追到静态全局。
2. `MANAGER_VTABLE` —— 管理器虚表。已知 `slot5`（`+0x28`）就是派发入口，缺的是它的 `.rdata` 基址。
3. `PROTO_FILL` —— 把我们的 protobuf 字节填进 `SnsPostRequest`。客户端在自己的发布链里直接构造报文（`0x4EAE7F0`），组件走的是 `0x4dbf670` 的“从既有报文拷贝”，**字节→消息** 的 `ParseFromArray` 还没定位。

三项齐了才能投递。补齐之前，组件的 `/health` 会返回 `verified:false`，`/submit` 直接拒绝——这是设计如此。

## 补齐的办法（不需要真的发一条）

1. **`PROTO_FILL` 用往返测试验**：消息虚表 `0x8b3df78` 的解析槽 + 回执持有对象 `0x8b3dff8`，把一份已知报文解析后再序列化出来，和输入逐字节比对。对得上就说明填充正确，**全程不联网、不投递**，不会触发风控。
2. **`ROOT_GLOBAL` 用只读校验**：候选根全局读出来当指针用，必须满足 `root[0]` 是 `.rdata` 里的虚表、`[root+0x2c8]` 的管理器虚表 `slot5` 落在 `.text`。对不上就换下一个候选，纯读内存。
3. 两项都过，再用一条**私密**内容做首次真实投递，核对服务端 `objectId` 与时间线。

## 工具

静态定位脚本在工作区 `components/wechat-moments/static/`（`corelib.py` + `find43.py`）：
纯 PE 只读解析（pefile + capstone + numpy），不加载 DLL、不注入、不碰进程。
换核心时改 `WX_CORE` 环境变量重新跑，就能把上面的表再推一遍。

## 风险

- 不要在发布状态机（`0x4EAB7D0` 这类长函数）或协程函数上布防单步：实测两次导致微信自行退出。
- 常量错一项 = 把数据当地址调用，客户端直接崩。所以组件坚持 `exact_build` + vtable 逐项校验。
