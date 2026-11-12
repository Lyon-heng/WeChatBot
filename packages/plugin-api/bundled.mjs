// Only these reviewed first-party packages belong in source/installer releases.
export const BUNDLED_PLUGINS = Object.freeze([
  Object.freeze({id:'cosyvoice-engine',name:'原生肥鱼 CosyVoice3',version:'1.0.1',source:'optional-extensions/cosyvoice-engine',zip:'optional-extensions/packages/cosyvoice-engine-1.0.1.zip'}),
  Object.freeze({id:'memory-evaluation',name:'虚构长对话评测',version:'1.0.1',source:'optional-extensions/memory-evaluation',zip:'optional-extensions/packages/memory-evaluation-1.0.1.zip'}),
  Object.freeze({id:'group-behavior',name:'自然群聊节奏',version:'1.0.1',source:'optional-extensions/group-behavior',zip:'optional-extensions/packages/group-behavior-1.0.1.zip',files:['README.md','plugin.json','index.mjs','lib/policy.mjs']}),
  Object.freeze({id:'local-voice-model',name:'本地声音模型',version:'1.0.0',source:'optional-extensions/local-voice-model',zip:'optional-extensions/packages/local-voice-model-1.0.0.zip'}),
  Object.freeze({id:'memory-retrieval',name:'档案检索助手',version:'1.2.1',source:'optional-extensions/memory-retrieval',zip:'optional-extensions/packages/memory-retrieval-1.2.1.zip'}),
  Object.freeze({id:'memory-events',name:'事件与约定',version:'1.2.1',source:'optional-extensions/memory-events',zip:'optional-extensions/packages/memory-events-1.2.1.zip',files:['README.md','plugin.json','index.mjs','event-policy.mjs']}),
  Object.freeze({id: 'chat-notes', name: '聊天小便签示例', version: '1.0.0', source: 'examples/plugins/chat-notes', files:['README.md','index.mjs','plugin.json']}),
  Object.freeze({id: 'admin-dsh', name: '管理员 WorkBuddy 助手', version: '1.1.0', source: 'optional-extensions/admin-dsh', zip: 'optional-extensions/packages/admin-dsh-1.1.0.zip'}),
  Object.freeze({id: 'bilibili-public', name: '哔哩哔哩', version: '1.0.0', source: 'optional-extensions/bilibili-public', zip: 'optional-extensions/packages/bilibili-public-1.0.0.zip'}),
  Object.freeze({id: 'fish-notebook', name: '鱼的记事本', version: '1.0.0', source: 'optional-extensions/fish-notebook', zip: 'optional-extensions/packages/fish-notebook-1.0.0.zip', files:['README.md','index.mjs','lib/notebook.mjs','plugin.json']}),
  Object.freeze({id: 'netease-music', name: '网易云音乐', version: '1.1.0', source: 'optional-extensions/netease-music', zip: 'optional-extensions/packages/netease-music-1.1.0.zip'}),
  Object.freeze({id: 'people-memory', essential:true, name: '跨聊天人物记忆', version: '1.3.0', source: 'optional-extensions/people-memory', zip: 'optional-extensions/packages/people-memory-1.3.0.zip'}),
  Object.freeze({id: 'persona-studio', essential:true, name: 'AI 人格工作室', version: '1.1.0', source: 'optional-extensions/persona-studio', zip: 'optional-extensions/packages/persona-studio-1.1.0.zip'}),
  Object.freeze({id: 'speech-recognition', name: '微信语音识别', version: '1.3.0', source: 'optional-extensions/speech-recognition', zip: 'optional-extensions/packages/speech-recognition-1.3.0.zip', files:['README.md','LICENSE','UPSTREAM.json','index.mjs','lib/recognize.mjs','lib/diagnostics.mjs','plugin.json','assets/config-test.wav']}),
  Object.freeze({id: 'voice-studio', name: '语音工作室', version: '1.4.1', source: 'optional-extensions/voice-studio', zip: 'optional-extensions/packages/voice-studio-1.4.1.zip'}),
]);
