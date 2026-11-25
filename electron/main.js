'use strict';

const { app, BrowserWindow, dialog, ipcMain, Menu, Tray, nativeImage, shell, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');

const selftest = process.argv.includes('--selftest');
const debug = process.env.SILLYCAT_DEBUG === '1';
const indexPath = app.isPackaged
  ? path.join(process.resourcesPath, 'prototype', 'index.html')
  : path.join(__dirname, '..', 'prototype', 'index.html');
const indexURL = pathToFileURL(indexPath).href;
const iconPath = app.isPackaged
  ? path.join(process.resourcesPath, 'tray.png')
  : path.join(__dirname, '..', 'src-tauri', 'icons', '32x32.png');
const border = 'html::after{content:"";position:fixed;inset:0;pointer-events:none;z-index:2147483647;outline:2px solid #ff00ff;outline-offset:-2px;box-shadow:inset 0 0 0 4px rgba(0,255,255,.55)}';
let userData, win, hook, out, watchdog, debugKey;
let loaded = false, started = false, failed = false, reported = false;
const results = [], consoleErrors = [];

const RUN_LOG_NAME = 'SillyCatDemo-run.log';
const BOM = Buffer.from([0xEF, 0xBB, 0xBF]);
let runLog;

// 运行日志放桌面，方便测试者找到并发回。app.getPath('desktop') 会跟随系统的桌面重定向（OneDrive、自定义路径等），
// 不要手拼 %USERPROFILE%\Desktop。桌面写不了（无权限、目录不存在）就退回 fallbackDir（userData），note 里写明原因。
function pickRunLog(desktopDir, fallbackDir) {
  const attempt = (dir) => {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, RUN_LOG_NAME);
    fs.closeSync(fs.openSync(file, 'a'));
    return file;
  };
  let failure;
  try {
    if (!desktopDir) throw new Error('取不到桌面路径');
    return { file: attempt(desktopDir), fellBack: false, note: '' };
  } catch (e) { failure = e; }
  const note = '桌面写不了（' + (failure.code || failure.message) + '），日志改存到 ' + fallbackDir;
  try { return { file: attempt(fallbackDir), fellBack: true, note }; }
  catch (e) { return { file: null, fellBack: true, note: note + '，这里也写不了（' + (e.code || e.message) + '）' }; }
}

function currentRunLog() {
  if (runLog) return runLog;
  const fallbackDir = userData || os.tmpdir();
  if (selftest) {
    runLog = { file: path.join(fallbackDir, RUN_LOG_NAME), fellBack: false, note: '' }; // 自检不碰真实桌面
  } else {
    let desktop;
    try { desktop = app.getPath('desktop'); } catch (_) {}
    runLog = pickRunLog(desktop, fallbackDir);
  }
  return runLog;
}

// UTF-8 带 BOM（Win7 自带记事本靠 BOM 认 UTF-8，否则中文乱码）、CRLF 换行（旧记事本不认单独的 LF）。
// 超过 512KB 时保留尾部 256KB（重写时补回 BOM）。
function appendLogLine(file, text) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch (_) {}
  if (size > 512 * 1024) {
    const tail = fs.readFileSync(file).slice(-256 * 1024);
    fs.writeFileSync(file, Buffer.concat([BOM, tail.slice(tail.indexOf(10) + 1)]));
  } else if (size === 0) {
    fs.writeFileSync(file, BOM);
  }
  fs.appendFileSync(file, text.replace(/\r?\n/g, '\r\n') + '\r\n');
}

function log(level, message) {
  const line = new Date().toISOString() + ' [' + level + '] ' + message;
  try { console.log(line); } catch (_) {}
  try {
    const info = currentRunLog();
    if (info.file) appendLogLine(info.file, line);
  } catch (_) {}
}

function finishTest() {
  if (reported) return;
  reported = true;
  clearTimeout(watchdog);
  try {
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'selftest.json'), JSON.stringify(results, null, 2));
  } catch (e) { results.push({ name: '结果写盘', ok: false, detail: e.message }); }
  const ok = results.length > 0 && results.every(item => item.ok);
  console.log(JSON.stringify(results, null, 2));
  console.log('selftest output: ' + out);
  console.log(ok ? 'SELFTEST PASS' : 'SELFTEST FAIL');
  process.exitCode = ok ? 0 : 1;
  app.once('will-quit', () => app.exit(process.exitCode));
  app.quit();
}

