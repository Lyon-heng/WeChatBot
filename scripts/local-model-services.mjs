import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {configuration,directory} from '../packages/plugin-api/catalog.mjs';
const quoted=value=>'"'+value+'"';
export function localModelServices(root,{prepare=false}={}){
  const config=configuration(root).config.plugins,voice=path.join(root,'state/voice'),services=[];
  const python=name=>path.join(voice,'engines',name,'venv/Scripts/python.exe');
  const memory=config['memory-retrieval'];
  if(memory?.enabled&&memory.permissions?.includes('model_embed')&&memory.settings?.embeddingEnabled&&['','multilingual-minilm-l12-v2-q8'].includes(memory.settings.embeddingModel??'')){
    const endpoint=new URL(memory.settings.embeddingUrl??'http://127.0.0.1:19884/v1/embeddings');
    if(endpoint.hostname!=='127.0.0.1'||endpoint.protocol!=='http:'||endpoint.pathname!=='/v1/embeddings'||!endpoint.port)throw Error('EMBEDDING_LOCAL_ENDPOINT_REQUIRED');
    const script=path.join(root,'scripts/local-embedding-server.py');
    services.push({name:'embeddings',exe:python('embeddings'),marker:script,port:Number(endpoint.port),cwd:root,args:quoted(script)+' --model-dir '+quoted(path.join(voice,'engines/embeddings/model'))+' --port '+endpoint.port,ready:fs.existsSync(path.join(voice,'engines/embeddings/model/onnx/model_quantized.onnx'))});
  }
  const cosy=config['cosyvoice-engine'];
  if(cosy?.enabled&&(cosy.settings?.engine==='cosyvoice'||cosy.settings?.allowComparison!==false)){
    const port=cosy.settings.port??19886;
    if(!Number.isInteger(port)||port<1024||port>65534)throw Error('COSY_PORT_INVALID');
    const script=path.join(root,'scripts/cosyvoice-server.py'),server=path.join(voice,'feiyu-service/server'),key=path.join(server,'.runtime/wechatbot-cosyvoice/api_key.txt');
    if(prepare&&fs.existsSync(python('tts'))&&fs.existsSync(path.join(server,'models/FeiyuVoice-CosyVoice3/manifest.json'))&&!fs.existsSync(key)){directory(root,'state/voice/feiyu-service/server/.runtime/wechatbot-cosyvoice');fs.writeFileSync(key,crypto.randomBytes(32).toString('base64url'),{mode:0o600,flag:'wx'});}
    services.push({name:'cosyvoice',exe:python('tts'),marker:script,port,cwd:root,args:quoted(script)+' --repo '+quoted(path.join(voice,'engines/tts/source'))+' --package '+quoted(path.join(server,'models/FeiyuVoice-CosyVoice3'))+' --key-file '+quoted(key)+' --port '+port,ready:fs.existsSync(key)&&fs.existsSync(path.join(server,'models/FeiyuVoice-CosyVoice3/manifest.json'))});
  }
  return services;
}
