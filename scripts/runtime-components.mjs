import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
export const RUNTIME_COMPONENTS=JSON.parse(fs.readFileSync(new URL('../packaging/windows/runtime-components.json',import.meta.url),'utf8'));
const fault=code=>Object.assign(Error(code),{code});
export function peExports(bytes){
  try{
    if(bytes.toString('ascii',0,2)!=='MZ')throw Error();
    const pe=bytes.readUInt32LE(60),optional=pe+24,sections=optional+bytes.readUInt16LE(pe+20),count=bytes.readUInt16LE(pe+6);
    if(bytes.readUInt32LE(pe)!==0x4550||bytes.readUInt16LE(optional)!==0x20b||!(bytes.readUInt16LE(pe+22)&0x2000)||count<1||count>96)throw Error();
    const offset=rva=>{for(let i=0;i<count;i++){const section=sections+i*40,start=bytes.readUInt32LE(section+12),size=bytes.readUInt32LE(section+16);if(rva>=start&&rva<start+size){const result=bytes.readUInt32LE(section+20)+rva-start;if(result>=bytes.length)throw Error();return result;}}throw Error();};
    const directory=offset(bytes.readUInt32LE(optional+112)),names=bytes.readUInt32LE(directory+24),table=offset(bytes.readUInt32LE(directory+32));
    if(names>4096)throw Error();
    const exports=[];for(let i=0;i<names;i++){const start=offset(bytes.readUInt32LE(table+i*4)),end=bytes.indexOf(0,start);if(end<start||end-start>256)throw Error();exports.push(bytes.toString('ascii',start,end));}
    return {machine:bytes.readUInt16LE(pe+4),exports};
  }catch{throw fault('RELEASE_COMPONENT_PE_INVALID');}
}
export function verifyReaderKey(file,expected=RUNTIME_COMPONENTS.readerKey){
  if(!fs.existsSync(file)||!fs.statSync(file).isFile())throw fault('RELEASE_READER_KEY_MISSING');
  const bytes=fs.readFileSync(file);
  if(bytes.length!==expected.bytes||crypto.createHash('sha256').update(bytes).digest('hex')!==expected.sha256)throw fault('RELEASE_READER_KEY_HASH_MISMATCH');
  const pe=peExports(bytes);if(pe.machine!==expected.machine||expected.exports.some(name=>!pe.exports.includes(name)))throw fault('RELEASE_READER_KEY_API_MISMATCH');
  return {path:expected.path,bytes:bytes.length,sha256:expected.sha256};
}
export function verifyPackagedComponents(project,expected=RUNTIME_COMPONENTS.readerKey){
  const component=verifyReaderKey(path.join(project,expected.path),expected);
  const manifest=JSON.parse(fs.readFileSync(path.join(project,'deployment.json'),'utf8').replace(/^\uFEFF/,''));
  if(!manifest.files?.includes(component.path)||manifest.sourceHashes?.[component.path]!==component.sha256)throw fault('RELEASE_READER_KEY_NOT_DEPLOYED');
  return component;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [mode,target]=process.argv.slice(2);if(!target||!['file','project'].includes(mode))throw Error('Usage: runtime-components.mjs file|project path');
  console.log(JSON.stringify(mode==='file'?verifyReaderKey(target):verifyPackagedComponents(target)));
}
