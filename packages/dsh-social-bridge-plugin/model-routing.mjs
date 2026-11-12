import fs from 'node:fs';
import path from 'node:path';
export const validModelId=value=>typeof value==='string'&&value.trim().length>0&&value.length<=300&&!/[\u0000-\u001f\u007f]/.test(value);
export function validateModelSettings(dsh){
  if(!dsh||!validModelId(dsh.provider)||!validModelId(dsh.model))throw Error('Invalid DSH model selection');
  if(dsh.chats!==undefined&&(!dsh.chats||typeof dsh.chats!=='object'||Array.isArray(dsh.chats)||Object.entries(dsh.chats).some(([key,value])=>!/^wechat:(private|group):[1-9]\d{0,15}$/.test(key)||!value||Object.keys(value).some(name=>!['provider','model'].includes(name))||!validModelId(value.provider)||!validModelId(value.model))))throw Error('Invalid conversation model selection');
}
export function conversationModel(root,key,fallback={}){
  const config=JSON.parse(fs.readFileSync(path.join(root,'config/wechatagent.json'),'utf8').replace(/^\uFEFF/,''));
  const selected=config.dsh?.chats?.[key]??config.dsh??fallback;
  if(!validModelId(selected.provider)||!validModelId(selected.model))throw Error('MODEL_SELECTION_INVALID');
  return {provider:selected.provider,model:selected.model};
}
export async function modelCatalog(llm,{onProviderError=()=>{}}={}){
  const models=[],seen=new Set();
  for(const provider of (await llm.listProviders()).slice(0,100)){
    if(!validModelId(provider.id))continue;
    let available;try{available=await llm.listModels(provider.id);}catch{onProviderError(provider.id);continue;}
    if(!Array.isArray(available)){onProviderError(provider.id);continue;}
    for(const model of available.slice(0,2000)){
      const id=JSON.stringify([provider.id,model.id]);if(!validModelId(model.id)||seen.has(id))continue;seen.add(id);
      models.push({provider:provider.id,providerName:typeof provider.name==='string'?provider.name.slice(0,300):provider.id,model:model.id,name:typeof model.name==='string'?model.name.slice(0,300):model.id,...(Array.isArray(model.inputModalities)?{inputModalities:[...new Set(model.inputModalities.filter(value=>typeof value==='string'&&value.length<30))]}:{})});
      if(models.length>=5000)return models;
    }
  }
  return models;
}
// Use the public scoped event contract to keep prompt variables, routing and
// attachments on the same selection. A turn owns its route until it settles.
export function bindConversationModel(agentCtx,select){
  let assembled;
  const offPrompt=agentCtx.on('system-prompt/assemble',async(_assembly,_context,next)=>{
    const selected=select();const value=await next();assembled=selected;
    return {...value,variables:{...value.variables,...selected}};
  });
  const offRequest=agentCtx.on('agent/request',async(_payload,next)=>{
    const value=await next();const selected=assembled??select();
    if(value.provider===selected.provider&&value.model===selected.model)return value;
    const {reasoningEffort:previousEffort,...options}=value;
    return {...options,...selected};
  });
  return ()=>{offPrompt?.();offRequest?.();};
}
