import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { singleDirectoryTemplate } from './installer-directory-page.mjs';
import { removalInclude, nsisString } from './windows-installer-policy.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [payloadArgument, outputArgument, version, listArgument, mode] = process.argv.slice(2);
if (!payloadArgument || !outputArgument || !/^\d+\.\d+\.\d+$/.test(version ?? '') || !listArgument || (mode && mode !== '--test')) throw Error('Usage: node build-windows-installer.mjs payload output version audited-file-list.json [--test]');
const payload = fs.realpathSync(payloadArgument), output = path.resolve(outputArgument);
const require = createRequire(path.join(process.env.WECHATBOT_BUILDER_HOME || path.join(root, 'packaging/windows'), 'package.json'));
const builderVersion = require('electron-builder/package.json').version;
if (builderVersion !== '26.15.3') throw Error('Install the locked Windows packaging dependencies (electron-builder 26.15.3).');
const { build, Platform, Arch } = require('electron-builder');
const test = mode === '--test';
const buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wechatbot-nsis-'));
const app = path.join(buildRoot, 'payload');
fs.mkdirSync(app);
// Only audited files enter the installer. Never pass a live app/data tree to builder.
const list = JSON.parse(fs.readFileSync(listArgument, 'utf8').replace(/^\uFEFF/, ''));
const files = list.filter(file => file.startsWith('app/')).map(file => file.slice(4));
const removal = removalInclude([...new Set([...files,'uninstallerIcon.ico'])]);
for (const relative of files) {
  const destination = path.join(app, relative);
  fs.mkdirSync(path.dirname(destination), { recursive:true });
  fs.copyFileSync(path.join(payload, 'app', relative), destination);
}
const helper = path.join(payload, 'WeChatBot.exe');
if (!fs.existsSync(helper)) throw Error('Build the native GUI launcher first.');
const templatesSource = path.join(path.dirname(require.resolve('app-builder-lib/package.json')), 'templates/nsis');
const templates = path.join(buildRoot, 'templates');
fs.cpSync(templatesSource, templates, { recursive:true });
const assisted = path.join(templates, 'assistedInstaller.nsh');
fs.writeFileSync(assisted, singleDirectoryTemplate(fs.readFileSync(assisted, 'utf8')));
require('app-builder-lib/out/targets/nsis/nsisUtil').nsisTemplatesDir = templates;
const removeFile = path.join(buildRoot, 'owned-files.nsh');
fs.writeFileSync(removeFile, removal);
const include = path.join(buildRoot, 'installer.nsh');
const license = path.join(buildRoot, 'license.txt');
// NSIS must see a BOM to decode Chinese license text rather than the system ANSI code page.
fs.writeFileSync(license, '\uFEFF' + ['LICENSE-LYON-HENG.md','LICENSE','LICENSES.md'].map(name=>fs.readFileSync(path.join(root,name),'utf8').replace(/^\uFEFF/,'')).join('\r\n\r\n'));
let storage = fs.readFileSync(path.join(root, 'packaging/windows/installer-storage.nsh'), 'utf8');
if (test) storage = storage.replaceAll('Software\\WeChatAgent', 'Software\\WeChatBot-Installer-Test-Legacy')
  .replaceAll('Software\\WeChatBot"', 'Software\\WeChatBot-Installer-Test"')
  .replaceAll('Uninstall\\WeChatBot"', 'Uninstall\\WeChatBot-Installer-Test-Legacy"')
  .replaceAll('Uninstall\\WeChatAgent"', 'Uninstall\\WeChatBot-Installer-Test-Legacy2"');
fs.writeFileSync(include, `!define WCG_HELPER "${nsisString(helper)}"\n!define WCG_REMOVE_FILES "${nsisString(removeFile)}"\n${storage}`);
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
// Match the upstream build's fast NSIS compression default; maintainers can override it.
process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL ??= '1';
try {
  await build({prepackaged:app, targets:Platform.WINDOWS.createTarget('nsis', Arch.x64), config:{
    appId:test ? 'local.wechatbot.installer-test' : 'local.wechatbot.desktop',
    productName:test ? 'WeChatBot Installer Test' : 'WeChatBot',
    executableName:'WeChatBot',
    artifactName:`WeChatBot-Setup-${version}-x64.exe`,
    directories:{app:path.join(payload, 'app/resources/app'), output, buildResources:path.join(root, 'desktop')},
    electronVersion:'41.1.1', asar:false, npmRebuild:false,
    win:{icon:path.join(root, 'desktop/icon.ico'),signAndEditExecutable:false,requestedExecutionLevel:'asInvoker'},
    nsis:{include,oneClick:false,perMachine:false,allowElevation:false,allowToChangeInstallationDirectory:true,
      createDesktopShortcut:!test,createStartMenuShortcut:!test,deleteAppDataOnUninstall:false,packElevateHelper:false,
      differentialPackage:false,runAfterFinish:!test,installerLanguages:['zh_CN','en_US'],language:'2052',
      installerIcon:path.join(root,'desktop/icon.ico'),uninstallerIcon:path.join(root,'desktop/icon.ico'),
      license,warningsAsErrors:true},
    compression:'normal',publish:null,
  }});
  fs.copyFileSync(removeFile,path.join(output,'INSTALLER-OWNED-FILES.nsh'));
} finally {
  // This unique temporary directory was created above; never delete payload or output.
  if (buildRoot.startsWith(path.join(os.tmpdir(), 'wechatbot-nsis-'))) fs.rmSync(buildRoot,{recursive:true,force:true});
}
