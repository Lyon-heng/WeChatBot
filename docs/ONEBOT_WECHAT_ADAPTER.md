# OneBot v11 微信适配说明

## 协议定位

桥接使用 OneBot v11 风格的反向 WebSocket：WeChatBot 在本机回环地址监听，微信 Hook 作为 WebSocket 客户端连接；客户端推送事件，桥接按 OneBot JSON 动作格式发回请求并用 `echo` 关联响应。默认端口为 11229，路径为 `/ws`。

这里实现的是本项目所需的 OneBot v11 子集和微信扩展，不是完整 OneBot v11 平台，也不能直接当作通用 QQ 机器人接口。标准通信、鉴权和消息事件说明见 [OneBot v11 反向 WebSocket](https://github.com/botuniverse/onebot-11/blob/master/communication/ws-reverse.md)、[鉴权](https://github.com/botuniverse/onebot-11/blob/master/communication/authorization.md) 与 [消息事件](https://github.com/botuniverse/onebot-11/blob/master/event/message.md)。

## 项目约定与扩展

- 支持私聊和群聊文本、白名单内事件处理，以及项目自定义图片、文件、表情、引用、拍拍和回执字段。
- 微信联系人由本地读取器解析为合成的正整数 OneBot ID；它不是微信原始 ID。发送目标须通过本机联系人映射解析。
- `wechatagent` 字段、`wechat_sticker` 段、`file` 段及 `wechatagent_*` 动作参数是私有扩展，只由本项目两端识别。对普通 OneBot 实现只保证标准字段部分。
- 消息文本使用数组段形式；收到不支持的媒体类型时会拒绝该条消息，不把不可读内容伪装成文本。
- 发送回执要求本机微信服务返回新生成的服务器消息 ID。超时且已提交的动作可能结果未知，调用方不能盲目重试。

## 连接与安全

默认只绑定 `127.0.0.1`。监听非回环地址时必须设置 `Authorization: Bearer <token>`；令牌应通过本机受保护配置传递，不写入日志、issue 或版本库。为避免浏览器网页跨站访问本机服务，带 `Origin` 的 WebSocket 握手会被拒绝。服务只接受单个活动客户端，连接丢失会使未完成动作失败，Hook 客户端负责断线重连。

握手需使用 HTTP GET、WebSocket 版本 13、有效的 16 字节密钥和 `Connection: Upgrade`。客户端数据帧必须带掩码；仅接受 UTF-8 JSON 文本，拒绝超限帧、非法控制帧、未完成/嵌套分片和无效 UTF-8。

回环监听不等于跨用户安全边界。同一台电脑上的进程仍可尝试连接；不要将端口转发到公网或局域网。外部接入应使用受保护的隧道或本机代理，并确保令牌不被 URL、日志和进程列表泄漏。

## 变更要求

新增标准动作或事件时标明对应 OneBot v11 字段和响应语义；新增微信扩展时使用 `wechatagent` 命名空间，记录版本、方向、字段类型、大小限制、权限、回执语义及未知字段处理。同步更新两端适配器、隔离测试和本说明。禁止把聊天文本当配置或权限来源。

协议回归命令：

```powershell
npm run test:onebot-protocol
```
