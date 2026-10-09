const path = require('path');
const http = require('http');
const fs = require('fs');
const { app, BrowserWindow, session, shell, ipcMain, utilityProcess, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const { saveResultJson } = require('./service/resultJsonSaver');
const { write: logWrite } = require('./utils/logger');

// 하드웨어 가속 명시적 활성화 (Windows 호환 플래그만 유지)
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');

const ADMIN_URL = 'http://localhost:3333/mgr';
const RELEASES_URL = 'https://github.com/cunipics/tarae/releases/latest';
const AUTO_UPDATE_DELAY_MS = 15000;
const AUTO_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
let backendProcess = null;
let appIsQuitting = false;

function startBackendServer() {
  if (backendProcess) return;

  const userDataDir = app.getPath('userData');
  const modelCacheDir = path.join(userDataDir, 'models');
  const databasePath = path.join(userDataDir, 'cms.db');
  const schemaStatePath = path.join(userDataDir, 'schema-version.json');

  fs.mkdirSync(userDataDir, { recursive: true });
  if (!fs.existsSync(databasePath)) {
    const seedDatabasePath = app.isPackaged
      ? path.join(process.resourcesPath, 'seed', 'cms.db')
      : path.join(__dirname, 'cms.db');
    fs.copyFileSync(seedDatabasePath, databasePath);
    fs.writeFileSync(schemaStatePath, JSON.stringify({ version: app.getVersion() }), 'utf8');
  }

  backendProcess = utilityProcess.fork(path.join(__dirname, 'app.js'), [], {
    cwd: userDataDir,
    env: {
      ...process.env,
      TARAE_MODEL_CACHE_DIR: modelCacheDir,
      TARAE_SCHEMA_STATE_FILE: schemaStatePath,
      TARAE_SCHEMA_VERSION: app.getVersion(),
      SQLITE_FILENAME: databasePath
    },
    stdio: 'pipe',
    serviceName: 'Tarae Backend'
  });

  if (backendProcess.stdout) {
    backendProcess.stdout.on('data', (data) => process.stdout.write(`[Backend] ${data}`));
  }
  if (backendProcess.stderr) {
    backendProcess.stderr.on('data', (data) => process.stderr.write(`[Backend] ${data}`));
  }

  backendProcess.on('error', (type, location, report) => {
    console.error('[Backend] 서버 프로세스 오류:', type, location, report);
  });

  backendProcess.on('exit', (code) => {
    backendProcess = null;
    if (!appIsQuitting) {
      console.error(`[Backend] 서버 프로세스 종료: code=${code}`);
    }
  });
}

function waitForBackend(timeoutMs = 60000) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const check = () => {
      const request = http.get(ADMIN_URL, (response) => {
        response.resume();
        resolve();
      });

      request.setTimeout(1000, () => request.destroy());
      request.on('error', () => {
        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error('관리자 서버가 제한 시간 안에 시작되지 않았습니다.'));
          return;
        }
        setTimeout(check, 200);
      });
    };

    check();
  });
}

function stopBackendServer() {
  if (!backendProcess) return;
  try {
    backendProcess.kill();
  } catch (err) {
    console.error('[Backend] 서버 프로세스 종료 실패:', err);
  }
}

