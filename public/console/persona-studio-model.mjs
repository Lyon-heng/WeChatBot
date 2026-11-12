export function draftIssue(draft) {
  if(!draft)return '先描述你想要的人格，或从现有人格开始。';
  const name=String(draft.display_name??'').trim();
  if(!name||name.length>60||/[<>:"/\\|?*\r\n]/.test(name)||name.includes('..')||/^[.]|[. ]$/.test(name)||/^(README|CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name))return '请填写 1–60 字的有效人格名称。';
  if(String(draft.description??'').length>300)return '简介最多 300 字。';
  const prompt=String(draft.system_prompt??'').trim();
  if(prompt.length<20||prompt.length>2200)return '人格设定需要 20–2200 字。';
  if(!Array.isArray(draft.examples)||draft.examples.length>4||draft.examples.some(row=>!['user','assistant'].includes(row.role)||!row.content?.trim()||row.content.length>180))return '对话示例最多 4 条，每条需要 1–180 字。';
  if([name,draft.description,prompt,...draft.examples.map(row=>row.content)].some(text=>/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)))return '人格内容中含有无法显示的控制字符。';
  return '';
}
export function draftMarkdown(draft){
  const issue=draftIssue(draft);if(issue)throw Error(issue);
  return `# ${draft.display_name.trim()}\n\n${draft.description.trim()}\n\n## 人格设定\n\n${draft.system_prompt.trim()}\n`+(draft.examples.length?'\n## 对话示例\n\n'+draft.examples.map(row=>`${row.role==='user'?'用户':'角色'}：${row.content.trim()}`).join('\n\n')+'\n':'');
}
export function studioChats(config,plugin){
  if(!plugin?.enabled||!plugin.permissions?.includes('model_generate'))return [];
  return ['private','groups'].flatMap(kind=>(config.wechat.whitelist[kind]??[]).map(id=>`wechat:${kind==='groups'?'group':'private'}:${id}`)).filter(key=>plugin.chats===null||plugin.chats?.includes(key));
}