function fatal(title, detail) {
  if (failed) return;
  failed = true;
  const info = currentRunLog();
  const ask = info.fellBack
    ? '桌面写不了日志，请到这里找 ' + (info.file || '（这次没能写出日志）') + ' 发回来（装过的话再加 SillyCatDemo-install.log）。'
    : '请把桌面上的 SillyCatDemo-run.log（装过的话再加桌面上的 SillyCatDemo-install.log）发回来。';
  const message = title + '\n' + detail + '\n日志：' + (info.file || '（没能写出）') +
    (info.fellBack ? '\n' + info.note : '') + '\n' + ask;
  log('FATAL', message.replace(/\n/g, ' '));
  if (selftest) {
    results.push({ name: title, ok: false, detail: String(detail) });
    finishTest();
  } else {
    try { dialog.showErrorBox(title, message); } finally { app.exit(1); }
  }
}

function send(name, payload) {
  if (loaded && win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send('silly:event', name, payload);
  }
}
function applyDebugCSS() { return win.webContents.insertCSS(border); }
function gpuStatus() {
  log('INFO', 'GPU feature status ' + JSON.stringify(app.getGPUFeatureStatus()));
}
function runtimeInfo() {
  const info = currentRunLog();
  log('INFO', '========== 新的一次启动 ==========');
  log('INFO', '运行日志 ' + (info.file || '(没能写出)'));
  if (info.fellBack) log('WARN', info.note);
  const v = process.versions;
  const cpus = os.cpus() || [];
  log('INFO', app.getName() + ' ' + app.getVersion() + ' Electron=' + v.electron +
    ' Chromium=' + v.chrome + ' Node=' + v.node + ' V8=' + v.v8);
  log('INFO', process.platform + '/' + process.arch + ' os.release=' + os.release() +
    ' os.version=' + (os.version ? os.version() : '') + ' os.arch=' + os.arch() +
    ' CPU=' + cpus[0]?.model + ' cores=' + cpus.length + ' memory=' + os.totalmem());
  log('INFO', 'isPackaged=' + app.isPackaged + ' resourcesPath=' + process.resourcesPath +
    ' userData=' + userData + ' argv=' + JSON.stringify(process.argv));
  for (const key of ['SILLYCAT_DEBUG', 'SILLYCAT_NO_FORWARD', 'SILLYCAT_DISABLE_GPU']) {
    log('INFO', key + '=' + (process.env[key] ?? '(unset)'));
  }
  log('INFO', 'setIgnoreMouseEvents forward=' + (process.env.SILLYCAT_NO_FORWARD !== '1'));
}

