import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {recognize} from './lib/recognize.mjs';
import {configureLocalEngine, localEngine} from './lib/local-engine.mjs';

// 插件目录固定为 <root>/plugins/speech-recognition，向上两级即运行时根目录。
const pluginDirectory = fileURLToPath(new URL('.', import.meta.url));
const hostRoot = path.resolve(pluginDirectory, '../..');

export function setup(api) {
  const engine = configureLocalEngine({
    root: hostRoot,
    log: (...args) => { try { api.log(...args); } catch { /* 日志不可用时忽略 */ } },
    settings: () => { try { return api.config(); } catch { return {}; } },
  });
  engine.init();
  api.registerAction({
    id: 'transcribe',
    description: '转写宿主核验过的当前微信语音；远程接口或本地引擎由本机配置决定。',
    parameters: {
      type: 'object', properties: {id: {type: 'string', minLength: 64, maxLength: 64}},
      required: ['id'], additionalProperties: false,
    },
    execute: recognize,
  });
  // 随服务自动启动本地引擎：不阻塞插件加载（setup 有时限），结果写 engine.json。
  const settings = (() => { try { return api.config(); } catch { return {}; } })();
  if (settings.engine === 'local' && settings.localAutostart !== false) {
    queueMicrotask(() => {
      engine.start().catch(error => {
        try { engine.log('[local-engine] 自动启动失败: ' + (error.message ?? error)); } catch { /* 忽略 */ }
      });
    });
  }
}

export async function deactivate() {
  const engine = localEngine();
  if (engine) await engine.dispose();
}

export async function dispose() {
  const engine = localEngine();
  if (engine) await engine.dispose();
}