function getStartupPageUrl() {
  const html = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Tarae 시작 중</title>
  <style>
    html, body { height: 100%; margin: 0; }
    body {
      display: grid;
      place-items: center;
      background: #f4f7fb;
      color: #1f2937;
      font-family: "Malgun Gothic", "Segoe UI", sans-serif;
    }
    .startup { text-align: center; }
    .title { margin: 0 0 12px; font-size: 30px; font-weight: 700; }
    .message { margin: 0; color: #64748b; font-size: 16px; }
    .bar {
      width: 260px;
      height: 4px;
      margin: 24px auto 0;
      overflow: hidden;
      border-radius: 999px;
      background: #dbe4f0;
    }
    .bar::after {
      content: "";
      display: block;
      width: 45%;
      height: 100%;
      border-radius: inherit;
      background: #2563eb;
      animation: loading 1.1s ease-in-out infinite alternate;
    }
    @keyframes loading {
      from { transform: translateX(0); }
      to { transform: translateX(122%); }
    }
  </style>
</head>
<body>
  <main class="startup">
    <h1 class="title">Tarae</h1>
    <p class="message">관리자 화면을 준비하고 있습니다.</p>
    <div class="bar" aria-hidden="true"></div>
  </main>
</body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

let mainWindow = null;
const protectedDownloadSessions = new WeakSet();
let updaterInitialized = false;
let updateCheckTimer = null;
let updateIntervalTimer = null;
let lastPromptedVersion = null;
const updateState = {
  status: 'idle',
  availableVersion: null,
  message: '업데이트 확인 전입니다.',
  progressPercent: 0,
  manualCheck: false,
  checking: false,
  downloading: false,
  downloaded: false
};

function isPortableBuild() {
  return Boolean(process.env.PORTABLE_EXECUTABLE_DIR);
}

function getUpdateSnapshot() {
  return {
    status: updateState.status,
    currentVersion: app.getVersion(),
    availableVersion: updateState.availableVersion,
    message: updateState.message,
    progressPercent: updateState.progressPercent,
    checking: updateState.checking,
    downloading: updateState.downloading,
    downloaded: updateState.downloaded,
    packaged: app.isPackaged,
    portable: isPortableBuild(),
    releasesUrl: RELEASES_URL
  };
}

function sendUpdateStatus() {
  const snapshot = getUpdateSnapshot();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updater:status', snapshot);
  }
  return snapshot;
}

function setUpdateState(status, values = {}) {
  updateState.status = status;
  Object.assign(updateState, values);
  return sendUpdateStatus();
}

function isTrustedAdminFrame(event) {
  const frame = event.senderFrame;
  const sourceUrl = frame && frame.url;
  return Boolean(
    mainWindow &&
    event.sender === mainWindow.webContents &&
    frame === event.sender.mainFrame &&
    sourceUrl &&
    (sourceUrl === ADMIN_URL || sourceUrl.startsWith(ADMIN_URL + '/'))
  );
}

async function downloadAvailableUpdate() {
  if (!app.isPackaged || isPortableBuild()) {
    return setUpdateState('portable', {
      message: '휴대용 실행 파일은 자동 설치를 지원하지 않습니다. 릴리스 페이지에서 새 파일을 받으십시오.',
      checking: false,
      downloading: false
    });
  }
  if (!updateState.availableVersion || updateState.downloading || updateState.downloaded) {
    return getUpdateSnapshot();
  }

  setUpdateState('downloading', {
    message: '업데이트 파일을 내려받는 중입니다.',
    progressPercent: 0,
    downloading: true
  });

  try {
    await autoUpdater.downloadUpdate();
  } catch (err) {
    console.error('[Updater] 다운로드 실패:', err);
    setUpdateState('error', {
      message: '업데이트 파일을 내려받지 못했습니다. 잠시 후 다시 시도해 주십시오.',
      downloading: false
    });
  }
  return getUpdateSnapshot();
}

async function checkForApplicationUpdate(manual = false) {
  if (!app.isPackaged) {
    return setUpdateState('development', {
      message: '개발 실행 중에는 업데이트를 확인하지 않습니다.',
      checking: false,
      manualCheck: false
    });
  }
  if (isPortableBuild()) {
    return setUpdateState('portable', {
      message: '휴대용 실행 파일은 자동 업데이트를 지원하지 않습니다. 릴리스 페이지에서 새 파일을 받으십시오.',
      checking: false,
      manualCheck: false
    });
  }
  if (updateState.checking || updateState.downloading) {
    return getUpdateSnapshot();
  }

  setUpdateState('checking', {
    message: '새 버전을 확인하고 있습니다.',
    checking: true,
    manualCheck: Boolean(manual),
    progressPercent: 0
  });

  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    console.error('[Updater] 확인 실패:', err);
    setUpdateState('error', {
      message: '업데이트 서버에 연결하지 못했습니다. 인터넷 연결과 릴리스 공개 상태를 확인해 주십시오.',
      checking: false,
      manualCheck: false
    });
  }
  return getUpdateSnapshot();
}

