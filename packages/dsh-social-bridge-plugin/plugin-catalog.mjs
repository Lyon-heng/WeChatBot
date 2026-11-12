// Display provenance only. Authorization always remains keyed by tool name.
import path from 'node:path';
import {pathToFileURL} from 'node:url';
export const name='wechat-tool-catalog';
export const inject=['tools'];
const ORIGINS = Symbol.for('wechatagent.tool-origins.v1');
const text = (value, limit = 200) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit) : '';
export function localizedText(value) {
  if (typeof value === 'string') return text(value, 500);
  if (!value || typeof value !== 'object') return '';
  return text(value['zh-cn'] ?? value['zh-CN'] ?? value.zh ?? value.en, 500);
}

function packageName(moduleName) {
  const bare = /^(@[a-z0-9._~-]+\/[a-z0-9._~-]+|[a-z0-9][a-z0-9._~-]*)(?:\/|$)/i.exec(moduleName);
  if (bare && !moduleName.startsWith('file:') && !moduleName.startsWith('cordis:')) return bare[1];
  // A configured file entry is a real registration source, not a tool-name guess.
  if (!moduleName.startsWith('file:')) return '';
  let pathname;try { pathname = decodeURIComponent(new URL(moduleName).pathname); } catch { return ''; }
  return /\/node_modules\/(@[^/]+\/[^/]+|[^/]+)\//.exec(pathname)?.[1] ?? '';
}

/** Observe the documented Cordis service accessor; never replace the registry,
 * tool definitions, execution callbacks, or returned lifecycle disposers. */
export function trackToolOrigins(ctx) {
  const root = ctx.root ?? ctx;
  if (root[ORIGINS]) {
    const shared = root[ORIGINS]; shared.references++;
    return subscription(root, shared);
  }
  const tools = ctx.get?.('tools');
  if (!ctx.reflect?.accessor || typeof tools?.register !== 'function') return () => {};
  const fallbackRegister = tools.register;
  const shared = { definitions: new WeakMap(), references: 1, dispose: null };
  try {
    shared.dispose = (root.reflect ?? ctx.reflect).accessor('tools.register', {
      get(receiver) {
        receiver ??= tools;
        const caller = receiver.ctx ?? this;
        const prototype = Object.getPrototypeOf(receiver);
        const prototypeMethod = prototype && Reflect.get(prototype, 'register');
        const register = typeof prototypeMethod === 'function' ? prototypeMethod : fallbackRegister;
        return function (...args) {
          const result = Reflect.apply(register, receiver, args);
          // Metadata failures must never affect a successful registration.
          try {
            const entry = caller.fiber?.entry;
            if (args[0] && typeof args[0] === 'object' && entry?.options?.name) {
              shared.definitions.set(args[0], {
                entryId: String(entry.id ?? ''),
                moduleName: entry.options.name,
                packageName: packageName(entry.options.name),
                baseUrl: entry.parent?.tree?.ctx?.baseUrl,
              });
            }
          } catch {}
          return result;
        };
      },
    });
    root[ORIGINS] = shared;
  } catch { return () => {}; } // Respect another plugin's existing accessor.
  return subscription(root, shared);
}
function subscription(root, shared) {
  let active=true;
  return () => { if(active){active=false;release(root,shared);} };
}
function release(root, shared) {
  if (--shared.references !== 0) return;
  if (root[ORIGINS] === shared) delete root[ORIGINS];
  shared.dispose?.();
}

export function apply(ctx) {
  const dispose=trackToolOrigins(ctx);
  // Assistant preset registration waits for this marker, so its eagerly
  // composed tools cannot precede their display-provenance observer.
  ctx.reflect.provide('wechatToolCatalog',{version:1});
  ctx.effect(()=>dispose);
}
export function toolCatalogPatch(root) {
  const row={id:'wechat-tool-catalog',name:pathToFileURL(path.join(root,'packages/dsh-social-bridge-plugin/plugin-catalog.mjs')).href};
  return '\n- insert:\n    - '+JSON.stringify(row)+'\n';
}
export function upsertToolCatalogPatch(input,root) {
  const base=input.replace(/\r?\n- insert:\r?\n    - \{"id":"wechat-tool-catalog",[^\r\n]+\}\r?\n?/g,'');
  if(base.includes('"id":"wechat-tool-catalog"'))throw Error('TOOL_CATALOG_CONFIG_UNSUPPORTED');
  return base+toolCatalogPatch(root);
}

