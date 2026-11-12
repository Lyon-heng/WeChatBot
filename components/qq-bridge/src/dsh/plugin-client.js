/**
 * wechatwb — 进程内模型客户端（替代原 DSH 插件 HTTP 客户端）
 *
 * 原版：通过 11230 端口 + Bearer 令牌调用外部 DSH/桥接程序（前端/后端分离）。
 * 现在：WorkBuddy 模型直接焊在本进程内，消息管线通过普通函数调用取得回复。
 * 无监听端口、无外部 exe、无令牌、无反代。
 *
 * 保留 DshPluginClient 类名与全部方法签名，WeChatBot 其余组件无需改动。
 */
import { chatWithFallback, chat, inProcessHealth, activeModel, listModels } from '../../../../wechatwb/workbuddy-model.mjs';
import { getPluginRuntime, openaiTools, createTurn, runToolStep, commitTurnVoice } from '../../../../wechatwb/plugin-tools.mjs';
import { recordActivity } from '../../../../wechatwb/activity.mjs';

export class DshPluginClient {
  constructor({ url, token, timeoutMs, feedback, root } = {}, log = () => {}) {
    this.log = log;
    this.feedback = feedback;
    this.root = root ? String(root) : '';
    this.timeoutMs = timeoutMs ?? 125000;
    this.instanceId = 'wechatwb-' + process.pid;
    this.startedAt = Date.now() - Math.floor(process.uptime() * 1000);
    this.log('[wechatwb] 内置 WorkBuddy 模型已装载（in-process, model=' + activeModel() + '）');
  }

  /** 进程内恒就绪；字段形状与 DshConnectionGuard 期望一致 */
  async connectionHealth({ projectRoot, accountScope } = {}) {
    return {
      ready: true,
      instanceId: this.instanceId,
      startedAt: this.startedAt,
      ...inProcessHealth(projectRoot, accountScope),
    };
  }

  /**
   * 联网搜索与助手持久任务曾由 DSH 提供。WorkBuddy 云端接口本身不带搜索/任务调度，
   * 因此这里保持关闭，改由本机插件的 tools 提供网页与媒体读取能力，避免模型假装搜过。
   */
  async searchReady() {
    this.searchSupported = false;
    this.controllerSupported = false;
    this.modelSearchSupported = false;
    return false;
  }

  async modelSearchReady() { return false; }
  async controllerReady() { return false; }

  /** 微信语音转写：改由本机 speech-recognition 插件在进程内完成，不再依赖 DSH 宿主 */
  async recognizeVoice(conversationKey, voice, _sender, options = {}) {
    const id = typeof voice === 'string' ? voice : voice?.id;
    if (!this.root || this.pluginsUnavailable || typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) {
      return { ok: false, code: 'VOICE_INPUT_UNAVAILABLE', stage: 'host' };
    }
    try {
      const runtime = await getPluginRuntime(this.root);
      if (!runtime.isActive('speech-recognition', conversationKey)) {
        return { ok: false, code: 'VOICE_INPUT_UNAVAILABLE', stage: 'host' };
      }
      const turn = createTurn(conversationKey, {});
      turn.voiceIds = [id];
      const result = await runtime.invokeAction('speech-recognition', 'transcribe', { id }, turn, { signal: options?.signal });
      return result ?? { ok: false, code: 'VOICE_INPUT_FAILED', stage: 'host' };
    } catch {
      return { ok: false, code: 'VOICE_INPUT_FAILED', stage: 'host' };
    }
  }

  /** 取本轮可用的插件工具；不可用时安静降级为纯文字聊天 */
  async pluginBridge(conversationKey, metadata) {
    if (!this.root || this.pluginsUnavailable) return null;
    if (!/^wechat:(private|group):[1-9]\d*$/.test(String(conversationKey ?? ''))) return null;
    try {
      const runtime = await getPluginRuntime(this.root);
      const tools = openaiTools(runtime, conversationKey);
      if (!tools.length) return null;
      const turn = createTurn(conversationKey, metadata ?? {});
      return {
        tools,
        runTool: (name, args) => runToolStep(runtime, turn, name, args),
        commit: () => commitTurnVoice(runtime, turn),
      };
    } catch (error) {
      this.pluginsUnavailable = true;
      this.log('[wechatwb] 插件工具不可用，已降级为纯文字：' + error.message);
      return null;
    }
  }

  /** 核心：一轮聊天 → 直接调用内置 WorkBuddy 模型（带插件工具） */
  async followup(conversationKey, message, metadata = {}, _options = {}) {
    const started = Date.now();
    const chatName = metadata?.conversationName || metadata?.chatName || conversationKey;
    const record = (phase, extra = {}) => {
      if (!this.root) return;
      recordActivity(this.root, {
        key: conversationKey, name: chatName, phase,
        at: extra.at ?? Date.now(), ms: extra.ms ?? 0, detail: extra.detail,
      });
    };
    record('thinking');
    try {
      const bridge = await this.pluginBridge(conversationKey, metadata);
      // 只注入「管理员 WorkBuddy 助手」的 before-context 指令，不触发其它插件的钩子。
      let extraContext = '';
      try {
        if (this.root) {
          const runtime = await getPluginRuntime(this.root);
          if (runtime.isActive?.('admin-dsh', conversationKey)) {
            const result = await runtime.hookFor?.('admin-dsh', 'before-context', { message }, createTurn(conversationKey, metadata ?? {}));
            if (typeof result?.context === 'string') extraContext = result.context;
          }
        }
      } catch (error) {
        this.log('[wechatwb] 管理员助手提示词未加载：' + error.message);
      }
      const text = await chatWithFallback(message, {
        ...metadata,
        conversationKey,
        root: this.root,
        ...(extraContext ? { extraContext } : {}),
        ...(bridge ? { tools: bridge.tools, runTool: bridge.runTool } : {}),
      });
      if (bridge) { try { bridge.commit(); } catch { /* ignore */ } }
      record('done', { ms: Date.now() - started });
      this.log(`[wechatwb] ${conversationKey} reply (${((Date.now() - started) / 1000).toFixed(1)}s): ${text.slice(0, 60)}`);
      return text;
    } catch (error) {
      record('failed', { ms: Date.now() - started, detail: String(error?.message ?? error).slice(0, 120) });
      this.log(`[wechatwb] ${conversationKey} model failed: ${error.message}`);
      throw Object.assign(new Error('wechatwb 模型调用失败：' + error.message), { admitted: false });
    }
  }

  /** 助手工作模式：同样走内置模型（不启用 DSH 持久任务） */
  async assistantFollowup(requestBody, metadata = {}) {
    let request = {};
    try { request = JSON.parse(requestBody); } catch { /* ignore */ }
    const text = await chatWithFallback(request.message ?? '', {
      ...metadata,
      persona: request.persona ?? metadata.persona,
      conversationKey: request.conversationKey,
    });
    return new Response(JSON.stringify({ text }), { status: 200 });
  }

  async assistantTask(_conversationKey, _action, _options = {}) {
    return { ok: false, task: null, unavailable: true };
  }

  /** 上下文压缩由 WeChatBot 自己的窗口机制承担，这里返回未压缩 */
  async maintainContext() {
    return { compacted: false, tokensBefore: 0, contextTokens: 0 };
  }

  /** 控制台可用：列出 WorkBuddy 云端模型 */
  async models() {
    return listModels();
  }
}
