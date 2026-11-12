// wechatwb：配置向导步骤与 WorkBuddy 内置模型连接卡片

const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));

export function setupProgress({config={},draft=config,reader={},status={},catalog,readerPending=false,selectionIncomplete=false}={}){
  const count=value=>(value?.wechat?.whitelist?.private?.length??0)+(value?.wechat?.whitelist?.groups?.length??0);
  const modelPending=selectionIncomplete||config.dsh?.provider!==draft.dsh?.provider||config.dsh?.model!==draft.dsh?.model;
  const chatPending=JSON.stringify(config.wechat?.whitelist??{})!==JSON.stringify(draft.wechat?.whitelist??{});
  const wechat=reader.verified===true&&!readerPending;
  // wechatwb: 模型焊在应用进程内，健康状态由控制台 /api/status 的「模型连接」服务给出，
  // 不再要求用户安装 WorkBuddy 或选择 DeepSeek Harness.exe。
  const workbuddy=status.services?.some(item=>item.id==='dsh'&&item.ready===true)===true;
  const model=!modelPending&&catalog?.available===true&&catalog.models?.some(row=>row.provider===config.dsh?.provider&&row.model===config.dsh?.model)===true;
  const sending=['native','foreground'].includes(config.wechat?.textTransport?.mode)&&config.wechat?.textTransport?.mode===draft.wechat?.textTransport?.mode;
  const running=wechat&&workbuddy&&model&&status.ready===true&&!status.pendingApply&&!status.dshRestartRequired;
  const steps=[
    {id:'wechat',title:'连接微信',description:'登录并验证自己的账号',done:wechat,detail:readerPending?'账号设置尚未保存':wechat?'账号读取已验证':'需要登录并完成账号验证'},
    {id:'dsh',title:'连接 WorkBuddy',description:'检查内置模型连接',done:workbuddy,detail:workbuddy?'WorkBuddy 内置模型已就绪':'正在检查 WorkBuddy 内置模型，可点击“重新检查”或重启应用'},
    {id:'model',title:'选择模型',description:'从 WorkBuddy 模型列表中选择',done:model,detail:modelPending?'模型选择尚未保存':model?'已在 WorkBuddy 模型列表中确认':catalog?.available?'请从当前列表选择有效模型':'连接 WorkBuddy 后检查模型'},
    {id:'start',title:'启动服务',description:'检查读取、桥接与模型连接',done:running,detail:status.pendingApply||status.dshRestartRequired?'已保存设置等待应用':running?'服务连接正常':wechat&&workbuddy&&model?'可以启动并检查连接':'先完成微信、WorkBuddy 和模型配置'},
    {id:'chats',title:'选择聊天并试聊',description:'只回复你允许的好友或群',done:running&&count(config)>0&&!chatPending,detail:chatPending?'聊天选择尚未保存':count(config)?`已保存 ${count(config)} 个聊天${running?'':'，等待服务就绪'}`:'尚未选择允许的聊天'},
    {id:'features',title:'配置插件与选配功能',description:'按需开启语音、记忆和其他插件',done:false,optional:true,detail:'可先跳过，之后可从插件配置页继续'},
    {id:'sending',title:'选择发送模式',description:'选择 Hook 或微信前台发送',done:sending,detail:sending?'已保存发送模式': '请选择发送模式并保存'},
  ];
  const required=steps.filter(step=>!step.optional);
  return {steps,completed:required.filter(step=>step.done).length,total:required.length,complete:required.every(step=>step.done),next:required.find(step=>!step.done)?.id??'features',savedChats:count(config),draftChats:count(draft),canStart:wechat&&workbuddy&&model&&sending};
}

// This is a configuration hint only. Runtime checks above remain authoritative
// inside the guide; a stopped service is not the same as an unfinished setup.
export function setupConfigured(config,reader){
  return reader?.verified===true&&!!config?.dsh?.provider&&!!config?.dsh?.model&&['native','foreground'].includes(config?.wechat?.textTransport?.mode)&&((config?.wechat?.whitelist?.private?.length??0)+(config?.wechat?.whitelist?.groups?.length??0))>0;
}

