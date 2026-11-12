const pluginHelp={
 'admin-dsh':{icon:'shield',steps:['先在管理员设置中选择真实微信身份，不通过昵称或聊天口令授予权限。','为允许的聊天分别授予本机工具与技能，再在插件配置中选择聊天范围。','从简单的本机任务开始验证；审批仍在本机确认，插件不会替你放开审批。'],link:'#settings/assistant',label:'配置管理员与执行权限'},
 'fish-notebook':{icon:'history',steps:['打开配置，选择允许整理日记的聊天，并授权读取对应历史与人格。','设置晚间整理的北京时间，电脑与应用需要保持运行。','到记忆页面查看鱼的记事本；日记整理与跨聊天人物事实记忆是两套独立功能。'],link:'#memory/notebook',label:'查看鱼的记事本'},
 'persona-studio':{icon:'person',steps:['确认已选择可用的 WorkBuddy 模型；工作室沿用当前聊天模型。','在插件中授予需要的生成与存储权限，选择允许的聊天。','到人格页面创建或编辑人格，先预览并保存，再为单个聊天选择使用。'],link:'#roles',label:'打开人格工作室'},
 'voice-studio':{icon:'music',steps:['先使用 Hook 发送模式，前台模式不支持原生语音和歌曲语音。','缺少本地环境时，在语音音色页的语音组件管理下载并导入 ZIP；模型与服务还需按状态分别配置。','打开配置，选择音色、语音随机替换概率和允许的聊天，保留默认连接参数。','在语音音色页展开自定义音色，可新增参考录音、调整语气和语速、勾选随机音色候选，并先在本机试听。默认使用本地合成；外接API需在语音合成来源中主动配置并保存。先检查声音服务，再在已授权聊天中测试短语音；唱歌前完成网易云登录。'],link:'#voice',label:'语音音色与本地模型'},
 'people-memory':{icon:'history',steps:['打开配置，选择允许记录人物记忆的聊天。','按需设置自动记录、事实类型、召回预算与近期上下文；同名用户不会自动合并。','到记忆页面查看记录。跨聊天共享必须由本人明确同意，关闭来源聊天会停止使用对应记忆。'],link:'#memory',label:'查看人物记忆'},
 'speech-recognition':{icon:'chat',steps:['配置识别服务、模型和凭据；密钥只在本机配置，不要发到聊天中。','选择允许识别语音的聊天，再检查服务连接。','语音转文字属于接收功能；使用前台发送模式时也不代表可以发送原生语音。']},
 'netease-music':{icon:'music',steps:['进入音乐页面，优先使用网易云官方窗口登录。','扫码授权后检查“登录已保存”，再搜索歌名与歌手，确认版本和账号音源权限。','歌曲语音发送需要 Hook 模式和声音插件；前台模式仍可搜索歌曲和查看曲库。'],link:'#music',label:'登录并配置网易云'},
 'bilibili-public':{icon:'image',steps:['打开配置，授予公开网络访问权限并选择允许的聊天。','可在允许的聊天中请求搜索视频或读取公开链接。','无需登录私人账号；受限或需要登录的内容可能无法读取。']},
};
export function featureSetupItems({project={},plugins=[],music,voice}={}){
 const foreground=project.wechat?.textTransport?.mode==='foreground';
 const rows=[
  {id:'persona',name:'人格与聊天习惯',icon:'person',status:project.persona?.default?'已选默认人格':'按需配置',steps:['选择默认人格；单个聊天可覆盖人格和使用模型。','配置群聊参与方式、唤醒词、回复节奏和分条数量。'],link:'#roles',label:'配置人格'},
  {id:'vision',name:'图片识别与独立解析',icon:'image',status:project.dsh?.visionFallback?.enabled?'已保存开启设置':'按需开启',steps:['聊天模型能直接看图时，自动跳过独立解析。','模型不能看图时，开启独立解析并选择支持识图的模型。','保存后可用内置示例图检查，不会向微信发送测试消息。'],link:'#settings/connections',label:'配置图片解析'},
  {id:'administrators',name:'管理员与执行权限',icon:'shield',status:project.wechat?.assistant?.administrators?.length?'已保存管理员名单':'按需配置',steps:['从真实微信好友中选择管理员，昵称和聊天文字不能授予权限。','在聊天详情中逐项授权本机工具和技能；普通聊天与管理员任务分别控制。','先授予所需的最少能力，涉及审批的操作仍在本机确认。'],link:'#settings/assistant',label:'配置管理员'},
  {id:'stickers',name:'表情、自动收集与图库',icon:'image',status:foreground?'前台：随机收藏表情':'Hook：指定表情与图库',steps:foreground?['先在微信中收藏想使用的表情。','保持微信窗口可操作；前台模式随机点击当前可见的收藏表情。','不能按图库 ID 指定表情，也不会回退到 Hook 发送。']:['在表情包页面设置发送范围、候选数量、收集与共享。','在“自动收集”分别选择微信聊天收集和素材入库，可只开一边或同时开启。','图库与联网补图由本机 WorkBuddy 表情插件提供，无需安装外部插件。','联网补图还需为该聊天开启联网权限。'],link:foreground?'#sending':'#stickers/sending',label:foreground?'查看前台模式':'配置表情'},
  {id:'network',name:'联网、网页阅读与主动聊天',icon:'plug',status:'按需配置',steps:['分别设置联网搜索和网页阅读，再为单个聊天授权。','主动聊天需要总开关和每个聊天的单独开关，同时设置安静时间与发送时段。','这些功能可能调用模型；不需要时保持关闭。'],link:'#extensions/network',label:'配置联网与阅读'},
  {id:'context',name:'上下文与自动压缩',icon:'history',status:project.wechat?.context?.enabled?'已保存开启设置':'按需开启',steps:['设置默认上下文阈值与聊天空闲时间。','单个聊天可以覆盖阈值；压缩会调用模型，进行中的回复会先完成。','阈值和压缩设置保存后生效，不会清空原始聊天历史。'],link:'#settings/context',label:'配置上下文'},
  {id:'proactive',name:'按人设主动聊天',icon:'chat',status:project.wechat?.proactive?.enabled?'总开关已保存开启':'按需开启',steps:['在聊天默认值中开启总开关，并设置空闲时间、机会间隔与发送时段。','在聊天详情中逐一选择允许主动联系的聊天。','不需要主动发言时关闭此项；开启后模型仍可以选择保持沉默。'],link:'#settings/chat',label:'配置主动聊天'},
 ];
 for(const plugin of plugins){
  if(!/^[a-z][a-z0-9-]{0,63}$/.test(plugin.id??''))continue;
  const fields=Object.entries(plugin.configSchema??{});if(!fields.length&&!plugin.requestedPermissions?.length&&!pluginHelp[plugin.id])continue;
  const help=pluginHelp[plugin.id]??{icon:'plug',steps:['打开插件配置，按说明填写所需参数。','授予需要的权限，选择允许的聊天并保存；不要把所有聊天默认加入。','保存后重新检查；配置已保存不等于外部服务或实际收发已验证。']};
  const blocked=foreground&&plugin.requestedPermissions?.includes('voice');
  let status=blocked?'当前前台模式停用':plugin.enabled?'已开启 · 请检查权限与聊天范围':'尚未开启';
  if(plugin.id==='netease-music'&&music?.account?.loggedIn)status='网易云登录已保存';
  if(plugin.id==='voice-studio'&&!blocked&&voice)status=voice.nativeVoice&&voice.speech?'声音连接已就绪':'声音服务需要检查';
  rows.push({...help,id:'plugin:'+plugin.id,pluginId:plugin.id,name:plugin.name??plugin.id,status,blocked,fields:fields.filter(([,schema])=>schema&&typeof schema==='object').slice(0,6).map(([key,schema])=>String(schema.title??key))});
 }
 return rows;
}
export function featureSetupMarkup(items,esc){return '<div class="feature-setup-grid">'+items.map(item=>'<article class="feature-setup-item"><div class="feature-setup-heading"><span class="feature-setup-icon"><svg aria-hidden="true"><use href="/icons.svg#'+esc(item.icon)+'"></use></svg></span><div><h3>'+esc(item.name)+'</h3><p class="subtle">'+esc(item.status)+'</p></div></div><ol>'+item.steps.map(step=>'<li>'+esc(step)+'</li>').join('')+'</ol>'+(item.fields?.length?'<p class="subtle feature-setup-fields">配置项：'+item.fields.map(esc).join('、')+'</p>':'')+'<div class="button-row">'+(item.pluginId?'<a class="button" data-plugin-config-route href="#plugins/'+esc(item.pluginId)+'">配置插件并选择聊天</a>':'')+(item.link?'<a class="button" href="'+esc(item.link)+'">'+esc(item.label)+'</a>':'')+'</div></article>').join('')+'</div>';}
export async function mountFeatureSetup(element,{api,project,esc}){
 element.innerHTML='<div class="loading-state">正在检查已安装插件与保存的配置…</div>';
 const results=await Promise.allSettled([api('/api/plugins'),api('/api/music'),api('/api/voice-studio')]);if(!element.isConnected)return;
 const value=i=>results[i].status==='fulfilled'?results[i].value:undefined;
 const plugins=value(0)?.plugins??[];
 element.innerHTML=(results[0].status==='rejected'?'<p class="notice">暂时无法读取插件清单，下面先显示基础功能。请稍后点击重新检查。</p>':'')+featureSetupMarkup(featureSetupItems({project,plugins,music:value(1),voice:value(2)}),esc);
}
