"""Load the dedicated model on first use; loopback and bearer key only."""
import argparse,os,sys,json,time,threading,hashlib,io,logging
logging.disable(logging.CRITICAL)
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
parser=argparse.ArgumentParser();parser.add_argument('--repo',required=True);parser.add_argument('--package',required=True);parser.add_argument('--key-file',required=True);parser.add_argument('--port',type=int,default=19886);args=parser.parse_args()
package=Path(args.package).resolve();repo=Path(args.repo).resolve();token=Path(args.key_file).read_text().strip()
if len(token)<16:raise ValueError('COSY_AUTH_KEY_INVALID')
os.environ.update(HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',PYTHONDONTWRITEBYTECODE='1',OMP_NUM_THREADS='4');os.chdir(repo);sys.path.insert(0,str(repo));sys.path.append(str(repo/'third_party/Matcha-TTS'))
import torch,numpy as np,soundfile as sf
if sys.platform=='win32':
 sys.path.insert(0,str(package.parent.parent));from feiyu_runtime.common import use_soundfile_loader
 import torchaudio;use_soundfile_loader(torchaudio)
from cosyvoice.cli.cosyvoice import AutoModel
from cosyvoice.utils.common import set_all_random_seed
manifest=json.loads((package/'manifest.json').read_text(encoding='utf-8-sig'));model_dir=(package/manifest['base_model_dir']).resolve();params=manifest['inference'];torch.set_num_threads(4);voice=None;states={};references={};active=None;lock=threading.Lock()
def digest(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for block in iter(lambda:f.read(8*1024*1024),b''):h.update(block)
 return h.hexdigest()
for style in ['cute','gentle']:
 selected=manifest['styles'][style];checkpoint=(package/selected['llm_checkpoint']).resolve();reference=(package/selected['reference_audio']).resolve()
 if package not in checkpoint.parents or package not in reference.parents or digest(checkpoint)!=selected['llm_sha256'] or digest(reference)!=selected['reference_sha256']:raise ValueError('COSY_PACKAGE_HASH_INVALID')
 # Keep checkpoint paths, not two additional full CPU copies of the LLM.
 states[style]=checkpoint;references[style]=(reference,selected['reference_text'])
load_ms=0
def synthesize(text,style):
 global active,voice,load_ms
 with lock,torch.inference_mode():
  if voice is None:
   began=time.perf_counter();voice=AutoModel(model_dir=str(model_dir),fp16=False,load_trt=False,load_vllm=False);voice.model.llm.eval();load_ms=int((time.perf_counter()-began)*1000)
  if active!=style:
   try:weights=torch.load(states[style],map_location='cpu',weights_only=True,mmap=True)
   except RuntimeError:weights=torch.load(states[style],map_location='cpu',weights_only=True)
   voice.model.llm.load_state_dict(weights,strict=True);del weights;active=style
  set_all_random_seed(params['seed']);reference,reftext=references[style]
  chunks=[r['tts_speech'].detach().cpu().numpy()[0] for r in voice.inference_zero_shot(text,params['prompt_prefix']+reftext,str(reference),stream=False,speed=params['speed'],text_frontend=True)]
  audio=np.concatenate(chunks)
  if not np.isfinite(audio).all() or len(audio)<480 or len(audio)>voice.sample_rate*60:raise ValueError('COSY_AUDIO_INVALID')
  audio=audio*min(1.0,0.98/max(float(abs(audio).max()),1e-9));return (audio*32767).astype('<i2').tobytes()
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def result(self,code,data,kind='application/json'):
  body=json.dumps(data).encode() if kind=='application/json' else data;self.send_response(code);self.send_header('Content-Type',kind);self.send_header('Content-Length',str(len(body)));self.send_header('X-Sample-Rate',str(voice.sample_rate if voice is not None else 24000));self.end_headers();self.wfile.write(body)
 def do_GET(self):self.result(200,{'ok':True,'engine':'feiyu-cosyvoice3','sampleRate':voice.sample_rate if voice is not None else 24000,'modelLoaded':voice is not None,'styles':['cute','gentle'],'modelLoadMs':load_ms}) if self.path=='/health' else self.result(404,{'error':'not_found'})
 def do_POST(self):
  import secrets
  if not secrets.compare_digest(self.headers.get('Authorization',''),'Bearer '+token):return self.result(401,{'error':'unauthorized'})
  if self.path!='/v1/audio/speech':return self.result(404,{'error':'not_found'})
  try:
   length=int(self.headers.get('Content-Length','0'))
   if not 1<=length<=16000:raise ValueError()
   data=json.loads(self.rfile.read(length));text=data.get('input',data.get('text',''));style=data.get('style',data.get('voice','cute'))
   if not isinstance(text,str) or not text.strip() or len(text)>220 or style not in states:raise ValueError()
   pcm=synthesize(text,style)
   if data.get('response_format')=='pcm':return self.result(200,pcm,'application/octet-stream')
   buffer=io.BytesIO();sf.write(buffer,np.frombuffer(pcm,dtype='<i2'),voice.sample_rate,format='WAV',subtype='PCM_16');self.result(200,buffer.getvalue(),'audio/wav')
  except Exception as error:
   print('Cosy request failed: '+type(error).__name__,flush=True);self.result(503,{'error':'cosy_synthesis_failed'})
print('Persistent CosyVoice ready; modelLoadMs='+str(load_ms),flush=True);ThreadingHTTPServer(('127.0.0.1',args.port),Handler).serve_forever()
