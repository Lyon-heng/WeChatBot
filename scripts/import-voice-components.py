"""Verify the registered environment ZIP and copy missing roots without executing it."""
import hashlib,json,os,pathlib,re,shutil,stat,sys,tempfile,zipfile

class ImportFailure(Exception):pass
def no_links(target):
    for part in (target,*target.parents):
        if part.is_symlink() or getattr(part,'is_junction',lambda:False)():raise ImportFailure('VOICE_COMPONENT_LINK')
def safe_name(name):
    if not name or '\\' in name or name.startswith('/') or any(c in name for c in '\x00\r\n'):raise ImportFailure('VOICE_COMPONENT_PATH')
    parts=name.rstrip('/').split('/')
    for part in parts:
        if not part or part in ('.','..') or part[-1:] in (' ','.') or re.search(r'[<>:"|?*\x00-\x1f]',part) or re.fullmatch(r'(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?',part,re.I):raise ImportFailure('VOICE_COMPONENT_PATH')
    return parts
def install(archive,data_home,spec,emit=lambda event:None):
    home=pathlib.Path(data_home).absolute();no_links(home)
    if not home.is_dir() or home==pathlib.Path(home.anchor):raise ImportFailure('VOICE_COMPONENT_DESTINATION')
    archive=pathlib.Path(archive);no_links(archive)
    if not archive.is_file():raise ImportFailure('VOICE_COMPONENT_ARCHIVE')
    lock=home/'.voice-components-import.lock';stage=None;owned_lock=False
    try:
        try:lock_handle=lock.open('xb');owned_lock=True
        except FileExistsError:raise ImportFailure('VOICE_COMPONENT_BUSY') from None
        with lock_handle,archive.open('rb') as source:
            if os.fstat(source.fileno()).st_size!=spec['bytes']:raise ImportFailure('VOICE_COMPONENT_HASH')
            emit({'phase':'validating','bytesDone':0,'bytesTotal':spec['bytes']});digest=hashlib.sha256();done=0
            while True:
                chunk=source.read(4*1024*1024)
                if not chunk:break
                digest.update(chunk);done+=len(chunk)
                if done%(32*1024*1024)==0:emit({'phase':'validating','bytesDone':done,'bytesTotal':spec['bytes']})
            if digest.hexdigest()!=spec['sha256']:raise ImportFailure('VOICE_COMPONENT_HASH')
            source.seek(0)
            with zipfile.ZipFile(source) as z:
                emit({'phase':'inspecting'});infos=z.infolist();seen={};files=[];total=0
                if len(infos)>spec['maxFiles']:raise ImportFailure('VOICE_COMPONENT_LIMIT')
                for info in infos:
                    parts=safe_name(info.filename);key='/'.join(parts).casefold()
                    mode=stat.S_IFMT(info.external_attr>>16)
                    if key in seen or info.flag_bits&1 or mode not in (0,stat.S_IFREG,stat.S_IFDIR):raise ImportFailure('VOICE_COMPONENT_PATH')
                    seen[key]=info
                    if parts==['VOICE-OPTIONAL-README.txt']:
                        if info.file_size>65536:raise ImportFailure('VOICE_COMPONENT_LIMIT')
                        continue
                    if len(parts)<2 or parts[0]!='data' or parts[1] not in spec['roots']:raise ImportFailure('VOICE_COMPONENT_PATH')
                    if info.is_dir():continue
                    if len(parts)<3:raise ImportFailure('VOICE_COMPONENT_PATH')
                    total+=info.file_size;files.append((info,parts))
                    if info.file_size>512*1024*1024 or total>spec['maxExpandedBytes']:raise ImportFailure('VOICE_COMPONENT_LIMIT')
                for key,info in seen.items():
                    if any('/'.join(key.split('/')[:i]) in seen and not seen['/'.join(key.split('/')[:i])].is_dir() for i in range(1,len(key.split('/')))):raise ImportFailure('VOICE_COMPONENT_PATH')
                for root,markers in spec['roots'].items():
                    for marker in markers:
                        info=seen.get(('data/'+root+'/'+marker).casefold())
                        if info is None or info.is_dir() or info.file_size<1:raise ImportFailure('VOICE_COMPONENT_INCOMPLETE')
                    no_links(home/root)
                missing=[root for root in spec['roots'] if not (home/root).exists()]
                if not missing:return {'installed':[],'kept':list(spec['roots'])}
                selected=[(info,parts) for info,parts in files if parts[1] in missing]
                required=sum(info.file_size for info,_ in selected)
                if shutil.disk_usage(home).free<required+64*1024*1024:raise ImportFailure('VOICE_COMPONENT_DISK_FULL')
                stage=pathlib.Path(tempfile.mkdtemp(prefix='.voice-components-import-',dir=home))
                emit({'phase':'extracting','filesDone':0,'filesTotal':len(selected)})
                for index,(info,parts) in enumerate(selected):
                    target=stage.joinpath(*parts[1:]);target.parent.mkdir(parents=True,exist_ok=True)
                    with z.open(info) as incoming,target.open('xb') as outgoing:
                        copied=0
                        while True:
                            chunk=incoming.read(1024*1024)
                            if not chunk:break
                            copied+=len(chunk)
                            if copied>info.file_size:raise ImportFailure('VOICE_COMPONENT_LIMIT')
                            outgoing.write(chunk)
                        if copied!=info.file_size:raise ImportFailure('VOICE_COMPONENT_INCOMPLETE')
                    if index%100==0 or index+1==len(selected):emit({'phase':'extracting','filesDone':index+1,'filesTotal':len(selected)})
                installed=[]
                for root in missing:
                    no_links(home/root)
                    if (home/root).exists():raise ImportFailure('VOICE_COMPONENT_DESTINATION_CHANGED')
                    emit({'phase':'installing','component':root})
                    # Windows rename refuses an existing destination; never merge existing runtimes.
                    os.rename(stage/root,home/root);installed.append(root)
                return {'installed':installed,'kept':[root for root in spec['roots'] if root not in missing]}
    finally:
        if stage is not None:
            if stage.parent.resolve()!=home.resolve() or not stage.name.startswith('.voice-components-import-'):raise ImportFailure('VOICE_COMPONENT_CLEANUP')
            no_links(stage);shutil.rmtree(stage)
        if owned_lock:lock.unlink(missing_ok=True)

if __name__=='__main__':
    try:
        request=json.loads(sys.stdin.read(16384));spec=json.loads((pathlib.Path(__file__).resolve().parent.parent/'packaging/windows/voice-components.json').read_text(encoding='utf-8-sig'))
        result=install(request['archive'],request['dataHome'],spec,lambda e:print(json.dumps(e),flush=True))
        print(json.dumps({'phase':'complete',**result}),flush=True)
    except Exception as error:
        print(json.dumps({'phase':'failed','code':str(error) if isinstance(error,ImportFailure) else 'VOICE_COMPONENT_IMPORT_FAILED'}),flush=True);sys.exit(1)
