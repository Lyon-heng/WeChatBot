# 单独安装 DSH

WeChatBot 安装包不再携带 DSH 桌面程序，也不自动下载或安装 DSH。安装包保留微信桥接插件及 SDK；当前插件验证版本为 0.2.0-rc.2。

1. 在“首次配置 → 安装并连接 DSH”点击“下载安装 DSH”，打开 [DSH 官方下载页面](https://www.deepseek.com/harness/)，选择 Windows 安装程序完成安装。已有可用 DSH 可继续使用。
2. 选择已安装的 `DeepSeek Harness.exe`，保存设置。也可以手动打开已配置好插件的 DSH，不填写自动启动路径。
3. 打开 DSH 一次完成初始化；从系统托盘完整退出 DSH，在本页点击“一键导入到 DSH”。导入结束后重新打开 DSH，登录自己的模型账号，点击“重新检查”。不支持导入命令的旧版可复制本机插件路径，在 DSH 插件页面手动添加并启用。
4. 从托盘完整退出并重新打开 DSH，再启动 WeChatBot 服务。模型提供方和模型标识沿用连接设置。

安装链接由系统浏览器打开，不会在后台执行下载到的程序。网页搜索、技能、表情图库和会话仍通过同一个本机桥接插件提供。

DSH 的账号、会话、附件和缓存由独立安装的 DSH 管理，通常不属于 WeChatBot 所选的 `data` 目录。原先已单独安装的 DSH 及其数据位置保持原样。

旧版升级不会自动删除原内置 DSH 程序或会话数据，也不会把它重新复制到新的运行环境中。已有旧程序路径仍可暂时继续使用；需要改用独立安装时，在连接设置选择新位置。两个独立 DSH 数据目录不会自动合并，旧数据保留供核对和迁移。

构建新安装包无需准备 DSH 程序或设置 `WECHATAGENT_DSH_SOURCE`；仍需准备项目插件 SDK、Python、Node.js、匹配微信与发送组件。打包清单明确记录 `dshBundled: false`。

## 一键导入本项目插件

入口位于“配置向导 → 连接 DSH”以及“设置 → 微信与 DSH → DSH 插件目录”。先保存程序位置，再从 DSH 系统托盘退出应用，点击“一键导入到 DSH”；导入通过操作进度面板显示结果，完成后点击“打开 DSH”。已有未保存草稿时先保存或放弃草稿。

实现调用已安装 DSH 自带的 Desktop CLI（`plugin --profile desktop add <本项目插件目录>`），保留 DSH 的配置锁、依赖安装与兼容性检查；不直接改写 DSH 的账号配置、会话或插件清单，不自动放开插件权限。下载依赖可能需要网络。插件导入成功不等于模型连接已就绪，仍需回到配置向导重新检查。

需要提供桌面 CLI 的 DSH 版本；不支持的旧版本提示升级或手动复制路径。未初始化时提示先打开一次，运行中提示从托盘退出，版本冲突不会自动豁免。超时后先在 DSH 插件页面核对是否已安装，再决定是否重试。旧版原内置 DSH 的自定义数据目录沿用已有启动配置。

官方 CLI 行为参考：[DSH Desktop 插件管理](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.md#bundled-command-runtime)及[插件管理器](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/plugin-manager/README.md)。

## 桌面启动报 Web authentication failed

部分DSH桌面版本在反复重启后累积本地dsh-auth认证Cookie，可能超过本地HTTP服务的请求头限制。这与模型API密钥错误不同，不应清空模型、插件或会话配置。

从系统托盘完整退出DSH，再通过WeChatBot打开DSH。新的启动入口会先检查本地临时认证缓存，私有备份后只清理127.0.0.1的dsh-auth条目；如果DSH仍在运行则跳过，备份失败则保留原数据并停止操作。备份在当前数据目录state/dsh-auth-backups内，不应上传仓库或公开分享。

上游复现与恢复记录：[认证Cookie累积导致HTTP431](https://github.com/deepseek-ai/deepseek-harness/discussions/11239)。后续官方修复仍应优先使用官方版本；这里不修改DSH程序文件或关闭认证。
