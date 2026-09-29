const path = require('path');
const { app, BrowserWindow, session, shell, ipcMain } = require('electron');
const { saveResultJson } = require('./service/resultJsonSaver');
const { write: logWrite } = require('./utils/logger');

// 하드웨어 가속 명시적 활성화 (Windows 호환 플래그만 유지)
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');

// Express 백엔드 서버 동시 구동
require('./app.js');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 1024,
    minHeight: 700,
    title: 'FCMS 관리자 시스템',
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

  // 현재 구동 중인 로컬 서버 페이지 로드
  mainWindow.loadURL('http://localhost:3333/mgr/login');

  mainWindow.on('closed', function () {
    mainWindow = null;
  });
}

app.whenReady().then(function () {
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

  // 웹뷰 및 모든 렌더러에 알럿/팝업 원천 차단 선제 스크립트 자동 등록
  const preloadScriptPath = path.join(__dirname, 'static', 'js', 'webview-preload.js');
  try {
    if (typeof session.defaultSession.registerPreloadScript === 'function') {
      session.defaultSession.registerPreloadScript({ filePath: preloadScriptPath });
    } else if (typeof session.defaultSession.setPreloads === 'function') {
      session.defaultSession.setPreloads([preloadScriptPath]);
    }
  } catch (e) {}

  // FCMS 결과 파일은 일반 다운로드로 허용하고, 외부 사이트의 다운로드는 계속 차단합니다.
  session.defaultSession.on('will-download', (event, item, webContents) => {
    const downloadUrl = item.getURL();
    const filename = item.getFilename();
    const isFcmsResultDownload = Boolean(
      mainWindow &&
      webContents === mainWindow.webContents &&
      /^result(?:_extra)?\.json$/i.test(filename) &&
      downloadUrl.startsWith('blob:http://localhost:3333/')
    );

    if (isFcmsResultDownload) {
      console.log('[Result JSON Download]:', filename);
      return;
    }

    console.log('[Auto Blocked Download]:', item.getURL(), item.getFilename());
    event.preventDefault();
  });

  // 외부 웹사이트(언론사, 공공기관 등)의 X-Frame-Options 및 frame-ancestors 보안 헤더 차단 해제
  // CPU 최적화: localhost 자체 요청 및 비HTML 리소스(이미지, CSS, JS, 폰트 등)는 즉시 통과
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    // localhost(자체 Express 서버) 요청은 헤더 가공 불필요 - 즉시 통과
    if (details.url.startsWith('http://localhost:')) {
      return callback({ cancel: false, responseHeaders: details.responseHeaders });
    }
    // 비HTML 리소스(이미지, CSS, JS, 폰트 등)는 X-Frame-Options 무관하므로 즉시 통과
    const ctHeader = details.responseHeaders['content-type'] || details.responseHeaders['Content-Type'];
    if (ctHeader) {
      const ct = Array.isArray(ctHeader) ? ctHeader[0] : ctHeader;
      if (ct && !ct.includes('text/html')) {
        return callback({ cancel: false, responseHeaders: details.responseHeaders });
      }
    }
    // HTML 응답만 X-Frame-Options / CSP frame-ancestors 헤더 제거
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

  // 모든 세션(신규 생성 세션 및 웹뷰 세션 포함)에 preload 스크립트 연결
  app.on('session-created', (sess) => {
    try {
      sess.setPreloads([preloadScriptPath]);
    } catch (e) {}
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
