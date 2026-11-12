import zlib from 'node:zlib';
import {LIMITS,fail} from './catalog.mjs';

const table=Uint32Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
export function crc32(bytes){let crc=0xffffffff;for(const byte of bytes)crc=table[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
function safeName(raw){
  let name;try{name=new TextDecoder('utf-8',{fatal:true}).decode(raw).replaceAll('\\','/').normalize('NFC');}catch{throw fail('ZIP 文件名需要使用 UTF-8。');}
  if(name.length>240||name.startsWith('/')||/[\x00-\x1f\x7f:<>"|?*]/.test(name))throw fail('ZIP 包含不安全的文件路径。');
  const parts=name.replace(/\/$/,'').split('/');
  if(parts.length>9||parts.some(part=>!part||part==='.'||part==='..'||/[. ]$/.test(part)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)||['node_modules','.git'].includes(part.toLowerCase())))throw fail('ZIP 包含路径穿越、保留名称或不支持的目录。');
  return name;
}
export function unpackZip(data,{allowContainer=false}={}){
  if(!Buffer.isBuffer(data)||data.length<22||data.length>LIMITS.zipBytes)throw fail('ZIP 文件为空或超过 8 MiB。');
  let end=-1;for(let i=data.length-22;i>=Math.max(0,data.length-65557);i--)if(data.readUInt32LE(i)===0x06054b50&&i+22+data.readUInt16LE(i+20)===data.length){end=i;break;}
  if(end<0)throw fail('ZIP 目录损坏，不支持分卷或 ZIP64。');
  const count=data.readUInt16LE(end+10),size=data.readUInt32LE(end+12),offset=data.readUInt32LE(end+16);
  if(data.readUInt16LE(end+4)||data.readUInt16LE(end+6)||data.readUInt16LE(end+8)!==count||!count||count>LIMITS.files||offset+size!==end)throw fail('ZIP 目录无效或超过 128 个条目。');
  const files=[],names=new Set(),ranges=[];let cursor=offset,total=0;
  for(let i=0;i<count;i++){
    if(cursor+46>end||data.readUInt32LE(cursor)!==0x02014b50)throw fail('ZIP 文件目录损坏。');
    const flags=data.readUInt16LE(cursor+8),method=data.readUInt16LE(cursor+10),crc=data.readUInt32LE(cursor+16),compressed=data.readUInt32LE(cursor+20),expanded=data.readUInt32LE(cursor+24),length=data.readUInt16LE(cursor+28),extra=data.readUInt16LE(cursor+30),comment=data.readUInt16LE(cursor+32),attributes=data.readUInt32LE(cursor+38),local=data.readUInt32LE(cursor+42);
    if(cursor+46+length+extra+comment>end||flags&~0x808||![0,8].includes(method)||data.readUInt16LE(cursor+34)||expanded>LIMITS.fileBytes||(total+=expanded)>LIMITS.expandedBytes||expanded>Math.max(1,compressed)*500)throw fail('ZIP 包含加密、过大文件或不支持的压缩格式。');
    const raw=data.subarray(cursor+46,cursor+46+length),name=safeName(raw),key=name.replace(/\/$/,'').toLowerCase();
    if(names.has(key)||((attributes>>>16)&0xf000)===0xa000||attributes&0x400)throw fail('ZIP 不允许重名文件或符号链接。');
    names.add(key);cursor+=46+length+extra+comment;
    if(local+30>offset||data.readUInt32LE(local)!==0x04034b50||data.readUInt16LE(local+6)!==flags||data.readUInt16LE(local+8)!==method)throw fail('ZIP 本地文件头损坏。');
    const localLength=data.readUInt16LE(local+26),localExtra=data.readUInt16LE(local+28),start=local+30+localLength+localExtra,finish=start+compressed;
    if(localLength!==length||!data.subarray(local+30,local+30+localLength).equals(raw)||finish>offset||ranges.some(([a,b])=>local<b&&finish>a))throw fail('ZIP 文件边界或名称冲突。');
    ranges.push([local,finish]);
    if(name.endsWith('/')){if(expanded||compressed)throw fail('ZIP 目录条目无效。');continue;}
    let bytes;try{bytes=method===0?Buffer.from(data.subarray(start,finish)):zlib.inflateRawSync(data.subarray(start,finish),{maxOutputLength:expanded+1});}catch{throw fail('ZIP 解压失败或解压体积超过限制。');}
    if(bytes.length!==expanded||crc32(bytes)!==crc)throw fail('ZIP 文件校验失败。');
    files.push({name,data:bytes});
  }
  if(cursor!==end||!files.length)throw fail('ZIP 内容不完整。');
  // Accept either the package itself or one enclosing folder, never a bundle
  // of several plugins. Metadata is not executed during installation.
  if(!allowContainer&&!files.some(item=>item.name==='plugin.json')){
    const prefix=files[0].name.split('/')[0]+'/';
    if(files.some(item=>!item.name.startsWith(prefix)))throw fail('请只压缩一个插件目录。');
    for(const item of files)item.name=item.name.slice(prefix.length);
  }
  for(const item of files)if(files.some(other=>other!==item&&other.name.startsWith(item.name+'/')))throw fail('ZIP 文件与目录同名。');
  return files;
}
export function packZip(files){
  const chunks=[],central=[];let offset=0;
  for(const file of files){
    const name=Buffer.from(file.name),data=Buffer.from(file.data),compressed=zlib.deflateRawSync(data),crc=crc32(data),header=Buffer.alloc(30),entry=Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(8,8);header.writeUInt32LE(crc,14);header.writeUInt32LE(compressed.length,18);header.writeUInt32LE(data.length,22);header.writeUInt16LE(name.length,26);
    entry.writeUInt32LE(0x02014b50);entry.writeUInt16LE(20,4);entry.writeUInt16LE(20,6);entry.writeUInt16LE(0x800,8);entry.writeUInt16LE(8,10);entry.writeUInt32LE(crc,16);entry.writeUInt32LE(compressed.length,20);entry.writeUInt32LE(data.length,24);entry.writeUInt16LE(name.length,28);entry.writeUInt32LE(offset,42);
    chunks.push(header,name,compressed);central.push(entry,name);offset+=header.length+name.length+compressed.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...chunks,directory,end]);
}
