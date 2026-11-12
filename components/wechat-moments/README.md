# 朋友圈原生组件（wechat-moments）

给**本机这版微信**做一个能发朋友圈的注入式组件，思路与 shiyu（waaakong/xiaoyu）的
`moments-bridge` 一致：在微信进程里起一个只监听 `127.0.0.1` 的 HTTP 服务，收到
一包已授权的 XYM1 报文后，调用微信自己的 SNS 发送路径把动态发出去。

与小鱼的区别只有一个：**常量要按 4.1.10.27 这一版核心重新定位**（小鱼的常量是给 4.2.0.13 的）。

## 目标版本

| 项 | 值 |
| --- | --- |
| 微信版本 | 4.1.10.27（本应用 Hook 用的那一份） |
| 核心文件 | `data/workspace/state/hook/wechat-4.1.10.27/4.1.10.27/Weixin.dll` |
| 核心 SHA-256 | `f487e4f56930456a25fb0d7b058c77e2dcd364e268d49bdfff4dc0e3be26ba36` |
| 已找到的字符串 | `/cgi-bin/micromsg-bin/mmsnspost` @ RVA `0x8B5DA6C` |

## 需要定位的常量（`profile.h`）

| 名称 | 用途 | 状态 |
| --- | --- | --- |
| `WM_POST_INFO` | SNS 发送参数的信息块（16 字节，随后补 CGI 号 209、endpoint 指针、长度） | 待定位 |
| `WM_POST_CTOR` | SNS 发送参数对象的构造函数 | 待定位 |
| `WM_POST_VTABLE` | 该对象的 vtable，用于构造后逐一比对函数指针 | 待定位 |
| `WM_DETAIL_INFO` / `WM_DETAIL_CTOR` / `WM_DETAIL_VTABLE` | 只读对象（mmsnsobjectdetail）对应的一组 | 待定位 |
| `WM_ROOT_GLOBAL` | 全局根对象，`+0x2c8` 取到网络管理器 | 待定位 |
| `WM_MANAGER_VTABLE` / `WM_MANAGER_DISPATCH` | 管理器校验与派发函数 | 待定位 |
| `WM_ALLOCATE` | 微信自己的分配器 | 待定位 |
| `WM_PROTO_PARSE` | 原生 protobuf 解析 | 待定位 |
| `WM_HOLDER_DATA` / `WM_HOLDER_SIZE` | 从响应 holder 取字节与长度 | 待定位 |

**在这些常量全部验证通过之前，组件一律拒绝提交**（`profile.h` 里留 0，代码会判 0 并返回
未就绪），不会出现“猜一个地址试试”的情况。

## 阶段

1. **骨架 + 离线自测（已完成）**：`build.bat` 产出三个文件——`WeChatMomentsMock.dll`（模拟，
   永不调用微信）、`WeChatMoments.dll`（生产）、`mock-host.exe`（把模拟 DLL 装进独立进程做协议测试）。
   `tests/bridge-test.mjs` 实测 **18 项全通过**：健康核验、令牌缺失/带 Origin/未授权正文被拒、
   授权正文受理、回执 id 一致、重复提交 409、模拟模式下如实返回 `not-submitted`。
2. **常量定位（进行中）**：结论先说——**静态路线走不通**。
   | 目标字符串 | RVA | lea 引用 | 8 字节指针 | 4 字节 RVA |
   | --- | --- | --- | --- | --- |
   | `/cgi-bin/micromsg-bin/mmsnspost` | 0x8B5DA6C | 0 | 0 | 0 |
   | `SnsPostRequest` | 0x8B3DFE1 | 0 | 0 | 0 |
   | `SnsPostResponse` | 0x8B3E061 | 0 | 0 | 0 |
   | `SnsObject` | 0x8B3D911 | 0 | 0 | 0 |

   这版核心还把 RTTI 类型名（`.?AVSns*`）去掉了，所以既不能靠字符串引用定位，也不能靠
   类型名找 vtable。唯一有引用的是 `SnsPublishTask` 等几个名字，顺下去落在 SNS 存储层
   （`SnsTimeLine` 表、`tid/user_name/content/pack_info_buf` 字段），不是发送路径。

   3. **动态定位（下一步）**：`probe.c` 是为此写的原型——把目标字符串所在页设成不可读，
   谁读谁触发异常，用 VEH 记下 RIP，不修改任何代码。**目前这个原型还没跑通**（自测会以
   0xC0000005 退出），所以已从默认构建里移除，只作为实验代码保留。
   修好之后的做法是：在微信里手工发一条朋友圈，捕获真正的发送函数，再顺着它找管理器。
   这一步需要你在微信客户端上手动发一条动态作为触发，并且接受"微信可能崩一次"的风险。

4. **只读验收**：只加载组件、只做 `/health` 与 `mmsnsobjectdetail`（读一条已存在的动态），
   **不发任何新内容**。
5. **单条真实投递**：需要你明确批准后，才发一条测试动态。

`load.py` 目前只实现体检（`python load.py`），注入流程等常量就绪再补——不会先把半成品注入打进微信。

## 现在就能跑的三条命令

```powershell
cd components\wechat-moments
cmd /c build.bat                                  # 编译三个产物
python load.py                                    # 体检：进程、核心哈希、DLL 哈希
node tests\bridge-test.mjs                        # 协议自测（不碰微信）
```

体检实测：正在运行的微信核心 `f487e4f56930456a…` 与组件目标版本**完全一致**。

## 风险（必须知道）

- 调用错地址 = 微信进程崩溃。崩了重开即可，但正在跑的聊天自动化会中断。
- 这是对本机微信二进制的调用，属于客户端内部接口；**存在账号风控风险**，建议先在小号上验证。
- 组件一次加载只放行一条内容，这是刻意限制，不提供“重发”。

## 目录

```
components/wechat-moments/
├── profile.h            常量表（未验证的写 0，代码会拒绝执行）
├── moments-bridge.c     组件本体：HTTP 服务 + 报文校验 + 原生投递
├── build.ps1            用 MSVC 2022 编译（支持 -OfflineTest）
├── load.py              加载器（默认 --check-only，只体检不注入）
└── analyze.py           静态分析：定位 SNS 常量候选
```
