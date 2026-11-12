import {PluginBundles,pluginPackages} from './plugin-bundles.mjs';
import {interfacePreferences} from './interface-preferences.mjs';
import {replay as replayGroupPolicy} from '../optional-extensions/group-behavior/lib/policy.mjs';
import {feedbackSnapshot,saveFeedback} from '../packages/dsh-social-bridge-plugin/assistant-feedback.mjs';
import {createMemoryConsole} from './memory-console.mjs';
import {createPeopleConsole} from './people-console.mjs';
import {createMemoryEvaluation} from './memory-evaluation-console.mjs';
import {PeopleMemory} from '../packages/plugin-api/people-memory.mjs';
import {fishNotebookSnapshot} from './fish-notebook-console.mjs';
import fs from 'node:fs';
import {createPersonaCategories} from './persona-categories.mjs';
import {createUpdateChecker} from './update-check.mjs';
import {builtinCatalog,applyBuiltinUpdate,extensionPresentation} from './extension-status.mjs';
import {pluginCatalog,updatePlugin,archivePlugin,packageFiles,inspectPackage,scanPlugins,validateValue} from '../packages/plugin-api/catalog.mjs';
import {PluginInstaller} from '../packages/plugin-api/installer.mjs';
import {packZip} from '../packages/plugin-api/zip.mjs';
import {BUNDLED_PLUGINS} from '../packages/plugin-api/bundled.mjs';
import {bundledExtensionCatalog,saveBundledExtension} from './bundled-extensions.mjs';
import {memeSources} from '../packages/workbuddy-memes/index.mjs';
import {listActivity} from '../wechatwb/activity.mjs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateConfig, projectRoot } from './project-config.mjs';
import { conversationId } from './hook-onebot.mjs';
import { runConsoleCommand, taskFailureMessage, windowsPowerShellEnvironment, windowsPowerShellExecutable } from './console-process.mjs';
import { personaError,personaReferences } from '../public/console/persona-files.mjs';
import {applyChatSettings} from '../public/console/conversation-settings.mjs';
import { runReaderSetup, readerSetupMessage } from './reader-setup.mjs';
import { dshConfigurationMatches,sameProjectPath } from './dsh-configuration.mjs';
import { inProcessHealth, listModels, modelConfig, visionTest, accountInfo, verifyWorkbuddyAccount, saveWorkbuddyAccount, clearWorkbuddyAccount } from '../wechatwb/workbuddy-model.mjs';
import { createProcessRecovery,startupConflictPorts } from './process-recovery.mjs';
import { readerAccountId, cachedReaderAccount, applyReaderAccount,activeReaderAccount } from './reader-account-state.mjs';
import {verifyWeChatAccount} from './wechat-account-check.mjs';
import {createMusicConsole} from './music-console.mjs';
import {createVoiceConsole} from './voice-console.mjs';
import {createVoiceComponents} from './voice-components.mjs';
import {createSpeechPluginConsole} from './speech-plugin-console.mjs';
import {hostCompatibility,hostContract} from '../packages/plugin-api/contract.mjs';
import {localPluginApi} from '../wechatwb/plugin-tools.mjs';
import {ForegroundSender} from './foreground-sender.mjs';
import {createClientDetector} from './wechat-clients.mjs';
import {startMuseServices,stopMuseServices,serviceStatus,openAdmin} from '../plugins/muse-video/lib/gateway.mjs';

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fault = (message, status = 400) => Object.assign(new Error(message), { status });
const setupCode = value => typeof value==='string'&&/^(?:READER|WECHAT|HOOK|REVIEWED)_[A-Z0-9_]{1,65}$/.test(value)?value:'';
const atomic = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
};
const optionalJson = (file, fallback = {}) => fs.existsSync(file) ? readJson(file) : fallback;
const roleName = name => typeof name === 'string' && /^[^\\/\0.][^\\/\0]{0,60}$/.test(name) && !name.includes('..') && !/[<>:"|?*\r\n]/.test(name) && !/[. ]$/.test(name) && !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(name);
const portOpen = port => new Promise(resolve => {
  const socket = net.connect({ host: '127.0.0.1', port });
  const finish = value => { socket.destroy(); resolve(value); };
  socket.setTimeout(600); socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.once('timeout', () => finish(false));
});

export function validateConsoleConfig(config, root) {
  try { validateConfig(config); } catch (error) {
    const translations = [
      [/distinct|ports|Required ports/, '端口必须为 1024–65535 的整数，且不能互相重复。'],
      [/loopback/, '发送后端地址必须是本机回环 HTTP 地址。'],
      [/matching|version/, '发送组件需要匹配版本 4.1.10.27 的微信程序。'],
      [/persona/, '人格名称不能包含路径、点号前缀或无效字符。'],
      [/OneBot IDs/, '聊天 ID 必须是有效的正整数。'],
      [/nicknames|Python/, '请填写 Python 程序位置与至少一个账号昵称。'],
      [/provider|model/, '请填写有效的模型提供方与模型标识。'],
      [/wake_mode/, '请选择自然参与或唤醒后回复。'],
      [/sticker/, '表情发送与标签缓存必须使用开关值，聊天覆盖设置需要有效聊天 ID。'],
      [/webReader/, '网页阅读设置必须是开关值。'],
      [/search/, '请检查联网搜索开关、聊天 ID 和单轮次数范围。每轮搜索次数为 1–3，摘要长度为 256–3000 字符。'],
      [/proactive/, '请检查主动聊天开关、内容方向、时间段和间隔。时间为 HH:MM，主动间隔为 30–1440 分钟。'],
      [/context/, '请检查上下文压缩设置：阈值为 4,000–2,000,000 token，空闲等待为 15–3,600 秒；单个聊天填 0 可关闭。'],
      [/Hook/, '请检查发送请求超时、回执等待时间和并发上限。'],
    ];
    throw fault(translations.find(([pattern]) => pattern.test(error.message))?.[1] ?? '配置格式无效，请检查连接与回复设置。');
  }
  for (const value of [config.runtime.python, config.runtime.dshDesktop ?? '']) {
    if (typeof value !== 'string' || /[\0\r\n"]/.test(value) || value.length > 1024) throw fault('程序路径包含无效字符。');
  }
  for (const list of [config.account.nicknames, config.wechat.wake_words]) {
    if (!Array.isArray(list) || list.length > 50 || list.some(v => typeof v !== 'string' || !v.trim() || v.length > 100)) throw fault('昵称与唤醒词必须是有效文字，每项不超过 100 字。');
  }
  const ranges = { batch_ms: [0, 60000], min_interval_ms: [0, 3600000], private_min_interval_ms: [0, 3600000], max_per_minute: [1, 1000], max_per_ten_minutes: [1, 10000] };
  for (const [key, [low, high]] of Object.entries(ranges)) {
    if (!Number.isInteger(config.social?.[key]) || config.social[key] < low || config.social[key] > high) throw fault(`回复频率 ${key} 必须在 ${low}–${high} 范围内。`);
  }
  for (const [key, value] of Object.entries(config.persona.chats ?? {})) {
    if (!/^wechat:(private|group):[1-9]\d*$/.test(key) || !roleName(value)) throw fault('聊天人格映射无效。');
  }
  for (const name of [config.persona.default, ...Object.values(config.persona.chats ?? {})]) {
    if (!roleName(name) || !fs.existsSync(path.join(root, 'roles', name + '.md'))) throw fault(`找不到人格「${name}」，请先在“人格”页面创建。`);
  }
  for (const key of ['allowStickerCdn', 'allowStickerCdnAlias']) {
    if (typeof config.wechat.media?.[key] !== 'boolean') throw fault('图片设置必须是开关值。');
  }
  return config;
}

import {allowedConversation,validateConversationSettings,conversationWorkMode} from '../packages/dsh-social-bridge-plugin/conversation-policy.mjs';
export function createConsole({ root = projectRoot, port = 3310, runner, readerSetup = runReaderSetup, accountVerifier = verifyWeChatAccount, fetchImpl = fetch, nodeExecutable = process.execPath, filePicker, onQuit, processProbe, processStop, officialLogin, speechCapabilities, wechatClientScan } = {}) {
  const updates=createUpdateChecker({root,fetchImpl});
  const wechatClients=createClientDetector(root,{scan:wechatClientScan});
  const publicDir = path.join(projectRoot, 'public', 'console');
  const pluginInstaller=new PluginInstaller(root);const pluginBundles=new PluginBundles(root,projectRoot,pluginInstaller,{fetcher:fetchImpl});
  const musicConsole=createMusicConsole(root,{officialLogin});
  const voiceConsole=createVoiceConsole(root);
  const speechChecks=createSpeechPluginConsole({root,fetchImpl,...(speechCapabilities?{readCapabilities:speechCapabilities}:{})});
  const personaCategories=createPersonaCategories(root);
  const categorySnapshot=()=>{try{return personaCategories.read();}catch(error){return {categories:[],assignments:{},revision:null,error:error.message};}};
  const configFile = path.join(root, 'config', 'wechatagent.json');
  const preferenceFile = path.join(root, 'state', 'console-state.json');
  const deletedPersonaFile = name => path.join(root,'state','deleted-personas',hash(name.toLocaleLowerCase())+'.json');
  const readerFile = path.join(root, 'state', 'weflow', 'WeFlow-config.json');
  const readerRevision = () => hash(JSON.stringify(optionalJson(readerFile)));
  const readerVerified = () => optionalJson(preferenceFile).readerVerifiedRevision === readerRevision();
  const csrf = crypto.randomBytes(32).toString('hex');
  const jobs = new Map(); let activeJob = null; let latestJob = null; let protectingCredential = false;
  let processRecoveryBusy=false;
  let shutdownPromise=null,shuttingDown=false;
  const processRecovery=createProcessRecovery({root,probe:processProbe,stop:processStop});
  let statusPromise; let statusTime = 0;
  const memoryView=createMemoryConsole({root,configFor:()=>snapshot().config,plugin});
  const peopleView=createPeopleConsole({root,configFor:()=>snapshot().config,plugin});
  const memoryEvaluation=createMemoryEvaluation({root,configFor:()=>snapshot().config,plugin});
  const snapshot = () => {
    const raw = fs.readFileSync(fs.existsSync(configFile) ? configFile : path.join(root, 'config', 'wechatagent.example.json'), 'utf8');
    return { config: JSON.parse(raw.replace(/^\uFEFF/, '')), revision: hash(raw) };
  };
  const safeText = input => {
    let text = String(input ?? '');
    for (const relative of ['state/social-dsh-token.txt', 'state/hook/native-token.txt']) {
      const file = path.join(root, relative);
      if (fs.existsSync(file)) { const secret = fs.readFileSync(file, 'utf8').trim(); if (secret) text = text.split(secret).join('[已隐藏]'); }
    }
    let io = {}; try { io = optionalJson(path.join(root, 'state', 'wechat-io-config.json')); } catch {}
    if (io.reader_token) text = text.split(io.reader_token).join('[已隐藏]');
    return text.replace(/(Bearer\s+)[^\s"']+/gi, '$1[已隐藏]').replace(/((?:decryptKey|access_token|api[_-]?key|password|reader_token)\s*[":=]+\s*")[^"]*/gi, '$1[已隐藏]').replace(/userdpapi:[A-Za-z0-9+/=]+/g, '[已隐藏凭据]').replace(/\b[0-9a-f]{64}\b/gi, '[已隐藏凭据]');
  };
  const backup = file => {
    if (!fs.existsSync(file)) return;
    const dir = path.join(root, 'state', 'console-backups');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(file, path.join(dir, `${path.basename(file)}.${Date.now()}.${crypto.randomBytes(3).toString('hex')}.bak`));
  };
  const markPending = (dsh = false) => {
    const previous = optionalJson(preferenceFile);
    atomic(preferenceFile, { ...previous, pendingApply: true, dshRestartRequired: previous.dshRestartRequired || dsh });
    statusTime = 0;
  };
  const voiceComponents=createVoiceComponents({root,pickFile:()=>filePicker?filePicker('zip'):nativeHelper('zip'),python:()=>snapshot().config.runtime?.python??'python'});
  const assertIdle = () => { if(shuttingDown)throw fault('正在退出并停止后台服务，请等待操作完成。',409);if(voiceComponents.busy)throw fault('语音组件正在选择或导入，请等待完成后再保存、重启或退出。',409);if (activeJob || protectingCredential || processRecoveryBusy) throw fault('有操作正在进行，请等它完成后再保存或执行其他操作。', 409); };
  function shutdown() {
    if(shutdownPromise)return shutdownPromise;
    assertIdle();shuttingDown=true;let output='';
    shutdownPromise=Promise.resolve().then(()=>execute({...command('stop'),timeoutMs:70000},chunk=>{output=safeText(output+chunk.toString()).slice(-12000);})).then(code=>{
      const logDir=path.join(root,'state','logs');fs.mkdirSync(logDir,{recursive:true});
      fs.writeFileSync(path.join(logDir,'shutdown.log'),new Date().toISOString()+'\n'+output+'\nexit='+code+'\n');
      if(code!==0)throw fault('后台服务未能全部停止。请查看运行日志 shutdown.log 后重试退出。',503);
      statusTime=0;return {ok:true};
    }).catch(error=>{shuttingDown=false;shutdownPromise=null;throw error;});
    return shutdownPromise;
  }
  async function remote(url, token, timeout = 2200) {
    const response = await fetchImpl(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(timeout) });
    if (!response.ok) throw fault('连接服务暂不可用。请检查服务是否启动。', 503);
    const data = await response.json();
    if (data.success === false) throw fault('读取服务返回错误，请查看运行日志。', 503);
    return data;
  }
  /** wechatwb: 模型能力焊在本进程内，健康检查/模型列表不再走 11230 HTTP */
  function localHealth() {
    const { config } = snapshot();
    let accountScope = '';
    try { accountScope = optionalJson(path.join(root, 'state/weflow/active-account.json')).id ?? ''; } catch { /* ignore */ }
    let pluginRevision = '';
    try {
      const patch = path.join(root, 'packages/dsh-social-bridge-plugin/cordis.patch.yml');
      if (fs.existsSync(patch)) pluginRevision = /wechatagent=([a-f0-9]{16})/.exec(fs.readFileSync(patch, 'utf8'))?.[1] ?? '';
    } catch { /* ignore */ }
    // 插件由应用进程内的 PluginRuntime 加载，宿主契约是完整的；
    // 如实上报，控制台才能显示「已开启」并开放插件动作与能力分配。
    const contract = hostContract();
    return {
      ...inProcessHealth(root, accountScope),
      provider: config.dsh?.provider ?? 'workbuddy',
      model: config.dsh?.model ?? modelConfig().model,
      pluginRevision,
      pluginHost: 'workbuddy-inprocess',
      pluginRuntime: contract.runtime,
      pluginApiVersion: contract.apiVersion,
      pluginPermissions: contract.permissions,
      pluginHostFeatures: contract.features,
      apiVersion: contract.apiVersion,
      runtime: contract.runtime,
      revision: contract.revision,
      features: contract.features,
      permissions: contract.permissions,
      memoryWorkbench: 'fact-management-v1',
    };
  }
  async function localModels() {
    const { config } = snapshot();
    const provider = config.dsh?.provider ?? 'workbuddy';
    const current = config.dsh?.model ?? modelConfig().model;
    let rows = [];
    try {
      const cloud = await listModels();
      if (Array.isArray(cloud)) rows = cloud.filter(item => item && typeof item.id === 'string')
        .map(item => ({
          provider, model: item.id, name: item.name ?? item.id,
          disabled: item.enabled === false,
          supportsImages: item.supportsImages === true && item.disabledMultimodal !== true,
          supportsToolCall: item.supportsToolCall === true,
          description: typeof item.descriptionZh === 'string' ? item.descriptionZh : (item.descriptionEn ?? ''),
        }));
    } catch { /* 离线时保留当前模型 */ }
    if (!rows.some(item => item.model === current)) rows.unshift({ provider, model: current, name: '当前内置模型' });
    return { available: true, models: rows };
  }
  async function reader(route) {
    const { config } = snapshot(); const io = optionalJson(path.join(root, 'state', 'wechat-io-config.json'));
    if (!io.reader_token) throw fault('读取连接尚未准备，请先启动服务。', 503);
    return remote(`http://127.0.0.1:${config.ports.weflow}${route}`, io.reader_token, 5000);
  }
  async function stickerManager(route,body) {
    const {config}=snapshot(),io=optionalJson(path.join(root,'state','wechat-io-config.json'));
    if(!io.reader_token)throw fault('请先连接微信并启动读取服务，再管理表情包。',503);
    let response;
    try{response=await fetchImpl(`http://127.0.0.1:${config.ports.weflow}/api/v1/stickers/manage${route}`,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+io.reader_token,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});}
    catch{throw fault('表情池暂时无法连接，请确认读取服务已启动。',503);}
    const data=await response.json();
    if(!response.ok){
      const messages={STICKER_MANAGER_ACCOUNT_CHANGED:'微信账号已变化，请刷新表情管理页面后重试。',STICKER_MANAGER_CHANGED:'表情池已更新，请刷新列表后重试。',STICKER_MANAGER_BUSY:'已有图片正在导入，请稍后重试。',STICKER_MANAGER_FULL:'表情池已满 50 张，请先删除不需要的表情再添加。',STICKER_MANAGER_TOO_LARGE:'每张图片不能超过 8 MB。',STICKER_MANAGER_INVALID_IMAGE:'图片无效或过大。支持 GIF、PNG、JPG、WebP，最多 64 帧、边长不超过 4096 像素。',STICKER_MANAGER_INVALID:'请检查名称、描述和标签：名称与描述最多 120 字，标签最多 6 个、每个最多 16 字。',STICKER_MANAGER_NOT_FOUND:'这张表情已移除，请刷新列表。',STICKER_MANAGER_INTEGRITY:'图片校验失败，原有表情未修改。'};
      throw fault(messages[data.error]??(response.status===404?'读取服务尚未加载表情管理功能，请退出重开 WeChatBot 并重启服务。':'表情管理暂时不可用，请查看读取服务日志。'),[400,404,409,413].includes(response.status)?response.status:503);
    }
    return data;
  }
  async function plugin(route,body,{signal}={}) {
    // wechatwb: 模型与插件宿主都在应用进程内，不再转发到 DSH 11230 端口。
    if (route === '/health') return localHealth();
    if (route === '/models') return localModels();
    try {
      const local = await localPluginApi(route, body ?? {}, root, {signal});
      if (local !== null) return local;
    } catch (error) {
      if (error?.status) throw error;
      throw fault('本机插件宿主暂不可用：' + String(error?.message ?? error), 503);
    }
    throw fault('该能力尚未接入 WorkBuddy 内置模型，请在「能力」页查看可用的本机插件。', 503);
  }
  async function assertMemoryWriterReady(){let memoryHealth;try{memoryHealth=await plugin('/health');}catch{}if(memoryHealth?.ok&&memoryHealth.memoryWorkbench!=='fact-management-v1')throw fault('记忆写入组件尚未就绪，请重启应用后再修改事实。',409);}
  function buffered() {
    const buffer = optionalJson(path.join(root, 'state', 'social-messages.json'), { chats: {} });
    let member={chats:{}};
    try{const account=activeReaderAccount(root);member=optionalJson(path.join(root,'state/accounts',account.id||account.legacyId||'legacy','assistant-group-chat.json'),member);}catch{}
    const rows = [buffer,member].flatMap(item=>Object.entries(item.chats??{}).flatMap(([key,messages])=>messages.map(m=>({...m,key}))));
    return { buffer, rows,chatCount:new Set([...Object.keys(buffer.chats??{}),...Object.keys(member.chats??{})]).size };
  }
  async function getStatus() {
    if (statusPromise && Date.now() - statusTime < 3000) return statusPromise;
    statusTime = Date.now();
    statusPromise = (async () => {
      const { config } = snapshot();
      const io = optionalJson(path.join(root, 'state', 'wechat-io-config.json'));
      const tokenFile = path.join(root, 'state', 'social-dsh-token.txt');
      const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
      const results = await Promise.allSettled([
        io.reader_token ? remote(`http://127.0.0.1:${config.ports.weflow}/api/v1/reader/status`, io.reader_token) : Promise.reject(),
        io.reader_token ? remote(`http://127.0.0.1:${config.ports.weflow}/api/v1/sessions?limit=1`, io.reader_token) : Promise.reject(),
        remote(`http://127.0.0.1:${config.ports.adapter}/status`),
        Promise.resolve(localHealth()),
        portOpen(config.ports.onebot),
      ]);
      const value = index => results[index].status === 'fulfilled' ? results[index].value : null;
      const readerState = value(0), adapter = value(2), health = value(3);
      const matchesDsh=dshConfigurationMatches(root,snapshot().config,health);
      if(optionalJson(preferenceFile).dshRestartRequired && matchesDsh)atomic(preferenceFile,{...optionalJson(preferenceFile),dshRestartRequired:false});
      const dshReady = health?.ok === true && health.project === 'WeChatAgent' && sameProjectPath(health.projectRoot,root) && health.contextMode === 'native-session-v1' && health.behaviorPolicy === 'local-config-only-v1' && ['native-attachment-v1','workbuddy-multimodal-v1'].includes(health.imageInput) && (!optionalJson(preferenceFile).dshRestartRequired || matchesDsh);
      const readerReady = !!readerState && !!value(1) && !readerState.lastError;
      const bridgeReady = !!value(4) && adapter?.ob_connected === true;
      const hookReady = adapter?.hook_connected === true && adapter?.hook_account_verified === true && adapter?.version === config.hook.expectedVersion;
      const ready = readerReady && bridgeReady && hookReady && dshReady && adapter?.reader_connected === true;
      const { rows } = buffered();
      const services = [
        { id: 'reader', label: '微信读取', ready: readerReady, detail: readerReady ? '数据库可读，消息同步正常' : readerState?.lastError ? '读取异常，请重新连接并验证' : readerFailureDetail(), port: config.ports.weflow },
        { id: 'bridge', label: '消息桥接', ready: bridgeReady && hookReady && adapter?.reader_connected === true, detail: bridgeReady && hookReady && adapter?.reader_connected ? '收发连接正常，账号已核验' : !hookReady ? '等待匹配微信登录与发送连接' : '等待消息桥接连接', port: config.ports.adapter },
        { id: 'dsh', label: '模型连接', ready: dshReady, detail: dshReady ? 'WorkBuddy 内置模型已就绪' : '模型模块未装载，请重启应用', port: config.ports.dshPlugin },
      ];
      const running = !!readerState || !!adapter || !!value(4);
      return { ready, running, services, lastError: safeText(adapter?.last_error ?? ''),
        stats: { received: rows.filter(m => !m.outgoing).length, sent: rows.filter(m => m.outgoing).length, pending: rows.filter(m => !m.outgoing && !m.processed).length, chats: buffered().chatCount },
        recent: rows.sort((a, b) => b.timestamp - a.timestamp).slice(0, 6).map(m => ({ key: m.key, name: m.conversation_name, text: m.text?.slice(0, 100), outgoing: m.outgoing, timestamp: m.timestamp })),
        ...optionalJson(preferenceFile), activeJob: activeJob ? jobs.get(activeJob) : null, latestJob: latestJob ? jobs.get(latestJob) : null, updatedAt: Date.now() };
    })();
    return statusPromise;
  }
  function command(action, body = {}) {
    const ps = (file, ...args) => ({ exe: windowsPowerShellExecutable(), args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'console-powershell.ps1'), '-ScriptPath', path.join(root, 'scripts', file), '-ArgumentsBase64', Buffer.from(JSON.stringify(args), 'utf8').toString('base64')] });
    const node = (file, ...args) => ({ exe: nodeExecutable, args: [path.join(root, 'scripts', file), ...args] });
    if (['start', 'stop', 'restart', 'prepare'].includes(action)) return ps('manage.ps1', action);
    if (action === 'setup') return ps(fs.existsSync(path.join(root, 'config', 'distribution.json')) ? 'check-runtime.ps1' : 'setup.ps1');
    if (action === 'dsh-open') return ps('launch-dsh.ps1');
    if (action === 'dsh-plugin-import') return node('import-dsh-plugin.mjs');
    if (action === 'wechat-open') return ps('launch-hook-wechat.ps1', ...(fs.existsSync(path.join(root,'state/hook/native/build.previous.json')) ? ['-UpdateHook'] : []));
    if (action === 'hook-build') return ps('build-hook.ps1');
    if (action === 'hook-pin') return ps('pin-hook-client.ps1');
    if (action === 'hook-unpin') return ps('pin-hook-client.ps1', '-Unlock');
    if (action === 'hook-check') return node('hook-onebot.mjs', '--check');
    if (action === 'reader-check') return { exe: snapshot().config.runtime.python, args: ['-B', path.join(root, 'scripts', 'reader-api.py'), '--check'] };
    if (['sessions-configure', 'sessions-compact'].includes(action)) {
      const key = body.conversationKey;
      const config = snapshot().config;
      const match = /^wechat:(private|group):([1-9]\d*)$/.exec(key ?? '');
      if (!match || !config.wechat.whitelist[match[1] === 'group' ? 'groups' : 'private'].map(String).includes(match[2])) throw fault('请从已允许的聊天中选择需要管理的会话。');
      return node('manage-dsh-sessions.mjs', action === 'sessions-compact' ? 'compact' : 'configure', key);
    }
    throw fault('不支持此操作。');
  }
  const execute = runner ?? ((spec, onOutput) => runConsoleCommand(spec, onOutput, { cwd: root, timeoutMs: spec.timeoutMs }));
  function readerFailureDetail() {
    const file = path.join(root, 'state', 'logs', 'reader.stderr.log');
    if (!fs.existsSync(file)) return '请在首次配置中连接并验证微信';
    const output = fs.readFileSync(file, 'utf8').slice(-8000);
    return output.trim() ? taskFailureMessage(output, 1) : '等待读取服务启动';
  }
  function readerRequest(body) {
    if (body.revision !== readerRevision()) throw fault('读取配置已变化，请重新载入后再连接。', 409);
    const settings = optionalJson(readerFile);
    for (const key of ['dbPath', 'myWxid', 'decryptKey']) {
      if (typeof body[key] !== 'string' || body[key].length > 4096 || /[\0\r\n]/.test(body[key])) throw fault('读取设置包含无效字符。');
    }
    if (typeof body.autoKey !== 'boolean') throw fault('请选择自动连接或手动验证。');
    const dbPath = body.dbPath.trim(), myWxid = body.myWxid.trim();
    if(!dbPath||!myWxid)throw fault('请先识别账号目录，并明确选择当前登录的微信账号。');
    const selectedId = readerAccountId(root, { dbPath, myWxid });
    const currentId = readerAccountId(root, settings);
    const cached = selectedId ? cachedReaderAccount(root, selectedId) : null;
    const request = { operation: 'connect', dbPath, myWxid,
      decryptKey: body.decryptKey.trim() || (selectedId === currentId ? settings.decryptKey : cached?.reader?.decryptKey) || '',
      autoKey: body.autoKey, wechatExecutable: snapshot().config.hook.wechatExecutable };
    if (!request.dbPath || !request.myWxid) throw fault('请先自动查找账号或选择微信账号文件夹。');
    return request;
  }
  function startJob(body) {
    assertIdle();
    const connectRequest = body.action === 'reader-connect' ? readerRequest(body) : null;
    const checkRevision = readerRevision();
    const initialConfigRevision = snapshot().revision;
    const spec = connectRequest ? {} : command(body.action, body);
    spec.timeoutMs = body.action === 'dsh-plugin-import' ? 240000 : ['setup', 'hook-build', 'hook-test'].includes(body.action) ? 1200000 : ['start', 'restart'].includes(body.action) ? 180000 : 150000;
    const id = crypto.randomUUID();
    const job = { id, action: body.action, state: 'running', startedAt: Date.now(), output: '', exitCode: null };
    jobs.set(id, job); activeJob = id; latestJob = id;
    while (jobs.size > 30) jobs.delete(jobs.keys().next().value);
    const output = chunk => { job.output = safeText(job.output + chunk.toString()).slice(-40000); };
    Promise.resolve().then(async () => {
      if (!connectRequest) return execute(spec, output);
      job.phase='checking-wechat';
      await accountVerifier({root,config:snapshot().config,settings:connectRequest,fetchImpl,wait:false,requireReady:false});
      job.phase='validating-database';
      const result = await readerSetup({ root, python: snapshot().config.runtime.python, request: connectRequest, onProgress: message => output(message + '\n') });
      if (!result.ok) { job.message = readerSetupMessage(result.code);if(setupCode(result.code)){job.code=setupCode(result.code);output('['+job.code+'] ');}output(job.message + '\n'); return 1; }
      if (checkRevision !== readerRevision()) throw fault('读取配置已在其他程序中变化。请刷新后重试，当前配置未覆盖。', 409);
      if (!/^userdpapi:[A-Za-z0-9+/=]+$/.test(result.protectedKey ?? '') || !result.dbPath || !result.myWxid) throw fault('凭据保护或数据库验证未完成，原配置已保留。');
      if (initialConfigRevision !== snapshot().revision) throw fault('其他设置已在验证期间变化。请刷新后重试，原账号配置已保留。', 409);
      const previousReader = optionalJson(readerFile);
      const settings = { ...previousReader, dbPath: result.dbPath, myWxid: result.myWxid, decryptKey: result.protectedKey };
      if(readerAccountId(root,settings)!==readerAccountId(root,connectRequest))throw new Error('READER_ACCOUNT_RESULT_MISMATCH');
      job.phase='confirming-wechat-account';
      output('数据库已验证，正在确认微信实时账号；尚未保存切换结果…\n');
      await accountVerifier({root,config:snapshot().config,settings,fetchImpl,onProgress:message=>output(message+'\n')});
      if(checkRevision!==readerRevision()||initialConfigRevision!==snapshot().revision)throw fault('配置已在账号核对期间变化。请刷新后重试，原账号配置未覆盖。',409);
      const previousId = readerAccountId(root, previousReader), nextId = readerAccountId(root, settings);
      if (previousId && previousId !== nextId) {
        job.phase='stopping-services';
        output('新账号已验证，正在停止旧账号的读取与消息服务…\n');
        const stopped = await execute(command('stop'), output);
        if (stopped !== 0) throw fault('旧账号服务未能停止，原账号配置已保留。请先停止服务后再切换。');
        const ports = snapshot().config.ports;
        if ((await Promise.all([ports.weflow, ports.onebot, ports.adapter].map(portOpen))).some(Boolean)) throw fault('旧账号服务端口仍在使用，原账号配置已保留。请退出占用服务后再切换。');
        if (checkRevision !== readerRevision() || initialConfigRevision !== snapshot().revision) throw fault('配置已在停止服务期间变化。请刷新后重试，原账号配置未覆盖。', 409);
      }
      job.phase='switching-account';
      await accountVerifier({root,config:snapshot().config,settings,fetchImpl,wait:false});
      if(checkRevision!==readerRevision()||initialConfigRevision!==snapshot().revision)throw fault('配置已在保存账号前变化。请刷新后重试，原账号配置未覆盖。',409);
      backup(readerFile); backup(configFile);
      const applied = applyReaderAccount(root, previousReader, settings, snapshot().config);
      markPending(applied.needsDshRestart);
      atomic(preferenceFile, { ...optionalJson(preferenceFile), readerVerifiedRevision: readerRevision() });
      job.readerConfigured = true; job.accountSwitched = applied.changed;
      job.dshRestartRequired = applied.needsDshRestart;
      job.phase='complete';
      output(applied.changed ? '已切换并保存账号。聊天范围按账号保存；请重启应用，再启动助手服务。\n' : applied.needsDshRestart ? '微信数据库已验证并保存。如果应用已打开，请重启应用，再启动助手服务。\n' : '微信数据库已验证并保存。可以继续启动服务。\n');
      return 0;
    }).then(async code => {
      job.exitCode = code; job.state = code === 0 ? 'succeeded' : 'failed';
      if (code !== 0 && ['start', 'restart'].includes(body.action) && /reader exited/.test(job.output)) {
        const file = path.join(root, 'state', 'logs', 'reader.stderr.log');
        if (fs.existsSync(file)) output('\n读取器错误：\n' + fs.readFileSync(file, 'utf8').slice(-8000));
      }
      if (code !== 0 && !job.message) job.message = taskFailureMessage(job.output, code);
      if (code === 0 && body.action === 'reader-check' && checkRevision === readerRevision()) {
        atomic(preferenceFile, { ...optionalJson(preferenceFile), readerVerifiedRevision: checkRevision }); job.readerConfigured = true;
      }
      if (code === 0 && ['start', 'restart'].includes(body.action)) {
        if(initialConfigRevision!==snapshot().revision)throw fault('设置在启动期间发生变化，请重新应用。',409);
        if(optionalJson(preferenceFile).dshRestartRequired){
          const health=localHealth();
          if(!dshConfigurationMatches(root,snapshot().config,health))throw fault('当前模型或插件配置尚未生效，请保存设置并重启应用后重试。',409);
        }
        atomic(preferenceFile, { ...optionalJson(preferenceFile), pendingApply: false, dshRestartRequired:false });
      }
    }).catch(error => { job.state = 'failed'; job.exitCode = 1; job.message = error.status ? error.message : connectRequest ? readerSetupMessage(error.message) : taskFailureMessage(job.output, 1);if(connectRequest&&setupCode(error.code??error.message)){job.code=setupCode(error.code??error.message);output('['+job.code+'] ');}output(job.message); }).finally(() => {
      job.finishedAt = Date.now(); activeJob = null; statusTime = 0;
    });
    return job;
  }
  async function readBody(req,limit=128*1024) {
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > limit) throw fault('提交内容过大。', 413); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fault('表单内容无效。'); }
  }
  async function nativeHelper(kind, input) {
    if (process.platform !== 'win32') throw fault('文件选择与凭据保护需要 Windows。');
    return new Promise((resolve, reject) => {
      const child = spawn(windowsPowerShellExecutable(), ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(projectRoot, 'scripts', 'console-native.ps1'), kind], { windowsHide: true, shell: false, env: windowsPowerShellEnvironment() });
      let output = ''; let error = '';
      child.stdout.on('data', b => { output += b.toString(); }); child.stderr.on('data', b => { error += b.toString(); });
      child.once('error', () => reject(fault('无法打开 Windows 选择窗口。')));
      child.once('close', code => code === 0 ? resolve(output.trim()) : reject(fault(kind === 'protect' ? '无法保护读取凭据。原有设置未修改。' : '文件选择失败，请手动填写路径。')));
      child.stdin.end(input ?? '');
    });
  }
  const server = http.createServer(async (req, res) => {
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" };
    const reply = (status, body, type = 'application/json; charset=utf-8') => { res.writeHead(status, { ...headers, 'Content-Type': type }); res.end(type.startsWith('application/json') ? JSON.stringify(body) : body); };
    try {
      const boundPort = server.address()?.port ?? port;
      const expectedHost = `127.0.0.1:${boundPort}`;
      if (req.headers.host !== expectedHost) throw fault('请通过本机控制台地址访问。', 403);
      const origin = `http://${expectedHost}`;
      if ((req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') throw fault('不允许其他网站访问本机控制台。', 403);
      const url = new URL(req.url, origin);
      const route = url.pathname;
      if (req.method === 'GET' && !route.startsWith('/api/')) {
        if(route==='/plugin-api.md'){res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Content-Disposition':'attachment; filename="WeChatBot-plugin-api-v2.md"','X-Content-Type-Options':'nosniff'});res.end(fs.readFileSync(path.join(projectRoot,'docs/PLUGIN_DEVELOPMENT.md')));return;}
        if(route==='/plugin-contract.mjs'){res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','X-Content-Type-Options':'nosniff'});res.end(fs.readFileSync(path.join(projectRoot,'public/console/plugin-contract.mjs')));return;}
        if(route==='/speech-settings.mjs')return reply(200,fs.readFileSync(path.join(publicDir,'speech-settings.mjs'),'utf8'),'text/javascript; charset=utf-8');
        if(route==='/packages/plugin-api/bundled.mjs'){res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','X-Content-Type-Options':'nosniff'});res.end(fs.readFileSync(path.join(projectRoot,'packages/plugin-api/bundled.mjs')));return;}
        if(route==='/packages/plugin-api/contract.mjs'){res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','X-Content-Type-Options':'nosniff'});res.end(fs.readFileSync(path.join(projectRoot,'packages/plugin-api/contract.mjs')));return;}
        if(route==='/plugin-example.zip'){const example=path.join(projectRoot,'examples/plugins/chat-notes');inspectPackage(example);res.writeHead(200,{'Content-Type':'application/zip','Content-Disposition':'attachment; filename="chat-notes-1.0.0.zip"','X-Content-Type-Options':'nosniff'});res.end(packZip(packageFiles(example)));return;}
        const builtinMatch=route.match(/^\/plugin-packages\/([a-z][a-z0-9-]{0,39})\.zip$/);if(builtinMatch){const bundle=BUNDLED_PLUGINS.find(item=>item.id===builtinMatch[1]&&item.zip);if(!bundle)throw fault('没有找到这个内置插件包。',404);const source=path.join(projectRoot,bundle.source);if(!fs.existsSync(path.join(source,'plugin.json'))){const entry=pluginPackages(projectRoot).entries.find(p=>p.id===bundle.id);if(!entry)throw fault('插件包未登记。',404);res.writeHead(302,{Location:entry.url});res.end();return;}const item=inspectPackage(source);if(item.id!==bundle.id||item.version!==bundle.version)throw fault('内置插件包版本校验失败。',409);const bytes=packZip(packageFiles(source));res.writeHead(200,{'Content-Type':'application/zip','Content-Disposition':`attachment; filename="${bundle.id}-${bundle.version}.zip"`,'X-Content-Type-Options':'nosniff'});res.end(bytes);return;}
        const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'], '/console.css': ['console.css', 'text/css; charset=utf-8'], '/console.js': ['console.js', 'text/javascript; charset=utf-8'], '/persona-files.mjs': ['persona-files.mjs', 'text/javascript; charset=utf-8'], '/appearance.js': ['appearance.js', 'text/javascript; charset=utf-8'], '/appearance.css': ['appearance.css', 'text/css; charset=utf-8'], '/icons.svg': ['icons.svg', 'image/svg+xml'], '/app-icon.png': ['app-icon.png', 'image/png'], '/favicon.svg': ['app-icon.png', 'image/png'] };
        assets['/extension-market.js']=['extension-market.js','text/javascript; charset=utf-8'];assets['/extension-market.css']=['extension-market.css','text/css; charset=utf-8'];
        assets['/plugins.js']=['plugins.js','text/javascript; charset=utf-8'];assets['/plugins.css']=['plugins.css','text/css; charset=utf-8'];
        assets['/feature-setup.mjs']=['feature-setup.mjs','text/javascript; charset=utf-8'];
        assets['/external-links.js']=['external-links.js','text/javascript; charset=utf-8'];
        assets['/music.js']=['music.js','text/javascript; charset=utf-8'];assets['/music.css']=['music.css','text/css; charset=utf-8'];assets['/send-mode-ui.mjs']=['send-mode-ui.mjs','text/javascript; charset=utf-8'];assets['/send-mode.css']=['send-mode.css','text/css; charset=utf-8'];
        assets['/sticker-manager.js']=['sticker-manager.js','text/javascript; charset=utf-8'];assets['/sticker-manager.css']=['sticker-manager.css','text/css; charset=utf-8'];
        assets['/updates.js']=['updates.js','text/javascript; charset=utf-8'];
        for(const file of ['workspace-layout.js','layout-model.mjs','session-usage.js'])assets['/'+file]=[file,'text/javascript; charset=utf-8'];
        assets['/workspace-layout.css']=['workspace-layout.css','text/css; charset=utf-8'];
        assets['/assistant-feedback.js']=['assistant-feedback.js','text/javascript; charset=utf-8'];
        for(const file of ['interface-model.mjs','theme-init.js','color-theme.js','persona-studio.js','persona-studio-model.mjs'])assets['/'+file]=[file,'text/javascript; charset=utf-8'];
        for(const file of ['ui-polish.css','persona-studio.css','redesign.css'])assets['/'+file]=[file,'text/css; charset=utf-8'];
        assets['/memory-view.js']=['memory-view.js','text/javascript; charset=utf-8'];assets['/memory-view.css']=['memory-view.css','text/css; charset=utf-8'];
        assets['/fish-notebook.js']=['fish-notebook.js','text/javascript; charset=utf-8'];assets['/fish-notebook.css']=['fish-notebook.css','text/css; charset=utf-8'];
        assets['/conversation-settings.mjs']=['conversation-settings.mjs','text/javascript; charset=utf-8'];
        assets['/dsh-catalog.mjs']=['dsh-catalog.mjs','text/javascript; charset=utf-8'];
        assets['/persona-delete.js']=['persona-delete.js','text/javascript; charset=utf-8'];
        assets['/persona-categories.js']=['persona-categories.js','text/javascript; charset=utf-8'];assets['/persona-categories.css']=['persona-categories.css','text/css; charset=utf-8'];
        assets['/dsh-install.mjs']=['dsh-install.mjs','text/javascript; charset=utf-8'];
        assets['/dsh-models.js']=['dsh-models.js','text/javascript; charset=utf-8'];
        assets['/wechat-clients.mjs']=['wechat-clients.mjs','text/javascript; charset=utf-8'];
        assets['/session-groups.js']=['session-groups.js','text/javascript; charset=utf-8'];assets['/session-groups.css']=['session-groups.css','text/css; charset=utf-8'];
        assets['/process-recovery.js']=['process-recovery.js','text/javascript; charset=utf-8'];assets['/process-recovery.css']=['process-recovery.css','text/css; charset=utf-8'];
        assets['/dsh-access.js']=['dsh-access.js','text/javascript; charset=utf-8'];assets['/extensions.js']=['extensions.js','text/javascript; charset=utf-8'];
        if (!assets[route]) return reply(404, { error: '页面不存在。' });
        const [file, type] = assets[route]; return reply(200, fs.readFileSync(path.join(publicDir, file)), type);
      }
      if (req.method === 'GET' && route === '/api/info') return reply(200, { project: 'WeChatBot Console', root, version: 1, token: csrf });
      if (req.headers['x-console-token'] !== csrf) throw fault('控制台连接已更新，请刷新页面。', 401);
      if(req.method==='GET'&&route==='/api/wechat-clients')return reply(200,await wechatClients.inspect({force:url.searchParams.get('refresh')==='1'}));
      if(req.method==='GET'&&route==='/api/updates')return reply(200,await updates.check());
      if(req.method==='GET'&&route==='/api/assistant-feedback')return reply(200,feedbackSnapshot(root));
      if(req.method==='GET'&&route==='/api/memory')return reply(200,memoryView.overview());
      if(req.method==='GET'&&route==='/api/fish-notebook')return reply(200,fishNotebookSnapshot(root,snapshot(),url.searchParams));
      if(req.method==='GET'&&route==='/api/interface-preferences')return reply(200,interfacePreferences(root).snapshot());
      if(req.method==='GET'&&route==='/api/plugin-packages')return reply(200,pluginPackages(projectRoot));
      if(req.method==='GET'&&route==='/api/music')return reply(200,musicConsole.snapshot());
      if(req.method==='GET'&&route==='/api/voice-studio/music-preferences')return reply(200,voiceConsole.musicPreferences());
      if(req.method==='GET'&&route==='/api/voice-studio/engine')return reply(200,voiceConsole.engine());
      if(req.method==='GET'&&route==='/api/voice-studio/voices')return reply(200,voiceConsole.voices());
      if(req.method==='GET'&&route==='/api/voice-studio/web-sources')return reply(200,{items:voiceConsole.webSources()});
      if(req.method==='GET'&&route==='/api/voice-studio/singing-voices')return reply(200,await voiceConsole.singingVoices());
      if(req.method==='GET'&&route==='/api/voice-studio')return reply(200,await voiceConsole.snapshot());
      if(req.method==='GET'&&route==='/api/voice-components')return reply(200,voiceComponents.snapshot());
      if(req.method==='GET'&&route==='/api/memory/members')return reply(200,memoryView.members(url.searchParams));
      if(req.method==='GET'&&route==='/api/memory/summaries')return reply(200,await memoryView.summaries(url.searchParams));
      if(req.method==='GET'&&route==='/api/memory/people')return reply(200,peopleView.snapshot(url.searchParams));
      if(req.method==='GET'&&route==='/api/memory/diagnostics')return reply(200,await peopleView.diagnostics());
      if(req.method==='GET'&&route==='/api/memory/evaluation')return reply(200,memoryEvaluation.snapshot());
      if (req.method === 'GET' && route === '/api/config') return reply(200, { ...snapshot(), ...optionalJson(preferenceFile) });
      if(req.method==='GET'&&route==='/api/sticker-pool'){try{return reply(200,await reader('/api/v1/stickers/pool-status'));}catch{throw fault('表情收集状态暂不可用，请检查读取服务与微信账号连接。',503);}}
      if(req.method==='GET'&&route==='/api/sticker-diagnostics'){
        const project=snapshot().config,mode=project.wechat.textTransport?.mode??'native';
        const results=await Promise.allSettled([getStatus(),remote('http://127.0.0.1:'+project.ports.adapter+'/status',null),stickerManager('')]);
        const status=results[0].status==='fulfilled'?results[0].value:{services:[]},adapter=results[1].status==='fulfilled'?results[1].value:{},pool=results[2].status==='fulfilled'?results[2].value:null;
        const readerReady=status.services.some(service=>service.id==='reader'&&service.ready),bridgeReady=status.services.some(service=>service.id==='bridge'&&service.ready);
        return reply(200,{checks:[{label:'微信读取服务',ok:readerReady,detail:readerReady?'已连接，可读取当前账号表情。':'读取服务未就绪，请启动服务或检查微信账号连接。'},{label:'消息桥接服务',ok:bridgeReady,detail:bridgeReady?'收发连接已就绪。':'消息桥接未就绪，请启动服务并检查微信连接。'},{label:'表情发送方式',ok:mode==='foreground'?bridgeReady:adapter.native_sticker_send===true,detail:mode==='foreground'?'当前为前台模式：使用微信收藏中的随机表情，需要微信窗口可操作；共享池中的指定表情不会通过Hook发送。':adapter.native_sticker_send===true?'Hook组件支持原生表情发送。':'原生表情发送组件未就绪，请检查匹配微信是否已打开。'},{label:'当前账号共享池',ok:!!pool&&(mode==='foreground'||pool.count>0),detail:pool?'已加载 '+pool.count+' 张表情。'+(mode==='foreground'?'前台模式的收藏表情由微信管理。':pool.count?'聊天收集的表情仍受来源与共享范围限制。':'请添加表情或开启允许范围内的自动收集。'):'表情池无法连接，请先恢复读取服务。'}],lastError:/^[A-Z][A-Z0-9_]{2,79}$/.test(adapter.last_error??'')?adapter.last_error:''});
      }
      if(req.method==='GET'&&route==='/api/sticker-manager')return reply(200,await stickerManager(''));
      if(req.method==='GET'&&route==='/api/sticker-manager/image'){
        const id=url.searchParams.get('id'),scope=url.searchParams.get('scope');
        if(!/^[a-f0-9]{64}$/.test(id??'')||!/^[a-f0-9]{64}$/.test(scope??''))throw fault('请选择当前账号中的表情。');
        return reply(200,await stickerManager('/image?id='+id+'&scope='+scope+'&animated='+(url.searchParams.get('animated')==='1'?'1':'0')));
      }
      if(req.method==='GET'&&route==='/api/dsh-catalog'){const key=url.searchParams.get('conversationKey');if(key&&!allowedConversation(snapshot().config.wechat,key))throw fault('请先保存聊天范围。');return reply(200,await plugin('/dsh-catalog'+(key?'?conversationKey='+encodeURIComponent(key):'')));}
      if(req.method==='GET'&&route==='/api/meme-library-status'){try{return reply(200,await plugin('/meme-library/status'));}catch{return reply(200,{available:false,installed:false,reason:'DSH_PLUGIN_UNAVAILABLE'});}}
      if(req.method==='GET'&&route==='/api/extensions/meme-search'){
        const query=url.searchParams.get('query')??'';
        try{
          if(!query)return reply(200,await memeSources(root).status());
          return reply(200,await memeSources(root).search({query,kind:url.searchParams.get('kind')??'any',provider:url.searchParams.get('provider')??'auto',limit:3}));
        }catch(error){throw fault(error.message,400);}
      }
      if(req.method==='GET'&&(route==='/api/extensions'||route==='/api/plugins')){
        const saved=snapshot();let connected=false,runtime=[],pluginApiReady=false,liveFeatures=[];
        try{const health=await plugin('/health');connected=!!health.ok;pluginApiReady=health.pluginRuntime==='isolated-v2';liveFeatures=health.pluginHostFeatures??[];if(pluginApiReady)runtime=(await plugin('/extensions')).extensions??[];}catch{}
        const catalog=pluginCatalog(root,runtime);
        for(const item of catalog.plugins)if(item.id==='speech-recognition')item.serviceStatus=speechChecks.status();
        for(const item of catalog.plugins)if(item.enabled&&item.requiresHostFeatures.some(feature=>!liveFeatures.includes(feature))){item.loaded=false;item.active=false;item.reason='应用内置宿主尚未提供此插件需要的能力，请重启应用后重试。';item.statusLabel='等待宿主能力';item.statusTone='warning';}
        if(route==='/api/plugins')return reply(200,{...catalog,runtimeConnected:pluginApiReady});
        return reply(200,{...builtinCatalog(saved.config,saved.revision,connected),plugins:catalog.plugins,pluginRevision:catalog.revision,pluginError:catalog.error??null,canInstallZip:true,pluginApiReady});
      }
      if (req.method === 'GET' && route === '/api/deployment') {
        const distribution = optionalJson(path.join(root, 'config', 'distribution.json'));
        const readerSettings = optionalJson(path.join(root, 'state', 'weflow', 'WeFlow-config.json'));
        return reply(200, { installed: !!distribution.installed, version: distribution.version ?? '0.4.3', configured: !!readerSettings.dbPath && !!readerSettings.myWxid && !!readerSettings.decryptKey && readerVerified(), pluginPath: path.join(root, 'packages', 'dsh-social-bridge-plugin') });
      }
      if (req.method === 'GET' && route === '/api/status') return reply(200, await getStatus());
      if(req.method==='GET'&&route==='/api/people-memory'){const account=activeReaderAccount(root);if(!account.id)throw fault('请先连接微信。',409);const memory=new PeopleMemory({root,accountScope:hash(account.id),accountId:account.id});return reply(200,{scope:account.id,...memory.catalog()});}
      if(req.method==='GET'&&route==='/api/dsh-models'){
        try{return reply(200,await plugin('/models'));}catch{return reply(200,{available:false,models:[],message:'模型列表暂不可用，请检查 WorkBuddy 云端连接。'});}
      }
      if(req.method==='GET'&&route==='/api/workbuddy-account')return reply(200,accountInfo());
      if(req.method==='GET'&&route==='/api/activity')return reply(200,{items:listActivity(root,Number(url.searchParams.get('limit'))||24),updatedAt:Date.now()});
      if(req.method==='GET' && route==='/api/process-recovery'){
        assertIdle();const config=snapshot();
        if(url.searchParams.get('purpose')==='hook-repair')return reply(200,{...await processRecovery.scan(config.config,config.revision,{includeMatchingWeChat:true,matchingWeChatOnly:true}),purpose:'hook-repair'});
        const status=await getStatus();
        const healthyPorts=[];
        if(status.services.find(service=>service.id==='reader')?.ready)healthyPorts.push(config.config.ports.weflow);
        if(status.services.find(service=>service.id==='bridge')?.ready)healthyPorts.push(config.config.ports.onebot,config.config.ports.adapter,Number(new URL(config.config.hook.baseUrl).port||80));
        // wechatwb: 模型是进程内模块，没有 dshPlugin 监听端口，不再把它当作待清理的服务端口。
        const conflictPorts=startupConflictPorts(jobs.get(latestJob)?.output,Object.values(config.config.ports));
        return reply(200,await processRecovery.scan(config.config,config.revision,{healthyPorts:healthyPorts.filter(port=>!conflictPorts.includes(port)),includeMatchingWeChat:/HOOK_COMPONENT_UPDATE_PENDING|HOOK_CLIENT_UNHEALTHY|HOOK_INITIALIZATION_TIMEOUT|HOOK_NOT_LISTENING/.test(jobs.get(latestJob)?.output??'')}));
      }

      if (req.method === 'GET' && route === '/api/persona-categories') return reply(200,personaCategories.read());
      if (req.method === 'GET' && route === '/api/roles') {
        const names = fs.existsSync(path.join(root, 'roles')) ? fs.readdirSync(path.join(root, 'roles')).filter(n => n.endsWith('.md') && n !== 'README.md' && roleName(n.slice(0, -3))) : [];
        return reply(200, { categories: categorySnapshot(), roles: names.map(file => { const content = fs.readFileSync(path.join(root, 'roles', file), 'utf8'); return { name: file.slice(0, -3), content, revision: hash(content) }; }) });
      }
      if (req.method === 'GET' && route === '/api/contacts') {
        const kind = url.searchParams.get('kind') === 'groups' ? 'groups' : 'private';
        const keyword = (url.searchParams.get('keyword') ?? '').slice(0, 100).trim();
        // Sessions contain selected chats only; discovery must use the contact catalog.
        const data = await reader(`/api/v1/contacts?kind=${kind}&keyword=${encodeURIComponent(keyword)}&limit=100&refresh=1`);
        const io = optionalJson(path.join(root, 'state', 'wechat-io-config.json'));
        const rows = data.contacts ?? [];
        const contacts = rows.filter(c => c.username && c.username !== io.self_wxid && (c.username.includes('@chatroom') ? 'groups' : 'private') === kind)
          .map(c => ({ name: c.remark || c.displayName || c.nickname || c.username, id: String(conversationId(c.username, c.displayName, c.conversationId)), ambiguous: c.ambiguous === true,
            ...(kind==='private'&&url.searchParams.get('includeIdentity')==='1'?{wechatId:c.username}:{}),
            ...(kind==='groups'&&c.conversationId!==undefined?{groupRef:c.username}:{}) }));
        const counts = new Map(); for (const row of contacts) counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
        return reply(200, { contacts: contacts.map(c => ({ ...c, ambiguous: c.ambiguous || counts.get(c.id) > 1 })) });
      }
      if (req.method === 'GET' && route === '/api/chats') {
        const { buffer } = buffered();
        return reply(200, { chats: Object.entries(buffer.chats ?? {}).map(([key, rows]) => ({ key, name: rows.at(-1)?.conversation_name ?? key, lastAt: rows.at(-1)?.timestamp ?? 0 })) });
      }
      if (req.method === 'GET' && route === '/api/sessions') return reply(200, await plugin('/sessions'));
      if(req.method==='GET'&&route==='/api/session-groups'){try{return reply(200,await plugin('/session-groups'));}catch{return reply(200,{available:false,groups:[],revision:''});}}
      if (req.method === 'GET' && route === '/api/job') {
        const job = jobs.get(url.searchParams.get('id')); if (!job) throw fault('此操作记录已过期。', 404); return reply(200, job);
      }
      if (req.method === 'GET' && route === '/api/logs') {
        const dir = path.join(root, 'state', 'logs');
        const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => /^[a-zA-Z0-9._-]+\.log$/.test(n)).sort() : [];
        const name = url.searchParams.get('file') ?? files.find(n => n === 'bridge.stdout.log') ?? files[0];
        if (name && !files.includes(name)) throw fault('日志文件不存在。', 404);
        let content = '';
        if (name) { const file = path.join(dir, name); const fd = fs.openSync(file, 'r'); try { const size = fs.fstatSync(fd).size; const bytes = Buffer.alloc(Math.min(size, 120000)); fs.readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length)); content = safeText(bytes.toString('utf8')); } finally { fs.closeSync(fd); } }
        return reply(200, { files, file: name ?? '', content });
      }
      if (req.method === 'GET' && route === '/api/reader-config') {
        const settings = optionalJson(path.join(root, 'state', 'weflow', 'WeFlow-config.json'));
        return reply(200, { dbPath: /^(userdpapi:|safe:)/.test(settings.dbPath ?? '') ? '' : settings.dbPath ?? '', myWxid: /^(userdpapi:|safe:)/.test(settings.myWxid ?? '') ? '' : settings.myWxid ?? '', hasKey: !!settings.decryptKey, hasPath: !!settings.dbPath, hasAccount: !!settings.myWxid, verified: readerVerified(), revision: hash(JSON.stringify(settings)) });
      }
      if (req.method === 'GET' && route === '/api/muse-services') return reply(200, await serviceStatus({ root }));
      if (req.method === 'GET' && route === '/api/plugins/speech-recognition/engine') return reply(200, await speechChecks.engineStatus());
      if (req.method !== 'POST') throw fault('接口不存在。', 404);
      if (!req.headers['content-type']?.startsWith('application/json')) throw fault('请使用控制台表单。', 415);
      const body = await readBody(req,route==='/api/voice-studio/import-file'?90000000:(['/api/sticker-manager/import','/api/plugins/bundle/inspect','/api/plugins/inspect','/api/voice-studio/import-song','/api/voice-studio/voices','/api/vision-test'].includes(route)?11300000:128*1024));
      if(route==='/api/updates/check')return reply(200,await updates.check({force:true}));
      if(route==='/api/muse-services'&&req.method==='POST'){
        const action=String(body.action??'');
        // 等价于 open-muse-admin.cmd：带 Key 打开管理页（网关没起会先拉起）。
        if(action==='admin'){
          const result=await openAdmin({root,startIfOffline:true});
          return reply(200,{ok:true,...result});
        }
        if(!['start','stop'].includes(action))throw fault('action 必须是 start、stop 或 admin。',400);
        const result=action==='start'?await startMuseServices({root}):await stopMuseServices({root});
        return reply(200,{ok:true,...result});
      }
      if (route === '/api/jobs') return reply(202, startJob(body));
      assertIdle();
      if(route==='/api/vision-test'){
        if(!body||typeof body.b64!=='string'||body.b64.length>1050000)throw fault('测试图片过大，请使用768 KiB以内的图片。');
        const settings=snapshot().config.dsh??{};
        const controller=new AbortController();req.once('aborted',()=>controller.abort());res.once('close',()=>{if(!res.writableEnded)controller.abort();});
        const model=body.chatSelection?.model??settings.model??'auto';
        try{return reply(200,await visionTest({b64:body.b64,mime:body.mime,model,mode:body.mode==='parser'?'parser':'route',selection:body.selection??null},{signal:controller.signal}));}
        catch(error){
          const message=String(error?.message??error);
          throw fault(/^VISION_TEST_INVALID|^INVALID_IMAGE_DATA/.test(message)?'测试图片无效，请重新选择 PNG、JPEG 或 WebP 图片。':'图片识别失败：'+message,400);
        }
      }
      if(route==='/api/workbuddy-account'){
        if(!body||typeof body.endpoint!=='string'||typeof body.publishableKey!=='string')throw fault('请填写应用地址和 publishableKey。');
        let verified;try{verified=await verifyWorkbuddyAccount({endpoint:body.endpoint,publishableKey:body.publishableKey});}
        catch(error){throw fault(String(error?.message??error),400);}
        saveWorkbuddyAccount({endpoint:verified.endpoint,publishableKey:body.publishableKey.trim(),models:verified.models,label:body.label});
        return reply(200,{ok:true,models:verified.models,...accountInfo()});
      }
      if(route==='/api/workbuddy-account/reset'){clearWorkbuddyAccount();return reply(200,{ok:true,...accountInfo()});}
      if(route==='/api/workbuddy-account/login'){
        const exe=path.join(process.env.LOCALAPPDATA??'','Programs','WorkBuddy','WorkBuddy.exe');
        if(!fs.existsSync(exe))return reply(200,{ok:false,download:'https://www.workbuddy.cn',reason:'没有找到本机 WorkBuddy 客户端，请先安装并登录。'});
        try{const child=spawn(exe,[],{detached:true,stdio:'ignore',windowsHide:false});child.unref();return reply(200,{ok:true,path:exe});}
        catch(error){throw fault('无法启动 WorkBuddy：'+String(error?.message??error),500);}
      }
      const musicAction=/^\/api\/music\/([a-z-]+)$/.exec(route);if(musicAction)return reply(200,await musicConsole.action(musicAction[1],body));
      if(route==='/api/voice-components/select')return reply(200,await voiceComponents.select());
      if(route==='/api/voice-components/import')return reply(202,voiceComponents.start(body));
      if(route==='/api/plugins/bundle/inspect')return reply(200,pluginBundles.inspect(body));
      if(route==='/api/plugins/bundle/install')return reply(200,pluginBundles.install(body));
      if(route==='/api/plugins/bundle/download')return reply(200,await pluginBundles.download(body));
      if(route==='/api/interface-preferences')return reply(200,interfacePreferences(root).save(body));
      if(route==='/api/voice-studio/music-preferences')return reply(200,voiceConsole.saveMusicPreferences(body));
      if(route==='/api/voice-studio/engine')return reply(200,await voiceConsole.saveEngine(body));
      if(route==='/api/voice-studio/preview-engine')return reply(200,await voiceConsole.previewEngine(body));
      if(route==='/api/voice-studio/voices')return reply(200,voiceConsole.changeVoice(body));
      if(route==='/api/voice-studio/preview-voice')return reply(200,await voiceConsole.previewVoice(body));
      if(route==='/api/voice-studio/import-song')return reply(200,await voiceConsole.importSong(body));
      if(route==='/api/voice-studio/import-web')return reply(200,await voiceConsole.importWeb(body));
      if(route==='/api/voice-studio/search-songs')return reply(200,await voiceConsole.searchSongs(body));
      if(route==='/api/voice-studio/singing-voice')return reply(200,voiceConsole.saveSingingVoice(body));
      if(route==='/api/voice-studio/import-song-auto')return reply(200,await voiceConsole.importSongAuto(body));
      if(route==='/api/voice-studio/import-file')return reply(200,await voiceConsole.importLocal(body));
      if(route==='/api/voice-studio/delete-songs')return reply(200,voiceConsole.deleteSongs(body));
      if(route==='/api/voice-studio/song')return reply(200,voiceConsole.song(body));
      if(route==='/api/voice-studio/compare-engines')return reply(200,await voiceConsole.compareEngines(body));
      if(route==='/api/voice-studio/test')return reply(200,voiceConsole.test(body));
      if(route==='/api/sending-mode/check'){
        const sender=new ForegroundSender(root);
        try{return reply(200,{available:await sender.probe(path.resolve(root,snapshot().config.hook.wechatExecutable))});}
        catch(error){return reply(200,{available:false,reason:error.message});}
        finally{sender.close();}
      }
      if(route==='/api/people-memory/forget'){await assertMemoryWriterReady();const account=activeReaderAccount(root);if(!account.id||body.scope!==account.id||body.confirmed!==true)throw fault('账号已变化或尚未确认，请刷新。',409);return reply(200,new PeopleMemory({root,accountScope:hash(account.id),accountId:account.id}).forget(body.id));}
      if(route==='/api/memory/people'){await assertMemoryWriterReady();return reply(200,peopleView.change(body));}
      if(route==='/api/memory/evaluation')return reply(200,memoryEvaluation.start(body));
      if(route==='/api/memory/evaluation/cancel')return reply(200,memoryEvaluation.cancel(body));
      if(route==='/api/chat-model'){
        const previous=snapshot();if(body.revision!==previous.revision)throw fault('设置已变化，请重新打开模型选择。',409);
        if(!allowedConversation(previous.config.wechat,body.key))throw fault('请选择已允许的聊天。',403);
        const selected=body.selection;
        if(selected!==null){const catalog=await plugin('/models');if(!selected||Object.keys(selected).some(key=>!['provider','model'].includes(key))||!catalog.models?.some(row=>row.provider===selected.provider&&row.model===selected.model))throw fault('此模型已不在 WorkBuddy 可用列表中，请刷新后重选。',409);}
        const config=structuredClone(previous.config);config.dsh.chats??={};if(selected===null)delete config.dsh.chats[body.key];else config.dsh.chats[body.key]={provider:selected.provider,model:selected.model};
        validateConfig(config);backup(configFile);atomic(configFile,config);statusTime=0;return reply(200,{...snapshot(),...optionalJson(preferenceFile)});
      }
      if(route==='/api/group-behavior/replay'){if(!body||Object.keys(body).some(k=>k!=='settings'))throw fault('回放设置无效。');const item=inspectPackage(path.join(projectRoot,'optional-extensions/group-behavior'));validateValue(body.settings,{type:'object',properties:item.configSchema,additionalProperties:false});return reply(200,{simulated:true,modelCalls:0,messagesSent:0,results:replayGroupPolicy([{direct:true},{direct:false,deltaSeconds:5},{direct:true,deltaSeconds:5}],body.settings)});}
      if(route==='/api/plugins/inspect')return reply(200,pluginInstaller.inspect(body));
      if(route==='/api/plugins/install')return reply(200,pluginInstaller.install(body));
      if(route==='/api/plugins/cancel')return reply(200,pluginInstaller.cancel(body.ticket));
      if(route==='/api/plugins/speech-recognition/engine'&&req.method==='GET')return reply(200,speechChecks.engineStatus());
      if(route==='/api/plugins/speech-recognition/engine'&&req.method==='GET')return reply(200,speechChecks.engineStatus());
      if(route==='/api/plugins/speech-recognition/engine'&&req.method==='POST')return reply(200,speechChecks.engineCommand(body));
      const speechOperation=/^\/api\/plugins\/speech-recognition\/(models|check)$/.exec(route);
      if(speechOperation){
        const controller=new AbortController(),closed=()=>{if(!res.writableEnded)controller.abort();};res.once('close',closed);
        try{return reply(200,await speechChecks.run(speechOperation[1],body,{signal:controller.signal}));}
        catch(error){if(controller.signal.aborted||res.destroyed)return;throw error;}
        finally{res.removeListener('close',closed);}
      }
      const pluginRoute=/^\/api\/plugins\/([a-z][a-z0-9-]{0,39})(\/uninstall)?$/.exec(route);
      if(pluginRoute){
        if(!pluginRoute[2]&&pluginRoute[1]==='speech-recognition'){
          await speechChecks.validateForSave(body);
          if(body.enabled===true){
            let live=null;try{live=await plugin('/health');}catch{}
            const item=scanPlugins(root).find(item=>item.id==='speech-recognition'&&!item.invalid);
            if(item){const compatibility=hostCompatibility(item,live);if(!compatibility.compatible)throw fault(compatibility.reason,409);}
          }
        }
        const result=pluginRoute[2]?archivePlugin(root,pluginRoute[1],body.revision):updatePlugin(root,pluginRoute[1],body);
        if(!pluginRoute[2]&&pluginRoute[1]==='speech-recognition')speechChecks.onSaved();
        return reply(200,{ok:true,revision:result.revision});
      }
      const pluginAction=/^\/api\/plugins\/([a-z][a-z0-9-]{0,39})\/actions\/([a-z][a-z0-9-]{0,19})$/.exec(route);
      if(pluginAction){if(!allowedConversation(snapshot().config.wechat,body.key))throw fault('请选择已允许的聊天。',403);return reply(200,await plugin('/plugin-actions/'+pluginAction[1]+'/'+pluginAction[2],{conversationKey:body.key,args:body.args??{}}));}
      if(route==='/api/fish-notebook/settings'||route==='/api/fish-notebook/write'){
        const previous=snapshot(),params=new URLSearchParams({scope:String(body.scope??''),...(body.key?{conversationKey:body.key}:{})}),current=fishNotebookSnapshot(root,previous,params);
        if(!current.available||!body.scope)throw fault('请先连接微信并刷新记事本。',409);
        if(route==='/api/fish-notebook/write'){if(!current.effectiveEnabled)throw fault('请先安装并为此聊天启用鱼的记事本插件。');const result=await plugin('/fish-notebook/write',{conversationKey:current.conversationKey});if(!result.ok)throw fault('日记暂未写成，请确认插件已启用并检查 WorkBuddy 模型连接。',503);return reply(200,{ok:true});}
        throw fault('鱼的记事本已改为可选插件，请在插件配置中设置开关、时间和聊天范围。',410);
      }
      if(['/api/sticker-manager/import','/api/sticker-manager/edit','/api/sticker-manager/delete'].includes(route))return reply(200,await stickerManager('/'+route.split('/').at(-1),body));
      if(/^\/api\/session-groups\/(create|rename|delete|move)$/.test(route))return reply(200,await plugin(route.slice('/api'.length),body));
      if(route==='/api/group-bindings'){
        const config=snapshot();
        if(body.revision!==config.revision)throw fault('配置已变化，请刷新后重新关联群聊。',409);
        if(!config.config.wechat.whitelist.groups.map(String).includes(String(body.id))||typeof body.groupRef!=='string'||!/^[A-Za-z0-9_.-]{1,200}@chatroom$/.test(body.groupRef))throw fault('请选择已保存的原会话和当前微信中的群聊。');
        const io=readJson(path.join(root,'state/wechat-io-config.json'));
        const response=await fetchImpl('http://127.0.0.1:'+config.config.ports.weflow+'/api/v1/group-bindings',{method:'POST',headers:{Authorization:'Bearer '+io.reader_token,'Content-Type':'application/json'},body:JSON.stringify({username:body.groupRef,conversationId:String(body.id)}),signal:AbortSignal.timeout(8000)});
        const value=await response.json();
        if(!response.ok){const text=value.error==='GROUP_BINDING_ALREADY_ASSIGNED'?'原会话已绑定另一个真实群，请勿把不同群的历史合并。':value.error==='GROUP_BINDING_ALREADY_SELECTED'?'该群已添加到其他聊天，请先核对聊天范围中的重复项。':'群资料尚未准备好，请在匹配微信中打开该群，再刷新搜索。';throw fault(text,409);}
        statusTime=0;return reply(200,{ok:true,id:String(body.id),name:value.displayName});
      }
      if(['/api/assistant-task/status','/api/assistant-task/cancel','/api/assistant-task/list'].includes(route))return reply(200,await plugin(route.slice(4),{conversationKey:body.key,taskId:body.taskId,localControl:true}));
      if (route === '/api/chat-settings') {
        const previous = snapshot();
        if (body.revision !== previous.revision) throw fault('配置已变化，请重新打开此会话设置。', 409);
        if (!allowedConversation(previous.config.wechat, body.key)) throw fault('只能设置已保存到聊天范围的会话。');
        const config = structuredClone(previous.config);
        applyChatSettings(config, body.key, body.settings, body.access);
        validateConsoleConfig(config, root);
        const workModeChanged=conversationWorkMode(previous.config.wechat,body.key)!==conversationWorkMode(config.wechat,body.key);
        if(workModeChanged){
          const local=buffered().buffer;
          if(local.pendingReplies?.[body.key]||local.pendingRequests?.[body.key])throw fault('此会话还有待处理的回复，请完成当前任务后再切换模式。',409);
          // Offline configuration remains possible; a connected busy session must finish first.
          try{const sessions=await plugin('/sessions'),session=sessions.sessions.find(item=>item.conversationKey===body.key);if(session?.running)throw fault('此会话正在执行，请等待完成或取消任务后再切换模式。',409);}catch(error){if(error.status===409)throw error;}
        }
        const personaChanged = (previous.config.persona.chats?.[body.key] ?? null) !== (config.persona.chats?.[body.key] ?? null);
        backup(configFile); atomic(configFile, config);
        if (personaChanged) markPending();
        statusTime = 0;
        let modeReady=false;
        if(workModeChanged)try{await plugin('/configure',{conversationKey:body.key,workMode:conversationWorkMode(config.wechat,body.key)});modeReady=true;}catch{}
        return reply(200, { ...snapshot(), ...optionalJson(preferenceFile), personaChanged,workModeChanged,modeReady });
      }
      if(route==='/api/dsh-access'){const previous=snapshot();if(body.revision!==previous.revision)throw fault('配置已变化，请重新打开此聊天设置。',409);if(!allowedConversation(previous.config.wechat,body.key))throw fault('只能为已允许的聊天分配技能。');const config=structuredClone(previous.config);config.wechat.dshAccess??={chats:{}};config.wechat.dshAccess.chats[body.key]={skills:body.skills,tools:body.tools};validateConversationSettings(config.wechat);backup(configFile);atomic(configFile,config);statusTime=0;return reply(200,{...snapshot(),pendingApply:false});}
      if(route==='/api/extensions/meme-search'){
        try{return reply(200,await memeSources(root).save(body??{}));}
        catch(error){throw fault(error.message,400);}
      }
      const builtinRoute=/^\/api\/extensions\/(native-member-memory|native-web-reader|native-search|native-stickers|native-proactive|native-context)$/.exec(route);
      if(builtinRoute) {
        const previous=snapshot();
        if(body.revision!==previous.revision)throw fault('配置已变化，请重新打开扩展设置。',409);
        let config;try{config=validateConsoleConfig(applyBuiltinUpdate(previous.config,builtinRoute[1],body),root);}catch(error){throw error.status?error:fault(error.message);}
        backup(configFile);atomic(configFile,config);
        return reply(200,{...snapshot(),...optionalJson(preferenceFile)});
      }
      if (route === '/api/reader-accounts') {
        if (typeof body.dbPath !== 'string' || body.dbPath.length > 4096 || /[\0\r\n]/.test(body.dbPath)) throw fault('目录包含无效字符。');
        protectingCredential = true;
        try {
          const result = await readerSetup({ root, python: snapshot().config.runtime.python, request: { operation: 'discover', dbPath: body.dbPath.trim() } });
          if (!result.ok) throw fault(readerSetupMessage(result.code));
          return reply(200, { accounts: result.accounts });
        } catch (error) { throw error.status ? error : fault(readerSetupMessage(error.message)); }
        finally { protectingCredential = false; }
      }
      if (route === '/api/quit') {
        reply(200, { ok: true });
        setTimeout(() => { if (onQuit) onQuit(); else { server.closeAllConnections(); server.close(); } }, 100);
        return;
      }
      if (route === '/api/config') {
        const previous = snapshot();
        if (body.revision !== previous.revision) throw fault('配置已在其他窗口更新，请重新载入后再保存。', 409);
        const config = validateConsoleConfig(body.config, root);
        if(previous.config.dsh.provider!==config.dsh.provider||previous.config.dsh.model!==config.dsh.model){const catalog=await plugin('/models');if(!catalog.models?.some(row=>row.provider===config.dsh.provider&&row.model===config.dsh.model))throw fault('请选择 WorkBuddy 模型列表中当前可用的模型。',409);}
        if (Object.values(config.ports).includes(boundPort) || Number(new URL(config.hook.baseUrl).port || 80) === boundPort) throw fault('服务端口不能与当前控制台端口重复。');
        backup(configFile); atomic(configFile, config);
        const withoutStickers=value=>{const copy=structuredClone(value);delete copy.wechat.fishNotebook;delete copy.wechat.replyLayout;delete copy.wechat.stickers;delete copy.wechat.search;delete copy.wechat.webReader;delete copy.wechat.proactive;delete copy.wechat.context;delete copy.wechat.chatModes;delete copy.wechat.dshAccess;delete copy.wechat.memeLibrary;delete copy.wechat.assistant;if(copy.dsh){delete copy.dsh.provider;delete copy.dsh.model;delete copy.dsh.chats;}return copy;};
        if(JSON.stringify(withoutStickers(previous.config))!==JSON.stringify(withoutStickers(config)))markPending(JSON.stringify(previous.config.dsh) !== JSON.stringify(config.dsh) || previous.config.ports.dshPlugin !== config.ports.dshPlugin);
        return reply(200, { ...snapshot(), ...optionalJson(preferenceFile) });
      }
      if(route==='/api/assistant-feedback')return reply(200,saveFeedback(root,body));
      if (route === '/api/persona-categories') return reply(200,personaCategories.update(body));
      if (route === '/api/roles/delete') {
        if(personaError(body.name,'check'))throw fault('请选择有效的人设卡，不能删除说明文件或文件路径。');
        if(body.confirmed!==true)throw fault('请先确认删除人设卡。',409);
        const directory=path.join(root,'roles');
        if(!fs.existsSync(directory))throw fault('人设卡已不存在，请刷新后重试。',404);
        if(fs.lstatSync(directory).isSymbolicLink())throw fault('人设目录为链接，不能通过此入口删除。');
        const filename=fs.readdirSync(directory).find(name=>name.toLocaleLowerCase()===(body.name+'.md').toLocaleLowerCase());
        if(!filename)throw fault('人设卡已不存在，请刷新后重试。',404);
        const name=filename.slice(0,-3),file=path.join(directory,filename),stat=fs.lstatSync(file);
        if(!stat.isFile()||stat.isSymbolicLink())throw fault('此人设不是普通文件，不能删除。');
        if(body.revision!==hash(fs.readFileSync(file,'utf8')))throw fault('人设卡已被修改，请重新载入后再删除。',409);
        const references=personaReferences(snapshot().config.persona,name,snapshot().config.wechat.modeSettings);
        if(references.default)throw fault('此人设是默认人设，请先切换默认人设并保存设置。',409);
        if(references.chats.length)throw fault('有聊天正在使用此人设，请先切换聊天人设并保存设置。',409);
        backup(file);
        const marker=deletedPersonaFile(name),previous=fs.existsSync(marker)?fs.readFileSync(marker,'utf8'):null;
        atomic(marker,{version:1,name});
        let restoreCategories;
        try{restoreCategories=personaCategories.forget(name);fs.unlinkSync(file);}catch(error){restoreCategories?.();if(previous===null)fs.unlinkSync(marker);else atomic(marker,previous);throw error;}
        return reply(200,{ok:true,name});
      }
      if (route === '/api/roles') {
        const error = personaError(body.name, body.content);
        if (error) throw fault(error);
        fs.mkdirSync(path.join(root, 'roles'), { recursive: true });
        const file = path.join(root, 'roles', body.name + '.md');
        const exists = fs.existsSync(file);
        if (exists && body.revision !== hash(fs.readFileSync(file, 'utf8'))) throw fault('同名人格已存在或已被修改，请重新载入或换一个名称。', 409);
        if (!exists && body.revision) throw fault('人格文件已被移动，请重新载入。', 409);
        backup(file); atomic(file, body.content);
        const marker=deletedPersonaFile(body.name);if(fs.existsSync(marker))fs.unlinkSync(marker);
        markPending();
        return reply(200, { ok: true, revision: hash(body.content), categories: categorySnapshot() });
      }
      if (route === '/api/browse') {
        if (!['exe', 'folder', 'workspace'].includes(body.kind)) throw fault('无效的文件类型。');
        return reply(200, { path: filePicker ? await filePicker(body.kind) : await nativeHelper(body.kind) });
      }
      if (route === '/api/dsh-reopened') {
        const health=await plugin('/health');
        if(!dshConfigurationMatches(root,snapshot().config,health))throw fault('当前模型配置尚未生效，请保存设置并重启应用。',409);
        atomic(preferenceFile, { ...optionalJson(preferenceFile), dshRestartRequired: false }); statusTime = 0;
        return reply(200, { ok: true });
      }
      if(route==='/api/process-recovery/prepare')return reply(200,await processRecovery.prepare(body.scanId,body.ids,snapshot().revision));
      if(route==='/api/process-recovery/stop'){
        processRecoveryBusy=true;
        try{return reply(200,await processRecovery.stop(body.confirmation,body.confirmed,snapshot().revision));}
        finally{processRecoveryBusy=false;statusTime=0;}
      }
      if (route === '/api/reader-config') {
        const file = path.join(root, 'state', 'weflow', 'WeFlow-config.json');
        const settings = optionalJson(file);
        if (body.revision !== hash(JSON.stringify(settings))) throw fault('读取配置已变化，请重新载入后保存。', 409);
        for (const key of ['dbPath', 'myWxid', 'decryptKey']) {
          if (typeof body[key] !== 'string' || body[key].length > 4096 || /[\0\r\n]/.test(body[key])) throw fault('读取设置包含无效字符。');
        }
        if ((!body.dbPath.trim() && !settings.dbPath) || (!body.myWxid.trim() && !settings.myWxid) || (!body.decryptKey.trim() && !settings.decryptKey)) throw fault('首次配置需要数据库目录、账号标识和读取凭据。');
        const proposed = { ...settings, dbPath: body.dbPath.trim() || settings.dbPath, myWxid: body.myWxid.trim() || settings.myWxid };
        if (readerAccountId(root, proposed) !== readerAccountId(root, settings)) throw fault('切换账号请使用“连接并验证微信”，验证通过后会安全停止旧服务并切换。', 409);
        if (body.dbPath.trim()) settings.dbPath = body.dbPath.trim();
        if (body.myWxid.trim()) settings.myWxid = body.myWxid.trim();
        if (body.decryptKey.trim()) {
          protectingCredential = true;
          try {
            settings.decryptKey = await nativeHelper('protect', body.decryptKey.trim());
            if (!/^userdpapi:[A-Za-z0-9+/=]+$/.test(settings.decryptKey)) throw fault('凭据保护失败，原有配置未修改。');
          } finally { protectingCredential = false; }
        }
        if (body.revision !== hash(JSON.stringify(optionalJson(file)))) throw fault('读取配置已变化，请重新载入后保存。', 409);
        backup(file); atomic(file, settings); markPending(); return reply(200, { ok: true });
      }
      throw fault('接口不存在。', 404);
    } catch (error) {
      const message = error.code === 'ENOENT' ? '所需文件尚未准备，请检查连接设置。' : error.status ? error.message : '操作失败，请检查配置和本机文件。';
      reply(error.status ?? 500, { error: safeText(message) });
    }
  });
  server.requestTimeout = 180000;
  const start=()=>new Promise((resolve,reject)=>{
    let attempts=0;
    const listen=()=>{
      attempts++;
      const ready=()=>{server.removeListener('error',failed);resolve(server.address());};
      const failed=error=>{server.removeListener('listening',ready);if(port===0&&attempts<16&&['EADDRINUSE','EACCES'].includes(error.code)){listen();return;}reject(error);};
      server.once('error',failed);
      server.once('listening',ready);
      // Windows port 0 can choose a browser-blocked service port (e.g. 6667).
      server.listen(port===0?crypto.randomInt(20000,60000):port,'127.0.0.1');
    };
    listen();
  });
  server.on('close',()=>{pluginInstaller.dispose();speechChecks.close();});
  server.once('close',()=>memoryEvaluation.close());
  return { server, shutdown, isBusy: () => shuttingDown || !!activeJob || protectingCredential || processRecoveryBusy || voiceComponents.busy, close: () => { memoryEvaluation.close();server.closeAllConnections(); server.close(); }, start };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.WECHATWB_CONSOLE_PORT ?? 3310);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid console port');
  const app = createConsole({ port });
  await app.start();
  console.log(`WeChatBot Console: http://127.0.0.1:${port}`);
}