const sourceFor = (ctx, tools, scope, name) => {
  try {
    const definition = tools.get?.(name, scope);
    return definition && (ctx.root ?? ctx)[ORIGINS]?.definitions.get(definition);
  } catch { return undefined; }
};
const sameEntry = (row, origin) => row.entryId && row.entryId === origin.entryId;
const sameModule = (row, origin) => row.moduleName === origin.moduleName;

/** Read-only projection of DSH's own plugin manager, with bounded optional metadata. */
export async function decorateToolCatalog(ctx, tools, scope, definitions, { signal } = {}) {
  let bundles = [], metadataAvailable = false;
  const manager = ctx.get?.('pluginManager');
  if (manager?.listBundles) {
    try {
      const read = Promise.resolve(manager.listBundles());
      let abort;
      const stopped = signal ? new Promise((_, reject) => {
        if (signal.aborted) { reject(signal.reason); return; }
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
      }) : null;
      let result;try { result = await (stopped ? Promise.race([read, stopped]) : read); }
      finally { if (abort) signal.removeEventListener('abort', abort); }
      if (Array.isArray(result)) { bundles = result.filter(b => b?.installed === true || b?.enabled === true).slice(0, 300); metadataAvailable = true; }
    } catch {}
  }
  const plugins = new Map();
  const add = entry => {
    if (!plugins.has(entry.id)) plugins.set(entry.id, { ...entry, toolNames: [] });
    return plugins.get(entry.id);
  };
  for (const bundle of bundles) {
    const name = text(bundle.name);if (!name) continue;
    add({ id: 'plugin:' + name, name: localizedText(bundle.meta?.title) || name, packageName: name,
      description: localizedText(bundle.meta?.description) || text(bundle.description, 500),
      version: text(bundle.version, 60), enabled: bundle.enabled === true, kind: 'plugin' });
  }
  const catalogTools = definitions.map(tool => {
    const origin = sourceFor(ctx, tools, scope, tool.name);
    let group;
    if (origin) {
      // Prefer exact live entry identity. A module can belong to multiple bundles;
      // ambiguity is deliberately not resolved by a prefix or display name.
      const rows=b=>Array.isArray(b.rows)?b.rows.filter(row=>row&&typeof row==='object'):[];
      let candidates = bundles.filter(b => rows(b).some(row => sameEntry(row, origin)));
      if (!candidates.length) candidates = bundles.filter(b => rows(b).some(row => sameModule(row, origin)));
      if (candidates.length === 1) group = plugins.get('plugin:' + text(candidates[0].name));
      else if (!candidates.length && /^@deepseek-ai\/dsh-tool-/.test(origin.packageName)) {
        group = add({ id: 'dsh-builtin', name: 'DSH 内置能力', kind: 'builtin', enabled: true,
          description: '由当前 DSH 会话预设加载的文件、终端等内置工具。' });
      } else if (!candidates.length && origin.packageName) {
        let meta;try { meta = ctx.get?.('pluginPackages')?.metaOf(origin.moduleName, origin.baseUrl); } catch {}
        group = add({ id: 'module:' + origin.packageName, name: localizedText(meta?.title) || origin.packageName,
          packageName: origin.packageName, kind: 'plugin', enabled: true,
          description: localizedText(meta?.description) });
      }
    }
    group ??= add({ id: 'unverified', name: '来源未确认的工具', kind: 'unknown', enabled: true,
      description: 'DSH 已加载这些工具，但未取得可靠的来源记录。保留原工具 ID 和已有授权，不猜测插件归属。' });
    group.toolNames.push(tool.name);
    return { ...tool, sourceId: group.id };
  });
  return { tools: catalogTools, plugins: [...plugins.values()].map(group => ({ ...group, toolNames: group.toolNames.sort() })),
    metadataAvailable, provenance: 'registration-context-v1' };
}
