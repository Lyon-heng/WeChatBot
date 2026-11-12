import crypto from 'node:crypto';
import {boundedTask} from '../dsh-social-bridge-plugin/deadline.mjs';
export function createPluginModelUtility({ctx,provider:defaultProvider,model:defaultModel,modelFor,createUserMessage,BlockAssembler,recordUsage=()=>{}}){
  return async({pluginId,key,prompt,maxTokens=512,maxChars=2000,timeoutMs=25000,signal,allowed})=>{
    const {provider,model}=modelFor?.(key)??{provider:defaultProvider,model:defaultModel};
    if(typeof prompt!=='string'||!prompt.trim()||prompt.length>32000||!Number.isInteger(maxTokens)||maxTokens<16||maxTokens>2200||!Number.isInteger(maxChars)||maxChars<1||maxChars>4000||!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>25000)throw Error('PLUGIN_MODEL_OPTIONS_INVALID');
    const controller=new AbortController(),combined=AbortSignal.any([controller.signal,signal,AbortSignal.timeout(timeoutMs)]),sid='wechat-plugin-'+pluginId+'-'+crypto.randomUUID();let started=false,status='failed';const assembler=new BlockAssembler();
    try{return await boundedTask(async()=>{
      const llm=ctx.get?.('llm')??ctx.llm;if(!llm?.stream)throw Error('PLUGIN_MODEL_UNAVAILABLE');
      const info=await llm.resolveModelInfo?.(provider,model,combined),off=info?.reasoning?.efforts?.some(item=>item.id==='off')?{reasoningEffort:'off'}:{};
      started=true;let chars=0;
      for await(const chunk of llm.stream({provider,model,sessionId:sid,messages:[createUserMessage({content:[{type:'text',text:prompt}],source:{kind:'wechat-plugin-utility',pluginId}})],tools:[],maxTokens,...off,signal:combined})){
        combined.throwIfAborted();if(!allowed())throw Error('PLUGIN_PERMISSION_DENIED');assembler.push(chunk);if(chunk.type==='text-delta')chars+=chunk.text.length;if(chars>maxChars)throw Error('PLUGIN_MODEL_OUTPUT_LIMIT');
      }
      const blocks=assembler.blocks();if(blocks.some(block=>!['text','reasoning'].includes(block.type))||assembler.finish?.kind!=='stop')throw Error('PLUGIN_MODEL_OUTPUT_INVALID');
      const result=blocks.filter(block=>block.type==='text').map(block=>block.text).join('').trim();combined.throwIfAborted();if(!allowed()||!result||result.length>maxChars)throw Error('PLUGIN_MODEL_OUTPUT_INVALID');status='settled';return result;
    },{timeoutMs,signal:combined});}
    finally{controller.abort();if(started)try{recordUsage({id:sid,key,sid,provider,model,purpose:'plugin:'+pluginId,status,usage:assembler.usage});}catch{}}
  };
}
