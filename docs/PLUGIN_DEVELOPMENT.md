# WeChatBot 插件开发规范 · API v2

本文是 **ZIP 安装插件的现行契约**。可以直接把本文交给开发者或其他模型，用来编写插件。接口版本为 `2`，插件宿主标识为 `wechatagent`。

## 安装者怎么使用

1. 打开 WeChatBot 的“能力 → 能力目录”。把一个 `.zip` 拖入页面，或点击“安装 ZIP 插件”。
2. 核对名称、版本、作者和权限，点击“确认安装”。安装阶段只检查文件，不运行插件。
3. 在插件卡片点击“配置”，选择授权能力、允许的聊天，勾选“允许此插件运行”，保存。
4. 第一次升级到支持 API v2 的桥接宿主，先执行“准备项目配置”，从托盘完整退出并重开 DSH，再重新打开 WeChatBot 窗口并重启后台。之后安装、更新和修改设置在空闲时或下一轮聊天自动加载，不必每次重启 DSH。

安装成功不代表已启用，也不代表每个请求都一定会调用工具；工具由当前 DSH 模型按描述选择。助手模式继续遵守管理员限制，普通群友的只读聊天通道不会获得插件任务工具。

**DSH 插件不兼容此 ZIP 接口。** dsh-meme、DSH 技能和 npm 插件仍在 DSH 中安装。旧 API v1 目录包不能作为 v2 ZIP 导入。

## 包目录与文件要求

ZIP 可以直接包含以下文件，也可以只包一层外部目录：

```text
chat-notes/
  plugin.json       必需，UTF-8 JSON 清单
  index.mjs         必需，ESM 入口
  README.md        建议，面向安装者的用法
  lib/             可选，插件自己的 .mjs 模块
  assets/          可选，静态资源；不自动注入前端
```

入口固定为 `index.mjs`，无需 `package.json` 或 npm install。只支持预先打包好的代码，不能在安装时执行命令、下载依赖或运行脚本。依赖应预先合并到入口或放在包内相对路径模块中；不得携带 `node_modules`、`.git`、符号链接和目录链接。

不要依赖 `process.cwd()` 等于插件目录。读取包内静态资源请使用 `new URL('./assets/文件名', import.meta.url)`；ESM 相对 import 按模块所在位置解析。这样启用中的插件也能在 Windows 上正常更新、归档和卸载。

ZIP 最大 8 MiB，解压后最大 16 MiB，单文件最大 4 MiB，最多 128 个 ZIP 条目、8 层子目录，最高压缩比 500。支持标准 ZIP 的 Store / Deflate，不支持加密、分卷和 ZIP64。拒绝绝对路径、`..`、Windows 设备名、ADS、重名文件、文件/目录冲突和校验不符。文件名使用 UTF-8。

每个 ZIP 只包含一个插件。最多安装 32 个插件，同时最多运行 8 个；超过运行限制时会显示加载原因，请停用不使用的插件并重新保存需要运行的插件。

## plugin.json

```json
{
  "id": "chat-notes",
  "name": "聊天小便签",
  "version": "1.0.0",
  "apiVersion": 2,
  "host": "wechatagent",
  "author": "你的名字",
  "homepage": "https://example.com/project",
  "description": "在当前聊天记下、查看和清空便签。",
  "permissions": ["storage"],
  "settings": {"maxNotes": 20},
  "configSchema": {
    "maxNotes": {
      "type": "integer",
      "title": "最多保留便签数",
      "minimum": 1,
      "maximum": 50
    }
  }
}
```

| 字段 | 要求 |
| --- | --- |
| id | 必需，小写字母开头，仅小写字母、数字和 `-`，最多 40 字符；`native-` 保留。更新时保持相同 id。 |
| name / description | 必需，分别为 1–80 / 1–1024 字符。 |
| version | 必需，如 `1.0.0` 或 `1.1.0-beta.1`。 |
| apiVersion / host | 必须分别为 `2` / `wechatagent`。 |
| author / homepage | 可选。作者最多 120 字符；主页只接受 HTTPS，不允许 URL 用户凭据。 |
| permissions | 可选字符串数组，仅接受下表列出的宿主权限，所有声明权限均需授权后才能运行。 |
| settings | 可选，完整的默认设置，必须符合 configSchema。 |
| configSchema | 可选，设置字段到 Schema 的映射，最多 24 项。 |
| requiresHostFeatures | 可选，所需能力标识数组；不支持时拒绝安装，不能假装兼容。 |
| requiresAccount | 可选布尔值，true 时要求已绑定微信账号才能运行。 |
| schedule | 可选每日计划，格式见后文；需 schedule 权限。 |
| dataNamespace | 仅第一方 fish-notebook 的旧数据兼容声明，其他插件不可指定。 |


