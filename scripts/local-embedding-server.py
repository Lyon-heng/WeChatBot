"""Loopback-only ONNX sentence embeddings. Models stay outside the application package."""
import argparse,json,threading,time
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer
parser=argparse.ArgumentParser();parser.add_argument('--model-dir',required=True);parser.add_argument('--port',type=int,default=19884);args=parser.parse_args()
base=Path(args.model_dir);tokenizer=Tokenizer.from_file(str(base/'tokenizer.json'));tokenizer.enable_truncation(max_length=128);tokenizer.enable_padding(pad_id=0,pad_token='[PAD]')
options=ort.SessionOptions();options.intra_op_num_threads=4
session=ort.InferenceSession(str(base/'onnx/model_quantized.onnx'),sess_options=options,providers=['CPUExecutionProvider']);lock=threading.Lock();model_id='multilingual-minilm-l12-v2-q8'
def embed(texts):
 with lock:
  encoded=tokenizer.encode_batch(texts);values={'input_ids':np.array([e.ids for e in encoded],dtype=np.int64),'attention_mask':np.array([e.attention_mask for e in encoded],dtype=np.int64),'token_type_ids':np.array([e.type_ids for e in encoded],dtype=np.int64)}
  output=session.run(None,{item.name:values[item.name] for item in session.get_inputs()})[0]
  if len(output.shape)==3:
   mask=values['attention_mask'][...,None];output=(output*mask).sum(1)/np.maximum(mask.sum(1),1)
  return (output/np.maximum(np.linalg.norm(output,axis=1,keepdims=True),1e-12)).tolist()
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def send(self,status,data):
  body=json.dumps(data,separators=(',',':')).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
 def do_GET(self):self.send(200,{'ok':True,'model':model_id,'dimensions':384}) if self.path=='/health' else self.send(404,{'error':'not_found'})
 def do_POST(self):
  if self.path!='/v1/embeddings':return self.send(404,{'error':'not_found'})
  try:
   size=int(self.headers.get('Content-Length','0'))
   if size<1 or size>200000:raise ValueError()
   data=json.loads(self.rfile.read(size));texts=data['input']
   if data.get('model') not in ('',None,model_id) or not isinstance(texts,list) or not 1<=len(texts)<=101 or any(not isinstance(t,str) or not t.strip() or len(t)>500 for t in texts):raise ValueError()
   vectors=embed(texts);self.send(200,{'model':model_id,'data':[{'index':i,'embedding':v} for i,v in enumerate(vectors)]})
  except Exception:self.send(400,{'error':'embedding_request_failed'})
embed(['启动预热']);ThreadingHTTPServer(('127.0.0.1',args.port),Handler).serve_forever()
