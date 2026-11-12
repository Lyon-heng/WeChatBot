import crypto from 'node:crypto';
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
export function dailyScheduleIdentity(record,settings,date,persona){
  let identity=date;
  if(record.schedule.personaScoped)identity+=':'+hash(persona.personaName+'\0'+persona.persona);
  const fields=record.schedule.completionSettings??[];
  if(fields.length)identity+=':'+hash(JSON.stringify(fields.map(key=>[key,settings[key]])));
  return identity;
}
export function scheduleCompleted(result){
  if(['unknown','committing','submitted_unverified','blocked_existing_receipt'].includes(result?.status))return true;
  return !result?.retryLater&&result?.ok!==false&&!['failed_before_commit','busy','no_history'].includes(result?.status);
}
