export const modeSummary=mode=>mode==='foreground'
  ?'保存为前台模式后：文字和随机收藏表情通过微信窗口发送。所有 Hook 发送接口停用；原生 @ 改为普通文字称呼，语音气泡、歌曲语音、图片与文件的 Hook 发送不可用。'
  :'保存为 Hook 模式后：可使用完整发送能力，包括文字、指定表情、原生 @、语音气泡、歌曲语音和文件；无需通过前台窗口逐项操作。';
export function sendModeCard(selected,header){
  const modeIcon=id=>'<svg aria-hidden="true"><use href="/icons.svg#'+id+'"></use></svg>';
  return '<section class="card send-mode-card">'+header('微信发送模式','按整套发送能力切换，不混用发送通道。','','send-switch')+
  '<div class="send-mode-choices">'+[
    ['foreground','window-pointer','鲸鱼娘前台','通过微信窗口操作','作者预期：封号概率较低（未验证）','文字与随机收藏表情，适合愿意精简功能、保持微信窗口打开的使用方式。'],
    ['native','bolt-chat','Hook 完整模式','功能更全，回复更方便','作者预期：封号概率较高（未验证）','保留原生 @、语音气泡、歌曲语音、指定表情和文件发送。']
  ].map(([value,id,title,subtitle,risk,description])=>'<button type="button" class="send-mode-choice" data-select-send-mode="'+value+'" aria-pressed="'+(selected===value)+'"><span class="send-mode-choice-top"><span class="send-mode-choice-icon">'+modeIcon(id)+'</span><span class="send-mode-selected">'+(selected===value?'已选择':'选择此模式')+'</span></span><strong>'+title+'</strong><span>'+subtitle+'</span><span class="send-mode-risk">'+risk+'</span><small>'+description+'</small></button>').join('')+'</div>'+
  '<div class="field"><label for="text-transport-mode">发送模式</label><select id="text-transport-mode" data-path="wechat.textTransport.mode">'+[['native','Hook 发送（功能完整）'],['foreground','鲸鱼娘前台发送（文字与收藏表情）']].map(([value,label])=>'<option value="'+value+'" '+(selected===value?'selected':'')+'>'+label+'</option>').join('')+'</select><small>保存后用于新的发送；已经提交给微信的消息可能继续完成。前台模式需要保持微信打开，操作时会切换聊天窗口。</small></div>'+
  '<p id="send-mode-summary" class="notice plain space-top" role="status">'+modeSummary(selected)+'</p>'+
  '<div class="space-top" style="overflow-x:auto"><table class="send-mode-table"><thead><tr><th>功能</th><th>鲸鱼娘前台</th><th>Hook</th></tr></thead><tbody>'+[
    ['文字回复','微信界面发送','支持'],['表情包','随机点击当前可见的收藏表情','支持指定表情'],['原生 @ 提醒','停用，改为文字称呼','支持'],['语音气泡 / 唱歌发微信','停用','支持'],['图片 / 文件及其他 Hook 发送','停用','支持']
  ].map(row=>'<tr>'+row.map((v,i)=>'<'+(i?'td':'th')+'>'+v+'</'+(i?'td':'th')+'>').join('')+'</tr>').join('')+'</tbody></table></div>'+
  '<p class="card-description space-top"><strong>* 作者风险预期，未经验证：</strong>“前台封号概率较低、Hook 较高”是项目作者提出的使用判断，不是经统计验证的事实。前台发送接入较少，Hook 功能更完整、回复更方便，但接入客户端更深。目前没有可靠数据证明实际封号概率高低，两种方式都不能保证账号安全。</p>'+
  '<p class="subtle">此开关只隔离发送，不会卸载已经加载的 Hook，也不会更改消息读取方式，不能据此声称“无 Hook”或“低封号率”。收藏表情为空、同名聊天、已有输入草稿或目标不明确时，前台发送会停止，不会偷偷回退到 Hook。</p>'+
  '<button class="button space-top" id="check-text-transport">检查前台组件（不发送消息）</button><p id="text-transport-status" class="subtle space-top" role="status">独立实现，无需旧项目或额外 Python 环境。</p></section>';
}
document.addEventListener('change',event=>{if(event.target.id==='text-transport-mode'){const summary=document.querySelector('#send-mode-summary');if(summary)summary.textContent=modeSummary(event.target.value);for(const button of document.querySelectorAll('[data-select-send-mode]')){const selected=button.dataset.selectSendMode===event.target.value;button.setAttribute('aria-pressed',String(selected));button.querySelector('.send-mode-selected').textContent=selected?'已选择':'选择此模式';}}});
document.addEventListener('click',event=>{const button=event.target.closest('[data-select-send-mode]');if(!button)return;const select=document.querySelector('#text-transport-mode');if(!select)return;select.value=button.dataset.selectSendMode;select.dispatchEvent(new Event('input',{bubbles:true}));select.dispatchEvent(new Event('change',{bubbles:true}));});
