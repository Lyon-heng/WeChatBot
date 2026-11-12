import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {HistoryStore} from './history-store.mjs';import {recentWindow} from './request-window.mjs';import {continuityContext} from './continuity-memory.mjs';import {PeopleMemory} from '../plugin-api/people-memory.mjs';
export const MEMORY_CASES=Object.freeze([{id:'recall',name:'长对话后记住宠物',field:'pet',expected:'奶糖'},{id:'correction',name:'昵称纠正',field:'nickname',expected:'小红'},{id:'same-name',name:'同名人物分开',field:'pet',expected:'团子'},{id:'privacy',name:'私聊记忆不跨群泄露',field:'pet',expected:null},{id:'denied-sharing',name:'否定共享不能当作允许',field:'pet',expected:null}]);
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
export function memoryEvaluationPrompt(id,turns=100){
 const spec=MEMORY_CASES.find(item=>item.id===id);if(!spec||![100,500].includes(turns))throw Error('MEMORY_EVALUATION_INVALID');
 const base=path.resolve(os.tmpdir()),root=fs.mkdtempSync(path.join(base,'wechatbot-eval-')),account='a'.repeat(64),chat='wechat:private:1',group='wechat:group:2',store=new HistoryStore(root,account),people=new PeopleMemory({root,accountScope:hash(account),accountId:account});let seq=0;
 const observation=(text,sender='wxid_alice',key=chat)=>({conversationKey:key,peopleObservations:[{senderId:sender,name:'同名',text,at:Date.now(),evidenceId:hash(String(++seq))}]});
 const beganAt=Date.now()/1000-turns-20;const add=(text,sender='wxid_alice')=>{const t=observation(text,sender);people.capture(t);store.append(chat,{id:String(seq),kind:'private',sender_id:sender==='wxid_alice'?'1':'2',sender_name:'同名',sender_wxid:sender,timestamp:beganAt+seq,text});};
 try{
  add('我叫小明');add(id==='denied-sharing'?'我的猫叫奶糖，不要跨聊天共享':'我的猫叫奶糖');if(id==='correction')add('以后叫我小红');if(id==='same-name')add('我的猫叫团子','wxid_bob');for(let i=0;i<turns;i++)add('今天路过聊几句，这是第'+i+'次。');
  const key=['privacy','denied-sharing'].includes(id)?group:chat,sender=id==='same-name'?'wxid_bob':'wxid_alice',question=spec.field==='nickname'?'我现在应该叫什么昵称？':'我的猫叫什么名字？',turn=observation(question,sender,key),policy={recentMessages:40,recentChars:12000,summaryChars:3200};
  const recent=recentWindow(store.windowRows(key,policy),policy),memory=people.recall(turn,{limit:6}),context=continuityContext(store,key,policy,{recent,observations:turn.peopleObservations,accountId:account});
  const retrieved=JSON.stringify(memory),retrieval={passed:spec.expected===null?!JSON.stringify({memory,context}).includes('奶糖'):retrieved.includes(spec.expected),method:'person-facts-and-continuity',notes:memory.reduce((n,p)=>n+p.notes.length,0)};
  return {id:spec.id,name:spec.name,turns,retrieval,prompt:'这是隔离记忆评测。所有人物和聊天都是虚构数据，不调用工具。仅依据资料回答当前人物的问题；同名不等于同一个人，其他人的宠物不能算作当前人物的宠物。未知回答null。只输出JSON对象，字段为 '+spec.field+'，不要推测。\n'+JSON.stringify({current:people.current(turn),recent,personMemory:memory,continuity:context,question}),field:spec.field,expected:spec.expected};
 }finally{store.close();const resolved=path.resolve(root);if(resolved.startsWith(base+path.sep)&&path.basename(resolved).startsWith('wechatbot-eval-'))fs.rmSync(resolved,{recursive:true,force:true});}
}
export function scoreMemoryAnswer(spec,text){try{const parsed=JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g,'')),actual=parsed[spec.field];return {passed:Object.hasOwn(parsed,spec.field)&&actual===spec.expected,actual:typeof actual==='string'?actual.slice(0,100):actual===null?null:'格式无效',expected:spec.expected};}catch{return {passed:false,actual:'未返回有效JSON',expected:spec.expected};}}
