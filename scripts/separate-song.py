"""Separate bounded chunks, keeping one model and streaming the final stems."""
import argparse,json,pathlib,logging,os,tempfile,wave,sys

def load_separator_model(separator, runtime=None):
    # audio-separator does not expose ORT SessionOptions. Scope the adapter to
    # model loading in this isolated, single-request worker; restore it on error.
    # Retained CPU arenas/patterns can exhaust Windows commit while DSH/TTS run.
    if runtime is None:
        import onnxruntime as runtime
    original = runtime.InferenceSession
    def bounded_session(model, sess_options=None, *args, **kwargs):
        options = sess_options if sess_options is not None else runtime.SessionOptions()
        options.enable_cpu_mem_arena = False
        options.enable_mem_pattern = False
        options.intra_op_num_threads = min(4, os.cpu_count() or 1)
        options.inter_op_num_threads = 1
        return original(model, options, *args, **kwargs)
    runtime.InferenceSession = bounded_session
    try:
        separator.load_model(model_filename='UVR-MDX-NET-Inst_HQ_3.onnx')
    finally:
        runtime.InferenceSession = original

def error_code(error):
    message = str(error).lower()
    if isinstance(error, MemoryError) or any(text in message for text in (
        'out of memory', 'failed to allocate memory', 'bad allocation',
        'bad_alloc', 'not enough memory', 'cannot allocate memory',
    )) or isinstance(error, OSError) and (error.errno == 12 or getattr(error, 'winerror', None) == 1455):
        return 'SONG_SEPARATOR_MEMORY_PRESSURE'
    known = {'SONG_STEM_MISSING','SONG_STEMS_INVALID','SONG_SEPARATOR_INPUT_INVALID'}
    return str(error) if str(error) in known else 'SONG_SEPARATOR_FAILED'

def main():
    parser=argparse.ArgumentParser()
    for name in ('input','output','models'):parser.add_argument('--'+name,required=True)
    parser.add_argument('--tools')
    args=parser.parse_args()
    tools=pathlib.Path(args.tools) if args.tools else pathlib.Path(__file__).resolve().parent.parent/'state'/'voice'/'tools'
    os.environ['PATH']=str(tools)+os.pathsep+os.environ.get('PATH','')
    output=pathlib.Path(args.output).resolve()
    output.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='separation-',dir=output) as temp:
        work=pathlib.Path(temp)
        chunks=[]
        with wave.open(args.input,'rb') as source:
            if source.getframerate()!=44100 or source.getnchannels()!=2 or source.getsampwidth()!=2 or source.getnframes()>44100*600:
                raise RuntimeError('SONG_SEPARATOR_INPUT_INVALID')
            total=source.getnframes()
            for start in range(0,total,44100*10):
                end=min(total,start+44100*10)
                left=max(0,start-22050);right=min(total,end+22050)
                source.setpos(left);block=source.readframes(right-left)
                file=work/('part-%04d.wav'%len(chunks))
                with wave.open(str(file),'wb') as writer:
                    writer.setnchannels(2);writer.setsampwidth(2);writer.setframerate(44100);writer.writeframes(block)
                chunks.append((file,start-left,end-start))
        from audio_separator.separator import Separator
        separator=Separator(log_level=logging.ERROR,output_dir=str(work),output_format='WAV',model_file_dir=args.models)
        load_separator_model(separator)
        stems={'vocals':[],'instrumental':[]}
        for index,(file,trim,frames) in enumerate(chunks):
            files=separator.separate(str(file),custom_output_names={'Vocals':'vocals-%04d'%index,'Instrumental':'instrumental-%04d'%index})
            for stem in stems:
                candidates=[work/name for name in files if stem in pathlib.Path(name).name.lower()]
                if len(candidates)!=1 or not candidates[0].is_file():raise RuntimeError('SONG_STEM_MISSING')
                stems[stem].append((candidates[0],trim,frames))
            print('MUSIC_PROGRESS:separate:%d:%d'%(index+1,len(chunks)),flush=True)
        import soundfile as sf
        for stem,files in stems.items():
            with sf.SoundFile(str(output/(stem+'.wav')),mode='w',samplerate=44100,channels=2,subtype='PCM_16') as writer:
                for file,trim,frames in files:
                    with sf.SoundFile(str(file)) as reader:
                        if reader.samplerate!=44100 or reader.channels!=2:raise RuntimeError('SONG_STEMS_INVALID')
                        reader.seek(trim);remaining=frames
                        while remaining:
                            block=reader.read(min(44100,remaining),dtype='float32',always_2d=True)
                            if not len(block):raise RuntimeError('SONG_STEMS_INVALID')
                            writer.write(block);remaining-=len(block)
    print(json.dumps({'ok':True,'stems':['vocals.wav','instrumental.wav']}))

if __name__=='__main__':
    try:main()
    except Exception as error:
        print('WECHATBOT_MUSIC_ERROR:'+error_code(error),file=sys.stderr);sys.exit(1)
