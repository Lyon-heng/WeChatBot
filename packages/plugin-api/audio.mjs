import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function createAudioReader(root, {fetchImpl = fetch} = {}) {
  return async (id, key, pluginId, {format = 'wav', signal} = {}) => {
    if (!/^[a-f0-9]{64}$/.test(id) || !['wav', 'silk'].includes(format)) throw Error('VOICE_REFERENCE_INVALID');
    const io = JSON.parse(fs.readFileSync(path.join(root, 'state/wechat-io-config.json'), 'utf8').replace(/^\uFEFF/, ''));
    const base = new URL(io.reader_base_url);
    if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw Error('VOICE_READER_LOOPBACK_REQUIRED');
    const query = new URLSearchParams({conversationKey: key, pluginId, format});
    const response = await fetchImpl(base.origin+'/api/v1/voices/'+id+'?'+query, {
      headers: {Authorization: 'Bearer '+io.reader_token}, redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(9000), ...(signal ? [signal] : [])]),
    });
    const chunks = []; let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.length; if (size > 3*1024*1024) throw Error('VOICE_AUDIO_TOO_LARGE'); chunks.push(chunk);
    }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!response.ok) throw Error(/^VOICE_[A-Z_]{3,80}$/.test(result.error ?? '') ? result.error : 'VOICE_READER_UNAVAILABLE');
    if (result.id !== id || result.conversationKey !== key) throw Error('VOICE_CONVERSATION_MISMATCH');
    if (result.mime !== (format === 'wav' ? 'audio/wav' : 'audio/silk') || result.filename !== 'voice.'+format || !Number.isFinite(result.durationSeconds) || result.durationSeconds <= 0 || result.durationSeconds > 60 || typeof result.b64 !== 'string') throw Error('VOICE_AUDIO_INVALID');
    const bytes = Buffer.from(result.b64, 'base64');
    if (!bytes.length || bytes.length > 2*1024*1024 || bytes.toString('base64') !== result.b64 || crypto.createHash('sha256').update(bytes).digest('hex') !== result.sha256) throw Error('VOICE_INTEGRITY_FAILED');
    return {id, mime: result.mime, filename: result.filename, b64: result.b64, durationSeconds: result.durationSeconds, sampleRate: format === 'wav' ? 16000 : 0};
  };
}
