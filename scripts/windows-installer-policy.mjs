import path from 'node:path';

export const nsisString = value => String(value).replaceAll('$', () => '$$').replaceAll('"', () => '$\\"');
export function removalInclude(relativeFiles) {
  const files = relativeFiles.map(file => {
    const normalized = String(file).replaceAll('\\', '/');
    if (!normalized || normalized.startsWith('/') || normalized.split('/').some(part => !part || part === '.' || part === '..') || /[\r\n:"\0]/.test(normalized)) throw Error('Unsafe installer file path: ' + file);
    if (/^(?:storage\.ini|data(?:\/|$))/i.test(normalized)) throw Error('User data must never enter the installer file manifest.');
    return normalized;
  });
  const directories = new Set();
  for (const file of files) {
    let directory = path.posix.dirname(file);
    while (directory !== '.') { directories.add(directory); directory = path.posix.dirname(directory); }
  }
  return [
    '# Generated from the audited app payload. Do not recursively remove the install directory.',
    '!macro customRemoveFiles',
    ...files.map(file => `  Delete "$INSTDIR\\${nsisString(file.replaceAll('/', '\\'))}"`),
    ...[...directories].sort((a,b) => b.split('/').length - a.split('/').length).map(dir => `  RMDir "$INSTDIR\\${nsisString(dir.replaceAll('/', '\\'))}"`),
    '  Delete "$INSTDIR\\${UNINSTALL_FILENAME}"',
    '  RMDir "$INSTDIR"',
    '!macroend', '',
  ].join('\n');
}
