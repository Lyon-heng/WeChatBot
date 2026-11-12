// Pure shared data: installer, runtime, worker, DSH health and console UI use it.
export const API_VERSION = 2;
export const HOST_RUNTIME = 'isolated-v2';
export const CONTRACT_REVISION = 'wechatagent-plugin-v2.9';
export const PERMISSION_LABELS = Object.freeze({
  model_embed: '调用本机嵌入模型（向所选本机服务提供当前聊天片段）',
  reply_policy: '控制已授权群聊的接话与重复回复抑制',
  storage: '保存插件数据',
  history_read: '读取当前聊天历史',
  web_fetch: '访问公开网页',
  reply: '申请发送当前聊天回复',
  documents: '保存日记等独立文档',
  persona_read: '读取当前聊天人格',
  model_generate: '独立调用当前模型（会产生消耗）',
  schedule: '按设置的每日时间执行',
  audio_read: '读取当前微信语音（语音识别插件会上传至所配置的 API）',
  voice: '在已授权聊天发送原生语音与歌曲',
  video: '在已授权聊天发送视频文件（本机文件投递队列）',
  people_memory: '按真实身份保存跨聊天记忆',
  dsh_tasks: '管理员调用本机任务',
});
export const PERMISSIONS = Object.freeze(Object.keys(PERMISSION_LABELS));
export const FEATURE_LABELS = Object.freeze({
  'cosyvoice-speech-v1': '专用肥鱼常驻CosyVoice3语音引擎',
  'group-reply-policy-v1': '独立群聊接话门控与表达控制',
  'archive-memory-index-v1': '按账号聊天与人物过滤的完整档案持久索引',
  'multipart-song-v1': '60秒片段与55秒分段完整翻唱',
  'local-embeddings-v1': '本机嵌入向量与混合检索',
  'local-voice-model-v1': '选择本机 Breeze GGUF 语音模型',
  'secure-plugin-settings-v1': 'Windows 用户绑定的插件设置加密',
  'people-memory-config-v1': '可配置人物记忆、档案召回与滚动摘要',
  'actions-v1': '宿主动作',
  'documents-v1': '独立文档',
  'persona-read-v1': '当前人设读取',
  'model-utility-v1': '独立模型生成',
  'daily-schedule-v1': '每日计划',
  'schedule-phases-v1': '每日计划模式切换与失败重试',
  'history-day-v1': '当天或前一天的聊天素材',
  'netease-song-link-v1': '网易云歌曲链接点唱',
  'netease-account-v1':'网易云站内搜索与本机扫码登录',
  'random-voice-replacement-v1':'随机句子语音替换与文字补发',
  'saved-songs-v1': '翻唱成品保存与制作进度',
  'public-media-v1': '网易云音乐与哔哩哔哩公开内容',
  'voice-input-v1': '微信语音输入',
  'voice-input-route-v1': '语音接收、转写与回复完整链路',
  'native-voice-v1': '原生语音与唱歌',
  'video-delivery-v1': '插件视频文件投递',
  'people-memory-auto-v1':'明确人物事实自动保存与上下文召回',
  'people-memory-v1': '人物记忆',
  'admin-dsh-v1': '管理员任务',
  'chat-dsh-access-v1': '聊天模式本机权限',
});
export const HOST_FEATURES = Object.freeze(Object.keys(FEATURE_LABELS));
export const PERMISSION_FEATURES = Object.freeze({
  reply_policy: 'group-reply-policy-v1', model_embed: 'local-embeddings-v1', documents: 'documents-v1', persona_read: 'persona-read-v1',
  model_generate: 'model-utility-v1', schedule: 'daily-schedule-v1', audio_read: 'voice-input-v1',
  voice: 'native-voice-v1', video: 'video-delivery-v1', people_memory: 'people-memory-v1', dsh_tasks: 'admin-dsh-v1',
});
export const HOOKS = Object.freeze(['before-context', 'after-response']);

export function requiredHostFeatures(item) {
  return [...new Set([...(item.requiresHostFeatures ?? []), ...(item.permissions ?? []).map(name => PERMISSION_FEATURES[name]).filter(Boolean), ...(item.schedule ? ['daily-schedule-v1'] : [])])];
}

export function hostContract() {
  return {apiVersion: API_VERSION, runtime: HOST_RUNTIME, revision: CONTRACT_REVISION, permissions: [...PERMISSIONS], features: [...HOST_FEATURES]};
}

export function contractFingerprint(contract = hostContract()) {
  return JSON.stringify([contract.apiVersion, contract.runtime, contract.revision, [...(contract.permissions ?? [])].sort(), [...(contract.features ?? [])].sort()]);
}

