import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {verifyPackagedComponents} from './runtime-components.mjs';

const payload=fs.realpathSync(process.argv[2]);
const project=path.join(payload,'app/resources/project');
verifyPackagedComponents(project);
const node=path.join(payload,'app/resources/runtime/node.exe');
const entry=pathToFileURL(path.join(project,'scripts/console-server.mjs')).href;
const bridge=pathToFileURL(path.join(project,'packages/dsh-social-bridge-plugin/package.json')).href;
const code=`import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';const require=createRequire(${JSON.stringify(bridge)});await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href);await import(${JSON.stringify(entry)});console.log('Packaged runtime imports passed; no services or chats were started.');`;
const environment={...process.env};delete environment.ELECTRON_RUN_AS_NODE;
const result=spawnSync(node,['--input-type=module','-e',code],{cwd:project,env:environment,encoding:'utf8',windowsHide:true,shell:false,timeout:30000,maxBuffer:128*1024});
if(result.error)throw result.error;
if(result.status!==0)throw Error('PACKAGED_RUNTIME_DEPENDENCIES_MISSING\n'+(result.stderr||result.stdout||'Import subprocess failed'));
console.log(result.stdout.trim());
