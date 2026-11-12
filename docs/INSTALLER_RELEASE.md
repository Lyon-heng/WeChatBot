# Windows 安装、升级与发行包

本文说明当前源码的 Windows 打包方式。当前采用图形安装流程；旧 0.5.1 附件保持原样；实际公开下载以 [GitHub Releases](https://github.com/Lyon-heng/WeChatBot/releases) 为准。

## 包与依赖

| 附件 | 用途 |
| --- | --- |
| WeChatBot-Setup-0.5.5-x64.exe | 新构建使用 Electron Builder + NSIS 中文图形安装器，旧附件保持原样 |
| WeChatBot-0.5.5-portable-x64.zip | 新构建解压后双击根目录 WeChatBot.exe 或 app/WeChatBot.exe；不弹出命令窗口 |
| WeChatBot-voice-components.zip | 可选语音运行环境，在语音音色页选择 ZIP 导入；不包含所有模型 |
| SHA256SUMS.txt | 核对附件完整性 |
| VERIFICATION.json | 当前构建元数据；具体测试范围另见同版本日志 |

适用 Windows 10/11 x64。DSH 独立安装，清单记录 dshBundled: false。匹配微信目标为 4.1.10.27 x64，桥接 SDK 为 0.2.0-rc.2；发行前需核对真实二进制与清单一致。大型语音环境与模型不是插件 ZIP 的组成部分，可选运行组件也不等于完整模型。

## 安装与升级

选择根目录后，程序放 app，数据放同级 data。同位置升级保留已有数据路径及账号配置、人格、插件、状态和桌面配置。换位置按迁移流程确认来源和目标，保留原副本；微信数据库与外部 DSH 数据不跟随助手目录自动搬移。磁盘空间按实际附件、解压体积及备份需求预留。

升级前保存未提交编辑，停止服务并完整退出旧助手；要替换微信或 DSH 相关组件时再退出对应程序。升级后重新准备连接配置，涉及插件接口更新需从 DSH 托盘完整退出并重开。不要只关闭窗口后就判断插件已经重新加载。

首次启动默认配置向导，初始聊天允许范围为空。新导航、音乐、发送模式及插件与聊天页见[界面说明](UI_LAYOUT.md)。名字变化不改变稳定插件 ID，旧数据目录继续兼容。

窗口“×”收起到托盘；退出程序有序停止本实例服务，保留外部微信与 DSH。图形安装器遇到程序占用时提示保存并完整退出，可重试或取消，不自动强制结束进程。新版卸载入口位于 Windows“已安装的应用”和 app/Uninstall WeChatBot.exe；卸载仅删除安装时记录的程序文件，保留 data、storage.ini 及额外放入的文件，用户数据清理需单独处理。详见[数据位置](DATA_STORAGE.md)、[退出行为](EXIT_SHUTDOWN.md)。

## 构建边界

语音环境附件使用已登记 ZIP，构建可传 `-VoiceComponentsZip <ZIP路径>`；同步脚本也会查找开发机对应的 `release/artifacts-<组件登记版本>/`。校验通过后原样附带，不从活动数据重新压缩。未提供时只生成核心包，音乐页仍可下载登记附件。登记文件与维护方法见[语音组件导入](VOICE_COMPONENTS.md)。

scripts/sync-and-package.ps1 基于审计后的现有 Windows 发行基线同步源码并生成部署清单；scripts/build-release.ps1 从隔离载荷生成便携 ZIP、安装器、可选语音 ZIP 与校验文件。脚本不是完整第三方二进制重建工具链。

Windows 安装组件参考[原项目固定提交](https://github.com/sourcepro5/WeChatAgent/blob/38c1060ce500a294d69a4a2f9e07ca1b63a08b06/scripts/build-installer.mjs)，构建工具单独锁定，不加入应用运行依赖：

```powershell
npm ci --prefix packaging/windows --ignore-scripts --no-audit --no-fund
.\scripts\sync-and-package.ps1 -Version 0.5.5 -StagingDirectory 'D:\发布暂存\WeChatBot-0.5.5' -OutputDirectory 'D:\发布产物\WeChatBot-0.5.5'
```

按本机审计基线显式指定 `-Baseline` 和 `-ClientRoot`。如使用独立工具目录，可设置 `WECHATBOT_BUILDER_HOME` 指向具有锁定 electron-builder 26.15.3 的目录。首次构建由 builder 获取固定版本的 NSIS 编译资源；无须运行第三方安装向导安装编译器。启动 EXE 由系统 .NET Framework 编译器生成，使用 Windows GUI 子系统。

`scripts/build-windows-installer.mjs` 只读取构建脚本审查后的文件清单，在临时目录复制干净的程序文件再交给 builder。它不把活动 data 或用户插件作为安装资源。卸载清单只列确切文件，目录仅在清空后移除，不递归删除整个安装目录。原项目的目录选择模板在独立副本中适配；上游结构变化会停止构建，避免静默产生错误布局。

同步脚本按桥接插件的现有锁文件安装必需运行依赖，禁用安装脚本，不复制活动环境的 node_modules。打包前由内置 Node 执行 SDK 与控制台的真实模块导入检查，避免开发机已有依赖掩盖干净安装的缺项；该检查不启动服务、不连接或发送聊天。

读取密钥组件 wx_key.dll 不在 Git 文件集中，构建时必须显式复制。默认从审计基线的同一路径读取；使用缺件的旧基线时，通过 `-ReaderKeyDll 'D:\已审计组件\wx_key.dll'` 指定已登记的组件。SHA-256、x64 格式、所需导出和部署清单必须全部匹配，否则在打包前停止。仅在开发机已有该 DLL 不能作为新安装验收结果；必须验证它进入模板清单并被复制到实际 workspace。

维护测试可给 `build-release.ps1` 加 `-InstallerTestMode`，使用独立的测试应用标识、注册表路径并关闭快捷方式；测试包不能作为正式版本发布。先完成中文路径新装、原位升级、自定义数据位置、程序占用拒绝和卸载保留验证，再生成普通候选包。编译器、源码、便携包及标准卸载器都不要求用户打开 CMD。

对隔离测试包运行 `scripts/test-windows-package.ps1 -TestSetup <测试安装包> -Launcher <新启动器> -TestDirectory <不存在的测试目录>`，自动验证中文路径安装、升级、卸载、占用时拒绝修改、数据保留及启动环境。脚本拒绝普通正式安装包，不向真实聊天发消息；结果写入测试目录的 RESULTS.json。

源版本、安装器和脚本默认值已调整为 0.5.5；部署元数据在隔离构建时重新生成，不能复用旧清单。15个产品插件从唯一清单生成可导入ZIP与总包；主包仅随附两项基础插件；用户已安装插件、账号配置和 state 不随包复制。

发行前按[发行流程](RELEASE_WORKFLOW.md)审查来源、许可、包体积和归档隐私。SHA256 证明完整性，不证明软件签名、全部功能可用或跨设备验收通过。安装器签名状态、实际隔离测试及未覆盖设备在版本日志如实记录。