export function setupGuideFrame({progress,selected,content,esc}){
  const current=progress.steps.find(step=>step.id===selected)??progress.steps[0],index=progress.steps.indexOf(current),required=progress.steps.filter(step=>!step.optional),number=current.optional?'选配':required.indexOf(current)+1;
  return `<div class="setup-guide"><section class="card setup-welcome"><div><span class="setup-eyebrow">开始使用 WECHATBOT</span><h2>一步一步，连接你的微信助手</h2><p>完成微信、模型、发送方式和聊天范围配置，就可以开始对话；插件可稍后配置。每一步都能随时返回修改。</p></div><div class="setup-progress"><strong id="setup-progress-count">${progress.completed} / ${progress.total}</strong><span>项检查已通过</span><progress id="setup-progress-bar" max="${progress.total}" value="${progress.completed}" aria-label="配置检查进度"></progress></div></section><div class="setup-layout"><nav class="setup-steps" aria-label="配置步骤">${progress.steps.map((step,i)=>`<button type="button" class="setup-step ${step.id===current.id?'selected':''}" data-guide-step="${step.id}" ${step.id===current.id?'aria-current="step"':''}><span class="setup-step-number" data-guide-number="${step.id}">${step.done?'✓':step.optional?'＋':required.indexOf(step)+1}</span><span><strong>${step.optional?'选配 · ':''}${esc(step.title)}</strong><small>${esc(step.description)}</small><span class="setup-step-status" data-guide-status="${step.id}">${step.optional?'可跳过':step.done?'已通过':'待完成'}</span></span></button>`).join('')}<p class="setup-save-note">设置保存在这台电脑上。切换步骤会保留当前输入，操作前请先保存设置。</p></nav><div class="setup-main"><div class="setup-step-heading"><div><span>${current.optional?'可选功能':`第 ${number} 步 / 共 ${progress.total} 步`}</span><h2>${esc(current.title)}</h2></div><button class="button small" id="guide-refresh">重新检查</button></div><p class="setup-current-status" id="setup-current-status" role="status">${esc(current.detail)}</p><div class="section-stack">${content}</div><div class="setup-footer"><button class="button" data-guide-step="${progress.steps[Math.max(0,index-1)].id}" ${index===0?'disabled':''}>上一步</button><span>状态由实际检查更新，无需手动打勾。</span>${index<progress.steps.length-1?`<button class="button primary" data-guide-step="${progress.steps[index+1].id}">下一步</button>`:`<a class="button primary" href="#overview">查看运行状态</a>`}</div></div></div></div>`;
}

/** wechatwb: 内置 WorkBuddy 模型连接卡片 —— 不再引导安装 WorkBuddy / 导入插件 */
export function dshInstallCard({header,config={},status={}}={}) {
  const service=(status.services??[]).find(item=>item.id==='dsh');
  const ready=service?.ready===true;
  const provider=esc(config.dsh?.provider??'workbuddy');
  const model=esc(config.dsh?.model??'auto');
  return `<section class="card setup-dsh-card">${header('连接 WorkBuddy','模型已内置在应用进程中，无需安装其他程序、导入插件或填写密钥。',`<span class="status-tag ${ready?'ok':'warn'}">${ready?'已连接':'待检查'}</span>`,'plug')}<ol class="setup-instructions"><li><strong>确认模型连接</strong><p>WorkBuddy 云服务免密钥接口随应用启动，健康检查通过后本步即完成。若显示“待检查”，点击右上角“重新检查”；仍不恢复时重启应用。</p></li><li><strong>选择聊天模型</strong><p>进入下一步“选择模型”，从 WorkBuddy 内置模型列表中选择并保存。</p></li></ol><div class="notice plain space-top"><span>当前提供方：<strong>${provider}</strong> · 当前模型：<strong data-wb-current-model>${model}</strong> · 连接状态：${ready?'已就绪':'未就绪'}</span></div><p class="subtle space-top">模型列表与请求都在本应用进程内完成，不依赖外部模型程序或本地端口。</p></section>`;
}