function installDownloadedUpdate() {
  if (!updateState.downloaded) return getUpdateSnapshot();
  appIsQuitting = true;
  stopBackendServer();
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return getUpdateSnapshot();
}

function initializeAutoUpdater() {
  if (updaterInitialized) return;
  updaterInitialized = true;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;

  autoUpdater.on('checking-for-update', () => {
    setUpdateState('checking', {
      message: '새 버전을 확인하고 있습니다.',
      checking: true
    });
  });

  autoUpdater.on('update-available', (info) => {
    const version = String(info && info.version || '');
    setUpdateState('available', {
      availableVersion: version,
      message: version ? `새 버전 ${version}을 사용할 수 있습니다.` : '새 버전을 사용할 수 있습니다.',
      checking: false,
      manualCheck: false,
      downloading: false,
      downloaded: false
    });

    if (!mainWindow || mainWindow.isDestroyed() || lastPromptedVersion === version) return;
    lastPromptedVersion = version;
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Tarae 업데이트',
      message: version ? `Tarae ${version} 버전을 사용할 수 있습니다.` : 'Tarae 새 버전을 사용할 수 있습니다.',
      detail: '지금 업데이트 파일을 내려받으시겠습니까? 다운로드 중에도 프로그램을 계속 사용할 수 있습니다.',
      buttons: ['업데이트 다운로드', '나중에'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    }).then(({ response }) => {
      if (response === 0) downloadAvailableUpdate();
    }).catch((err) => console.error('[Updater] 알림 표시 실패:', err));
  });

  autoUpdater.on('update-not-available', () => {
    setUpdateState('up-to-date', {
      availableVersion: null,
      message: '현재 최신 버전을 사용하고 있습니다.',
      progressPercent: 0,
      checking: false,
      manualCheck: false,
      downloading: false,
      downloaded: false
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    const percent = Math.max(0, Math.min(100, Number(progress && progress.percent) || 0));
    setUpdateState('downloading', {
      message: `업데이트 파일을 내려받는 중입니다. ${percent.toFixed(1)}%`,
      progressPercent: percent,
      checking: false,
      downloading: true
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    const version = String(info && info.version || updateState.availableVersion || '');
    setUpdateState('downloaded', {
      availableVersion: version,
      message: '업데이트 준비가 끝났습니다. 프로그램을 다시 시작하면 설치됩니다.',
      progressPercent: 100,
      checking: false,
      downloading: false,
      downloaded: true
    });

    if (!mainWindow || mainWindow.isDestroyed()) return;
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Tarae 업데이트 준비 완료',
      message: '업데이트 파일을 모두 내려받았습니다.',
      detail: '지금 프로그램을 다시 시작하여 업데이트를 설치하시겠습니까?',
      buttons: ['지금 다시 시작', '나중에'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    }).then(({ response }) => {
      if (response === 0) installDownloadedUpdate();
    }).catch((err) => console.error('[Updater] 설치 알림 표시 실패:', err));
  });

  autoUpdater.on('error', (err) => {
    console.error('[Updater] 오류:', err);
    setUpdateState('error', {
      message: '업데이트 처리 중 오류가 발생했습니다. 인터넷 연결과 릴리스 공개 상태를 확인해 주십시오.',
      checking: false,
      manualCheck: false,
      downloading: false
    });
  });

  autoUpdater.on('before-quit-for-update', () => {
    appIsQuitting = true;
    stopBackendServer();
  });
}

function scheduleAutomaticUpdateChecks() {
  if (!app.isPackaged || isPortableBuild() || updateCheckTimer || updateIntervalTimer) return;

  updateCheckTimer = setTimeout(() => {
    updateCheckTimer = null;
    checkForApplicationUpdate(false);
    updateIntervalTimer = setInterval(() => {
      checkForApplicationUpdate(false);
    }, AUTO_UPDATE_INTERVAL_MS);
  }, AUTO_UPDATE_DELAY_MS);
}

function getResponseHeader(responseHeaders, headerName) {
  const headers = responseHeaders || {};
  const matchedKey = Object.keys(headers).find(key => key.toLowerCase() === headerName.toLowerCase());
  if (!matchedKey) return '';
  const value = headers[matchedKey];
  return Array.isArray(value) ? value.join('; ') : String(value || '');
}

function isDownloadResponse(details) {
  if (details.resourceType !== 'mainFrame') return false;

  const disposition = getResponseHeader(details.responseHeaders, 'content-disposition');
  if (/\battachment\b/i.test(disposition)) return true;

  const contentType = getResponseHeader(details.responseHeaders, 'content-type')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();

  if (!contentType.startsWith('application/')) return false;
  return !/(?:json|xml|javascript|wasm|xhtml)/i.test(contentType);
}

function configureDownloadProtection(targetSession, options = {}) {
  if (!targetSession || protectedDownloadSessions.has(targetSession)) return;
  protectedDownloadSessions.add(targetSession);

  const allowAdminResultJson = Boolean(options.allowAdminResultJson);

  targetSession.on('will-download', (event, item, webContents) => {
    const downloadUrl = item.getURL();
    const filename = item.getFilename();
    const isAllowedResultJson = Boolean(
      allowAdminResultJson &&
      mainWindow &&
      webContents === mainWindow.webContents &&
      /^result(?:_extra)?\.json$/i.test(filename) &&
      downloadUrl.startsWith('blob:http://localhost:3333/')
    );

    if (isAllowedResultJson) {
      console.log('[Result JSON Download]:', filename);
      return;
    }

    console.log('[Auto Blocked Download]:', downloadUrl, filename);
    event.preventDefault();
  });

  targetSession.webRequest.onHeadersReceived((details, callback) => {
    if (!allowAdminResultJson && isDownloadResponse(details)) {
      console.log('[Auto Blocked File Response]:', details.url);
      callback({ cancel: true });
      return;
    }

    if (!allowAdminResultJson || details.url.startsWith('http://localhost:')) {
      callback({ cancel: false, responseHeaders: details.responseHeaders });
      return;
    }

    const contentType = getResponseHeader(details.responseHeaders, 'content-type');
    if (contentType && !contentType.includes('text/html')) {
      callback({ cancel: false, responseHeaders: details.responseHeaders });
      return;
    }

    const responseHeaders = Object.assign({}, details.responseHeaders);
    for (const key of Object.keys(responseHeaders)) {
      const lower = key.toLowerCase();
      if (lower === 'x-frame-options') {
        delete responseHeaders[key];
      }
      if (lower === 'content-security-policy') {
        responseHeaders[key] = responseHeaders[key].map(csp =>
          csp.replace(/frame-ancestors[^;]+;?/gi, '')
        );
      }
    }
    callback({ cancel: false, responseHeaders });
  });
}

async function createWindow() {
  startBackendServer();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: '#f4f7fb',
    title: 'Tarae 불법 광고 탐지 시스템',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload', 'admin-download.js'),
      webviewTag: true,
      webSecurity: false,
      backgroundThrottling: true
    }
  });

  // 메뉴바 숨김 처리
  mainWindow.setMenuBarVisibility(false);

  // 백엔드가 준비되는 동안 빈 화면 대신 시작 화면을 즉시 표시합니다.
  await mainWindow.loadURL(getStartupPageUrl());
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
  }

  // F5 및 Ctrl+R 새로고침 단축키 지원 (개발 편의성)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown') {
      if (input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r')) {
        mainWindow.reload();
        event.preventDefault();
      }
      if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
        mainWindow.webContents.toggleDevTools();
        event.preventDefault();
      }
    }
  });

  // webview가 mainWindow에 연결될 때 CDP 디버거 즉시 바인딩하여 모든 alert/confirm 자동 닫기
  mainWindow.webContents.on('did-attach-webview', (event, guestWebContents) => {
    try {
      if (!guestWebContents.debugger.isAttached()) {
        guestWebContents.debugger.attach('1.3');
      }
      guestWebContents.debugger.sendCommand('Page.enable').catch(() => {});
      guestWebContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          try {
            window.alert = function(m) { console.log('[Auto Blocked Alert]:', m); };
            window.confirm = function(m) { return true; };
            window.prompt = function(m) { return null; };
            window.onbeforeunload = null;
          } catch(e) {}
        `
      }).catch(() => {});
      guestWebContents.debugger.on('message', (ev, method, params) => {
        if (method === 'Page.javascriptDialogOpening') {
          console.log('[Electron CDP Webview] 알럿 대화상자 0초 만에 자동 수락 완료:', params.message);
          guestWebContents.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
        }
      });
    } catch (e) {}
  });

  // 서버 준비가 끝난 뒤 관리자 화면을 엽니다.
  try {
    await waitForBackend();
    if (mainWindow && !mainWindow.isDestroyed()) {
      await mainWindow.loadURL(ADMIN_URL);
      scheduleAutomaticUpdateChecks();
    }
  } catch (err) {
    console.error('[Backend] 관리자 화면 로드 실패:', err);
    if (mainWindow && !mainWindow.isDestroyed()) {
      await mainWindow.loadURL(ADMIN_URL).catch(() => {});
    }
  }

  mainWindow.on('closed', function () {
    mainWindow = null;
  });
}

app.whenReady().then(function () {
  initializeAutoUpdater();

  ipcMain.handle('save-result-json', async (event, payload) => {
    const frame = event.senderFrame;
    const sourceUrl = frame && frame.url;
    if (!mainWindow || event.sender !== mainWindow.webContents ||
        frame !== event.sender.mainFrame ||
        !sourceUrl || !sourceUrl.startsWith('http://localhost:3333/mgr/')) {
      return { status: 'error', message: '관리자 화면에서만 저장할 수 있습니다.' };
    }
    logWrite(path.join(__dirname, 'logs'), { event: 'result_json_save', status: 'requested', bytes: Buffer.byteLength(String(payload && payload.content || ''), 'utf8') });
    const result = await saveResultJson(payload, { app });
    logWrite(path.join(__dirname, 'logs'), { event: 'result_json_save', status: result.status, path: result.path || null, error: result.message || null });
    console.log('[Result JSON Save]', result.status, result.path || result.message || '');
    return result;
  });

  ipcMain.handle('updater:get-status', (event) => {
    if (!isTrustedAdminFrame(event)) return null;
    return getUpdateSnapshot();
  });

  ipcMain.handle('updater:check', (event) => {
    if (!isTrustedAdminFrame(event)) return null;
    return checkForApplicationUpdate(true);
  });

  ipcMain.handle('updater:download', (event) => {
    if (!isTrustedAdminFrame(event)) return null;
    return downloadAvailableUpdate();
  });

  ipcMain.handle('updater:install', (event) => {
    if (!isTrustedAdminFrame(event)) return null;
    return installDownloadedUpdate();
  });

  ipcMain.handle('updater:open-releases', async (event) => {
    if (!isTrustedAdminFrame(event)) return false;
    await shell.openExternal(RELEASES_URL);
    return true;
  });

  // 웹뷰 및 모든 렌더러에 알럿/팝업 원천 차단 선제 스크립트 자동 등록
  const preloadScriptPath = path.join(__dirname, 'static', 'js', 'webview-preload.js');
  try {
    if (typeof session.defaultSession.registerPreloadScript === 'function') {
      session.defaultSession.registerPreloadScript({ filePath: preloadScriptPath });
    } else if (typeof session.defaultSession.setPreloads === 'function') {
      session.defaultSession.setPreloads([preloadScriptPath]);
    }
  } catch (e) {}

  // 관리자 결과 JSON은 허용하고, 외부 탐지 세션의 파일 응답과 다운로드는 차단합니다.
  configureDownloadProtection(session.defaultSession, { allowAdminResultJson: true });

  // 별도 파티션은 기본 세션과 이벤트를 공유하지 않으므로 직접 보호합니다.
  const liveBrowserSession = session.fromPartition('persist:fcms-live-browser');
  // 일부 사이트가 Electron 식별자가 포함된 기본 정보에서 화면 초기화를 중단하므로
  // 설치된 Chromium 버전을 사용한 일반 브라우저 정보로 실시간 뷰어를 통일합니다.
  const liveBrowserUserAgent = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    'AppleWebKit/537.36 (KHTML, like Gecko)',
    `Chrome/${process.versions.chrome}`,
    'Safari/537.36'
  ].join(' ');
  liveBrowserSession.setUserAgent(liveBrowserUserAgent);
  configureDownloadProtection(liveBrowserSession);
  try {
    liveBrowserSession.setPreloads([preloadScriptPath]);
  } catch (e) {}

  // 이후 만들어지는 세션에도 같은 보호를 적용합니다.
  app.on('session-created', (sess) => {
    configureDownloadProtection(sess, { allowAdminResultJson: sess === session.defaultSession });
    try {
      sess.setPreloads([preloadScriptPath]);
    } catch (e) {}
  });

  createWindow();

  // 모든 웹뷰 및 하위 창 이벤트 제어
  app.on('web-contents-created', (event, contents) => {
    // 1. 새 창/팝업 열기 요청 제어
    contents.setWindowOpenHandler((details) => {
      // 관리자 메인 화면에서 사용자가 클릭한 외부 링크인 경우 시스템 기본 브라우저로 열기
      if (mainWindow && contents === mainWindow.webContents) {
        if (details.url.startsWith('http://') || details.url.startsWith('https://')) {
          shell.openExternal(details.url);
        }
        return { action: 'deny' };
      }

      // 웹뷰 내부에서 발생하는 불법 광고 팝업은 100% 원천 차단
      console.log('[Electron] 외부 웹사이트 광고 팝업 차단 완료:', details.url);
      return { action: 'deny' };
    });

    // 2. 페이지 이탈 방지 알럿(will-prevent-unload) 원천 차단
    contents.on('will-prevent-unload', (e) => {
      e.preventDefault();
    });

    // 3. 웹뷰 및 하위 창에서 발생하는 alert/confirm/prompt 대화상자 CDP 기반 원천 자동 닫기
    if (contents.getType() === 'webview') {
      try {
        if (!contents.debugger.isAttached()) {
          contents.debugger.attach('1.3');
        }
        contents.debugger.sendCommand('Page.enable').catch(() => {});
        contents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
          source: `
            try {
              window.alert = function(m) { console.log('[Auto Blocked Alert]:', m); };
              window.confirm = function(m) { return true; };
              window.prompt = function(m) { return null; };
              window.onbeforeunload = null;
            } catch(e) {}
          `
        }).catch(() => {});
        contents.debugger.on('message', (event, method, params) => {
          if (method === 'Page.javascriptDialogOpening') {
            console.log('[Electron CDP] 자바스크립트 알럿 대화상자 자동 수락 및 차단 완료:', params.message);
            contents.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
          }
        });
      } catch (dbgErr) {}

      // 스크립트 실행 시작 시점마다 alert 덮어쓰기 재보장
      const disableAlertCode = `
        try {
          Object.defineProperty(window, 'alert', { value: function(m){ console.log('[차단 Alert]:', m); }, writable: false, configurable: false });
          Object.defineProperty(window, 'confirm', { value: function(m){ console.log('[차단 Confirm]:', m); return true; }, writable: false, configurable: false });
          Object.defineProperty(window, 'prompt', { value: function(m){ console.log('[차단 Prompt]:', m); return null; }, writable: false, configurable: false });
          window.onbeforeunload = null;
        } catch(e) {}
      `;
      contents.on('did-start-navigation', () => {
        contents.executeJavaScript(disableAlertCode).catch(() => {});
      });
      contents.on('dom-ready', () => {
        contents.executeJavaScript(disableAlertCode).catch(() => {});
      });
    }
  });

  // 메인 창 외에 외부 사이트(병원, 언론사 등)가 띄우는 모든 팝업 윈도우 생성 즉시 원천 파괴
  app.on('browser-window-created', (event, win) => {
    if (mainWindow && win !== mainWindow) {
      console.log('[Electron] 외부 사이트 팝업 창 감지 즉시 강제 파괴 완료');
      setImmediate(() => {
        try {
          if (!win.isDestroyed()) win.destroy();
        } catch (e) {}
      });
    }
  });

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', function () {
  appIsQuitting = true;
  if (updateCheckTimer) clearTimeout(updateCheckTimer);
  if (updateIntervalTimer) clearInterval(updateIntervalTimer);
  stopBackendServer();
});
