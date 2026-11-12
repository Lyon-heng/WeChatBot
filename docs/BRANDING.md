# WeChatBot 品牌与兼容规则

从 0.4.4 起，产品名称统一为 **WeChatBot**，桌面、托盘、控制台、插件页面、应用图标、安装器和快捷方式均使用这一品牌。

已经安装的旧版仍可能使用 `WeChatAgent` 文件夹、`%APPDATA%\WeChatAgent`、`wechatagent` 配置字段、日志名、本地接口和 DSH 内部项目 ID。它们属于升级兼容标识，不能只为改名批量移动、删除或改写；新版本继续识别旧数据，并在明确的数据迁移流程中沿用原路径。项目代码目录变化时，连接配置会重新生成 DSH 插件文件链接，插件 ID 仍保持稳定。GitHub 仓库现名和历史下载链接在仓库管理完成改名之前也保持有效。

当前构建使用 `desktop/icon.ico` 作为安装器与卸载器图标，并从 `desktop/package.json` 读取产品名。原有 `%LOCALAPPDATA%\WeChatAgent` 安装位置和 `storage.ini` 继续兼容，避免更名造成数据迁移或重复安装。

## 全仓命名复核

已逐项复核当前 README、根目录维护指南、控制台可见文案、首方插件说明、插件开发文档、迁移/卸载说明、发行说明和 DSH 插件模板。当前用户流程与新增功能说明统一称 **WeChatBot**；新 ZIP 下载名称也采用该产品品牌。

源码中还会看到 `WeChatAgent`/`wechatagent`，但其用途是保留既有接口和用户数据：上游项目与许可证署名、API v2 `host` 值、`/WeChatAgent` Hook 路径、`X-WeChatAgent-*` 请求头、配置和文件目录、旧进程发现及迁移规则、历史版本标题、GitHub 仓库 URL，以及朋友圈插件现用的 LocalAppData 数据目录。它们不作为当前产品介绍文案；更名这些值需要独立迁移并保留旧路径读取。

检查方式：对仓库内 Markdown、HTML、JSON、YAML 和脚本搜索 `WeChatAgent`、`DeepSeekGirl` 与 `deepseekgirl`，逐条区分当前界面文字、上游/历史来源和兼容标识；没有对整个仓库做无差别替换，避免破坏协议、目录迁移和发行历史。
