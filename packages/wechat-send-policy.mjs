import fs from 'node:fs';import path from 'node:path';
export const sendingMode=project=>project?.wechat?.textTransport?.mode==='foreground'?'foreground':'native';
export function readSendingMode(root){return sendingMode(JSON.parse(fs.readFileSync(path.join(root,'config/wechatagent.json'),'utf8').replace(/^\uFEFF/,'')));}
export const foregroundFavoriteId='c8c5fd1315c3f709eb3ac0d8ab401e826c9bdc529bcc7b058081e2193ab4b7df';
export const sendModeHelp='前台模式通过微信界面发送文字与随机收藏表情，关闭全部 Hook 发送接口；原生 @、语音气泡、歌曲语音和文件发送不可用。Hook 模式功能更完整、回复更方便，但接入客户端更深。两种方式均有账号风险，缺少可靠数据证明封号概率高低；本开关只隔离发送，不卸载已加载的 Hook 或改变读取方式。';
