const normalize=value=>String(value??'').normalize('NFKC').replace(/\s+/g,'').toLocaleLowerCase();
const sensitive=/密码|验证码|令牌|token|api.?key|身份证|银行卡|手机号|电话号码|住址|疾病|抑郁|诊断|政治|政党|宗教|性取向|性癖|自杀|健康|血型|收入|工资|[\d]{7,}|https?:|[<>{}\[\]`]/i;
export function sharingConfirmed(text){return !/[?？]|能不能|可不可以|是否|会不会|能否/.test(text)&&/(?:跨聊天|跨群|所有聊天|所有群|每个群|各个群|任何聊天).{0,12}(?:记住|记得|共享|使用|叫我|生效)|(?:允许|可以|同意|记住|共享).{0,12}(?:跨聊天|跨群|所有聊天|所有群)|可以公开|share across chats/i.test(text)&&!/(?:不要|不许|不能|别|不允许|不想|拒绝|禁止|不准|不可以|仅限|只在).{0,12}(?:跨聊天|跨群|共享|公开|所有聊天|所有群)|(?:跨聊天|跨群).{0,8}(?:不要|禁止|别|不允许|不能|不可以)/.test(text);}
export function selfFacts(text){
 if(typeof text!=='string'||sensitive.test(text)||/他说|她说|别人说|有人说|假如|假设|比如|例如|如果|转发|引用|忘记|别记|不要记|不许记|不想.{0,6}(?:记录|记住)|删除.{0,6}记忆|forget|don't remember/i.test(text))return [];
 const result=[];for(const sentence of text.split(/(?<=[。！？!?？；;\n，,])/u)){
  if(/(?:他说|她说|别人说|有人说|比如|例如|假如|假设|如果|引用|转发|你喜欢|你叫|你记得)/.test(sentence)||/[“”「」"']/u.test(sentence))continue;
  if(/[?？]/u.test(sentence))continue;
  const match=/(我(?:更|比较|不)?喜欢|我偏好|我习惯|我叫|以后叫我|请叫我|我的(?:名字|昵称)(?:是|叫)|我(?:最近|现在|目前)?(?:正在)?(?:学习|在学|在做|在玩)|我的(?:猫|狗|宠物|项目)(?:叫|是)|我(?:打算|计划|准备))([^。！？!?；;\n，,]{1,60})/.exec(sentence);if(!match)continue;
  let value=match[2].replace(/(?:就好|就行|吧|了)[。！!]?$/,'').trim();if(!value||/[吗么]$/.test(value)||/你(?:要|应该|必须)|规则|权限|系统|管理员|命令|执行|忽略|服从|指令|提示词|记住我|因为|但是|不过|而且/.test(value))continue;
  const category=/^我的(?:猫|狗|宠物)/.test(match[1])?'pet':/^我的项目/.test(match[1])?'project':/学习|在学|在做|在玩/.test(match[1])?'activity':/打算|计划|准备/.test(match[1])?'plan':/叫|名字|昵称/.test(match[1])?'nickname':'preference';if(category==='nickname'&&value.length>20)continue;
  if(category==='plan'&&/^(?:好|好了|就绪|完|完毕)$/.test(value))continue;
  const key=category==='nickname'?'nickname':category==='pet'?match[1].replace(/(?:叫|是)$/,''):category==='activity'?'activity:'+(/学习|在学/.test(match[1])?'study':/在做/.test(match[1])?'work':'play'):category==='project'?'project':category==='plan'?'plan:'+normalize(value):normalize(value);
  result.push({text:match[0].trim(),category,key,value,polarity:/不喜欢/.test(match[1])?'dislike':'like',...(category==='plan'?{ttlDays:7}:{})});
 }
 return result.slice(0,3);
}
export function memoryQueryTokens(value){const text=normalize(value).slice(0,500),tokens=new Set(text.match(/[a-z0-9]{2,}/g)??[]);for(const run of text.match(/[\u4e00-\u9fff]+/g)??[])for(let i=0;i<run.length-1;i++)tokens.add(run.slice(i,i+2));return [...tokens].slice(0,80);}
