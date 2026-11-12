import fs from 'node:fs';import path from 'node:path';
import {activeReaderAccount} from './reader-account-state.mjs';
import {FishNotebookStore} from '../packages/dsh-social-bridge-plugin/fish-notebook-store.mjs';
import {NOTEBOOK_DEFAULTS} from '../packages/dsh-social-bridge-plugin/fish-notebook-policy.mjs';
import {pluginCatalog,pluginEnabled} from '../packages/plugin-api/catalog.mjs';
const fault=(message,status=400)=>Object.assign(Error(message),{status});
export function fishNotebookSnapshot(root,{config,revision},params=new URLSearchParams()){
  const plugin=pluginCatalog(root).plugins.find(item=>item.id==='fish-notebook'),installed=!!plugin&&!plugin.invalid;
  const settings={...NOTEBOOK_DEFAULTS,...config.wechat.fishNotebook,...plugin?.settings,enabled:installed&&plugin.enabled},chats=['private','groups'].flatMap(kind=>(config.wechat.whitelist?.[kind]??[]).map(id=>({key:'wechat:'+(kind==='groups'?'group':'private')+':'+id,id:String(id),kind}))),file=path.resolve(root,'state/weflow/active-account.json');
  for(let current=file;current!==path.resolve(root);current=path.dirname(current))if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw fault('记事本账号目录包含链接，已停止读取。',409);
  const active=activeReaderAccount(root),scope=active.id||active.legacyId;
  if(!scope)return {available:false,installed,settings,revision,chats,entries:[],message:'先连接并验证微信，再使用鱼的记事本插件。'};
  if(params.get('scope')&&params.get('scope')!==scope)throw fault('微信账号已变化，请刷新记事本。',409);
  const key=params.get('conversationKey')??chats[0]?.key??'';if(key&&!chats.some(chat=>chat.key===key))throw fault('请选择已保存聊天范围中的会话。',403);
  const offset=Number(params.get('offset')??0);if(!Number.isSafeInteger(offset)||offset<0||offset>10000)throw fault('日记页码无效。');
  let listed={entries:[],total:0,offset,limit:12,errors:0};if(key)listed=new FishNotebookStore(root,scope).list(key,{offset});
  return {available:true,installed,pluginId:'fish-notebook',accountScope:scope,settings,revision,chats,conversationKey:key,chatEnabled:!!key&&(plugin?.chats===null||plugin?.chats?.includes(key)),effectiveEnabled:!!key&&pluginEnabled(root,'fish-notebook',key),...listed};
}
