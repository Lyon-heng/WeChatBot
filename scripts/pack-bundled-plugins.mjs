import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {BUNDLED_PLUGINS} from '../packages/plugin-api/bundled.mjs';
import {inspectPackage,packageFiles} from '../packages/plugin-api/catalog.mjs';
import {packZip,unpackZip} from '../packages/plugin-api/zip.mjs';
const root=path.resolve(import.meta.dirname,'..');
const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version,entries=[];
for(const bundle of BUNDLED_PLUGINS.filter(item=>item.zip)){
  const source=path.join(root,bundle.source),item=inspectPackage(source);
  if(item.id!==bundle.id||item.version!==bundle.version)throw Error('PLUGIN_BUNDLE_IDENTITY_MISMATCH');
  const zip=packZip(packageFiles(source));unpackZip(zip);
  const target=path.join(root,bundle.zip);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,zip);
  const digest=crypto.createHash('sha256').update(zip).digest('hex');fs.writeFileSync(target+'.sha256',digest+'  '+path.basename(target)+'\n');
  console.log(JSON.stringify({id:item.id,version:item.version,bytes:zip.length,sha256:digest}));
  entries.push({id:item.id,name:item.name,version:item.version,essential:bundle.essential===true,source:bundle.source,file:path.basename(bundle.zip),bytes:zip.length,sha256:digest,url:'https://github.com/Lyon-heng/WeChatBot/releases/download/v'+version+'/'+path.basename(bundle.zip)});
}
const files=entries.map(item=>({name:item.file,data:fs.readFileSync(path.join(root,'optional-extensions/packages',item.file))}));
files.push({name:'plugins.json',data:Buffer.from(JSON.stringify({format:'wechatbot-plugins-v1',version,plugins:entries.map(({id,version,file,sha256})=>({id,version,file,sha256}))},null,2))});
files.push({name:'README.txt',data:Buffer.from('在WeChatBot能力目录选择“导入插件总包”，或点击“一键下载并导入”。已有插件会跳过，新插件默认关闭，不自动授权聊天。')});
const allName='WeChatBot-plugins-all-'+version+'.zip',allBytes=packZip(files),allSha=crypto.createHash('sha256').update(allBytes).digest('hex');
fs.writeFileSync(path.join(root,'optional-extensions/packages',allName),allBytes);fs.writeFileSync(path.join(root,'optional-extensions/packages',allName+'.sha256'),allSha+'  '+allName+'\n');
fs.mkdirSync(path.join(root,'packages/plugin-distribution'),{recursive:true});fs.writeFileSync(path.join(root,'packages/plugin-distribution/catalog.json'),JSON.stringify({version,entries,schemas:{'speech-recognition':JSON.parse(fs.readFileSync(path.join(root,'optional-extensions/speech-recognition/plugin.json'),'utf8'))},all:{file:allName,bytes:allBytes.length,sha256:allSha,url:'https://github.com/Lyon-heng/WeChatBot/releases/download/v'+version+'/'+allName}},null,2)+'\n');
