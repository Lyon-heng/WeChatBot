import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {directory,atomicJson,configuration} from '../plugin-api/catalog.mjs';
import {songPlayback} from './segments.mjs';
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const fault=(message,status=400)=>Object.assign(Error(message),{status});
export function requestedSongMode(text=''){
  const full=/(?:完整(?:翻唱|演唱|播放|唱|发送)?|整首(?:歌)?|全曲|唱完)/g,preview=/(?:1\s*分钟|一\s*分钟|60\s*秒|六十秒|片段|试听)/g;
  const source=String(text);const hits=[...source.matchAll(full)].map(m=>({at:m.index,mode:'full'})).concat([...source.matchAll(preview)].map(m=>({at:m.index,mode:'preview'}))).filter(hit=>!/(?:不要|不用|别|不想|无需)(?:只|仅)?(?:唱|发|播放|发送|翻唱)?$/.test(source.slice(Math.max(0,hit.at-10),hit.at))).sort((a,b)=>b.at-a.at);
  return hits[0]?.mode;
}
export class MusicPreferences{
  constructor(root){this.root=root;this.file=path.join(root,'state/voice/music-preferences.json');}
  snapshot(){
    directory(this.root,'state/voice');let raw='';
    if(fs.existsSync(this.file)){if(fs.lstatSync(this.file).isSymbolicLink()||fs.statSync(this.file).size>4096)throw fault('音乐偏好文件异常，已保留原文件。',409);raw=fs.readFileSync(this.file,'utf8');}
    const value=raw?JSON.parse(raw):null;if(value&&(value.version!==1||!['preview','full'].includes(value.mode)))throw fault('音乐偏好格式无效，已保留原文件。',409);
    const legacy=value?undefined:configuration(this.root).config.plugins['voice-studio']?.settings?.songPlaybackMode;
    const mode=value?.mode??(legacy==='full'?'full':'preview');const maxSongs=value?.maxSongs??0;if(!Number.isInteger(maxSongs)||maxSongs<0||maxSongs>500)throw fault('曲库保留数量无效。',409);return {mode,maxSongs,revision:hash(raw),label:songPlayback(mode).label};
  }
  save(body){
    if(!body||Object.keys(body).some(k=>!['mode','maxSongs','revision'].includes(k))||body.mode!==undefined&&!['preview','full'].includes(body.mode)||body.maxSongs!==undefined&&(!Number.isInteger(body.maxSongs)||body.maxSongs<0||body.maxSongs>500)||body.mode===undefined&&body.maxSongs===undefined||typeof body.revision!=='string')throw fault('请选择有效的默认歌曲发送方式。');
    directory(this.root,'state/voice');const lock=this.file+'.lock';let fd;
    try{fd=fs.openSync(lock,'wx');}catch{throw fault('另一窗口正在保存音乐设置，请稍后重试。',409);}
    try{if(this.snapshot().revision!==body.revision)throw fault('音乐设置已变化，请刷新后再保存。',409);const current=this.snapshot();atomicJson(this.file,{version:1,mode:body.mode??current.mode,maxSongs:body.maxSongs??current.maxSongs});return this.snapshot();}finally{fs.closeSync(fd);fs.unlinkSync(lock);}
  }
}
