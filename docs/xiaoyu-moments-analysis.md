# 小鱼是怎么发朋友圈的（以及本应用怎么用上了它）

分析对象：[waaakong/xiaoyu](https://github.com/waaakong/xiaoyu)（小鱼 · AI 陪伴工作台），关注其朋友圈发布实现。

涉及文件：

| 文件 | 作用 |
| --- | --- |
| `src/wechat-moments-protocol.js` | 报文构建与解析（XYM1 / XYM3、TimelineObject、64 位 ID 读取） |
| `src/wechat-moments.js` | 业务层：草稿、提案、确认令牌、投递记录、回读核对 |
| `integrations/wechat/moments-native/moments-bridge.c` | 注入微信进程的 DLL：本地 HTTP 服务 + 调原生发送 |
| `scripts/build-wechat-moments.py` | 用 Zig 构建 DLL，写入精确构建的常量与哈希清单 |
| `scripts/load-wechat-moments.py` | 按 PID + `LoadLibraryW` 加载，绑定**一条**内容的哈希 |
| `scripts/wechat-moments-read-trial.mjs` | 只读会话：按 objectId 回读已发布对象做核对 |

## 一、它没有走 UI，也没有走 Hook

小鱼有三条发送路径（前台模拟、原生文字、朋友圈原生），朋友圈走的是**进程内原生调用**：

```
你的程序 ──HTTP(127.0.0.1:随机端口, Bearer)──▶ XiaoyuMoments.dll（在 Weixin.exe 进程内）
                                                     │
                                                     ├─ 用微信自己的分配器申请任务对象（XY_ALLOCATE）
                                                     ├─ 调 SNS 构造函数（XY_POST_CTOR / XY_DETAIL_CTOR）
                                                     ├─ 校验 vtable 与 5 个函数指针是否等于预期地址
                                                     ├─ 原生 protobuf 解析（XY_PROTO_PARSE）
                                                     └─ 交给微信任务管理器派发（XY_MANAGER_DISPATCH）
                                                            → /cgi-bin/micromsg-bin/mmsnspost（CGI 209）
                                                            → 服务端返回 ret + SnsObject.id
```

关键点：

- **先核对，再调用**。构造函数返回后不信任结果，而是把对象 vtable 与 5 个函数指针逐一比对（`0x58c74a0 / 0x58c7370 / 0x58c7460 / 0x115010 / 0x1eb5900`），不一致就整包丢掉。这是防止“版本不对却硬调”导致客户端崩溃的主要防线。
- **回执是回调拿的**。它临时替换任务对象的 vtable（`on_response` / `on_destroy`），从微信自己的响应回调里取 protobuf，而不是自己猜结果。
- **成功分两层**。`ret=0` 且有 64 位对象 ID 只代表“服务端受理”；真实内容要另开一次只读会话，用 `mmsnsobjectdetail`（CGI 210）把对象拉回来，比对 username、contentDesc 是否与提案一致。

## 二、报文长什么样

44 字节头 + protobuf：

| 偏移 | 内容 |
| --- | --- |
| 0 | 魔数 `0x314d5958`（`XYM1`，发朋友圈）/ `0x334d5958`（`XYM3`，读对象） |
| 4 | 36 字节 UUID（同时写进 protobuf 字段 7，用于把回执对回来） |
| 40 | 后续长度（uint32 LE） |
| 44 | protobuf 外壳 |

protobuf 外壳字段：`1`=设备信息（空串 + `Windows`），`2`=正文缓冲 `{1: XML 长度, 2: TimelineObject}`，`7`=请求标识，`3/5/6/8/9/11/13/16` 必须为 0（加载器会检查，非 0 视为“私自扩大可见范围”）。

`TimelineObject` 是微信服务端真正解析的那段 XML：

```xml
<TimelineObject>
  <id>0</id><username>wxid_xxx</username><createTime>1762...</createTime>
  <contentDesc>正文</contentDesc><contentattr>0</contentattr><private>0</private>
  <ContentObject><contentStyle>2</contentStyle>…<mediaList></mediaList></ContentObject>
</TimelineObject>
```

`contentStyle=2` + 空 `mediaList` = 纯文字；`private=0` = 公开。

解析回执时**绝不用 Number 接 64 位 ID**（朋友圈对象 ID 会超过 2^53），一律走 BigInt；超长、截断、字段重复、wire type 不认识，全部判失败。

## 三、四条安全约束（这才是它最值钱的部分）

1. **一次加载只放行一条内容**。加载器把正文哈希写进 DLL 启动配置，`/submit` 先算哈希再比对，不符直接拒绝；`/health` 也带 `limit:1`。想发第二条，只能重新加载。
2. **一次提交只尝试一次**。DLL 里 `admitted` 计数器用 `InterlockedCompareExchange` 守着，第二次直接 `409 already-attempted-do-not-retry`。结果未知（超时、崩溃）时**不重发**，只报 `unknown`，等人工核对。
3. **只读会话与发布会话分离**。回读对象用的是另一种魔数与 `operation=detail`，这类会话不允许发布新动态。
4. **加载是可核查的**：先核对微信 PID、Weixin.dll 哈希、账号目录（`wxid_xxx_4` 前缀），再用 `LoadLibraryW` 加载；加载前先把“将要加载”的状态写进 `session.json`，所以不确定的结果不会触发第二次注入。

结论：这套设计**故意不能无人值守**。想全自动，只能像它那样另接一个 Pad 协议网关。

## 四、为什么绑定 4.2.0.13 这个精确构建

`build-wechat-moments.py` 里的常量是 RVA（相对虚拟地址），全部针对核心 SHA-256 `afe3d02c58bada3c35009c0cd58ee1f57b2a00fe53237d0dce649107fddb9a20` 的 `Weixin.dll`：

```
XY_MANAGER_DISPATCH 0x35f490   XY_ROOT_GLOBAL 0xbd0fdf0   XY_MANAGER_VTABLE 0x90d3ec8
XY_POST_CTOR        0x58c71a0  XY_POST_INFO   0x9b5f390   XY_ALLOCATE       0x76a750c
XY_PROTO_PARSE      0x6abe50   XY_HOLDER_DATA 0x6ac610    XY_HOLDER_SIZE    0x6ac640
```

微信一升级，这些地址对应的函数就变了。DLL 内 `exact_build()` 会先比对核心哈希，不匹配直接拒绝启动——所以**换个版本不是“可能出问题”，而是根本不会加载**。要做别的版本，得用他们的 `wechat-moments-analyze.py` 重新做静态对比、再逐项验证，属于另一个量级的逆向工作。

## 五、本应用怎么运用

原来的 `moments-autopilot` 只能把正文 POST 给一个 Pad 协议网关，本机 Hook 又没有朋友圈路由，所以“自动发布”经常落回发件箱。新的 `plugins/moments-native` 换掉了发布层：

- `lib/protocol.mjs`：把上面那套报文完整实现（含自检 `selfCheck`、XML 转义、64 位 ID 读取、BigInt 边界）。
- `lib/native-client.mjs`：组件 HTTP 客户端，健康核验包含组件标识、`offlineTest`、`verified`、PID、账号目录、限额六项；提交前本地先比对哈希。
- `lib/publish.mjs`：三条通道（native / gateway / outbox）+ 回读核对；**任何通道都不自动重试**。
- `lib/diagnose.mjs`：扫描本机所有 `Weixin.dll` 与组件支持的哈希比对，并检查会话文件——先让人看清“现在到底能不能发”，再谈发布。
- `index.mjs`：每日写稿 + `status / preview / prepare / publish-now / diagnose` 五个命令；提案文件字段与 xiaoyu 的 `proposals/*.json` 兼容，可直接喂给他们的加载脚本。

离线验证（不碰微信、不发真实内容）：

- 报文与解析 24 项：魔数与长度字段、XML 转义还原、控制字符/超长/非 wxid 拒绝、`ret!=0` 判不受理、64 位 ID 不丢精度、篡改检测。
- 假组件投递 9 项：健康核验、单次提交受理、重复提交被 409 拦下、未授权正文本地拦截、组件标识不符拒绝。
- 假宿主跑插件 21 项：5 个工具注册、写稿、提案落盘与哈希一致、无 confirm 拒发、无会话如实说明、draft 只落草稿、同日不重复。

## 六、本机结论（诊断实测）

| 微信核心 | SHA-256 前缀 | 与组件匹配 |
| --- | --- | --- |
| `C:\Program Files\Tencent\Weixin\4.2.0.12` | `2b3677c3f932daaa…` | 否 |
| 本应用 Hook 用的 `4.1.10.27` | `f487e4f56930456a…` | 否 |
| 组件支持 | `afe3d02c58bada3c…`（4.2.0.13） | —— |

所以在这台机器上，原生通道暂时发不出去。两条可行路线：

1. **想尽快真发**：接一个支持发朋友圈的 Pad 协议网关，插件设 `channel=gateway`；
2. **想走原生**：把微信换成 4.2.0.13，按 xiaoyu 的 `build` / `load` 脚本构建并加载组件；或用分析脚本为自己的核心重新推导常量后**先只做只读核验**，确认对象能回读一致再考虑发布。

不管走哪条，插件都不会替你做“重试一次试试看”这种事——那正是重复动态的来源。
