import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import path from 'node:path';
import {windowsPowerShellExecutable} from './console-process.mjs';

export function validateTextTransport(value) {
  if(value===undefined)return;
  if(!value||!['native','foreground'].includes(value.mode??'native'))throw Error('请选择有效的文字发送方式。');
}

// A single process and queue owns the UI. Never retry or change transports after submission.
export class ForegroundSender {
  constructor(root,{spawnImpl=spawn,timeoutMs=60000}={}){this.root=root;this.spawn=spawnImpl;this.timeoutMs=timeoutMs;this.tail=Promise.resolve();}
  async start(){
    if(this.child)return;
    this.close();
    const child=this.spawn(windowsPowerShellExecutable(),['-NoProfile','-NonInteractive','-STA','-ExecutionPolicy','Bypass','-File',path.join(this.root,'scripts/foreground-sender.ps1')],{cwd:this.root,windowsHide:true,stdio:['pipe','pipe','ignore']});
    this.child=child;this.lines=createInterface({input:child.stdout});
    this.lines.on('line',line=>{try{this.pending?.resolve(JSON.parse(line));}catch{this.pending?.reject(Error('FOREGROUND_PROTOCOL_ERROR'));}this.pending=null;});
    child.on('error',()=>this.fail());child.on('exit',()=>{if(this.child===child)this.fail();});
    const ready=await this.wait();if(!ready.ready){this.close();throw Error('FOREGROUND_DEPENDENCIES_MISSING');}
  }
  fail(){this.pending?.reject(Error('FOREGROUND_PROCESS_STOPPED'));this.pending=null;this.child=null;}
  wait(){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending=null;this.close();reject(Error('FOREGROUND_TIMEOUT'));},this.timeoutMs);this.pending={resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}};});}
  send(body,beforeSend=async()=>{}){const task=this.tail.then(async()=>{await this.start();await beforeSend();const result=this.wait();this.child.stdin.write(JSON.stringify(body)+'\n',error=>{if(error)this.fail();});return result;});this.tail=task.catch(()=>{});return task;}
  async probe(executable){try{return (await this.send({probe:true,executable})).accepted===true;}finally{this.close();}}
  close(){this.pending?.reject(Error('FOREGROUND_PROCESS_STOPPED'));this.pending=null;const child=this.child;this.child=null;if(child){child.stdin.end();child.kill();}this.lines?.close();}
}
