import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const BEHAVIOR_POLICY = 'local-config-only-v1';
export const MAX_PERSONA_BYTES = 60000;
export const MAX_RPC_BYTES = 256 * 1024;

/** Read the owner-generated snapshot; request text and metadata are not authority. */
export function localPersona(root, key) {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'state/bridge-config.json'), 'utf8').replace(/^\uFEFF/, ''));
  const selected = config.roles?.[key];
  const persona = selected && typeof selected === 'object' && typeof selected.persona === 'string' ? selected.persona : config.role;
  const personaName = selected && typeof selected === 'object' && typeof selected.name === 'string' ? selected.name : config.persona_name;
  if (typeof persona !== 'string' || !persona.trim() || persona.includes('\0') || Buffer.byteLength(persona,'utf8') > MAX_PERSONA_BYTES || typeof personaName !== 'string' || !personaName.trim()) throw new Error('LOCAL_PERSONA_CONFIG_REQUIRED');
  return { persona, personaName };
}

export function assertLocalPersona(body, locked) {
  if ((body.persona !== undefined && body.persona !== locked.persona) || (body.personaName !== undefined && body.personaName !== locked.personaName) || (body.personaDigest !== undefined && body.personaDigest !== crypto.createHash('sha256').update(locked.persona).digest('hex'))) throw new Error('BEHAVIOR_CHANGE_NOT_ALLOWED');
}
