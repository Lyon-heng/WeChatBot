import fs from 'node:fs';
import crypto from 'node:crypto';
import {VOICE_COMPONENTS} from './voice-components.mjs';
const file=process.argv[2];
if(!file||fs.statSync(file).size!==VOICE_COMPONENTS.bytes)throw Error('VOICE_COMPONENT_PACKAGE_SIZE_MISMATCH');
const hash=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))hash.update(chunk);
if(hash.digest('hex')!==VOICE_COMPONENTS.sha256)throw Error('VOICE_COMPONENT_PACKAGE_HASH_MISMATCH');
console.log('Registered voice component archive verified; binaries were not executed.');
