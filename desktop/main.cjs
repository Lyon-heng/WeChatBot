const { app, BrowserWindow, Menu, Tray, nativeImage, nativeTheme, dialog, ipcMain, screen, shell, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { projectDirectory, safeNavigation, externalWebUrl, windowPlacement } = require('./desktop-policy.cjs');
const { bootstrapDeployment } = require('./deployment.cjs');
const { createAppearanceStore, strengthOf } = require('./appearance.cjs');
const {createShutdownController}=require('./shutdown.cjs');
const { spawn: spawnChild } = require('node:child_process');
const {resolveStorageLocation,migrationPlan,retainDsh,deploymentStorageOptions,prepareDataHome,rebindExternalDsh,stopLegacyServices}=require('./storage-location.cjs');

app.setName('WeChatBot');
app.setAppUserModelId('local.wechatbot.desktop');
// RDP / mixed-DPI guard: when the session's DPI or resolution changes behind
// our back, Windows can place the window at a physical size that disagrees
// with Chromium's scale factor. The renderer then maps real mouse clicks to
// the wrong element (the three window keys become dead), while CDP-injected
// events still work — which hides the bug from automated tests. Forcing a
// 1:1 device scale factor keeps layout, visuals and hit-testing aligned.
app.commandLine.appendSwitch('force-device-scale-factor', '1');
// RDP rendering guard: with GPU-accelerated compositing in a remote session,
// Chromium's occlusion tracker can mark a fully-visible window as hidden, and
// the desktop keeps showing stale frames after minimize/maximize — the window
// "stops reacting" to the three keys even though every action runs. Software
// rendering avoids both the desync and the stale-frame updates.
app.disableHardwareAcceleration();
const installedDistribution = app.isPackaged && fs.existsSync(path.join(process.resourcesPath, 'project', 'deployment.json'));
const legacyHome=path.join(app.getPath('appData'),'wechatwb-legacy');
let storage=null,storageFailure=null;
try{if(installedDistribution)storage=resolveStorageLocation({appDir:path.dirname(process.resourcesPath),legacyHome,override:process.env.WECHATAGENT_TEST_DATA_HOME});}catch(error){storageFailure=error;}
const deploymentHome = storage?.dataHome || process.env.WECHATAGENT_TEST_DATA_HOME || legacyHome;
let deployment = null;
const root = installedDistribution ? path.join(deploymentHome, 'workspace') : projectDirectory(process.resourcesPath, __dirname, app.isPackaged);
let dataDirectory = installedDistribution ? path.join(deploymentHome,'desktop') : path.join(root, 'state', 'desktop');
try{if(storageFailure)throw storageFailure;fs.mkdirSync(dataDirectory,{recursive:true});}catch(error){storageFailure=Error('无法使用所选数据位置，请确认磁盘已连接且目录可写。\n'+error.message);dataDirectory=path.join(require('node:os').tmpdir(),'wechatbot-startup-'+process.pid);fs.mkdirSync(dataDirectory,{recursive:true});}
app.setPath('userData', dataDirectory);
app.setPath('sessionData', path.join(dataDirectory, 'session'));
const preferenceFile = path.join(dataDirectory, 'window.json');
let preferences = {};
try { preferences = JSON.parse(fs.readFileSync(preferenceFile, 'utf8')); } catch {}
nativeTheme.themeSource = preferences.theme === 'dark' ? 'dark' : 'light';
const appearanceStore = createAppearanceStore(dataDirectory, nativeImage);
let window, tray, consoleApp, origin; let quitting = false, quitApproved=false, quitCheck=null, restartRequested=false;
const savePreferences = () => {
  const temp = preferenceFile + '.tmp'; fs.writeFileSync(temp, JSON.stringify(preferences, null, 2)); fs.renameSync(temp, preferenceFile);
};
const bringForward = () => { if (window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } };
function queryUnsavedChanges() {
  if(!window||window.isDestroyed()||window.webContents.isDestroyed())return Promise.resolve(false);
  return new Promise(resolve=>{
    const id=require('node:crypto').randomUUID();
    const answer=value=>{if(quitCheck?.id!==id)return;clearTimeout(quitCheck.timer);quitCheck=null;resolve(value);};
    quitCheck={id,answer,timer:setTimeout(()=>answer(true),2000)};
    try{window.webContents.send('desktop:check-unsaved',id);}catch{answer(true);}
  });
}
const shutdown=createShutdownController({
  confirm:async()=>{
    if(await queryUnsavedChanges()){
      const response=dialog.showMessageBoxSync(window,{type:'question',title:'有未保存的设置',message:'退出会放弃未保存的更改，并停止本实例的后台服务。',buttons:['继续编辑','放弃更改并退出'],defaultId:0,cancelId:0});
      if(response!==1)return false;
    }
    quitApproved=true;return true;
  },
  stop:async()=>{if(consoleApp)await consoleApp.shutdown();},
  finish:()=>{quitting=true;if(restartRequested)app.relaunch();app.quit();},
  onState:state=>{
    if(window&&!window.isDestroyed()&&!window.webContents.isDestroyed())window.webContents.send('desktop:shutdown-state',state);
    if(tray&&!tray.isDestroyed())tray.setToolTip(state==='stopping'?'WeChatBot · 正在停止后台服务':'WeChatBot');
  },
  onError:error=>{quitApproved=false;quitting=false;bringForward();dialog.showErrorBox('退出未完成',error.message+'\n程序已保留，请检查运行日志后重试。');},
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', bringForward);
  app.on('activate', bringForward);
  Menu.setApplicationMenu(null);
  app.whenReady().then(async () => {
    if(storageFailure)throw storageFailure;
    let loadingWindow;
    if (installedDistribution) {
      loadingWindow = new BrowserWindow({ width:480, height:280, resizable:false, title:'WeChatBot', icon:path.join(__dirname,'icon.png'), backgroundColor:preferences.theme==='dark'?'#161c19':'#f3f5f4', webPreferences:{preload:path.join(__dirname,'loading-preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false} });
      loadingWindow.setMenu(null);
      await loadingWindow.loadFile(path.join(__dirname,'loading.html'));
      const progress=message=>{if(!loadingWindow.isDestroyed())loadingWindow.webContents.send('deployment:progress',message);};
      let plan=migrationPlan(storage);
      if(plan.needed){
        const answer=dialog.showMessageBoxSync(loadingWindow,{type:'question',title:'迁移已有数据',message:'发现可迁移的已有数据',detail:'从：'+plan.source+'\n到：'+plan.dataHome+'\n\n会停止旧实例管理的后台服务，再复制并校验配置、人设、表情包和会话状态，保留旧副本。请先退出旧版窗口和匹配微信。\n\n选择“保留旧 DSH”会跳过 DSH 数据迁移，保留其原位置、会话、附件和配置并继续启动；启动后需在 DSH 中手动重新添加新版插件目录。选择完整迁移时，请先从托盘退出 DSH。',buttons:['停止旧服务并迁移','保留旧 DSH','暂不启动'],defaultId:1,cancelId:2});
        if(answer!==0&&answer!==1){quitting=true;app.quit();return;}
        if(answer===1)plan=retainDsh(plan);
        progress('正在停止旧实例管理的后台服务…');await stopLegacyServices(plan,process.resourcesPath);
      }
      let migrated;
      try{migrated=await prepareDataHome(plan,{progress});}catch(error){
        if(error.code!=='DSH_EXTERNAL_LINK'||plan.dshRetained)throw error;
        const answer=dialog.showMessageBoxSync(loadingWindow,{type:'warning',title:'保留旧 DSH 数据',message:'旧 DSH 包含外部链接，无法自动迁移',detail:error.message+'\n\n可保留旧 DSH 原位置，仅迁移 WeChatBot 的数据并继续启动。不会复制、删除或修改旧 DSH 数据；启动后需手动重新添加新版插件目录。',buttons:['保留旧 DSH 并继续','暂不启动'],defaultId:0,cancelId:1});
        if(answer!==0){quitting=true;app.quit();return;}
        plan=retainDsh(plan);migrated=await prepareDataHome(plan,{progress});
      }
      deployment = await bootstrapDeployment(process.resourcesPath, deploymentHome, progress, deploymentStorageOptions(migrated.report,deploymentHome));
      await rebindExternalDsh(migrated.report,root,deploymentHome);
      try{preferences=fs.existsSync(preferenceFile)?JSON.parse(fs.readFileSync(preferenceFile,'utf8')):{};}catch{preferences={};}
    }
    const runtimeNode = deployment?.node ?? (app.isPackaged ? path.join(process.resourcesPath, '..', 'runtime', 'node.exe') : process.env.WECHATAGENT_NODE_EXECUTABLE);
    if (!runtimeNode || !fs.existsSync(runtimeNode)) throw new Error('找不到桌面应用的 Node.js 运行环境，请重新构建应用。');
    process.env.PATH = path.dirname(runtimeNode) + path.delimiter + (process.env.PATH ?? '');
    delete process.env.ELECTRON_RUN_AS_NODE;
    delete process.env.PSModulePath;
    const { createConsole } = await import(pathToFileURL(path.join(root, 'scripts/console-server.mjs')).href);
    const officialMusicLogin = require(path.join(root,'scripts/netease-login-window.cjs'))({BrowserWindow,session});
    if (deployment) {
      const { prepare } = await import(pathToFileURL(path.join(root, 'scripts/project-config.mjs')).href);
      prepare(root);
    }
    consoleApp = createConsole({ root, port: 0, nodeExecutable: runtimeNode, officialLogin:officialMusicLogin,
      onQuit: () => app.quit(),
      filePicker: async kind => {
        const result = await dialog.showOpenDialog(window, { title: kind === 'zip' ? '选择 WeChatBot 语音组件 ZIP 包' : kind === 'workspace' ? '选择工作区目录' : kind === 'folder' ? '选择微信数据库目录' : '选择程序', properties: ['folder','workspace'].includes(kind) ? ['openDirectory'] : ['openFile'], ...(kind === 'zip' ? { filters: [{ name: '语音组件包', extensions: ['zip'] }] } : kind === 'exe' ? { filters: [{ name: '程序', extensions: ['exe'] }] } : {}) });
        return result.canceled ? '' : result.filePaths[0];
      },
    });
    const address = await consoleApp.start(); origin = `http://127.0.0.1:${address.port}`;
    fs.writeFileSync(path.join(dataDirectory, 'runtime.json'), JSON.stringify({ pid: process.pid, port: address.port, root, startedAt: Date.now() }, null, 2));
    const theme = preferences.theme === 'dark' ? 'dark' : 'light';
    const iconPath = path.join(__dirname, 'icon.png');
    const iconImage = nativeImage.createFromPath(iconPath);
    const savedBounds = preferences.bounds;
    const area = savedBounds && Number.isFinite(savedBounds.x) && Number.isFinite(savedBounds.y) ? screen.getDisplayNearestPoint({ x: savedBounds.x, y: savedBounds.y }).workArea : screen.getPrimaryDisplay().workArea;
    window = new BrowserWindow({ ...windowPlacement(savedBounds, area), minWidth: Math.min(900, area.width), minHeight: Math.min(620, area.height), title: 'WeChatBot', icon: iconPath, show: false,
      // No titleBarOverlay: on Windows that would paint a solid native caption
      // strip over the redesigned topbar. The console draws its own window
      // controls so they follow the active skin (telemetry / glass / print).
      titleBarStyle: 'hidden',
      backgroundColor: theme === 'dark' ? '#161c19' : '#f3f5f4',
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, devTools: false, spellcheck: false },
    });
    const trusted = event => event.sender === window.webContents && safeNavigation(event.senderFrame?.url ?? '', origin);
    const sendWindowState = () => { if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('desktop:window-state', { maximized: window.isMaximized() }); };
    window.on('maximize', sendWindowState);
    window.on('unmaximize', sendWindowState);

    // Safety net for the self-drawn window keys. The renderer's own click
    // handlers (verified end-to-end through preload -> IPC -> BrowserWindow)
    // are the primary path; this one only matters if a future skin ever
    // re-introduces a drag region that swallows those clicks.
    // Geometry is read from the live DOM via executeJavaScript, which works
    // under this app's CSP. When it is unavailable we do nothing at all, so a
    // stale or wrongly-scaled rectangle can never dispatch the wrong action.
    let controlRects = [];
    const refreshControlRects = async () => {
      if (window.isDestroyed() || window.webContents.isDestroyed()) return;
      try {
        const raw = await window.webContents.executeJavaScript(
          `JSON.stringify([...document.querySelectorAll('[data-window-action]')].map(b=>{const r=b.getBoundingClientRect();return {a:b.dataset.windowAction,x0:r.left,y0:r.top,x1:r.right,y1:r.bottom}}))`
        );
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length) {
          controlRects = parsed.filter(r => r && ['minimize', 'maximize', 'close'].includes(r.a) && [r.x0, r.x1, r.y0, r.y1].every(Number.isFinite));
        }
      } catch {}
    };
    const nativeWindowAction = action => {
      if (window.isDestroyed()) return;
      if (action === 'minimize') window.minimize();
      else if (action === 'maximize') { if (window.isMaximized()) window.unmaximize(); else window.maximize(); }
      else if (action === 'close') window.close();
      sendWindowState();
    };
    window.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'mouseDown') return;
      if (input.button !== 'left' && input.button !== 0 && input.button != null) return;
      const x = Number(input.x), y = Number(input.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const hit = controlRects.find(r => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1);
      if (!hit) return;
      event.preventDefault();
      nativeWindowAction(hit.a);
    });
    window.webContents.on('did-finish-load', () => { void refreshControlRects(); sendWindowState(); });
    window.webContents.on('did-navigate-in-page', () => { void refreshControlRects(); });
    let rectTimer = null;
    window.on('resize', () => { clearTimeout(rectTimer); rectTimer = setTimeout(() => { void refreshControlRects(); }, 150); });
    ipcMain.on('desktop:window-controls-refresh', event => { if (event.sender === window.webContents) void refreshControlRects(); });
    const restartApplication=async()=>{if(consoleApp?.isBusy())throw Error('请等待当前操作完成后再重启程序。');restartRequested=true;const ok=await shutdown.request();if(!ok)restartRequested=false;return ok;};
    const serviceAction=action=>{bringForward();window.webContents.send('desktop:service-action',action);};
    ipcMain.handle('desktop:restart-app',event=>{if(!trusted(event))throw Error('不允许此窗口重启程序。');return restartApplication();});
    ipcMain.handle('desktop:reveal-song',async(event,payload)=>{
      if(!trusted(event)||!payload||!['rendered-song','vocal-source'].includes(payload.kind)||typeof payload.id!=='string'||!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(payload.id))throw Error('请选择当前曲库中的歌曲。');
      const {VoiceJobs}=await import(pathToFileURL(path.join(root,'packages/voice-studio/jobs.mjs')).href);
      const item=new VoiceJobs(root).songs().find(song=>song.id===payload.id&&song.kind===payload.kind);if(!item)throw Error('歌曲已变化，请刷新曲库。');
      let folder=path.join(root,'state/voice/songs');if(item.kind==='rendered-song'){const {SavedSongs}=await import(pathToFileURL(path.join(root,'packages/voice-studio/saved-songs.mjs')).href);folder=new SavedSongs(root).folder();}
      const file=path.join(folder,item.id+'.wav');const actual=fs.realpathSync(file),base=path.resolve(root,'state/voice')+path.sep;if(!actual.toLowerCase().startsWith(base.toLowerCase())||!fs.statSync(actual).isFile())throw Error('歌曲文件位置异常。');shell.showItemInFolder(actual);return {ok:true};
    });
    ipcMain.on('desktop:unsaved-answer',(event,id,value)=>{if(trusted(event)&&quitCheck?.id===id&&typeof value==='boolean')quitCheck.answer(value);});
    ipcMain.on('desktop:initial', event => { event.returnValue = event.sender === window.webContents ? { theme: preferences.theme ?? theme, appearance:appearanceStore.read(preferences.appearance), colors:preferences.colors, maximized: window.isMaximized() || preferences.maximized === true } : {}; });
    const runWindowAction = (event, action) => {
      if (event.sender !== window.webContents) throw new Error('不允许此窗口执行窗口操作。');
      if (window.isDestroyed()) return false;
      if (action === 'minimize' || action === 'maximize') {
        // Electron's minimize()/maximize() execute WM_SYSCOMMAND through the
        // views widget, which silently no-ops in mixed-DPI RDP sessions (the
        // three window keys look dead). A plain external ShowWindow always
        // works, so route those two actions through the native helper and
        // keep the Electron call only as a fallback.
        let handled = false;
        try {
          const helper = path.join(__dirname, 'winctl.exe');
          if (fs.existsSync(helper)) {
            const hwnd = window.getNativeWindowHandle().readBigUInt64LE(0);
            const child = spawnChild(helper, [String(hwnd), action === 'minimize' ? 'minimize' : 'maximize'], { windowsHide: true, stdio: 'ignore' });
            child.on('error', () => {});
            handled = true;
          }
        } catch {}
        if (!handled) {
          if (action === 'minimize') window.minimize();
          else { if (window.isMaximized()) window.unmaximize(); else window.maximize(); }
        }
              }
      else if (action === 'close') window.close();
      else throw new Error('窗口操作无效。');
      return true;
    };
    ipcMain.handle('desktop:window-action', runWindowAction);
    // Fire-and-forget twin: if invoke() is unavailable in the preload for any
    // reason, send() still reaches the main process and the keys keep working.
    ipcMain.on('desktop:window-action-sync', (event, action) => {
      try { runWindowAction(event, action); } catch {}
    });
    ipcMain.handle('desktop:voice-model-select',async event=>{if(!trusted(event))throw Error('不允许此窗口选择模型。');const result=await dialog.showOpenDialog(window,{title:'选择 Breeze TTS 2 兼容的本地 GGUF 模型',properties:['openFile'],filters:[{name:'GGUF 模型',extensions:['gguf']}]});return result.canceled?null:result.filePaths[0]??null;});
    ipcMain.handle('desktop:appearance-choose', async event => {
      if (!trusted(event)) throw new Error('不允许此窗口修改背景。');
      const result = await dialog.showOpenDialog(window,{title:'选择背景图片',properties:['openFile'],filters:[{name:'图片',extensions:['png','jpg','jpeg']}]});
      if(result.canceled || !result.filePaths[0])return {canceled:true};
      preferences.appearance = await appearanceStore.importFile(result.filePaths[0],preferences.appearance);
      savePreferences();return appearanceStore.read(preferences.appearance);
    });
    ipcMain.handle('desktop:appearance-strength',(event,value)=>{
      if(!trusted(event)||!Number.isFinite(value))throw new Error('背景强度无效。');
      preferences.appearance={...preferences.appearance,strength:strengthOf(value)};savePreferences();return {strength:preferences.appearance.strength};
    });
    ipcMain.handle('desktop:appearance-reset',event=>{
      if(!trusted(event))throw new Error('不允许此窗口修改背景。');
      appearanceStore.reset();delete preferences.appearance;savePreferences();return appearanceStore.read();
    });
    ipcMain.handle('desktop:colors', (event, value) => {
      if (!trusted(event) || !value || !['accent','background'].every(key => typeof value[key] === 'string' && /^#[0-9a-f]{6}$/i.test(value[key]))) throw new Error('配色无效。');
      const previous = preferences.colors;
      preferences.colors = { accent: value.accent.toLowerCase(), background: value.background.toLowerCase() };
      try { savePreferences(); } catch (error) { preferences.colors = previous; throw error; }
      return preferences.colors;
    });
    ipcMain.handle('desktop:theme', (event, value) => {
      if (!trusted(event) || !['light', 'dark'].includes(value)) return;
      preferences.theme = value; savePreferences();
      nativeTheme.themeSource = value;
      window.setBackgroundColor(value === 'dark' ? '#161c19' : '#f3f5f4');
      // Window controls are rendered by the console CSS, which follows the
      // active skin; no native overlay needs to be repainted here.
    });
    ipcMain.handle('desktop:export-log', async (event, payload) => {
      if (!trusted(event) || typeof payload?.text !== 'string' || payload.text.length > 250000) throw new Error('日志内容无效。');
      const name = typeof payload.name === 'string' && /^[a-zA-Z0-9._-]+\.log$/.test(payload.name) ? payload.name : 'wechatagent.log';
      const result = await dialog.showSaveDialog(window, { title: '保存运行日志', defaultPath: path.join(app.getPath('documents'), name), filters: [{ name: '日志文件', extensions: ['log', 'txt'] }] });
      if (result.canceled) return { saved: false };
      await fs.promises.writeFile(result.filePath, payload.text, 'utf8'); return { saved: true };
    });
    ipcMain.handle('desktop:plugin-path', event => {
      if (!trusted(event)) return;
      require('electron').clipboard.writeText(path.join(root, 'packages', 'dsh-social-bridge-plugin'));
    });
    ipcMain.handle('desktop:plugin-folder', event => {
      if (!trusted(event)) return;
      return require('electron').shell.openPath(path.join(root, 'packages', 'dsh-social-bridge-plugin'));
    });
    const openExternal = async target => {
      const url = externalWebUrl(target);
      if (!url) throw new Error('只允许打开公开的 HTTP(S) 网页链接。');
      await shell.openExternal(url);
      return { opened:true };
    };
    ipcMain.handle('desktop:open-external', (event, target) => {
      if (!trusted(event)) throw new Error('不允许此窗口打开外部链接。');
      return openExternal(target);
    });
    const navigationExternal = target => { if (externalWebUrl(target)) openExternal(target).catch(error => dialog.showErrorBox('无法打开链接',error.message)); };
    window.webContents.setWindowOpenHandler(({url}) => { navigationExternal(url); return { action:'deny' }; });
    window.webContents.on('will-navigate', (event, target) => {
      if (!safeNavigation(target, origin)) { event.preventDefault(); navigationExternal(target); }
    });
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.webContents.session.setPermissionCheckHandler(() => false);
    window.webContents.on('will-prevent-unload', event => {
      if(quitApproved&&shutdown.finished){event.preventDefault();return;}
      const response = dialog.showMessageBoxSync(window, { type: 'question', title: '有未保存的设置', message: '退出会放弃未保存的更改。', buttons: ['继续编辑', '放弃更改并退出'], defaultId: 0, cancelId: 0 });
      if (response === 1) event.preventDefault(); else quitting = false;
    });
    window.on('close', event => {
      if (!quitting) { event.preventDefault(); window.hide(); return; }
      if (!window.isMaximized()) preferences.bounds = window.getBounds();
      preferences.maximized = window.isMaximized(); savePreferences();
    });
    window.once('ready-to-show', () => { if (preferences.maximized) window.maximize(); window.show(); if (loadingWindow && !loadingWindow.isDestroyed()) loadingWindow.destroy(); });
    window.webContents.on('page-title-updated', event => { event.preventDefault(); window.setTitle('WeChatBot'); });
    tray = new Tray(iconImage.resize({ width: 20, height: 20 }));
    tray.setToolTip('WeChatBot');
    tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开 WeChatBot', click: bringForward }, { type: 'separator' }, {label:'一键启动',click:()=>serviceAction('start')},{label:'重启服务',click:()=>serviceAction('restart')},{label:'重启程序',click:()=>restartApplication().catch(error=>dialog.showErrorBox('暂时无法重启',error.message))},{type:'separator'}, { label: '退出应用', click: () => app.quit() }]));
    tray.on('double-click', bringForward); tray.on('click', bringForward);
    await window.loadURL(origin + '/');
  }).catch(error => {
    dialog.showErrorBox('WeChatBot 启动失败', error.message); quitting = true; app.quit();
  });
  app.on('before-quit', event => {
    if(shutdown.finished||!consoleApp){quitting=true;return;}
    event.preventDefault();quitting=false;
    if(shutdown.running)return;
    if (consoleApp?.isBusy()) {
      event.preventDefault(); quitting = false; bringForward();
      dialog.showMessageBox(window, { type: 'info', title: '操作正在进行', message: '请等待当前操作完成后再退出应用。', buttons: ['知道了'] });
      return;
    }
    void shutdown.request();
  });
  app.on('will-quit', () => {
    if (tray) tray.destroy(); consoleApp?.close();
    const runtimeFile=path.join(dataDirectory,'runtime.json');
    try{if(JSON.parse(fs.readFileSync(runtimeFile,'utf8')).pid===process.pid)fs.unlinkSync(runtimeFile);}catch{}
  });
}