未知顶层字段会被拒绝。不要添加 `entry`、`enabledByDefault`、`scripts` 或自行改变宿主。插件不能通过清单默认启用或扩大聊天范围。

设置和工具参数使用 JSON Schema 的受限子集：`type`、`properties`、`required`、`additionalProperties`、`items`、`enum`、`description`、`title`、`default`、`minimum`、`maximum`、`minLength`、`maxLength`、`secret`。支持 object、array、string、number、integer、boolean；嵌套最多 12 层，数组值最多 100 项。未知参数默认拒绝。对象字段名不能为 `__proto__`、`prototype`、`constructor`。

设置页面自动生成字符串、数字、布尔、枚举及 JSON 对象/数组输入。秘密字符串可设置 `secret: true`：管理接口返回空值，留空保存会保留已保存值。插件执行时可读取它自己的真实设置。插件设置属于本机数据，请勿在日志或模型结果中输出密码、令牌。

自 0.5.4 起，API v2 插件的整份 settings 使用 Windows 当前用户 DPAPI 加密保存，配置文件格式为 version 2。旧配置读取时迁移，不创建明文备份；升级后须从托盘完整退出并重开 DSH，以加载 v2.5 宿主。换 Windows 账号或电脑、回退旧宿主时可能需要重新配置，历史明文备份不会自动清理。同账号恶意进程及获准运行的插件仍可能接触内存中的设置。

保存采用修订检查及独占写入锁。若异常断电后持续提示其他实例正在保存，请先完整退出 WeChatBot 和 DSH，备份原配置，再仅移除同目录的 `plugins.json.write.lock` 后重开；不要删除 `plugins.json`。

## 注册模型工具

`index.mjs` 必须导出 `setup(api)`。可以同步或异步，但初始化必须在 2 秒内完成。不要在初始化阶段发网络请求或启动长期任务。

```javascript
export function setup(api) {
  api.registerTool({
    id: 'notes',
    description: '用户明确要求记便签或查看便签时使用，只操作当前聊天。',
    parameters: {
      type: 'object',
      properties: {
        action: {type: 'string', enum: ['add', 'list']},
        text: {type: 'string', maxLength: 1000}
      },
      required: ['action'],
      additionalProperties: false
    },
    async execute(ctx, args) {
      const notes = await ctx.storage.get('notes') ?? [];
      if (args.action === 'list') {
        return {content: JSON.stringify(notes)};
      }
      if (!args.text?.trim()) {
        return {content: '请提供便签正文。', isError: true};
      }
      notes.push({text: args.text.trim(), createdAt: new Date().toISOString()});
      await ctx.storage.set('notes', notes.slice(-ctx.config().maxNotes));
      return {content: '便签已记下。'};
    }
  });
}
```

`api.apiVersion` 固定为 2。工具 id 最多 20 字符，格式与插件 id 相同；每插件最多 16 个工具，不能重复。description 为 1–2000 字符，parameters 必须是 object Schema。最终名称固定为 `<插件id>__<工具id>`，例如 `chat-notes__notes`，避免与 DSH 的 `web_search` 等工具重名。

如果 DSH 仍拒绝某个插件的工具注册（例如其他第三方插件使用了同名工具），会撤回该插件的本次工具注册并显示 `PLUGIN_TOOL_REGISTRATION_CONFLICT`，继续保留其他工具和原会话；更新插件的工具 id 后重新启用即可重试。

`execute(ctx,args)` 可以返回字符串，或 `{content: string, isError?: boolean}`。业务失败请返回 `isError:true` 或抛出 Error。模型会看到工具结果，并通过原有回复链路回复微信。返回值必须能 JSON 序列化；子进程结果上限 64 KiB，交给模型的文字最多 12,000 字符。

每轮最多调用 3 次插件工具，每次最长 8 秒。插件死循环、超时、进程崩溃时，只结束该插件子进程，不归档或废弃 DSH 会话；同一插件在其他聊天中的并发调用也可能失败，但其他插件、文字和后续聊天仍可继续。修正问题后，在插件设置中重新保存启用状态即可重试加载。

## ctx 与权限

