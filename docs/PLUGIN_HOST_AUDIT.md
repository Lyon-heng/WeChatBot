# 插件宿主与内置包检查

此页记录当前仓库可以重复执行的插件检查，避免把“ZIP 可生成”误写成“插件已在真实微信环境完整运行”。

## 覆盖范围

`scripts/plugin-host-check.mjs` 会检查：

- 插件契约中的权限/能力与目录校验器是否一致。
- DSH 宿主文件、语音编解码载荷及许可证/来源哈希是否齐全。
- worker 握手、宿主健康字段、项目版本指纹和控制台契约路由是否已接入。
- 每个内置插件清单能否校验，以及控制台展示列表是否和内置包清单同版本。
- 如要求 ZIP 校验，会解包比较 ZIP 与源码并校验 SHA-256。

## 日常维护

```powershell
node scripts/pack-bundled-plugins.mjs
node scripts/plugin-host-check.mjs --root .
git diff --check
```

新增或升级首方插件时，更新 `optional-extensions/<id>/`、`packages/plugin-api/bundled.mjs` 和 `public/console/plugin-contract.mjs`；随后重新打包。检查器会拒绝包清单与界面目录的 ID 或版本不一致。

改宿主权限、能力、worker 或服务实现时，检查 `packages/plugin-api/contract.mjs`、`catalog.mjs`、`worker.mjs`、`process.mjs`、DSH 健康接口，以及 `scripts/project-config.mjs` 的版本指纹文件清单。`history.day` 与 `media.search/read` 必须同时在 worker API、宿主权限校验和实际服务注入中存在；仅把 feature 名写进 manifest 不能证明功能可用。契约行为变化时递增 `CONTRACT_REVISION`，并确认新宿主与 worker 的握手一致。

## 验证边界

宿主检查只覆盖文件、契约和包一致性。它不启动 DSH、不安装或启用插件、不调用真实模型或媒体 API，也不向微信发送消息。插件服务运行依赖项仍需逐项用本地隔离测试验证；真实账号、授权和发送路径需在运行程序中由用户确认。

目前部分旧测试脚本仍引用运行时 `plugins/` 安装目录，个别媒体用例依赖未安装的 `htmlparser2`。在这些准备完成前，其失败不能被当成插件业务逻辑已通过或失败的结论。测试脚本与源码的差异应在后续维护中逐步消除。
