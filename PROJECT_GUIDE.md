# WeChatBot 项目维护指南

这是继续开发、排障和发行的根目录入口，按 **0.5.1 功能基线**整理。使用说明见 [README](README.md)，专题索引见 [docs/README.md](docs/README.md)。已实现不等于已发布；版本字段、测试结果与 Release 附件需在构建时分别核对。

## 源码与运行副本

当前开发机源码在 `<源码目录>`。安装壳在 `<安装目录>\app\resources\app`，随程序部署的模板在 `app\resources\project`，活动工作区在 `<安装目录>\data\workspace`。修改从源码开始，不用运行快照代替源码。

活动配置、人格、用户插件、state、凭据和聊天数据库属于私有数据。恢复插件时只挑选已审核的代码和公开说明，不复制用户配置或存储。同步程序代码要保留上述目录；不要为了同步文案而重启程序、丢弃草稿或覆盖整份工作区。

## 从功能找到实现

| 功能 | 主要入口 |
| --- | --- |
| 桌面窗口、托盘、退出、文件定位 | desktop/main.cjs、preload.cjs、desktop-policy.cjs |
| 部署与数据目录 | desktop/main.cjs、storage-location.cjs、deployment.json |
| 页面结构与通用交互 | public/console/index.html、console.js、workspace-layout.js、motion.js/css |
| 配置向导与可选功能 | console.js、feature-setup.mjs |
| 插件页面与聊天分配 | public/console/plugins.js、packages/plugin-api/ |
| 微信读取/发送桥接 | scripts/hook-onebot.mjs、components/qq-bridge/ |
| 发送模式与隔离 | packages/wechat-send-policy.mjs、scripts/foreground-sender.*、public/console/send-mode-ui.mjs |
| DSH 模型与图片分流 | public/console/dsh-models.js、packages/dsh-social-bridge-plugin/model-routing.mjs、vision-fallback.mjs |
| 插件契约与包登记 | packages/plugin-api/contract.mjs、bundled.mjs、worker.mjs、process.mjs |
| 人物事实与群内互动记忆 | packages/plugin-api/people-memory.mjs、people-facts.mjs；DSH 插件 member-memory.mjs |
| 声音、音色、外接 API 与投递 | packages/voice-studio/、scripts/voice-console.mjs、voice-delivery-worker.mjs |
| 原生语音编解码 | packages/voice-codec/、scripts/native-hook/VOICE_NOTICE.txt |
| 表情与群聊提醒 | public/console/sticker-manager.js、scripts/hook-onebot.mjs、qq-bridge 的 group-mentions.js |
| 安装器与构建 | packaging/windows/、scripts/sync-and-package.ps1、build-release.ps1 |

从路由、调用者和配置字段继续向下追踪，表格不是可独立替换文件的白名单。改共享模块时检查两种发送模式、取消、权限和旧配置兼容。

## 插件维护

九个第一方产品插件在 optional-extensions，chat-notes 是独立开发示例。包下载目录由 bundled.mjs 唯一登记，不复制第二套版本表。插件默认不安装、不启用、不授权；界面分配与配置参数分开。

修改插件后运行包生成并核对 ZIP、SHA-256 及宿主契约。增加 API 要同步宿主、worker、权限标签、DSH 指纹文件及示例。改插件版本需同步唯一清单与所有引用；不能只改源码而继续提供旧 ZIP。

```powershell
node scripts/pack-bundled-plugins.mjs
node scripts/plugin-host-check.mjs --root .
```

DSH 插件与 WeChatBot ZIP 插件是不同生命周期；完整重开 DSH 才能加载需要重新注册的接口。独立子进程不等于安全沙箱。

## 日常迭代

1. 读 AGENTS.md、相关专题，检查 git status，保留已有改动。
2. 写清复现、预期、权限与数据影响，从实际入口修改。
3. 对配置验证默认值和旧配置；对发送验证独立编号、取消、超时与未知回执；对 UI 检查深色、窄窗口、返回和草稿。
4. 运行与改动相关的现有测试，不给真实聊天自动发测试消息。
5. 更新专题、README 入口与 RELEASE_NOTES，检查完整差异、链接和隐私边界。

常用隔离回归为 `node --test --test-reporter=spec scripts/test-*.mjs`，收尾用 `git diff --check`。只记录本次实际执行结果，不把历史测试数或一台机器的速度当作保证。

## 打包和发布

先输出变更与验证计划，再统一根 package、desktop package、安装器、脚本及部署清单版本，构建到新隔离目录。当前发行脚本只生成隔离载荷，不同步活动安装；需提供已审计二进制基线和精确匹配的客户端。仓库不提供完整模型或全部构建输入，默认值不能代替版本核对。

归档排除用户配置、state、凭据、用户插件和临时文件。验收新部署、升级保留、卸载数据边界，记录哈希与未覆盖项。源码、版本日志一起提交，安装器和便携包作为 Release 附件，不进入 Git。本次按维护者明确要求重建为仅含 0.5.1 的单提交仓库；后续普通更新保留新增历史，再次清理需当次明确授权。

详见[发行流程](docs/RELEASE_WORKFLOW.md)、[安装说明](docs/INSTALLER_RELEASE.md)、[GitHub 发布](docs/GITHUB_PUBLISHING.md)。

## 名称与兼容

界面使用 WeChatBot。以下标识需保留或经过独立迁移，不能全局替换：host: wechatagent、/WeChatAgent/*、X-WeChatAgent-*、wechatagent.json、WECHATAGENT_*、旧数据目录/进程识别及上游署名。仓库当前地址仍为 Lyon-heng/WeChatBot，名称不决定仓库可见性。

继续阅读：[目录边界](docs/PROJECT_LAYOUT.md) · [迭代流程](docs/ITERATION_WORKFLOW.md) · [路线图](docs/ROADMAP.md) · [数据管理](docs/DATA_STORAGE.md) · [品牌兼容](docs/BRANDING.md)。