所有存储、历史、fetch、reply 操作都是 **异步 API，必须 await**。不等待的副作用可能在本次工具结束时被取消。

| API | 权限 / 返回 |
| --- | --- |
| ctx.apiVersion | 2 |
| ctx.chat | 当前聊天 `{key, platform:'wechat', kind:'private'\|'group', id, name}`。没有跨聊天目标参数。 |
| ctx.actor | `{id}`，当前批次可识别的真实微信发送者；无法确认时为空字符串。它不是管理员授权凭据。 |
| ctx.sessionId | 当前 DSH 会话 id，仅用于关联。 |
| ctx.account / ctx.now | `{id}` 为不含原 wxid 的账号作用域；now 为本次调用开始的毫秒时间。 |
| ctx.config() | 本插件的当前设置副本。 |
| ctx.signal | 本次执行的取消信号；宿主取消或超时后也会终止进程并拒绝新的宿主操作。 |
| await ctx.storage.get(key) | `storage`，读取当前账号 + 插件 + 聊天的数据，不存在返回 null。 |
| await ctx.storage.set(key,value) | `storage`，写 JSON 值，返回 `{ok:true}`。 |
| await ctx.storage.delete(key) | `storage`，删除键，返回 `{ok:true}`。 |
| ctx.actorStorage.get/set/delete | 与 storage 相同，额外按当前发送者隔离。发送者无法确认时拒绝操作。 |
| await ctx.history.recent({limit:20}) | `history_read`，当前聊天最近 1–100 条已收录文字记录。 |
| await ctx.fetch(url,{maxChars:12000,timeoutMs:6000}) | `web_fetch`，公开 HTTP(S) GET，返回标准 Response。 |
| await ctx.reply(text) | `reply`，申请本轮回复，返回 `{queued:true}`，不是即时送达回执。 |

存储键只允许 1–64 个英文字母、数字、`_`、`-`；值必须可 JSON 序列化。同一账号下每插件总存储上限 256 KiB。账号、插件、聊天、发送者不能通过参数改成其他目标。

历史只包含 `{id,text,senderId,senderName,timestamp,outgoing}`，不提供数据库密钥、原始路径或附件字节。未收录的旧消息不会自动补抓；每条文字最多 12,000 字符，整批最多 48 KiB，优先返回最新的记录。

fetch 仅接受 maxChars（256–32000）和 timeoutMs（100–7000 毫秒），不接受自定义请求头、请求体或任意代理。宿主检查 DNS、目标 IP 和重定向，拒绝本机/内网。用户本轮明确不允许联网时拒绝请求。Response 的 `X-WeChatAgent-Truncated: true` 表示正文被截断，不要把它当作完整 JSON 使用。

reply 每轮最多 3 项，合计最多 12,000 字符。只有工具与本轮模型任务成功、权限仍有效时，申请才会交给现有 Bridge 发送；失败、取消、停用后的申请丢弃。申请回复会作为本轮最终回复替代模型正文，避免重复发送两套回答。发送仍经过现有去重、聊天权限、限流与微信回执流程。

## 可选钩子与生命周期

```javascript
export const hooks = {
  'before-context': async ctx => ({context: '仅供本轮参考的资料'}),
  'after-response': async ctx => ({})
};
```

- before-context 额外收到 `ctx.message`；返回 `{context:string}` 添加当轮资料，最多采用 4000 字符。它不能替换人格、系统规则、聊天授权或工具权限。
- after-response 额外收到 `ctx.text`；可返回 `{text:string}`，但必须声明并获授权 `reply`，并保留精确的 `SILENT` 或 `RESPOND:` 协议，否则不采用改写。
- 钩子中的宿主 API 只允许读取存储、历史；不允许写存储、联网或申请发送。每插件每类钩子最多 800 毫秒，一类钩子总预算 2 秒，超时终止该插件并跳过，不阻塞本轮其他功能。
- 可导出 `activate()`，只在启用后、子进程初始化时执行。启停通过独立进程创建/结束实现；不要依赖退出清理来保证数据正确。持久数据应在工具成功前通过 storage 写完。
- 当前未提供 MCP 注册、前端任意 JavaScript 注入、任意路径文件操作和原生图片/文件发送 API。每日计划、受限模型生成与文档存储见下文；其他任务仍使用已有、已授权的 DSH 能力。

