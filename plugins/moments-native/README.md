# 朋友圈发布（moments-native）

版本 2.0.0

按当前人设写一条朋友圈，然后用**小鱼（[waaakong/xiaoyu](https://github.com/waaakong/xiaoyu)）的原生组件协议**真正投递出去。

旧版 `moments-autopilot` 只能把正文 POST 给一个 Pad 协议网关，本机 Hook 没有朋友圈路由，所以“自动发布”经常落回发件箱。这一版换掉了发布层：正文会被编码成微信自己那套 `mmsnspost` 报文，交给微信进程里已加载的原生组件发出，再用服务端返回的对象 ID 核对。

## 一条朋友圈真正发出去要经过什么

1. **写稿**：人设 + 当天聊天片段 → 一条 30～80 字的正文（`lib/content.mjs`）。
2. **编码**：正文 → `TimelineObject` XML → protobuf → 44 字节头（魔数 `XYM1` + 请求标识 + 长度），得到一包**定稿报文**（`lib/protocol.mjs`）。
3. **授权**：把报文哈希交给原生组件加载器，组件在微信进程里只放行**这一包**内容（`prepare` 产出提案文件，加载器读它）。
4. **投递 + 核对**：`POST /submit` 把报文交给组件，组件调微信自己的 `mmsnspost`（CGI 209）；返回 `ret=0` 且有 64 位对象 ID 才算服务端受理，真实内容还要在手机上或只读会话里回读（`lib/native-client.mjs`、`lib/publish.mjs`）。

报文结构（与小鱼逐字节一致）：

```
偏移 0   4 字节 魔数 0x314d5958（'XYM1'）
偏移 4   36 字节 请求标识 UUID（ascii）
偏移 40  4 字节 后续长度
偏移 44  protobuf：
         1 = 设备信息（空串 + Windows 平台字段）
         2 = 正文缓冲 { 1: XML 长度, 2: TimelineObject }
         7 = 请求标识
         3,5,6,8,9,11,13,16 = 0（保留位，非 0 会被加载器判为“未审核的可见范围”）
```

`TimelineObject` 里 `contentStyle=2`（纯文字）、`private=0`（公开）、`mediaList` 必须为空——图片/视频这一版不碰。

## 三条通道

| 通道 | 行为 | 能否全自动 |
| --- | --- | --- |
| `native` | 交给小鱼原生组件投递，一次加载只发一条 | 否，每条要人工授权加载 |
| `gateway` | `POST {gatewayUrl}{gatewayPath}`，Pad 协议服务那一套 | 能，但依赖你自己部署的服务 |
| `outbox` | 只写进 `state/moments-native/outbox/` | —— 不会假装发布 |
| `auto` | 有组件走组件，其次网关，最后发件箱 | 视情况 |

**为什么原生通道不能全自动**：小鱼组件的安全设计就是“一次加载、一条内容、一次提交”，`/submit` 第二次直接回 409。这是防止重复发、防止内容被换掉的关键约束，插件不绕过它。要无人值守，用网关通道。

## 本机现状（诊断结果，别跳过）

`diagnose` 会扫描本机所有 `Weixin.dll` 并比对哈希：

| 微信核心 | SHA-256 前缀 | 状态 |
| --- | --- | --- |
| `C:\Program Files\Tencent\Weixin\4.2.0.12` | `2b3677c3f932daaa…` | 未登记（不是本应用在跑的那份） |
| 本应用 Hook 用的 `4.1.10.27` | `f487e4f56930456a…` | **已登记**：8 项常量已定位，缺 `ROOT_GLOBAL` / `MANAGER_VTABLE` / `PROTO_FILL` |
| 小鱼官方适配的 `4.2.0.13` | `afe3d02c58bada3c…` | 已登记，常量齐全 |

原生组件里的函数地址是**按精确构建写死**的（4.2.0.13 是 `XY_POST_CTOR=0x58c71a0`、`XY_MANAGER_DISPATCH=0x35f490`…；4.1.10.27 是 `POST_CTOR=0x4eb3c50`、`POST_VTABLE=0x8b5d768`…），换版本就全错，组件自己的 `exact_build()` 会拒绝加载。所以：

- 内置微信（4.1.10.27）的常量推导进度、证据和补齐办法见 [`native/README.md`](native/README.md) 与 [`native/constants-4.1.10.27.json`](native/constants-4.1.10.27.json)。三项补齐前原生通道投递不了，组件会**拒绝加载**而不是乱发。
- 现在就发：把 `channel` 设成 `uia`（或留 `auto`，可用时它会优先走界面通道），它不注入进程、不会让微信退出；也可以接 Pad 协议网关走 `gateway`。

## 从组件加载到投递

组件不在本仓库里，也不随插件打包。流程（在 xiaoyu 仓库里执行）：

```powershell
# 1. 构建（需要 Zig 0.15.2，脚本只读精确核心文件，不加载）
python scripts/build-wechat-moments.py

# 2. 生成本插件的提案，拿到 packetSha256
#    聊天里发 prepare，或直接看 state/moments-native/proposals/*.json

# 3. 加载组件，绑定这一条内容
python scripts/load-wechat-moments.py --confirm-sha256 <DLL哈希> --proposal <提案json> --confirm-content-sha256 <packetSha256>

# 4. 会话文件拷到本插件认识的路径，然后 publish-now
#    state/moments-native/session.json（或插件设置 sessionFile 指向它）
```

提案文件字段与 xiaoyu 的 `proposals/*.json` 兼容（`kind`、`requestId`、`account`、`text`、`visibility`、`created`（毫秒）、`packetSha256`、`packetFile`、`coreSha256`），可以直接喂给他们的加载脚本。

## 聊天里的命令

| 命令 | 作用 | 预算 |
| --- | --- | --- |
| `status` | 通道、组件是否在线、今天发了几条、最近一条正文 | 毫秒级 |
| `preview` | 让插件自己写一条草稿给你看；写不出来就如实说 | ≤5.2 秒 |
| `prepare` | 让插件写一条并生成定稿报文 | ≤5.2 秒 |
| `prepare-text` | **把聊天模型写好的正文**编码成定稿报文（不调模型，几十毫秒） | 毫秒级 |
| `publish-text` | **把聊天模型写好的正文**直接发出去（需 `confirm=true`） | 秒级 |
| `publish-now` | 投递一条已授权提案（不调模型） | 秒级 |
| `diagnose` | 扫微信核心哈希（带缓存）、查组件会话、给结论 | ≤6.7 秒 |

> **2026-11-09 实测教训**：这台机器的模型单次生成要 30 秒以上（日志里 `reply (31.4s)`、`reply (38.7s)`），而宿主给插件工具的上限是 8 秒、模型接口上限 25 秒。连内置的 `fish-notebook` 也在反复 `OPERATION_TIMEOUT`。所以**插件自己写稿在这套环境下必然超时**，正确用法是让聊天模型写正文、用 `prepare-text` / `publish-text` 交给插件编码投递——这条路径实测 86 毫秒完成。

**为什么有些活儿不放在工具里**：宿主对插件工具的调用硬上限是 8 秒（`plugin-api` 里 `toolTimeoutMs` 最大就是 8000），而模型写一条要 6～20 秒。工具里硬等就会表现成「小工具卡住」，宿主随即掐断调用——聊天里那句「预览的小工具这会儿卡住啦」就是这么来的。

所以慢活儿注册成**动作**（宿主给 35 秒），由每日计划或接口触发：

| 动作 | 作用 |
| --- | --- |
| `draft` | 完整生成一条草稿存进发件箱 |
| `prepare` | 完整生成定稿报文与待授权材料 |
| `publish` | 投递最近一条待授权提案 |

接口：`POST /api/plugins/moments-native/actions/draft`，body `{"key":"wechat:private:1513137368"}`，头带 `x-console-token`。

## 安全边界（刻意保留的“笨”）

- **不自动重试**：一次投递失败就停手，重试可能变成两条重复动态；状态里如实写 `unknown`。
- **不换正文**：本地先比对 `sha256(报文) === 组件授权哈希`，不符直接拒绝，不发去让组件判。
- **不谎报**：落发件箱就叫“已存发件箱”；服务端受理也只是一句“仍需在手机核对”。
- **单条计数**：同一条提案在 `state.json` 的 `attempted` 里留痕，重复调用会被拦下。
- **只公开文字**：其他可见范围、图片、视频都没验证过，代码直接拒绝，不做“试试看”。

## 目录

```
plugins/moments-native/
├── plugin.json          清单元数据、设置项与配置表单
├── index.mjs            每日计划 + status/preview/prepare/publish-now/diagnose
└── lib/
    ├── protocol.mjs     XYM1/XYM3 报文构建与解析、自检、文本校验
    ├── native-client.mjs 组件 HTTP 客户端：健康核验、单次提交、动态库哈希
    ├── publish.mjs      native / gateway / outbox 三通道，回读核对
    ├── content.mjs      人设 + 当天聊天 → 正文
    ├── diagnose.mjs     本机微信核心扫描与结论
    └── state.mjs        提案、发件箱、当天计数
```

## 自测

```bash
node lib/diagnose.mjs <工作区根目录>   # 环境诊断
```

协议层与投递链路另外做过两轮离线验证（24 项报文/解析用例、9 项假组件投递用例），覆盖：魔数与长度字段、XML 转义与还原、控制字符/超长/非 wxid 拒绝、`ret!=0` 判不受理、64 位对象 ID 不丢精度、未授权正文本地拦截、组件身份不符拒绝、重复提交被 409 拦下。

## 界面通道（uia）：目前唯一能真正发出的通道

4.1.10.27 上，原生组件通道需要精确版本常量（缺 5 个，且实测继续追会让客户端自行退出），
协议网关需要外部服务。所以默认改走**界面操作**：

```
长按朋友圈相机图标（900ms）→ 弹出纯文字编辑框 → 粘贴正文 → 点“发表” → 校验编辑框已关闭
```

- 不注入、不改内存、不改注册表，**不会让微信退出**；
- 实测一次 6.8 秒（动作预算 35 秒，够用）；
- 前提：电脑解锁、微信在前台、“发现 → 朋友圈”页面处于打开状态；
- 失败时如实返回“没发出去：原因”，绝不谎报。

实现文件：

| 文件 | 作用 |
| --- | --- |
| `lib/uia.mjs` | 把正文写临时文件，调用 `tools/uia-publish.mjs`，解析结果 |
| `../../components/wechat-moments/tools/uia-publish.mjs` | 编排：枚举窗口 → 置前 → 长按相机 → 点输入框 → 粘贴 → 点发表 → 复核 |
| `../../components/wechat-moments/rpa.c` | `click / hold / paste / key / fg`（SendInput + 剪贴板） |
| `../../components/wechat-moments/winlist.c` | 枚举微信窗口（UTF-8 输出，避免控制台编码问题） |
| `../../components/wechat-moments/shot.c` | 窗口截图（BMP），用于回读核对 |

坐标不写死：全部按窗口 rect 相对计算（主窗口 `x+w-40, y+55` 是相机；编辑窗口 `+150,+90` 是输入框、`+144,+377` 是发表）。

设置里的 `channel` 可填 `uia`；填 `auto` 时若界面通道可用会优先用它（这样不用等应用刷新枚举）。
