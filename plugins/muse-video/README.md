# Muse 视频工作台（muse-video）

接入本机 `muse2api`，用你自己的 muse.ai 账号额度生成**短视频与图片**，并把文件投递到微信。

## 组成

| 文件 | 作用 |
|---|---|
| `plugin.json` / `index.mjs` | 插件主体：向微信对话暴露 `generate`/`collect`（视频）与 `generate_image`/`collect_image`（图片）四个工具 |
| `lib/muse-client.mjs` | muse2api 接口适配（视频 `/v1/videos`、图片 `/v1/images/tasks`，画幅字段、完成状态、结果地址归一） |
| `lib/delivery.mjs` | 微信会话清单、授权状态检查、FileTransfers 文件投递（视频 mp4 与图片 png/jpg 通用） |
| `lib/task-store.mjs` | 工作台任务状态持久化（`kind: video | image` 共用一个存储） |
| `lib/gateway.mjs` | muse2api 网关进程控制：定位部署目录、后台启动/停止、带 Key 打开管理页、随服务自动拉起 |
| `server.mjs` | 本地网页工作台 HTTP 服务，只监听 `127.0.0.1:18760` |
| `web/` | 网页前端（原生 HTML/CSS/JS，无外部依赖） |

## 三种用法

- **微信对话 · 视频**：在已授权聊天里说「用 Muse 生成一段…」，之后问「视频好了吗」领取。
- **微信对话 · 图片**：说「画一张…/生成一张…的图片」，之后问「图片好了吗」领取；`aspect` 可指定 1:1（默认）/16:9/9:16/4:3/3:4。
- **本地网页**：`http://127.0.0.1:18760/` 左栏有「新建视频」和「生成图片」两张表单，选会话生成完自动发微信。关掉网页后台仍会继续生成与投递。

生图走网关的 `POST /v1/images/tasks` 异步队列（muse.ai 的 imagine 流程，通常几十秒到两分钟，超时上限 240 秒）；画幅由网关注入提示词实现。图片与视频共用同一条后台轮询、下载（`state/media/video/muse-video/`）与 FileTransfers 投递管线。

## 网关服务管理（1.2.0 新增）

- **wechatwb 控制台插件卡片**：Muse 视频工作台卡片底部有「启动服务 / 停止服务」按钮和服务状态标签（`GET/POST /api/muse-services`）——一键管理**全部** muse 服务：muse2api 网关（18610）+ 网页工作台（18760）。启动先拉网关（失败不阻断）再拉工作台；停止先停工作台再停网关。状态每 15 秒自动刷新。
- 网页工作台顶部有 **「启动服务 / 停止服务」按钮**（`POST /api/gateway/start|stop`）：启动用后台 uvicorn 进程（参数与 `start-muse2api.cmd` 完全一致，stdout 落到 `state/logs/muse-gateway-stdout.log`）；停止按端口定位监听 PID，校验确属 muse2api 的 python 进程后才杀整棵树（含它管理的浏览器），非 muse2api 进程会拒绝执行。网关用 **`pythonw.exe`**（GUI 子系统）静默启动——venv 的 `python.exe` 启动器会再派生真正的 python 并新开控制台窗口，`windowsHide` 拦不住；pythonw 从不创建窗口。
- 插件设置里有 **「随服务自动启动（muse2api + 网页工作台）」**（`autoStartGateway`，默认开）：微信服务启动（插件加载）时自动拉起网页工作台与 muse2api 网关（工作台自己的启动回调也会带起网关，插件侧再兜底）；每个服务都已在线即跳过，不会重复拉起。决策与启停记录在 `state/logs/muse-gateway.log`。
- `start-muse2api.cmd` / `start-muse-studio.cmd` 仍然可用，所有路径拉起的是同一部署（`%USERPROFILE%\muse2api` 优先）。

## 三个启动脚本已内置（1.2.1）

项目根目录的三个 cmd 只是排错用的备用入口，日常不需要再双击它们：

| 原 cmd | 插件里的等价入口 |
|---|---|
| `start-muse2api.cmd` | 控制台插件卡片「启动服务」／网页工作台「启动服务」／随服务自动启动 |
| `start-muse-studio.cmd` | 控制台插件卡片「启动服务」（会一并拉起并打开 18760 页面） |
| `open-muse-admin.cmd` | 控制台插件卡片「打开管理页」／网页工作台「打开管理页」 |

「打开管理页」由服务端解析 API Key（优先级：环境变量 `MUSE2API_KEY` > 控制台插件设置 > muse2api 的 `.env`），
再用默认浏览器打开 `http://127.0.0.1:18610/admin?key=…`；网关没在运行时先自动拉起再打开。
带 Key 的完整链接只在本机服务端进程内使用，接口只返回打码地址（`?key=m2a_f7***`），Key 不下发浏览器。
对应接口：`POST /api/muse-services {action:"admin"}`（控制台）、`POST /api/admin/open`（网页工作台）。

## 前置条件

1. `muse2api` 在 `127.0.0.1:18610` 运行。**已有定制部署在 `%USERPROFILE%\muse2api`**（汉化管理页、账号密码登录、Clash 代理），不要重复安装或覆盖；账号在管理页用「方式四：账号密码登录」。
2. 有可用的 `MUSE2API_KEY`：服务会自动读已有部署的 `.env`，也可在控制台插件设置里显式填或用环境变量覆盖。
3. 目标微信聊天开启了**助理模式 + 文件传输授权**，且 `assistant.administrators` 里有管理员 wxid。

## 安全边界

- 服务只绑 `127.0.0.1`，校验 Host / Origin，带 CSP，API Key 不下发浏览器。
- 媒体文件只允许 `state/media/video/muse-video/` 下的 `.mp4`，文件名走白名单正则。
- 文件投递完全复用项目自带的 `FileTransfers` 管线，保留 50 MB 上限、授权检查与回执确认，不另开旁路。
- 任务记录与视频保留 7 天。

完整部署与排错见项目根目录 **`Muse-video-setup.md`**。