插件在独立 Node 子进程运行，V8 旧生代堆上限为 96 MiB，并有执行时间限制（不是进程总内存硬上限）；宿主不向它传入模型账号密钥或完整环境变量。这是 **故障隔离，不是恶意代码的操作系统沙箱**。Node 代码仍可能直接访问本机文件或系统能力，因此只启用信任的插件。permissions 约束这里列出的宿主 API，不代表 Node 本身的完整权限封锁。

## 可选扩展：动作、文档、当前人设与每日计划

这些是 API v2 的可选能力扩展；只依赖早期基础 API v2 的工具包仍可运行。新包通过 `requiresHostFeatures` 明确声明，例如：

```json
{
  "requiresHostFeatures": ["actions-v1", "documents-v1", "persona-read-v1", "model-utility-v1", "daily-schedule-v1"],
  "requiresAccount": true,
  "schedule": {"timeSetting": "writeTime", "personaScoped": true}
}
```

schedule 的 timeSetting 必须指向 configSchema 中的字符串设置，默认值和保存值都需满足 HH:MM。personaScoped 为可选布尔值，true 时需 persona_read 权限，每日回执额外按人格签名隔离。requiresHostFeatures 的标识可从 GET /api/plugins 的 hostFeatures 查看，实际运行的 DSH 宿主还会在 health 的 pluginHostFeatures 报告；安装后显示“等待新版宿主”时，准备配置并重开 DSH。

### 宿主动作

```javascript
export function setup(api) {
  api.registerAction({
    id: 'write-today', description: '由本机页面主动调用',
    parameters: {type:'object', properties:{}, additionalProperties:false},
    async execute(ctx, args) { return {ok:true}; }
  });
  api.onSchedule(async ctx => ({retryLater:true}));
}
```

每插件最多 16 个动作，id、description、parameters 与工具同样校验，最多执行 35 秒。动作不会自动注册成模型工具，也不构成微信万能命令。通过专用宿主接入或带控制台令牌的 `POST /api/plugins/:id/actions/:action` 调用，正文为 `{key:"wechat:private:123",args:{}}`；仅允许本机已授权聊天。若需要模型调用，请另行注册工具。

动作和每日计划不支持 ctx.reply；返回值由调用它的界面或专用聊天接入决定如何使用，不能借定时计划绕过既有发送流程。

### 新增上下文 API

| API | 权限与限制 |
| --- | --- |
| await ctx.persona() | persona_read；仅本聊天的 `{personaName,persona,digest,signature}`。正文最多 8000 字符；digest 是完整正文的哈希，signature 包含完整人格名与正文，用于旧数据标识兼容。 |
| await ctx.history.today({date,limit:200,maxChars:14000}) | history_read；date 必须为当前北京时间日期。仅返回本聊天当天有限片段 `{who,text}`，不含工具推理、转发/引用展开或其他聊天。 |
| await ctx.documents.get(id) | documents；当前账号、插件、聊天的一份 JSON 对象，不存在返回 null。 |
| await ctx.documents.put(id,value) | documents；单份最多 1 MiB；已有 JSON 损坏时拒绝覆盖。 |
| await ctx.documents.list({offset:0,limit:12}) | documents；每次最多 50 份、整批最多约 1 MiB，保留损坏文件并报告 errors；按 nextOffset 续读。 |
| await ctx.model.generate({prompt,maxTokens:512,maxChars:2000,timeoutMs:25000}) | model_generate；使用当前已配置模型、tools 固定为空，仅返回可见文本，忽略内部推理。 |

文档 id 为 1–120 个英文字母、数字、`_`、`-`，以字母或数字开头；拒绝 Windows 设备名、路径穿越和链接。若文档包含 id / conversationKey / accountScope，必须与当前目标一致。普通文档保存在 `state/plugin-documents/<账号作用域哈希>/<插件id>/<聊天哈希>/`。它和 256 KiB 键值存储分别管理；插件应自行控制历史数量，宿主不擅自删除旧文档。

第一方 fish-notebook 的 `dataNamespace: "fish-notebook-v1"` 专供兼容旧的 `state/fish-notebook/`，不开放任意自定义数据路径，也不允许其他 id 读取该命名空间。

模型 prompt 最多 32000 字符，maxTokens 为 16–2200，maxChars 为 1–4000，timeoutMs 为 1000–25000 毫秒。每次工具/动作最多 3 次独立模型请求，宿主最多同时处理 2 次；仍受外层工具 8 秒或动作 35 秒限制。支持关闭推理的模型会使用 off；计费及结果记入原聊天用量，不创建普通任务，也不改写主会话。生成和写文档会再次检查当前账号、授权及取消状态。不得把“独立请求”描述成没有模型费用。