export function hostCompatibility(item, live) {
  const required = requiredHostFeatures(item);
  if (!live) return {compatible: false, reason: '应用内置插件宿主未就绪，请重启应用后再启用。', missingFeatures: required, missingPermissions: []};
  const version = live.apiVersion ?? live.pluginApiVersion ?? live.extensionApiVersion;
  const runtime = live.runtime ?? live.pluginRuntime;
  const rawFeatures = live.features ?? live.pluginHostFeatures;
  const features = Array.isArray(rawFeatures) ? rawFeatures.filter(name=>typeof name==='string') : [];
  const permissions = live.permissions ?? live.pluginPermissions;
  const missingFeatures = required.filter(name => !features.includes(name));
  const missingPermissions = Array.isArray(permissions) ? (item.permissions ?? []).filter(name => !permissions.includes(name)) : [];
  if (version !== API_VERSION || runtime !== HOST_RUNTIME) return {compatible: false, reason: '应用内置插件宿主版本不兼容，请重启应用。', missingFeatures, missingPermissions};
  const missing = [...missingFeatures.map(name => FEATURE_LABELS[name] ?? name), ...missingPermissions.map(name => PERMISSION_LABELS[name] ?? name)];
  return {compatible: !missing.length, missingFeatures, missingPermissions, reason: missing.length ? '当前应用内置宿主缺少：'+[...new Set(missing)].join('、')+'。请重启应用以加载新版插件宿主。' : ''};
}

// Kept in one place so prepare/build checks cannot omit a new runtime module.
export const PLUGIN_HOST_FILES = Object.freeze([
  'packages/plugin-api/contract.mjs', 'packages/plugin-api/catalog.mjs',
  'packages/plugin-api/settings-protection.mjs',
  'packages/plugin-api/memory-policy.mjs',
  'packages/plugin-api/embeddings.mjs',
  'packages/plugin-api/archive-memory.mjs',
  'packages/dsh-social-bridge-plugin/continuity-memory.mjs',
  'packages/dsh-social-bridge-plugin/memory-evaluation.mjs',
  'packages/voice-studio/segments.mjs',
  'packages/voice-studio/music-preferences.mjs',
  'packages/voice-studio/library.mjs',
  'packages/voice-studio/cosyvoice.mjs',
  'packages/plugin-api/index.mjs', 'packages/plugin-api/process.mjs',
  'packages/plugin-api/worker.mjs', 'packages/plugin-api/installer.mjs',
  'packages/plugin-api/zip.mjs', 'packages/plugin-api/documents.mjs',
  'packages/plugin-api/daily-schedule.mjs',
  'packages/plugin-api/model-utility.mjs', 'packages/plugin-api/audio.mjs',
  'packages/public-media/index.mjs', 'packages/dsh-social-bridge-plugin/search-provider.mjs',
  'packages/plugin-api/voice-status.mjs',
  'packages/plugin-api/people-memory.mjs', 'packages/plugin-api/people-facts.mjs', 'packages/dsh-social-bridge-plugin/member-memory.mjs', 'packages/plugin-api/admin-dsh.mjs',
  'packages/voice-studio/jobs.mjs', 'packages/voice-studio/singing.mjs',
  'packages/voice-studio/synthesis.mjs', 'packages/voice-studio/voices.mjs', 'packages/voice-studio/speech-api.mjs',
  'packages/voice-studio/music.mjs', 'packages/voice-studio/delivery-policy.mjs', 'packages/voice-studio/reply-replacement.mjs',
  'packages/netease/client.mjs', 'packages/netease/credential.ps1',
  'packages/dsh-social-bridge-plugin/package.json', 'packages/dsh-social-bridge-plugin/package-lock.json',
  'packages/dsh-social-bridge-plugin/model-routing.mjs',
  'packages/dsh-social-bridge-plugin/vision-fallback.mjs',
]);
export const VOICE_CODEC_FILES = Object.freeze([
  'scripts/decode-wechat-voice.py', 'scripts/decode-wechat-voice.mjs',
  'packages/voice-codec/silk-wasm/package.json', 'packages/voice-codec/silk-wasm/LICENSE',
  'packages/voice-codec/silk-wasm/PROVENANCE.json', 'packages/voice-codec/silk-wasm/lib/index.mjs', 'packages/voice-codec/silk-wasm/lib/silk.wasm',
]);
export const VOICE_HOST_FILES = Object.freeze([
  ...VOICE_CODEC_FILES, 'scripts/wechat_voice_input.py', 'scripts/voice-requirements.txt',
  'scripts/reader-api.py', 'scripts/hook-onebot.mjs', 'scripts/reader-account-state.mjs',
  'components/qq-bridge/src/core/voice-ingress.js', 'components/qq-bridge/src/onebot/normalize.js',
  'components/qq-bridge/src/adapters/wechat/wechat-onebot-adapter.js',
  'components/qq-bridge/src/social-bridge.js', 'components/qq-bridge/src/dsh/plugin-client.js',
]);
