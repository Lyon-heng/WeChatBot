export const MAIN_PAGES=['overview','chats','roles','extensions','plugins','stickers','memory','music','voice','sending','settings'];
export const SETTINGS_SECTIONS={chat:'聊天默认值',assistant:'助手设置',context:'上下文',connections:'微信与 WorkBuddy',diagnostics:'诊断',logs:'运行日志',advanced:'开发者选项',appearance:'外观与数据'};
export const STICKER_SECTIONS={library:'我的表情',collection:'自动收集',sources:'来源与搜索',sending:'发送设置'};
export const CAPABILITY_SECTIONS={catalog:'能力目录',network:'联网与阅读',dsh:'WorkBuddy 能力'};
const aliases={sessions:{page:'chats',detail:'usage'},behavior:{page:'settings',section:'chat'},connections:{page:'settings',section:'connections'},tools:{page:'settings',section:'diagnostics'},logs:{page:'settings',section:'logs'},'send-mode':{page:'sending'}};
export function consoleRoute(hash=''){
 const [page,section]=String(hash).replace(/^#/,'').split('/');
 if(aliases[page])return {...aliases[page]};
 if(page==='setup')return {page:'setup',...(['wechat','dsh','model','start','chats','features','sending'].includes(section)?{section}:{})};
 if(page==='memory')return {page,section:['summaries','notebook','people','diagnostics','evaluation'].includes(section)?section:'members'};
 if(page==='settings')return {page,section:Object.hasOwn(SETTINGS_SECTIONS,section)?section:'chat'};
 if(page==='stickers')return {page,section:Object.hasOwn(STICKER_SECTIONS,section)?section:'library'};
 if(page==='extensions')return {page,section:Object.hasOwn(CAPABILITY_SECTIONS,section)?section:'catalog'};
 if(page==='plugins'&&/^[a-z][a-z0-9-]{0,63}$/.test(section??''))return {page,section};
 return {page:MAIN_PAGES.includes(page)?page:'overview'};
}
export const routeKey=route=>route.page+(route.section?'/'+route.section:'');
export const featureLocation=id=>({'native-search':'#extensions/network','native-web-reader':'#extensions/network','native-stickers':'#stickers/sending','native-proactive':'#settings/chat','native-context':'#settings/context'})[id]??null;
export function chatRows(config,names=new Map(),sessions=[]){
 const byKey=new Map(sessions.map(item=>[item.conversationKey,item]));
 return ['private','groups'].flatMap(kind=>(config.wechat.whitelist[kind]??[]).map(value=>{
  const id=String(value),key='wechat:'+(kind==='groups'?'group':'private')+':'+id;
  return {key,id,kind,name:names.get(key)||(kind==='groups'?'群聊':'好友')+' · '+id.slice(-4),mode:config.wechat.workModes?.[key]??'social',persona:config.persona.chats?.[key]??config.persona.default,session:byKey.get(key)??null};
 }));
}
export function filterChats(rows,{kind='all',mode='all',query=''}={}){
 const needle=query.trim().toLocaleLowerCase();
 return rows.filter(row=>(kind==='all'||row.kind===kind)&&(mode==='all'||row.mode===mode)&&(!needle||[row.name,row.id,row.persona].join(' ').toLocaleLowerCase().includes(needle)));
}
export function effectiveChatFeature(config,key,feature){
 const settings=config.wechat[feature]??{},own=Object.hasOwn(settings.chats??{},key),value=settings.chats?.[key];
 if(feature==='proactive')return {enabled:settings.enabled===true&&value===true,source:settings.enabled!==true?'总开关关闭':value===true?'本聊天已加入':'本聊天未加入'};
 if(feature==='context')return {enabled:settings.enabled===true&&value!==0,source:settings.enabled!==true?'总开关关闭':value===0?'本聊天关闭':own?'本聊天阈值':'继承默认阈值'};
 const fallback=feature==='stickers'?settings.enabled!==false:settings.enabled===true;
 return {enabled:own?value===true:fallback,source:own?'本聊天单独设置':'继承账号默认'};
}
