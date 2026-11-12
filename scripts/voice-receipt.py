"""Read-only receipt check: match the exact outgoing SILK payload, never send."""
import hashlib,importlib.util,json,pathlib,re,sys

def receipt(reader,job,nt):
    # Keep the check local to an account and already-authorized durable job.
    if not re.fullmatch(r'[a-f0-9]{32}',job.get('md5','')) or job.get('account')!=reader.account.name.lower() or not reader.sticker_account_active():
        raise RuntimeError('VOICE_RECEIPT_ACCOUNT_CHANGED')
    key=job.get('key','');talker=job.get('wxid','')
    if not re.fullmatch(r'wechat:(private|group):[1-9]\d{0,15}',key) or str(reader.conversation_id(talker))!=key.rsplit(':',1)[1] or talker not in reader.selected_talkers():
        raise RuntimeError('VOICE_RECEIPT_CHAT_CHANGED')
    from wechat_voice_input import load_voice_blob
    for row in reader.messages(talker,100):
        stamp=json.dumps([row.get('localId'),row.get('serverId'),row.get('createTime')],separators=(',',':'),ensure_ascii=False)
        if not row.get('isSend') or row.get('localType')!=34 or stamp in job.get('baseline',[]) or int(row.get('createTime',0))<int(job.get('startedAt',0)/1000)-1 or not re.fullmatch(r'[1-9]\d*',str(row.get('serverId',''))):continue
        try:blob=load_voice_blob(reader.account,{'talker':talker,'localId':row['localId'],'passphrase':reader.passphrase},nt)
        except RuntimeError:continue
        if hashlib.md5(blob).hexdigest()==job['md5']:
            return {'messageId':str(row['localId']),'type':'wechat-voice','serverConfirmed':True,'payloadMatched':True}
    return None

def main():
    root=pathlib.Path(__file__).resolve().parent.parent
    job_id=sys.argv[1] if len(sys.argv)==2 else ''
    if not re.fullmatch(r'[a-f0-9]{64}',job_id):raise RuntimeError('VOICE_JOB_INVALID')
    file=root/'state/voice/jobs'/(job_id+'.json')
    if file.is_symlink() or file.stat().st_size>65536:raise RuntimeError('VOICE_JOB_INVALID')
    job=json.loads(file.read_text(encoding='utf-8-sig'))
    if job.get('id')!=job_id or job.get('version')!=1 or job.get('state') not in ('submitting','submitted','unconfirmed') or not isinstance(job.get('baseline'),list) or not job.get('startedAt'):raise RuntimeError('VOICE_JOB_INVALID')
    spec=importlib.util.spec_from_file_location('voice_receipt_reader',root/'scripts/reader-api.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    reader=module.Reader(root,metadata_readonly=True)
    try:print(json.dumps({'receipt':receipt(reader,job,module.nt)}))
    finally:
        reader.stop.set()
        for name in ('image_executor','sticker_executor','sticker_review_executor'):getattr(reader,name).shutdown(wait=False,cancel_futures=True)

if __name__=='__main__':
    try:main()
    except Exception:print(json.dumps({'receipt':None,'error':'VOICE_PAYLOAD_RECEIPT_UNAVAILABLE'}));sys.exit(1)
