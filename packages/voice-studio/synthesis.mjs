import {MusicLibrary} from './library.mjs';
import {synthesizeCosyVoice} from './cosyvoice.mjs';
import {splitSongPcm} from './segments.mjs';
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {encode} from '../voice-codec/silk-wasm/lib/index.mjs';
import {directory} from '../plugin-api/catalog.mjs';import {voiceError} from './jobs.mjs';
import {synthesizeSinging,wavToPcm,pcmToWav} from './singing.mjs';
import {SavedSongs} from './saved-songs.mjs';
import {CustomVoices,validateVoiceProfile} from './voices.mjs';
import {SpeechApi} from './speech-api.mjs';
export async function boundedAudio(response,signal,maxBytes=24000*2*60){
  if(!response.ok){await response.body?.cancel();throw voiceError('VOICE_SYNTHESIS_HTTP_'+response.status);}
  const chunks=[];let length=0;for await(const part of response.body){if(signal?.aborted)throw voiceError('VOICE_CANCELLED');length+=part.length;if(length>maxBytes)throw voiceError('VOICE_EXCEEDS_60_SECONDS');chunks.push(Buffer.from(part));}if(length<960||length%2)throw voiceError('VOICE_AUDIO_INVALID');return Buffer.concat(chunks);
}
export async function synthesizeVoice(root,request,settings,{signal,fetcher=fetch,remoteJobId,onRemoteJob,onProgress=()=>{},onPcm,singing=synthesizeSinging}={}){
  if(request.kind==='song'&&request.cachedOnly&&!request.playbackMode&&settings.songPlaybackMode!=='full'){const legacy=new SavedSongs(root).find(request,settings);if(legacy){onProgress('cached');return new SavedSongs(root).restore(legacy,signal);}}
  if(request.kind==='song')request={...request,playbackMode:request.playbackMode??settings.songPlaybackMode??'preview'};
  const saved=new SavedSongs(root),cached=saved.find(request,settings);if(cached){onProgress('cached');return saved.restore(cached,signal);}if(request.cachedOnly)throw voiceError('SAVED_SONG_UNAVAILABLE');
  let preparedSong;const singingOptions={signal,fetcher,remoteJobId,onRemoteJob,onProgress,mixSettings:settings,onPreparedSong:value=>{preparedSong=value;}};
  const port=settings.breezePort??19881;if(!Number.isSafeInteger(port)||port<1024||port>65534)throw voiceError('VOICE_PORT_INVALID');
  const profile=request.kind==='speech'&&settings.speechEngine?.mode!=='external'&&settings.customVoiceProfile?validateVoiceProfile(settings.customVoiceProfile):null;
  const dedicated=request.kind==='speech'&&settings.speechEngine?.mode==='cosyvoice';
  const external=request.kind==='speech'&&settings.speechEngine?.mode==='external',style=profile?.baseStyle??request.style,useFeiyu=dedicated?false:external?profile?.feiyu===true:profile?.feiyu??settings.feiyuTimbre===true;
  let pcm;
  if(request.kind==='speech'&&useFeiyu&&remoteJobId)pcm=await singing(root,request,singingOptions);
  else if(request.kind==='speech'){
  if(dedicated){onProgress('speech');pcm=await synthesizeCosyVoice(root,request.text,style,{signal,fetcher,expectedRevision:settings.speechEngine.revision});}
  else if(external){onProgress('speech');pcm=await new SpeechApi(root,{fetcher}).synthesize(request.text,{expectedRevision:settings.speechEngine.revision,voice:profile?.apiVoice,instruction:profile?.instruction,signal});}
  else{
  const refs=directory(root,'state/voice/references'),reference=path.join(refs,(style==='gentle'?'gentle':'cute')+'.wav');
  if(!profile?.referenceId&&(!fs.existsSync(reference)||fs.lstatSync(reference).isSymbolicLink()||fs.statSync(reference).size>2*1024*1024))throw voiceError('VOICE_REFERENCE_NOT_READY');
  const form=new FormData();form.set('text',request.text);form.set('ref_audio',new Blob([profile?.referenceId?new CustomVoices(root).reference(profile):fs.readFileSync(reference)],{type:'audio/wav'}),'reference.wav');
  form.set('ref_text',profile?.referenceId?profile.referenceText:style==='gentle'?'我刚刚把桌子收拾了一下，也给自己倒了一杯温水。现在可以坐下来，安安静静地听你说话了。':'我已经准备好了，我们开始吧。');
  // Ordinary reference cloning uses CFG 1; expressive direction belongs to opt-in custom voices.
  form.set('instruction',profile?.instruction||'自然清晰地说话。');form.set('cfg_scale',String(profile?.cfgScale??(profile?3:1)));if(profile?.temperature!==undefined)form.set('temperature',String(profile.temperature));if(profile?.seed!==undefined)form.set('seed',String(profile.seed));form.set('split_chars','0');form.set('max_new_tokens','750');
  onProgress('speech');const response=await fetcher(`http://127.0.0.1:${port}/v1/audio/speech`,{method:'POST',body:form,signal,redirect:'error'});
  const rate=Number(response.headers.get('x-sample-rate'));if(rate!==24000){await response.body?.cancel();throw voiceError('VOICE_SAMPLE_RATE_INVALID');}
  pcm=await boundedAudio(response,signal);
  }
  const pitch=profile?.pitch??(style==='cute'?(settings.cutePitch??3):style==='natural'?1:0);if(!dedicated&&(useFeiyu||profile&&(pitch||profile.speed!==1)))pcm=await wavToPcm(root,pcmToWav(pcm),{signal,pitchSemitones:pitch,speed:profile?.speed??1});
  if(useFeiyu)pcm=await singing(root,{kind:'cover'},{...singingOptions,sourceWav:pcmToWav(pcm)});
  }else pcm=await singing(root,request,singingOptions);
  // Keep identity conversion first: processing here also covers resumed conversion jobs.
  // Custom voices and external providers keep their own explicit speed/EQ settings.
  if(request.kind==='speech'&&!profile&&!external&&useFeiyu)pcm=await wavToPcm(root,pcmToWav(pcm),{signal,bassDb:-1.5,trebleDb:0.8,lightVoice:true});
  if(profile&&(profile.volume!==undefined&&profile.volume!==1||profile.bassDb||profile.trebleDb||profile.normalize||profile.trimSilence))pcm=await wavToPcm(root,pcmToWav(pcm),{signal,volume:profile.volume??1,bassDb:profile.bassDb??0,trebleDb:profile.trebleDb??0,normalize:profile.normalize??false,trimSilence:profile.trimSilence??false});
  if(signal?.aborted)throw voiceError('VOICE_CANCELLED');
  onPcm?.(pcm);onProgress('encode');const pieces=request.kind==='song'?splitSongPcm(pcm,request.playbackMode):[pcm],proofs=[];
  for(const part of pieces){const result=await encode(part,24000),data=Buffer.from(result.data),durationMs=Math.round(result.duration);
  if(data[0]!==2||data.subarray(1,10).toString()!=='#!SILK_V3'||durationMs<20||durationMs>60000||data.length>1024*1024)throw voiceError('VOICE_CODEC_INVALID');
  const md5=crypto.createHash('md5').update(data).digest('hex'),outgoing=directory(root,'state/voice/outgoing'),file=path.join(outgoing,md5+'.silk');
  if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())throw voiceError('VOICE_OUTPUT_INVALID');fs.writeFileSync(file,data,{mode:0o600});const proof={md5,size:data.length,durationMs};if(request.kind==='song'){onProgress('save');const entry=saved.save(request,settings,proof,part,{...preparedSong,segmentIndex:proofs.length,segmentCount:pieces.length,seriesId:crypto.createHash('sha256').update(pcm).digest('hex')},signal);proofs.push({...proof,savedSongId:entry.id,cached:false});}else proofs.push(proof);}
  if(request.kind==='song')try{new MusicLibrary(root).enforceLimit({protectIds:proofs.map(p=>p.savedSongId)});}catch{onProgress('save');}
  return {...proofs[0],...(request.kind==='song'?{playbackMode:request.playbackMode,segmentIndex:0,segmentProofs:proofs}: {})};
}
