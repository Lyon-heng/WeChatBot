import {chooseVoiceSentence} from './lib/random-speech.mjs';
const styles={cute:'明亮可爱（B）',natural:'自然可爱（A）',gentle:'温柔'};
const effective=async ctx=>(await ctx.storage.get('style'))??ctx.config().defaultStyle??'cute';
const result=value=>({content:JSON.stringify(value)});
export function setup(api){
  api.registerTool({id:'speak',description:'用户明确要求说一句、朗读或发语音时使用。只给当前聊天申请原生微信语音，文字最多220字；合成和投递在本轮成功后异步执行。返回 staged 不代表已生成或送达，不能宣称对方已收到。',parameters:{type:'object',properties:{text:{type:'string',minLength:1,maxLength:220},style:{type:'string',enum:['cute','natural','gentle']}},required:['text'],additionalProperties:false},execute:async(ctx,args)=>result(await ctx.voice.enqueue({kind:'speech',text:args.text,style:args.style??await effective(ctx)}))});
  api.registerTool({id:'voice',description:'用户要求切换音色、查看语音进度、查看已准备歌曲或明确要求停止语音/唱歌时使用。cancel 取消当前聊天的待发送申请，已提交微信的不能承诺撤回。音色设置仅影响当前聊天；单次指定声音不会改长期偏好。未确认送达不能说已发送成功。',parameters:{type:'object',properties:{action:{type:'string',enum:['get','set','status','songs','cancel']},style:{type:'string',enum:['cute','natural','gentle']},id:{type:'string',minLength:64,maxLength:64}},required:['action'],additionalProperties:false},execute:async(ctx,args)=>{
    if(args.action==='set'){if(!styles[args.style])return {isError:true,content:'请选择 cute（明亮可爱）、natural（自然可爱）或 gentle（温柔）。'};await ctx.storage.set('style',args.style);return result({style:args.style,label:styles[args.style],scope:'当前聊天'});}
    if(args.action==='cancel')return result(await ctx.voice.cancel(args.id?{id:args.id}:{}));if(args.action==='status')return result(await ctx.voice.status());if(args.action==='songs')return result(await ctx.voice.songs());const style=await effective(ctx);return result({style,label:styles[style]});
  }});
  api.registerTool({id:'sing',description:'用户要求唱网易云歌曲链接时，使用kind=song并把原始歌曲链接填入sourceUrl，按歌曲ID唱准确版本，无需猜歌名或再搜索。只有歌名时填写title，指定歌手同时填artist；系统会自动联网检索公开音源并下载完整音轨，用户不需要提供任何链接，也不要因为缺少链接就拒绝或让对方自己去找。搜索/read返回的网易云歌曲URL也可交给sourceUrl。同歌同音色的保存成品会直接复用，不重复制作。voice/songs中rendered-song使用kind=song和sourceUrl；原始vocal-source才用kind=cover和songId。后台自动查找公开可播放的匹配版本，分离原唱和伴奏，保持原唱歌词、旋律和时间轴，转换为肥鱼音色后混音。找不到准确歌曲或没有公开音源时明确失败，不能编造素材或把朗读歌词当唱歌。kind=cover 用 voice/songs 返回的本机 songId；kind=score 用 ABC 曲谱和对齐歌词创作清唱。用户未明确指定时省略playbackMode，使用音乐页面保存的默认方式；本次明确要求优先且不修改默认。playbackMode=preview只处理1分钟片段；playbackMode=full完整翻唱并按每段最长55秒发送。staged 仅表示已申请，只有 confirmed 才能说已送达。',parameters:{type:'object',properties:{kind:{type:'string',enum:['song','cover','score']},playbackMode:{type:'string',enum:['preview','full']},cachedOnly:{type: "boolean",description:"只调用已保存成品，不重新制作或联网"},style:{type:"string",enum:["cute","natural","gentle"]},sourceUrl:{type:'string',maxLength:2048,description:'网易云官方歌曲链接，支持#/song；不能填歌单或任意音频网址'},title:{type:'string',maxLength:100},artist:{type:'string',maxLength:100},songId:{type:'string',maxLength:64},score:{type:'string',maxLength:8000},lyrics:{type:'string',maxLength:1000}},required:['kind'],additionalProperties:false},execute:async(ctx,args)=>result(await ctx.voice.enqueue({...args,style:args.style??await effective(ctx)}))});
}
export const hooks={
  'before-context':async ctx=>{
    if(!/唱|歌|语音|进度|多久|好了没|做好没/.test(JSON.stringify(ctx.message??'')))return {};
    const jobs=await ctx.voice.status(),active=jobs.filter(j=>!['confirmed','failed','unconfirmed','cancelled','expired'].includes(j.state));
    return {context:'声音任务以本机状态为准：'+JSON.stringify(active.length?active:jobs.slice(-2))+'。用户问进度时用阶段和已等时间回答，不再新建同一歌曲，不把排队或编码当成已送达。想再次唱已保存歌曲时先查voice/songs；rendered-song是成品，使用sing kind=song和其sourceUrl，可设cachedOnly=true直接复用，不能把成品ID当原始人声songId。'};
  },
  'after-response':async ctx=>{
    if(ctx.config().randomVoice===true){const text=chooseVoiceSentence(ctx.text,{chance:ctx.config().randomVoiceChance??25});if(text)return {voiceReplacement:{kind:'speech',text,style:await effective(ctx)}};return {};}
    if(!ctx.config().autoVoice||typeof ctx.text!=='string'||!ctx.text.startsWith('RESPOND:'))return {};
    const text=ctx.text.slice(8).trim();if(!text||text.length>220||/[\[\]{}<>`]|(?:SILENT|OBSERVE|REASONING):/.test(text))return {};
    return {voiceRequest:{kind:'speech',text,style:await effective(ctx)}};
  }
};