async function ready() {
  if (process.platform === 'darwin') app.dock.hide();
  gpuStatus();
  app.getGPUInfo('basic').then(info => log('INFO', 'GPU basic ' + JSON.stringify(info).slice(0, 6000)))
    .catch(e => log('WARN', 'GPU basic ' + e.message));
  log('INFO', 'displays ' + JSON.stringify(screen.getAllDisplays().map(
    ({ bounds, workArea, scaleFactor, internal }) => ({ bounds, workArea, scaleFactor, internal }))));
  if (!fs.existsSync(indexPath)) throw new Error('找不到猫页面 ' + indexPath);

  const { bounds, source } = initialBounds();
  win = new BrowserWindow({
    ...bounds, useContentSize: true, frame: false, transparent: true, backgroundColor: '#00000000',
    hasShadow: false, alwaysOnTop: true, skipTaskbar: true, resizable: false,
    maximizable: false, minimizable: false, fullscreenable: false, focusable: false, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false,
      sandbox: true, backgroundThrottling: false, spellcheck: false, devTools: debug || selftest
    }
  });
  win.on('move', schedulePosition);
  win.setAlwaysOnTop(true, 'screen-saver');
  log('INFO', 'window created ' + JSON.stringify({ bounds: win.getBounds(),
    contentBounds: win.getContentBounds(), visible: win.isVisible(), source }));
  const wc = win.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (event, url) => { if (url !== indexURL) event.preventDefault(); });
  wc.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (_, callback) => callback({ cancel: true }));
  wc.on('did-start-loading', () => { loaded = false; });
  wc.on('did-fail-load', (_, code, desc, url, mainFrame) => {
    log('ERROR', 'did-fail-load ' + code + ' ' + desc + ' ' + url);
    if (mainFrame) fatal('猫页面加载失败', code + ' ' + desc + ' ' + url);
  });
  wc.once('render-process-gone', (_, details) => fatal('猫页面进程已退出', JSON.stringify(details)));
  for (const event of ['unresponsive', 'responsive']) win.on(event, () => log('WARN', event));
  let messages = 0;
  wc.on('console-message', (_, level, message) => {
    if (level < 2 || messages >= 50 || message.includes('Electron Security Warning')) return; // 本地页面没有 CSP，这条警告是噪音
    messages++;
    if (level >= 3 && selftest) consoleErrors.push(message.slice(0, 300));
    log(level >= 3 ? 'ERROR' : 'WARN', message.slice(0, 300));
  });
  // 窗口不可聚焦（focusable:false），收不到键盘，所以不提供 DevTools 快捷键，也不注册会抢占系统范围 Ctrl+Shift+I 的全局快捷键。
  wc.on('did-finish-load', () => {
    loaded = true;
    win.showInactive();
    log('INFO', 'did-finish-load visible=' + win.isVisible());
    setTimeout(gpuStatus, 2000);
  });
  installIPC();
  installTray();
  await win.loadFile(indexPath);
  if (debug) debugKey = await applyDebugCSS();
  if (process.platform === 'win32' && !selftest) {
    hook = require('./input-hook');
    hook.start({ log, onKey: payload => send('silly:key', payload), onButton: payload => {
      if (payload.button === 0 && !payload.down) endDrag();
      send('silly:button', payload);
    } });
  }
  log('INFO', 'hook ' + JSON.stringify(hook ? hook.status() : { started: false, reason: selftest ? 'selftest' : process.platform }));
  if (debug) setInterval(() => {
    const { keys, buttons } = inputStatus().events;
    log('INFO', 'hook counts ' + JSON.stringify({ keys, buttons }));
  }, 10000);
  started = true;
  if (selftest) {
    async function check(name, test) {
      try { results.push({ name, ok: true, detail: (await test()) || '通过' }); }
      catch (e) { results.push({ name, ok: false, detail: e.stack || String(e) }); }
    }
    await require('./selftest').run({ win, out, userData, send, setCursor, menuTemplate, defaultPos,
      getIgnore, isDragging, consoleErrors, applyDebugCSS, debugKey, getOpenedFolder,
      runLog: currentRunLog, pickRunLog, appendLogLine, RUN_LOG_NAME }, check);
    finishTest();
  }
}

function boot() {
  app.setName('SillyCatElectronDemo');
  userData = selftest ? fs.mkdtempSync(path.join(os.tmpdir(), 'sillycat-profile-'))
    : path.join(app.getPath('appData'), 'SillyCatElectronDemo');
  app.setPath('userData', userData);
  if (selftest) app.setPath('sessionData', userData);
  if (selftest) {
    const i = process.argv.indexOf('--selftest-out');
    out = i >= 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1])
      : path.join(os.tmpdir(), 'sillycat-selftest-' + Date.now());
    watchdog = setTimeout(() => fatal('自检超时', '55 秒内未完成'), 55000);
    fs.mkdirSync(out, { recursive: true });
  }
  runtimeInfo();
  const gpuSources = [];
  if (process.argv.includes('--disable-gpu')) gpuSources.push('--disable-gpu');
  if (process.env.SILLYCAT_DISABLE_GPU === '1') gpuSources.push('SILLYCAT_DISABLE_GPU');
  if (gpuSources.length) {
    app.disableHardwareAcceleration();
    app.commandLine.appendSwitch('disable-gpu');
    log('INFO', 'GPU 已关闭 ' + gpuSources.join(', '));
  }
  if (!selftest && !app.requestSingleInstanceLock()) {
    log('INFO', '已有实例运行'); app.quit(); return;
  }
  app.on('second-instance', () => { if (win && !win.isDestroyed()) win.showInactive(); });
  app.on('child-process-gone', (_, d) => log('ERROR', 'child-process-gone ' + JSON.stringify(d)));
  app.on('before-quit', () => { if (hook) hook.stop(); endDrag(); flushPosition(); });
  app.on('window-all-closed', () => app.quit());
  process.on('uncaughtException', e => {
    if (!started || selftest) fatal('桌宠运行异常', e.stack || e.message);
    else log('ERROR', 'uncaughtException ' + (e.stack || e.message));
  });
  process.on('unhandledRejection', e => log('ERROR', 'unhandledRejection ' + (e?.stack || String(e))));
  app.whenReady().then(ready).catch(e => fatal('桌宠启动失败', e.stack || e.message));
}
const BASE_W = 420;
const BASE_H = 345;
const MARGIN = 24;
const SIZE_MIN = 0.5;
const SIZE_MAX = 2;
const POSITION_DEBOUNCE_MS = 400;
const DRAG_POLL_MS = 8;
const DRAG_TIMEOUT_MS = 60_000;
const forwardMouse = process.env.SILLYCAT_NO_FORWARD !== '1';