每日计划由宿主每分钟检查。后台服务停止、账号变化或当前任务繁忙时等待；到时对已允许的聊天调用 onSchedule。成功回执按账号/插件/聊天/日期保存，personaScoped 时还包含人设签名；处理失败 15 分钟后再试。返回 `{retryLater:true}` 不记为当天完成，例如当天尚无聊天。停止或卸载插件结束新执行，保留文档和调度回执。不要自行创建不受宿主管理的常驻定时器。

鱼的记事本是完整示例，源码在 `optional-extensions/fish-notebook/`，包在 `release/plugins/fish-notebook-1.0.0.zip`；其原有前端由宿主提供兼容只读展示，不通过 ZIP 注入任意前端脚本。

## 打包、更新和卸载

项目提供校验打包命令：

```powershell
node scripts/pack-plugin.mjs examples/plugins/chat-notes release/plugins/chat-notes-1.0.0.zip
```

它检查清单、入口、链接与限额，再生成标准 ZIP 并再次验证。也可以在 Windows 资源管理器压缩插件目录，或使用：

```powershell
Compress-Archive -Path '.\chat-notes\*' -DestinationPath '.\chat-notes-1.0.0.zip'
```

更新保持 id 不变、递增 version，重新拖入 ZIP 并确认更新。同名包不会悄悄覆盖：旧代码归档，数据及符合新 Schema 的设置保留，权限清空、插件停用，需要重新确认后启用。

卸载只归档代码并移除启用配置，保留插件数据。重新安装相同 id、相同微信账号时，可继续读取保存的数据；不要更换 id 来发布同一插件的更新。

路径均相对于当前 WeChatBot 工作目录，安装版通常为所选数据目录中的 `workspace/`：

| 内容 | 相对路径 |
| --- | --- |
| 已安装代码 | plugins/插件id/ |
| 本机设置与授权 | config/plugins.json |
| 隔离后的持久数据 | state/plugins/账号作用域哈希/插件id/data.json |
| 旧版和卸载源码 | state/plugin-archives/ |
| 安装预览临时文件 | state/plugin-install-staging/ |

用户安装的代码、配置和运行数据不会自动混进项目发布包。安装器只包含宿主和第一方示例，未默认启用任何第三方插件。

## 本机管理接口

所有 `/api/plugins` 接口使用控制台的 Host/Origin 检查和 `X-Console-Token`，不供微信用户直接调用。

| 方法 / 路径 | 请求 / 结果 |
| --- | --- |
| GET /api/plugins | `{apiVersion:2,revision,plugins,runtimeConnected}`；秘密设置已脱敏。 |
| POST /api/plugins/inspect | `{name:'包.zip',zip:'标准Base64'}`，返回 ticket、revision、插件信息和已安装版本；不执行代码。 |
| POST /api/plugins/install | `{ticket,revision,replace:false}`，确认安装；更新需要 replace:true。 |
| POST /api/plugins/cancel | `{ticket}`，删除对应预览临时文件。 |
| POST /api/plugins/:id | `{revision,enabled,permissions,chats,settings}`；chats:null 为全部已允许聊天，[] 为不分配。 |
| POST /api/plugins/:id/uninstall | `{revision}`，归档代码，保留数据。 |

预览 ticket 有效 10 分钟，同一控制台最多保留 4 份。提交使用插件配置 revision 检查冲突，409 时重新读取列表或重新选择 ZIP，不要强行覆盖。

## 开发验收清单

- ZIP 根目录或单层目录中含合法 plugin.json 和 index.mjs；没有 npm 安装步骤。
- 安装后未启用时，不产生任何代码执行或网络请求。
- 为一个聊天启用后能调用工具；其他聊天、账号和未授权发送者不越权。
- 所有宿主 API 都 await，输出为可序列化且有界的结果。
- 工具失败、超时、死循环、插件退出后，仍可继续发送普通文字。
- 更新、停用、重新启用、卸载后，数据保留且权限状态符合预期。
- README 写清功能、触发示例、权限用途、数据范围和版本要求，不声称整个 DSH/npm 插件直接兼容。

维护者可运行：`node --test scripts/test-plugin-api.mjs`。完整便签示例见 [examples/plugins/chat-notes](../examples/plugins/chat-notes/)。
