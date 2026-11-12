"""Optional bounded SILK-to-WAV conversion, with no recognition model or network."""
import base64
import io
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import wave

ROOT = pathlib.Path(__file__).resolve().parent.parent


def wasm_command():
    script = ROOT/'scripts/decode-wechat-voice.mjs'
    if not script.is_file() or not (ROOT/'packages/voice-codec/silk-wasm/lib/silk.wasm').is_file():
        return None
    candidates = []
    try:
        distribution = json.loads((ROOT/'config/distribution.json').read_text(encoding='utf-8-sig'))
        candidates.append(distribution.get('node'))
    except (OSError, ValueError):
        pass
    candidates.extend([str(pathlib.Path(sys.executable).parent.parent/'node.exe'), shutil.which('node')])
    for candidate in candidates:
        if candidate and pathlib.Path(candidate).is_absolute() and pathlib.Path(candidate).is_file():
            return [candidate, '--max-old-space-size=128', str(script)]
    return None


def run_wasm(command, blob=None):
    try:
        process = subprocess.run(command + (['--probe'] if blob is None else []),
                                 input='' if blob is None else json.dumps({'b64': base64.b64encode(blob).decode('ascii')}),
                                 text=True, encoding='utf-8', capture_output=True, timeout=5,
                                 creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    except subprocess.TimeoutExpired:
        raise RuntimeError('VOICE_DECODE_TIMEOUT') from None
    if len(process.stdout) > 3*1024*1024:
        raise RuntimeError('VOICE_DECODE_LIMIT')
    if process.returncode:
        try:
            code = json.loads(process.stderr.strip().splitlines()[-1]).get('error', '')
        except (ValueError, IndexError):
            code = ''
        raise RuntimeError(code if code in ('VOICE_DECODER_MISSING', 'VOICE_FORMAT_UNSUPPORTED', 'VOICE_DECODE_LIMIT') else 'VOICE_DECODE_FAILED')
    return json.loads(process.stdout)


def probe():
    command = wasm_command()
    if command:
        return run_wasm(command)
    try:
        import pilk
        ready = callable(getattr(pilk, 'silk_to_wav', None))
    except (ImportError, OSError):
        ready = False
    return {'decoder': ready, 'backend': 'pilk' if ready else None}


def decode(blob):
    if len(blob) > 2*1024*1024:
        raise RuntimeError('VOICE_DECODE_LIMIT')
    if not (blob.startswith(b'#!SILK_V3') or blob.startswith(b'\x02#!SILK_V3')):
        raise RuntimeError('VOICE_FORMAT_UNSUPPORTED')
    command = wasm_command()
    if command:
        result = run_wasm(command, blob)
        data = base64.b64decode(result['b64'], validate=True)
        return wav_result(data)
    try:
        import pilk
    except (ImportError, OSError):
        raise RuntimeError('VOICE_DECODER_MISSING') from None
    with tempfile.TemporaryDirectory(prefix='wechatagent-voice-') as temp:
        source, target = pathlib.Path(temp)/'input.silk', pathlib.Path(temp)/'output.wav'
        source.write_bytes(blob)
        pilk.silk_to_wav(str(source), str(target), rate=16000)
        if not target.is_file() or target.stat().st_size > 2*1024*1024:
            raise RuntimeError('VOICE_DECODE_LIMIT')
        data = target.read_bytes()
    return wav_result(data)


def wav_result(data):
    if len(data) > 2*1024*1024:
        raise RuntimeError('VOICE_DECODE_LIMIT')
    with wave.open(io.BytesIO(data), 'rb') as audio:
        duration = audio.getnframes()/audio.getframerate()
        if audio.getnchannels() != 1 or audio.getframerate() != 16000 or audio.getsampwidth() != 2 or not 0 < duration <= 60.5:
            raise RuntimeError('VOICE_DECODE_LIMIT')
    return {'b64': base64.b64encode(data).decode('ascii'), 'durationSeconds': min(duration, 60), 'sampleRate': 16000}


if __name__ == '__main__':
    try:
        if sys.argv[1:] == ['--probe']:
            print(json.dumps(probe()))
            sys.exit(0)
        raw = sys.stdin.buffer.read(3*1024*1024+1)
        if len(raw) > 3*1024*1024:
            raise RuntimeError('VOICE_DECODE_LIMIT')
        result = decode(base64.b64decode(json.loads(raw)['b64'], validate=True))
        print(json.dumps(result))
    except Exception as error:
        code = str(error) if str(error).startswith('VOICE_') else 'VOICE_DECODE_FAILED'
        print(json.dumps({'error': code}), file=sys.stderr)
        sys.exit(1)