let positionLocked = false;
let tray;
let positionTimer;
let pendingPosition;
let drag;
let cursorOverride;
let ignoreApplied = false;
let ignoreDesired = false;
let lastIgnoreArgs = null;
let openedFolder = null;
const loggedUnknownCommands = new Set();

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readJSON(filename) {
  try {
    return JSON.parse(fs.readFileSync(path.join(userData, filename), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') log('WARN', `Cannot read ${filename}: ${error.message}`);
    return null;
  }
}

function writeJSON(filename, value) {
  const file = path.join(userData, filename);
  const temp = `${file}.tmp`;
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
}

function loadSettings() {
  const settings = readJSON('settings.json');
  return isObject(settings) ? settings : null;
}

function validSize(size) {
  return Number.isFinite(size) && size >= SIZE_MIN && size <= SIZE_MAX;
}

function catSizeOf(settings) {
  return validSize(settings?.size) ? settings.size : 1;
}

function sizeBounds(size) {
  return { width: Math.round(BASE_W * size), height: Math.round(BASE_H * size) };
}

function liveWindow() {
  return win && !win.isDestroyed();
}

function defaultPos({ width, height } = liveWindow() ? win.getBounds() : sizeBounds(1)) {
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x + area.width - width - MARGIN, y: area.y + area.height - height - MARGIN };
}

function initialBounds() {
  positionLocked = readJSON('window-lock.json')?.locked === true;
  const size = sizeBounds(catSizeOf(loadSettings()));
  const position = readJSON('window-position.json');
  if (Number.isFinite(position?.x) && Number.isFinite(position?.y)) {
    const x = Math.round(position.x);
    const y = Math.round(position.y);
    const cx = x + size.width / 2;
    const cy = y + size.height / 2;
    const onScreen = screen.getAllDisplays().some(({ bounds }) =>
      cx >= bounds.x && cx < bounds.x + bounds.width &&
      cy >= bounds.y && cy < bounds.y + bounds.height);
    if (onScreen) return { bounds: { x, y, ...size }, source: 'saved' };
    log('WARN', 'Saved window position is outside the available displays');
  } else if (position !== null) {
    log('WARN', 'Invalid window-position.json coordinates');
  }
  return { bounds: { ...defaultPos(size), ...size }, source: 'default' };
}

function schedulePosition() {
  if (!liveWindow() || drag) return;
  const { x, y } = win.getBounds();
  pendingPosition = { x, y };
  clearTimeout(positionTimer);
  positionTimer = setTimeout(flushPosition, POSITION_DEBOUNCE_MS);
}

function flushPosition() {
  clearTimeout(positionTimer);
  positionTimer = undefined;
  if (!pendingPosition) return;
  const position = pendingPosition;
  pendingPosition = undefined;
  try {
    writeJSON('window-position.json', position);
  } catch (error) {
    log('WARN', `Cannot save window position: ${error.message}`);
  }
}

function applyCatSize(size) {
  if (!liveWindow()) return;
  const bounds = win.getBounds();
  const { width, height } = sizeBounds(size);
  if (bounds.width === width && bounds.height === height) return;
  endDrag();
  win.setBounds({
    x: bounds.x + bounds.width - width,
    y: bounds.y + bounds.height - height,
    width,
    height,
  });
  schedulePosition();
}

function setCursor(pointOrNull) {
  cursorOverride = pointOrNull;
}

function getCursorPoint() {
  return cursorOverride ?? screen.getCursorScreenPoint();
}

function cursorLocal() {
  if (!liveWindow()) return null;
  try {
    const { x: gx, y: gy } = getCursorPoint();
    const { x, y } = win.getContentBounds();
    return { gx, gy, x: gx - x, y: gy - y };
  } catch {
    return null;
  }
}

function getIgnore() {
  return { applied: ignoreApplied, desired: ignoreDesired, lastArgs: lastIgnoreArgs };
}

function applyIgnore() {
  // Keep accepting mouseup during drag even when the pointer leaves the cat.
  const next = !drag && ignoreDesired;
  if (!liveWindow() || ignoreApplied === next) return;
  const args = forwardMouse ? [next, { forward: true }] : [next];
  win.setIgnoreMouseEvents(...args);
  ignoreApplied = next;
  lastIgnoreArgs = args;
}

function isDragging() {
  return drag !== undefined;
}

function endDrag() {
  if (!drag) return;
  clearInterval(drag.poll);
  clearTimeout(drag.timeout);
  drag = undefined;
  applyIgnore();
  schedulePosition();
}

function startDragging() {
  if (!liveWindow() || positionLocked || drag) return;
  const start = getCursorPoint();
  const bounds = win.getBounds();
  const dx = start.x - bounds.x;
  const dy = start.y - bounds.y;
  const { width, height } = bounds;
  let { x, y } = bounds;
  drag = {
    poll: setInterval(() => {
      try {
        if (!liveWindow()) {
          endDrag();
          return;
        }
        const point = getCursorPoint();
        const nextX = Math.round(point.x - dx);
        const nextY = Math.round(point.y - dy);
        if (nextX === x && nextY === y) return;
        win.setBounds({ x: nextX, y: nextY, width, height });
        x = nextX;
        y = nextY;
      } catch (error) {
        log('WARN', `Window drag stopped: ${error.message}`);
        endDrag();
      }
    }, DRAG_POLL_MS),
    timeout: setTimeout(endDrag, DRAG_TIMEOUT_MS),
  };
  applyIgnore();
}

function showContextMenu() {
  if (selftest || !liveWindow()) return;
  const menu = Menu.buildFromTemplate(menuTemplate());
  return new Promise((resolve) => menu.popup({ window: win, callback: resolve }));
}

function inputStatus() {
  const state = hook?.status();
  const started = state?.started === true;
  return {
    granted: true,
    keys: started,
    mouse: started,
    keyboard: started ? 'ok' : 'unsupported',
    needs_permission: false,
    events: { keys: state?.keys ?? 0, buttons: state?.buttons ?? 0 },
  };
}

function invokeCommand(command, args) {
  switch (command) {
    case 'platform_flags': return { win7: false };
    case 'load_settings': return loadSettings();
    case 'save_settings': {
      const settings = args?.settings;
      if (!isObject(settings)) throw new Error('settings 必须是对象');
      writeJSON('settings.json', settings);
      applyCatSize(catSizeOf(settings));
      send('silly:settings', settings);
      return;
    }
    case 'preview_cat_size':
      if (validSize(args?.size)) applyCatSize(args.size);
      return;
    case 'cursor_local': return cursorLocal();
    case 'position_locked': return positionLocked;
    case 'show_context_menu': return showContextMenu();
    case 'input_status': return inputStatus();
    case 'held_input_state': throw new Error('unsupported');
    case 'update_status': return { kind: 'idle' };
    case 'install_update': throw new Error('此 demo 不含自动更新');
    case 'open_settings': log('INFO', '设置窗口在 demo 里未实现'); return;
    case 'updater_configured': return false;
    case 'app_version': return app.getVersion();
    case 'autostart_status':
    case 'set_autostart':
    case 'open_login_items':
    case 'open_input_monitoring':
    case 'reset_input_monitoring':
    case 'restart_app':
    case 'open_link': throw new Error('demo 未实现');
    default: {
      const name = typeof command === 'string' ? command : '<invalid>';
      const error = `unknown command: ${name}`;
      if (!loggedUnknownCommands.has(name)) {
        loggedUnknownCommands.add(name);
        log('WARN', error);
      }
      throw new Error(error);
    }
  }
}

function windowMethod(method, arg) {
  switch (method) {
    case 'setIgnoreCursorEvents':
      if (typeof arg !== 'boolean') throw new Error('setIgnoreCursorEvents requires a boolean');
      ignoreDesired = arg;
      applyIgnore();
      return;
    case 'startDragging': return startDragging();
    case 'close': return;
    default: throw new Error('unknown window method');
  }
}

function isMainPage(event) {
  if (!liveWindow() || event.sender !== win.webContents) return false;
  const frame = event.senderFrame;
  // 不用 === indexURL：Chromium 与 Node 对路径里特殊字符的百分号编码可能不同，严格相等会让整页 IPC 被误拒。页面只加载本地文件，will-navigate 也已锁死。
  return !!frame && frame === win.webContents.mainFrame && /^file:/i.test(frame.url);
}

function installIPC() {
  const handle = (handler) => async (event, ...args) => {
    try {
      if (!isMainPage(event)) throw new Error('unauthorized IPC sender');
      return { value: await handler(...args) };
    } catch (error) {
      return { error: error.message ?? String(error) };
    }
  };
  ipcMain.handle('silly:invoke', handle(invokeCommand));
  ipcMain.handle('silly:window', handle(windowMethod));
  ipcMain.on('silly:drag-end', (event) => {
    if (isMainPage(event)) endDrag();
  });
  log('INFO', `Mouse forwarding ${forwardMouse ? 'enabled' : 'disabled (SILLYCAT_NO_FORWARD=1)'}`);
}

function trayAvailable() {
  return !!tray && !tray.isDestroyed();
}

function refreshTrayMenu() {
  if (!trayAvailable()) return;
  tray.setContextMenu(Menu.buildFromTemplate(menuTemplate()));
}

function toggleVisibility() {
  if (!liveWindow()) return;
  if (!win.isVisible()) win.showInactive();
  else if (selftest || trayAvailable()) {
    endDrag();
    win.hide();
  }
}

function togglePositionLock() {
  positionLocked = !positionLocked;
  if (positionLocked) endDrag();
  try {
    writeJSON('window-lock.json', { locked: positionLocked });
  } catch (error) {
    log('WARN', `Cannot save window lock: ${error.message}`);
  }
  send('silly:lock', positionLocked);
  refreshTrayMenu();
}

function resetPosition() {
  if (!liveWindow()) return;
  endDrag();
  const { width, height } = win.getBounds();
  win.setBounds({ ...defaultPos({ width, height }), width, height });
  schedulePosition();
  win.showInactive();
}

async function openLogFolder() {
  const info = currentRunLog();
  openedFolder = info.file || userData;
  if (selftest) return;
  try {
    if (info.file) shell.showItemInFolder(info.file);
    else {
      const error = await shell.openPath(userData);
      if (error) log('WARN', `Cannot open log folder: ${error}`);
    }
  } catch (error) {
    log('WARN', `Cannot open log folder: ${error.message}`);
  }
}

function getOpenedFolder() {
  return openedFolder;
}

function menuTemplate() {
  return [
    { label: '显示/隐藏猫', enabled: selftest || trayAvailable(), click: toggleVisibility },
    { label: '锁定位置', type: 'checkbox', checked: positionLocked, click: togglePositionLock },
    { label: '重置位置', click: resetPosition },
    { label: '打开日志文件夹', click: openLogFolder },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ];
}

function installTray() {
  if (selftest) return;
  try {
    const image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) throw new Error(`Cannot load tray icon: ${iconPath}`);
    tray = new Tray(image);
    tray.setToolTip('捣蛋奶牛猫（Electron demo）');
    refreshTrayMenu();
    if (process.platform === 'win32') {
      tray.on('right-click', refreshTrayMenu);
      tray.on('click', () => {
        refreshTrayMenu();
        tray.popUpContextMenu();
      });
    }
    log('INFO', 'Tray created');
  } catch (error) {
    if (trayAvailable()) tray.destroy();
    tray = undefined;
    log('WARN', `Cannot create tray: ${error.message}`);
  }
}

try {
  boot();
} catch (error) {
  fatal('桌宠初始化失败', error.stack || error.message);
}
