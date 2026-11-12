import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {DatabaseSync,backup} from 'node:sqlite';import {execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const predicate="host_key='127.0.0.1' AND name GLOB 'dsh-auth-*'";
const fault=code=>Object.assign(Error(code),{code});
function safePath(file){const absolute=path.resolve(file);for(let p=absolute;;p=path.dirname(p)){if(fs.existsSync(p)&&fs.lstatSync(p).isSymbolicLink())throw fault('DSH_AUTH_PATH_LINKED');if(path.dirname(p)===p)break;}return absolute;}
export function localAuthCounts(file){safePath(file);if(!fs.existsSync(file))return {temporary:0,other:0};const db=new DatabaseSync(file,{readOnly:true});try{return {temporary:Number(db.prepare('SELECT count(*) n FROM cookies WHERE '+predicate).get().n),other:Number(db.prepare('SELECT count(*) n FROM cookies WHERE NOT('+predicate+')').get().n)};}finally{db.close();}}
export async function recoverLocalAuth(file,{backupDirectory,closed,protectBackup}={}){
 safePath(file);if(!closed?.())throw fault('DSH_AUTH_APP_RUNNING');if(!fs.existsSync(file))return {changed:false,removed:0};
 const db=new DatabaseSync(file);let target;
 try{const count=Number(db.prepare('SELECT count(*) n FROM cookies WHERE '+predicate).get().n);if(!count)return {changed:false,removed:0};
  safePath(backupDirectory);fs.mkdirSync(backupDirectory,{recursive:true});protectBackup?.(backupDirectory);target=path.join(backupDirectory,'Cookies.sqlite');if(fs.existsSync(target))throw fault('DSH_AUTH_BACKUP_EXISTS');await backup(db,target);if(!closed())throw fault('DSH_AUTH_APP_RUNNING');
  db.exec('BEGIN IMMEDIATE');try{const other=Number(db.prepare('SELECT count(*) n FROM cookies WHERE NOT('+predicate+')').get().n),result=db.prepare('DELETE FROM cookies WHERE '+predicate).run();if(Number(db.prepare('SELECT count(*) n FROM cookies WHERE NOT('+predicate+')').get().n)!==other)throw fault('DSH_AUTH_UNRELATED_ROWS_CHANGED');db.exec('COMMIT');return {changed:true,removed:Number(result.changes),otherPreserved:other,backup:target};}catch(error){db.exec('ROLLBACK');throw error;}
 }finally{db.close();}
}
export function dshClosed(){const text=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"if(@(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue).Count){'running'}else{'closed'}"],{encoding:'utf8',windowsHide:true,timeout:10000});return text.trim()==='closed';}
export function dshCookiePath(root,env=process.env){const c=JSON.parse(fs.readFileSync(path.join(root,'config/wechatagent.json'),'utf8').replace(/^\uFEFF/,'')),distribution=path.join(root,'config/distribution.json');let profile=path.join(env.APPDATA,'@deepseek-ai/dsh-desktop');if(fs.existsSync(distribution)){const d=JSON.parse(fs.readFileSync(distribution,'utf8').replace(/^\uFEFF/,''));if(d.dsh&&d.dshHome&&path.resolve(d.dsh).toLowerCase()===path.resolve(c.runtime.dshDesktop).toLowerCase())profile=path.join(d.dshHome,'desktop');}return path.join(profile,'Network/Cookies');}
function protectBackup(folder){const identity=execFileSync('whoami',[],{encoding:'utf8',windowsHide:true}).trim();execFileSync('icacls',[folder,'/inheritance:r','/grant:r',identity+':(OI)(CI)F','SYSTEM:(OI)(CI)F'],{windowsHide:true,stdio:'ignore'});}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const root=path.resolve(process.argv[2]??path.join(import.meta.dirname,'..'));if(!dshClosed()){console.log(JSON.stringify({changed:false,skipped:'running'}));}else{const result=await recoverLocalAuth(dshCookiePath(root),{backupDirectory:path.join(root,'state/dsh-auth-backups',crypto.randomUUID()),closed:dshClosed,protectBackup});console.log(JSON.stringify({changed:result.changed,removed:result.removed,otherPreserved:result.otherPreserved??null}));}}
 catch(error){process.stderr.write((/^DSH_AUTH_[A-Z_]+$/.test(error.code??'')?error.code:'DSH_AUTH_RECOVERY_UNAVAILABLE')+'\n');process.exitCode=1;}
}
