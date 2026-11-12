import crypto from 'node:crypto';

export const ASSISTANT_ACCESS = Symbol.for('wechatagent.assistant-access.v1');
export const validWechatIdentity = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const groupKey = key => /^wechat:group:[1-9]\d{0,15}$/.test(key);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
export function validateAssistantSettings(wechat) {
  const value = wechat?.assistant;
  if (value === undefined) return;
  if (!plain(value) || Object.keys(value).some(key => !['administrators','adminOnlyGroups','fileTransferChats'].includes(key)) ||
      value.administrators !== undefined && (!Array.isArray(value.administrators) || value.administrators.length > 50 || !value.administrators.every(validWechatIdentity) || new Set(value.administrators).size !== value.administrators.length) ||
      value.fileTransferChats !== undefined && (!plain(value.fileTransferChats) || Object.entries(value.fileTransferChats).some(([key,on]) => !/^wechat:(private|group):[1-9]\d{0,15}$/.test(key) || !Number.isSafeInteger(Number(key.split(':')[2])) || typeof on !== 'boolean')) ||
      value.adminOnlyGroups !== undefined && (!plain(value.adminOnlyGroups) || Object.entries(value.adminOnlyGroups).some(([key,on]) => !groupKey(key) || !Number.isSafeInteger(Number(key.split(':')[2])) || typeof on !== 'boolean'))) throw Error('助手模式管理员设置无效：请使用真实微信 ID，最多 50 位；群管理员模式必须为开关值。');
}
// Kept for old settings/readers. Legacy false values never grant execution.
export const assistantAdminOnly = () => true;
export const assistantAdministrator = (wechat,wxid) => validWechatIdentity(wxid) && (wechat?.assistant?.administrators ?? []).includes(wxid);
export function assistantSenderAllowed(wechat,key,wxid) {
  validateAssistantSettings(wechat);
  const match = /^wechat:(private|group):([1-9]\d{0,15})$/.exec(key);
  if (!match || !Number.isSafeInteger(Number(match[2])) || !(wechat?.whitelist?.[match[1] === 'group' ? 'groups' : 'private'] ?? []).some(id => String(id) === match[2])) return false;
  return assistantAdministrator(wechat,wxid);
}
// A missing trusted identity may chat in an allowed group, but can never work.
export function assistantGroupChatAllowed(wechat,key,wxid='') {
  validateAssistantSettings(wechat);
  const match=/^wechat:group:([1-9]\d{0,15})$/.exec(key);
  return !!match&&Number.isSafeInteger(Number(match[1]))&&(wechat?.whitelist?.groups??[]).some(id=>String(id)===match[1])&&(wxid===''||validWechatIdentity(wxid));
}
// The authenticated reader supplies this identity. Never derive it from text,
// a nickname, a quoted author or the model's claimed identity.
export function verifiedAssistantSender(message) {
  const wxid = message?.sender_wxid;
  if (message?.platform !== 'wechat' || !validWechatIdentity(wxid)) return '';
  const id = String(Number(crypto.createHash('sha256').update(wxid).digest().readBigUInt64BE(0) % 2147483647n + 1n));
  return String(message.sender_id) === id && (message.kind === 'group' || message.kind === 'private' && String(message.conversation_id) === id) ? wxid : '';
}
export function verifiedBatchSender(rows){
  const incoming=rows.filter(row=>!row.outgoing),ids=incoming.map(verifiedAssistantSender);
  return incoming.length&&ids.every(id=>id&&id===ids[0])?ids[0]:'';
}
export function assistantControlAllowed(wechat,key,sender,owner,{running=false}={}) {
  return assistantSenderAllowed(wechat,key,sender) && (!running || assistantAdministrator(wechat,sender) || validWechatIdentity(owner) && owner === sender);
}
