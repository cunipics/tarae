/**
 * 불법광고 점검 및 탐지 대시보드 관리자 (detect-manager.js)
 * - 원래 No results state 룩앤필 완벽 복원 (돋보기 회전 + 텍스트 롤링)
 * - 브라우저 뷰어 박스 제거
 * - khan4019/tree-grid-directive 스타일의 계층형 트리 테이블 구현 (+/- 토글)
 * - 표준 result.json 생성 및 다운로드 지원
 */

(function () {
  // 상태 변수
  let isInspecting = false;
  let isPaused = false;
  let currentTargetUrl = '';
  let activeMasterId = null;
  let loadedHistoryMasterId = null;
  let activeCms = null;
  let elapsedTimer = null;
  let fastScanInterval = null;
  let elapsedSec = 0;
  let scannedCount = 0;
  let activeTabType = 'ALL';

  // 점검 중 수집된 데이터 저장소
  let findings = [];
  let treeNodes = [];

  // 이번 탐지 턴 임시 키워드 저장소
  let tempPollutedKeywords = [];
  let tempAllowedKeywords = [];

  // DOM 요소 캐시
  const inputUrl = document.getElementById('detect-url-input');
  const inputTempPolluted = document.getElementById('input-temp-polluted');
  const listTempPolluted = document.getElementById('list-temp-polluted');
  const inputTempAllowed = document.getElementById('input-temp-allowed');
  const listTempAllowed = document.getElementById('list-temp-allowed');
  const btnStart = document.getElementById('btn-start-detect');
  const feedbackEl = document.getElementById('url-validation-feedback');
  const iconSpin = document.getElementById('icon-detect-spin');
  const textUrl = document.getElementById('text-current-url');
  const textStep = document.getElementById('text-current-step');
  const btnToggle = document.getElementById('btn-toggle-detect');
  const textBtnToggle = document.getElementById('text-btn-toggle');
  const listContainer = document.getElementById('finding-list-container');
  const summaryViolationCnt = document.getElementById('summary-violation-cnt');
  const summaryElapsedTime = document.getElementById('summary-elapsed-time');
  const btnExportJson = document.getElementById('btn-export-json');
  const historyExcludeOption = document.getElementById('history-exclude-option');
  const excludeHistoryUrls = document.getElementById('exclude-history-urls');
  const excludeHistoryUrlsLabel = document.getElementById('exclude-history-urls-label');

  // Tree Grid 요소
  const treeGridBody = document.getElementById('tree-grid-body');
  const treeTotalBadge = document.getElementById('tree-total-badge');

  // 탐지 진행률 및 프로세스바 DOM 캐시
  const progressWrapper = document.getElementById('detect-progress-wrapper');
  const progressLabel = document.getElementById('detect-progress-label');
  const progressPct = document.getElementById('detect-progress-pct');
  const progressBar = document.getElementById('detect-progress-bar');

  // 실시간 점검 브라우저 팝업 레이어 DOM 캐시
  const liveBrowserOverlay = document.getElementById('live-browser-overlay');
  const liveBrowserTitle = document.getElementById('live-browser-title');
  const liveBrowserBadge = document.getElementById('live-browser-badge');
  const liveBrowserUrl = document.getElementById('live-browser-url');
  const liveBrowserWebview = document.getElementById('live-browser-webview');
  const liveBrowserIframe = document.getElementById('live-browser-iframe');
  const liveBrowserLoading = document.getElementById('live-browser-loading');
  const liveBrowserLoadingText = document.getElementById('live-browser-loading-text');
  const liveBrowserPulse = document.getElementById('live-browser-pulse');
  const btnLiveBrowserMin = document.getElementById('btn-live-browser-min');
  const btnLiveBrowserExpand = document.getElementById('btn-live-browser-expand');
  const btnLiveBrowserClose = document.getElementById('btn-live-browser-close');
  const liveBrowserBody = document.getElementById('live-browser-body');
  const liveBrowserHeader = document.getElementById('live-browser-header');
  const liveBrowserResizerTop = document.getElementById('live-browser-resizer-top');
  const liveBrowserResizerBottom = document.getElementById('live-browser-resizer-bottom');

  let isBrowserMinimized = false;
  let isBrowserExpanded = false;
  let lastLoadedBrowserUrl = '';
  let pendingLiveBrowserUrl = '';
  let liveBrowserLoadPromise = null;
  let liveBrowserRecoveryTimer = null;
  let knownSearchInProgress = false;
  let skipKnownSearchRequested = false;

  function setLiveBrowserLoading(visible, message) {
    if (liveBrowserLoadingText && message) liveBrowserLoadingText.textContent = message;
    if (liveBrowserLoading) liveBrowserLoading.classList.toggle('d-none', !visible);
  }

  async function drainLiveBrowserQueue() {
    if (knownSearchInProgress || liveBrowserLoadPromise || !pendingLiveBrowserUrl) return;

    const targetUrl = pendingLiveBrowserUrl;
    pendingLiveBrowserUrl = '';
    lastLoadedBrowserUrl = targetUrl;
    setLiveBrowserLoading(true, '현재 점검 페이지를 불러오는 중...');

    const loadTask = (async () => {
      try {
        if (typeof liveBrowserWebview.loadURL === 'function') {
          await liveBrowserWebview.loadURL(targetUrl);
        } else {
          liveBrowserWebview.src = targetUrl;
        }
      } catch (err) {
        if (!err || (err.code !== 'ERR_ABORTED' && err.errno !== -3)) {
          console.warn('[Webview] 페이지 표시 실패:', targetUrl, err && err.message ? err.message : err);
        }
      }
    })();

    liveBrowserLoadPromise = loadTask;
    try {
      await loadTask;
    } finally {
      if (liveBrowserLoadPromise === loadTask) liveBrowserLoadPromise = null;
      setLiveBrowserLoading(false);
      if (pendingLiveBrowserUrl && pendingLiveBrowserUrl !== lastLoadedBrowserUrl) {
        drainLiveBrowserQueue();
      }
    }
  }

  // 탐지 속도가 화면 로딩보다 빨라도 진행 중인 로딩을 취소하지 않고 가장 최신 주소만 이어서 표시합니다.
  function loadUrlInLiveViewer(targetUrl) {
    if (!targetUrl) return;
    if (liveBrowserUrl) liveBrowserUrl.textContent = targetUrl;

    const isElectronWebviewAvailable = liveBrowserWebview && (typeof liveBrowserWebview.loadURL === 'function' || liveBrowserWebview.tagName === 'WEBVIEW');
    if (isElectronWebviewAvailable) {
      if (targetUrl === lastLoadedBrowserUrl && !liveBrowserLoadPromise) return;
      pendingLiveBrowserUrl = targetUrl;
      drainLiveBrowserQueue();
      // webview가 동작 중일 때는 iframe에 중복 로드하지 않음 (알럿 중복 팝업 원천 차단)
      if (liveBrowserIframe) {
        liveBrowserIframe.src = 'about:blank';
      }
    } else if (liveBrowserIframe) {
      if (targetUrl === lastLoadedBrowserUrl) return;
      lastLoadedBrowserUrl = targetUrl;
      liveBrowserIframe.src = targetUrl;
    }
  }

  function waitMs(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function readDuckDuckGoSearchPage(targetHost) {
    const state = await liveBrowserWebview.executeJavaScript(`(() => {
      const challenge = Boolean(document.querySelector('form[action*="anomaly"], .anomaly-modal'));
      const links = Array.from(document.querySelectorAll('a[href]')).map(anchor => anchor.href);
      return { challenge, links };
    })()`);
    const urls = [];
    for (const href of (state && state.links) || []) {
      try {
        let parsed = new URL(href, 'https://lite.duckduckgo.com/');
        if ((parsed.hostname === 'duckduckgo.com' || parsed.hostname.endsWith('.duckduckgo.com')) && parsed.searchParams.has('uddg')) {
          parsed = new URL(parsed.searchParams.get('uddg'));
        }
        if (parsed.hostname.replace(/^www\./, '') === targetHost) urls.push(parsed.href);
      } catch (e) {}
    }
    return { challenge: Boolean(state && state.challenge), urls };
  }

  async function showKoreanDuckDuckGoChallengeGuide() {
    try {
      await liveBrowserWebview.executeJavaScript(`(() => {
        const title = document.querySelector('.anomaly-modal__title');
        const description = document.querySelector('.anomaly-modal__description');
        const instructions = document.querySelector('.anomaly-modal__instructions');
        const submit = document.querySelector('.anomaly-modal button[type="submit"], .anomaly-modal input[type="submit"]');
        if (title) title.textContent = '자동 검색 방지를 위한 사람 확인';
        if (description) description.textContent = '알려진 검색을 사용하려면 아래 문제를 한 번 완료해 주세요.';
        if (instructions) instructions.textContent = '오리가 있는 모든 칸을 선택하세요.';
        if (submit) {
          if (submit.tagName === 'INPUT') submit.value = '확인';
          else submit.textContent = '확인';
        }
      })()`);
    } catch (e) {}
  }

  async function collectKnownSearchUrls(targetUrl, requestDelayMs) {
    if (!liveBrowserWebview || typeof liveBrowserWebview.loadURL !== 'function' ||
        typeof liveBrowserWebview.executeJavaScript !== 'function') {
      return { completed: false, urls: [] };
    }

    let keywords = [];
    try {
      const response = await fetch('/mgr/api/detect/search-keywords');
      const json = await response.json();
      keywords = json && json.success && json.data && Array.isArray(json.data.keywords)
        ? json.data.keywords
        : [];
    } catch (e) {
      return { completed: false, urls: [] };
    }

    const targetHost = new URL(targetUrl).hostname.replace(/^www\./, '');
    const found = new Set();
    let challengeNoticeShown = false;
    knownSearchInProgress = true;
    skipKnownSearchRequested = false;
    if (liveBrowserOverlay) liveBrowserOverlay.classList.remove('d-none');
    if (liveBrowserBody) liveBrowserBody.style.display = 'block';
    if (liveBrowserOverlay) liveBrowserOverlay.style.height = '440px';
    if (liveBrowserBadge) liveBrowserBadge.textContent = '알려진 검색';
    if (liveBrowserIframe) liveBrowserIframe.src = 'about:blank';

    for (const [keywordIndex, keyword] of keywords.entries()) {
      const query = `site:${targetHost} ${keyword}`;
      const searchUrl = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
      lastLoadedBrowserUrl = searchUrl;
      if (liveBrowserUrl) liveBrowserUrl.textContent = searchUrl;
      if (liveBrowserTitle) liveBrowserTitle.textContent = `알려진 검색 확인 중: ${query}`;
      if (textStep) textStep.textContent = `알려진 검색 확인 중: ${query}`;

      try {
        await liveBrowserWebview.loadURL(searchUrl);
        let pageState = await readDuckDuckGoSearchPage(targetHost);
        while (pageState.challenge && !skipKnownSearchRequested) {
          await showKoreanDuckDuckGoChallengeGuide();
          if (!challengeNoticeShown) {
            challengeNoticeShown = true;
            alert('알려진 검색을 활용하기 위해 사람 확인 문제를 한 번 풀어 주세요.');
          }
          if (liveBrowserTitle) liveBrowserTitle.textContent = '오리 사진을 선택하고 사람 확인을 완료해 주세요. 닫으면 알려진 검색을 건너뜁니다.';
          if (textStep) textStep.textContent = 'DuckDuckGo 사람 확인을 기다리는 중입니다.';
          await waitMs(1000);
          try {
            pageState = await readDuckDuckGoSearchPage(targetHost);
          } catch (e) {
            await waitMs(500);
          }
        }
        for (const resultUrl of pageState.urls) found.add(resultUrl);
      } catch (e) {}

      if (skipKnownSearchRequested) break;
      if (keywordIndex < keywords.length - 1 && requestDelayMs > 0) await waitMs(requestDelayMs);
    }

    knownSearchInProgress = false;
    if (liveBrowserTitle) liveBrowserTitle.textContent = `알려진 검색 완료: ${found.size}개 색인 URL 확보`;
    if (liveBrowserBadge) liveBrowserBadge.textContent = 'LIVE';
    loadUrlInLiveViewer(targetUrl);
    return { completed: true, urls: [...found] };
  }

  if (btnLiveBrowserMin && liveBrowserBody && liveBrowserOverlay) {
    btnLiveBrowserMin.addEventListener('click', function () {
      isBrowserMinimized = !isBrowserMinimized;
      if (isBrowserMinimized) {
        liveBrowserBody.style.display = 'none';
        liveBrowserOverlay.style.height = 'auto';
        liveBrowserOverlay.style.minHeight = 'auto';
        btnLiveBrowserMin.innerHTML = '<i class="bi bi-square"></i>';
      } else {
        liveBrowserBody.style.display = 'block';
        liveBrowserOverlay.style.height = isBrowserExpanded ? '92vh' : '720px';
        liveBrowserOverlay.style.minHeight = '250px';
        btnLiveBrowserMin.innerHTML = '<i class="bi bi-dash-lg"></i>';
      }
    });
  }

  if (btnLiveBrowserExpand && liveBrowserOverlay) {
    btnLiveBrowserExpand.addEventListener('click', function () {
      isBrowserExpanded = !isBrowserExpanded;
      if (isBrowserExpanded) {
        liveBrowserOverlay.style.width = '96vw';
        liveBrowserOverlay.style.height = '92vh';
        liveBrowserOverlay.style.left = '2vw';
        liveBrowserOverlay.style.top = '4vh';
        liveBrowserOverlay.style.right = 'auto';
        liveBrowserOverlay.style.bottom = 'auto';
        liveBrowserOverlay.style.maxHeight = 'none';
        btnLiveBrowserExpand.innerHTML = '<i class="bi bi-arrows-angle-contract"></i>';
      } else {
        liveBrowserOverlay.style.width = '1200px';
        liveBrowserOverlay.style.height = '720px';
        liveBrowserOverlay.style.right = '20px';
        liveBrowserOverlay.style.bottom = '20px';
        liveBrowserOverlay.style.left = 'auto';
        liveBrowserOverlay.style.top = 'auto';
        btnLiveBrowserExpand.innerHTML = '<i class="bi bi-arrows-angle-expand"></i>';
      }
    });
  }

  if (btnLiveBrowserClose && liveBrowserOverlay) {
    btnLiveBrowserClose.addEventListener('click', function () {
      if (knownSearchInProgress) skipKnownSearchRequested = true;
      liveBrowserOverlay.classList.add('d-none');
    });
  }

  // [실시간 점검 브라우저 창 마우스 드래그 이동 핸들러]
  if (liveBrowserHeader && liveBrowserOverlay) {
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let windowStartLeft = 0;
    let windowStartTop = 0;

    liveBrowserHeader.addEventListener('mousedown', function (e) {
      if (e.target.closest('button')) return; // 헤더 내부 버튼 클릭 시 이동 시작 방지
      if (isBrowserExpanded) return; // 전체화면 모드 시 이동 방지

      isDragging = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;

      const rect = liveBrowserOverlay.getBoundingClientRect();
      windowStartLeft = rect.left;
      windowStartTop = rect.top;

      // right, bottom 고정 스타일을 해제하고 현재 left, top 절대 픽셀로 변환
      liveBrowserOverlay.style.left = windowStartLeft + 'px';
      liveBrowserOverlay.style.top = windowStartTop + 'px';
      liveBrowserOverlay.style.right = 'auto';
      liveBrowserOverlay.style.bottom = 'auto';

      // 드래그 중 내부 webview/iframe이 마우스 이벤트를 가로채는 현상 방지
      if (liveBrowserWebview) liveBrowserWebview.style.pointerEvents = 'none';
      if (liveBrowserIframe) liveBrowserIframe.style.pointerEvents = 'none';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    window.addEventListener('mousemove', function (e) {
      if (!isDragging) return;

      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;

      const maxLeft = Math.max(0, window.innerWidth - 150);
      const maxTop = Math.max(0, window.innerHeight - 50);

      const newLeft = Math.max(0, Math.min(maxLeft, windowStartLeft + dx));
      const newTop = Math.max(0, Math.min(maxTop, windowStartTop + dy));

      liveBrowserOverlay.style.left = newLeft + 'px';
      liveBrowserOverlay.style.top = newTop + 'px';
    });

    window.addEventListener('mouseup', function () {
      if (isDragging) {
        isDragging = false;
        if (liveBrowserWebview) liveBrowserWebview.style.pointerEvents = 'auto';
        if (liveBrowserIframe) liveBrowserIframe.style.pointerEvents = 'auto';
        document.body.style.userSelect = '';
      }
    });
  }

  // [실시간 점검 브라우저 상하 리사이즈 핸들러]
  if (liveBrowserOverlay) {
    let isResizingTop = false;
    let isResizingBottom = false;
    let resizeStartY = 0;
    let resizeStartTop = 0;
    let resizeStartHeight = 0;

    function startVerticalResize(e, isTop) {
      if (isBrowserMinimized || isBrowserExpanded) return;

      const rect = liveBrowserOverlay.getBoundingClientRect();
      resizeStartTop = rect.top;
      resizeStartHeight = rect.height;
      resizeStartY = e.clientY;

      liveBrowserOverlay.style.left = rect.left + 'px';
      liveBrowserOverlay.style.top = resizeStartTop + 'px';
      liveBrowserOverlay.style.height = resizeStartHeight + 'px';
      liveBrowserOverlay.style.right = 'auto';
      liveBrowserOverlay.style.bottom = 'auto';
      liveBrowserOverlay.style.maxHeight = 'none';

      if (isTop) {
        isResizingTop = true;
      } else {
        isResizingBottom = true;
      }

      if (liveBrowserWebview) liveBrowserWebview.style.pointerEvents = 'none';
      if (liveBrowserIframe) liveBrowserIframe.style.pointerEvents = 'none';
      document.body.style.userSelect = 'none';
      e.preventDefault();
      e.stopPropagation();
    }

    if (liveBrowserResizerTop) {
      liveBrowserResizerTop.addEventListener('mousedown', function (e) {
        startVerticalResize(e, true);
      });
    }

    if (liveBrowserResizerBottom) {
      liveBrowserResizerBottom.addEventListener('mousedown', function (e) {
        startVerticalResize(e, false);
      });
    }

    window.addEventListener('mousemove', function (e) {
      if (isResizingTop) {
        const dy = e.clientY - resizeStartY;
        const minH = 250;
        const maxH = window.innerHeight - 30;

        let newHeight = resizeStartHeight - dy;
        let newTop = resizeStartTop + dy;

        if (newTop < 10) {
          newHeight += (newTop - 10);
          newTop = 10;
        }
        if (newHeight < minH) {
          newTop = resizeStartTop + (resizeStartHeight - minH);
          newHeight = minH;
        }
        if (newHeight > maxH) {
          newTop = resizeStartTop - (maxH - resizeStartHeight);
          newHeight = maxH;
        }

        liveBrowserOverlay.style.top = newTop + 'px';
        liveBrowserOverlay.style.height = newHeight + 'px';
      } else if (isResizingBottom) {
        const dy = e.clientY - resizeStartY;
        const minH = 250;
        const maxH = window.innerHeight - resizeStartTop - 10;

        const newHeight = Math.max(minH, Math.min(maxH, resizeStartHeight + dy));
        liveBrowserOverlay.style.height = newHeight + 'px';
      }
    });

    window.addEventListener('mouseup', function () {
      if (isResizingTop || isResizingBottom) {
        isResizingTop = false;
        isResizingBottom = false;
        if (liveBrowserWebview) liveBrowserWebview.style.pointerEvents = 'auto';
        if (liveBrowserIframe) liveBrowserIframe.style.pointerEvents = 'auto';
        document.body.style.userSelect = '';
      }
    });
  }

  // 레이어 팝업으로 웹페이지 안전 열기 (OS 새 창 팝업 대신 레이어 팝업으로 완벽 대체)
  function openLiveBrowserUrl(targetUrl, titleText) {
    if (!targetUrl || targetUrl === '#') return;

    if (liveBrowserOverlay) {
      liveBrowserOverlay.classList.remove('d-none');
      if (liveBrowserBody) liveBrowserBody.style.display = 'block';
      if (btnLiveBrowserMin) btnLiveBrowserMin.innerHTML = '<i class="bi bi-dash-lg"></i>';
      isBrowserMinimized = false;
    }

    const titleEl = document.getElementById('live-browser-title');
    if (titleEl) {
      titleEl.textContent = titleText ? `웹페이지 뷰어: ${titleText}` : '실시간 점검 브라우저 (PC 규격 뷰어)';
      titleEl.title = titleText || targetUrl;
    }

    const liveUrlSpan = document.getElementById('live-browser-url');
    if (liveUrlSpan) {
      liveUrlSpan.textContent = targetUrl;
      liveUrlSpan.title = targetUrl;
    }

    if (liveBrowserWebview) {
      try {
        if (typeof liveBrowserWebview.loadURL === 'function') {
          liveBrowserWebview.loadURL(targetUrl);
        } else {
          liveBrowserWebview.src = targetUrl;
        }
      } catch (err) {
        liveBrowserWebview.src = targetUrl;
      }
    }
  }

  // 실시간 웹뷰 내부의 alert, confirm, prompt 창 및 팝업 원천 차단 처리
  if (liveBrowserWebview) {
    // 팝업(새 창) 차단
    liveBrowserWebview.addEventListener('new-window', function (e) {
      e.preventDefault();
      console.log('[Webview] 광고 팝업 차단:', e.url);
    });

    const blockScript = `
      (function() {
        try {
          Object.defineProperty(window, 'alert', { value: function(m){ console.log('[차단 Alert]:', m); }, writable: false, configurable: false });
          Object.defineProperty(window, 'confirm', { value: function(m){ console.log('[차단 Confirm]:', m); return true; }, writable: false, configurable: false });
          Object.defineProperty(window, 'prompt', { value: function(m){ console.log('[차단 Prompt]:', m); return null; }, writable: false, configurable: false });
          Object.defineProperty(window, 'open', { value: function(u){ console.log('[차단 window.open]:', u); return null; }, writable: false, configurable: false });
          window.onbeforeunload = null;
        } catch (e) {}
      })();
    `;

    liveBrowserWebview.addEventListener('did-start-navigation', function () {
      try { liveBrowserWebview.executeJavaScript(blockScript); } catch (e) {}
    });

    liveBrowserWebview.addEventListener('dom-ready', function () {
      try { liveBrowserWebview.executeJavaScript(blockScript); } catch (e) {}
    });

    liveBrowserWebview.addEventListener('did-finish-load', function () {
      setLiveBrowserLoading(false);
    });

    liveBrowserWebview.addEventListener('did-fail-load', function (event) {
      if (event && event.errorCode === -3) return;
      setLiveBrowserLoading(false);
      console.warn('[Webview] 페이지 로딩 실패:', event && event.validatedURL, event && event.errorDescription);
    });

    liveBrowserWebview.addEventListener('render-process-gone', function () {
      const recoveryUrl = pendingLiveBrowserUrl || currentTargetUrl || lastLoadedBrowserUrl;
      pendingLiveBrowserUrl = recoveryUrl;
      lastLoadedBrowserUrl = '';
      liveBrowserLoadPromise = null;
      setLiveBrowserLoading(true, '실시간 화면을 다시 연결하는 중...');

      if (liveBrowserRecoveryTimer) clearTimeout(liveBrowserRecoveryTimer);
      liveBrowserRecoveryTimer = setTimeout(function () {
        try {
          if (typeof liveBrowserWebview.reload === 'function') liveBrowserWebview.reload();
        } catch (e) {}
        drainLiveBrowserQueue();
      }, 500);
    });
  }

  // 엄격한 URL 유효성 검증 함수 (www 등 미완성 주소 차단)
  function isValidUrl(val) {
    if (!val) return false;
    const trimmed = val.trim();

    // 1. http:// 또는 https:// 프로토콜 시작 확인
    if (!/^https?:\/\//i.test(trimmed)) return false;

    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

      const host = parsed.hostname;
      if (!host) return false;

      // 2. localhost 허용
      if (host.toLowerCase() === 'localhost') return true;

      // 3. IPv4 주소 허용 (예: 127.0.0.1, 192.168.0.1)
      if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) return true;

      // 4. 정식 도메인 형식 검증 (온점 포함 필수, 최상위 도메인 TLD 2자리 이상 알파벳)
      // 통과: example.com, test.go.kr / 탈락: www, test, example.
      const domainPattern = /^([a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
      return domainPattern.test(host);
    } catch (e) {
      return false;
    }
  }

  // 1. URL 입력 시 실시간 검증 및 버튼 활성화
  function handleUrlInput() {
    const val = (inputUrl.value || '').trim();
    if (isValidUrl(val)) {
      btnStart.disabled = false;
      btnStart.className = 'btn btn-primary px-4 fw-semibold shadow-sm';
      feedbackEl.className = 'form-text mt-1 text-success fw-semibold';
      feedbackEl.innerHTML = '<i class="bi bi-check-circle me-1"></i>올바른 웹사이트 주소입니다. [탐지 시작]을 눌러주세요.';
    } else {
      btnStart.disabled = true;
      btnStart.className = 'btn btn-secondary px-4 fw-semibold';
      feedbackEl.className = 'form-text mt-1 text-muted';
      feedbackEl.textContent = val.length === 0
        ? '점검을 시작할 공공 웹사이트의 전체 주소(https://...)를 입력해 주세요.'
        : '올바른 형식의 웹사이트 주소를 입력해 주세요. (예: https://www.example.go.kr/board/list)';
    }
  }

  function showHistoryExcludeOption(masterId, historyNodes, historyFindings) {
    loadedHistoryMasterId = masterId || null;
    if (!loadedHistoryMasterId || !historyExcludeOption || !excludeHistoryUrls) return;

    const historyUrls = new Set();
    for (const item of [...(historyNodes || []), ...(historyFindings || [])]) {
      const value = String((item && item.url) || '').replace(/\\%/g, '%').trim();
      if (value) historyUrls.add(value);
    }

    excludeHistoryUrls.checked = true;
    historyExcludeOption.classList.remove('d-none');
    if (excludeHistoryUrlsLabel) {
      excludeHistoryUrlsLabel.textContent = `이전 탐지 URL 제외 (${historyUrls.size}개)`;
    }
  }

  // 2. 검색 진행 상태 카드 UI 상태 제어
  function setDetectUIState(state) {
    if (state === 'planning') {
      iconSpin.classList.add('spin-anim');
      iconSpin.classList.remove('text-secondary', 'text-warning', 'text-success');
      iconSpin.classList.add('text-info');
      btnToggle.classList.remove('d-none');
      btnToggle.disabled = false;
      btnToggle.className = 'btn btn-sm btn-outline-danger px-3';
      textBtnToggle.textContent = '점검 중지';
      btnStart.disabled = true;

      if (progressWrapper) progressWrapper.classList.remove('d-none');
      if (progressLabel) progressLabel.textContent = '탐지 계획 수립 중...';
      if (progressPct) progressPct.textContent = '사전 탐색 중';
      if (progressBar) {
        progressBar.style.width = '100%';
        progressBar.className = 'progress-bar progress-bar-striped progress-bar-animated bg-info';
      }
    } else if (state === 'running') {
      iconSpin.classList.add('spin-anim');
      iconSpin.classList.remove('text-secondary', 'text-warning', 'text-success', 'text-info');
      iconSpin.classList.add('text-primary');
      btnToggle.classList.remove('d-none');
      btnToggle.disabled = false;
      btnToggle.className = 'btn btn-sm btn-outline-danger px-3';
      textBtnToggle.textContent = '점검 중지';
      btnStart.disabled = true;

      if (progressWrapper) progressWrapper.classList.remove('d-none');
      if (progressBar) {
        progressBar.className = 'progress-bar progress-bar-striped progress-bar-animated bg-primary';
      }
    } else if (state === 'paused') {
      iconSpin.classList.remove('spin-anim');
      iconSpin.classList.remove('text-primary', 'text-success', 'text-info');
      iconSpin.classList.add('text-warning');
      btnToggle.classList.remove('d-none');
      btnToggle.disabled = false;
      btnToggle.className = 'btn btn-sm btn-outline-primary px-3';
      textBtnToggle.textContent = '점검 재개';
    } else if (state === 'completed') {
      iconSpin.classList.remove('spin-anim');
      iconSpin.classList.remove('text-primary', 'text-warning', 'text-info');
      iconSpin.classList.add('text-success');
      btnToggle.classList.remove('d-none');
      btnToggle.disabled = false;
      btnToggle.className = 'btn btn-sm btn-outline-primary px-3';
      textBtnToggle.textContent = '새로운 탐지 준비';
      textUrl.textContent = '전체 하위 페이지 및 요소 점검 완료';
      textUrl.title = '전체 하위 페이지 및 요소 점검 완료';
      textStep.textContent = '4대 은닉 기법 정밀 분석 완료';
      textStep.title = '4대 은닉 기법(자모, 닮은꼴, 투명, 화면밖) 정밀 분석이 완료되었습니다. 결과 파일을 저장할 수 있습니다.';
      btnStart.disabled = false;

      if (progressWrapper) progressWrapper.classList.remove('d-none');
      if (progressBar) {
        progressBar.style.width = '100%';
        progressBar.className = 'progress-bar bg-success';
      }
      if (progressLabel) progressLabel.textContent = '전체 탐지 점검 완료';
      if (progressPct) progressPct.textContent = '100%';
    } else {
      // 초기 대기 상태 (탐지 시작 전: 버튼 숨김, 사용자 지정 문구 표출)
      iconSpin.classList.remove('spin-anim', 'text-primary', 'text-success', 'text-warning', 'text-info');
      iconSpin.classList.add('text-secondary');
      textUrl.textContent = '이곳에 검색중인 URL이 표시됩니다.';
      textUrl.title = '이곳에 검색중인 URL이 표시됩니다.';
      textStep.textContent = '이곳에 검색중인 광고기법이 표시됩니다.';
      textStep.title = '이곳에 검색중인 광고기법이 표시됩니다.';
      btnToggle.classList.add('d-none');
      btnToggle.disabled = true;
      btnStart.disabled = !isValidUrl(inputUrl.value);

      if (progressWrapper) progressWrapper.classList.add('d-none');
      if (progressBar) progressBar.style.width = '0%';
    }

    // 점검 진행 상태에 따른 키워드 입력창 및 URL 입력창 활성화/비활성화 제어
    const isBusy = (state === 'planning' || state === 'running' || state === 'paused');
    if (inputUrl) inputUrl.disabled = isBusy;
    if (inputTempPolluted) inputTempPolluted.disabled = isBusy;
    if (inputTempAllowed) inputTempAllowed.disabled = isBusy;
    if (excludeHistoryUrls) excludeHistoryUrls.disabled = isBusy;
    renderKeywordTags('polluted');
    renderKeywordTags('allowed');
  }

  // 점검 옵션 DOM 캐시
  const selectSpeedDelay = document.getElementById('select-speed-delay');
  const selectMaxPages = document.getElementById('select-max-pages');
  let pollInterval = null;
  const processedFindingIds = new Set();
  const processedNodeUids = new Set();

  // 3. 점검 시작
  async function startInspection(skipConfirm = false) {
    const url = (inputUrl.value || '').trim();
    if (!isValidUrl(url)) {
      alert('올바른 웹사이트 URL을 입력해 주세요.');
      return;
    }

    if (window.checkLLMReady && !window.checkLLMReady('AI 탐지 모델이 준비되는 동안 잠시만 기다려 주세요.')) {
      return;
    }

    const selectDelayEl = document.getElementById('select-speed-delay');
    const selectTimeEl = document.getElementById('select-max-time');
    const speedDelayMs = selectDelayEl ? Number(selectDelayEl.value) || 500 : 500;
    const maxTimeSec = selectTimeEl ? Number(selectTimeEl.value) || 1800 : 1800;
    const maxMinutesText = Math.floor(maxTimeSec / 60) + '분';
    const speedText = (speedDelayMs / 1000).toFixed(1) + '초 딜레이';
    const excludeHistoryMasterId = loadedHistoryMasterId && excludeHistoryUrls && excludeHistoryUrls.checked
      ? loadedHistoryMasterId
      : null;

    if (!skipConfirm) {
      const confirmMsg = `입력하신 공공 웹사이트에 대해 불법광고 전체 점검을 시작하시겠습니까?\n\n` +
        `점검 대상: ${url}\n` +
        `점검 속도: ${speedText} (서버 부하 및 차단 방지)\n` +
        `점검 시간: ${maxMinutesText} (지정 시간 동안 깊이 있게 탐색)` +
        (excludeHistoryMasterId ? `\n이전 탐지 URL: 제외` : '');

      if (!confirm(confirmMsg)) {
        return;
      }
    }

    // 상태 초기화
    if (pollInterval) clearInterval(pollInterval);
    isInspecting = true;
    isPaused = false;
    currentTargetUrl = url;
    activeMasterId = null;
    activeCms = null;
    elapsedSec = 0;
    scannedCount = 0;
    findings = [];
    treeNodes = [];
    processedFindingIds.clear();
    processedNodeUids.clear();
    lastLoadedBrowserUrl = '';
    pendingLiveBrowserUrl = '';
    clearFindingsUrlFilter();

    // 새 점검마다 이전 사이트의 렌더링 상태와 방문 기록을 비웁니다.
    if (liveBrowserRecoveryTimer) {
      clearTimeout(liveBrowserRecoveryTimer);
      liveBrowserRecoveryTimer = null;
    }
    if (liveBrowserWebview) {
      try {
        if (typeof liveBrowserWebview.stop === 'function') liveBrowserWebview.stop();
        if (typeof liveBrowserWebview.loadURL === 'function') {
          await liveBrowserWebview.loadURL('about:blank');
        } else {
          liveBrowserWebview.src = 'about:blank';
        }
        if (typeof liveBrowserWebview.clearHistory === 'function') liveBrowserWebview.clearHistory();
      } catch (e) {}
      liveBrowserLoadPromise = null;
    }
    if (liveBrowserIframe) liveBrowserIframe.src = 'about:blank';
    if (liveBrowserOverlay) liveBrowserOverlay.classList.add('d-none');

    summaryViolationCnt.textContent = '0';
    summaryElapsedTime.textContent = '0';
    listContainer.innerHTML = '';
    treeGridBody.innerHTML = '';
    updateTabCounts();

    // 1단계: 기존 탐지 브라우저에서 알려진 검색을 먼저 보여준 뒤 탐지 계획 수립
    setDetectUIState('planning');
    textUrl.textContent = url;
    textStep.textContent = '알려진 검색 준비 중...';

    try {
      const knownSearch = await collectKnownSearchUrls(url, speedDelayMs);
      const res = await fetch('/mgr/api/detect/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          speedDelayMs,
          maxTimeSec,
          maxPages: 5000,
          tempPollutedKeywords,
          tempAllowedKeywords,
          knownSearchUrls: knownSearch.urls,
          knownSearchCompleted: knownSearch.completed,
          excludeHistoryMasterId
        })
      });
      const data = await res.json();
      if (!data.success) {
        alert('점검 시작 실패: ' + (data.message || '서버 오류'));
        setDetectUIState('idle');
        isInspecting = false;
        return;
      }

      // 백엔드 상태 실시간 폴링 시작
      startRealtimePolling();
    } catch (err) {
      alert('서버 통신 실패: ' + err.message);
      setDetectUIState('idle');
      isInspecting = false;
    }
  }

  // 4. 실시간 백엔드 상태 폴링 엔진
  function startRealtimePolling() {
    if (pollInterval) clearInterval(pollInterval);

    pollInterval = setInterval(async function () {
      if (!isInspecting) {
        clearInterval(pollInterval);
        return;
      }

      try {
        const res = await fetch('/mgr/api/detect/status');
        const json = await res.json();
        if (!json.success || !json.data) return;

        const data = json.data;
        // 다른 사이트 점검 결과가 잔류하여 오작동하지 않도록 대상 도메인 유효성 검증
        if (currentTargetUrl && data.entryUrl) {
          try {
            const curHost = new URL(currentTargetUrl).hostname.replace(/^www\./, '');
            const resHost = new URL(data.entryUrl).hostname.replace(/^www\./, '');
            if (curHost !== resHost) return;
          } catch (e) {}
        }
        activeMasterId = data.masterId || activeMasterId;
        activeCms = data.detectedCms || activeCms;

        // 경과 시간 및 현재 URL/단계 업데이트
        if (typeof data.elapsedSec === 'number') {
          elapsedSec = data.elapsedSec;
          summaryElapsedTime.textContent = elapsedSec;
        }
        if (data.currentUrl) {
          textUrl.textContent = data.currentUrl;
          textUrl.title = data.currentUrl;

          // 정밀 검출 단계일 때만 실시간 브라우저 뷰어 URL 동기화
          if (data.status === 'RUNNING') {
            loadUrlInLiveViewer(data.currentUrl);
          }
        }
        if (data.currentStep) {
          textStep.textContent = data.currentStep;
          textStep.title = data.currentStep;
          if (liveBrowserTitle) liveBrowserTitle.textContent = data.currentStep;
        }

        // 1단계 (탐지 계획 수립 중) UI 처리
        if (data.status === 'PLANNING') {
          if (progressWrapper) progressWrapper.classList.remove('d-none');
          if (progressLabel) progressLabel.textContent = data.currentStep || '탐지 계획 수립 중...';
          if (progressPct) progressPct.textContent = data.planningProgress || '분석 중';
          if (progressBar) {
            progressBar.className = 'progress-bar progress-bar-striped progress-bar-animated bg-info';
            progressBar.style.width = '100%';
          }
        }
        // 2단계 (본격 정밀 검출 및 저장 시작) UI 처리
        else if (data.status === 'RUNNING') {
          if (iconSpin && iconSpin.classList.contains('text-info')) {
            setDetectUIState('running');
          }
          // 계획 수립 완료 시 실시간 브라우저 팝업 레이어 오픈
          if (liveBrowserOverlay && liveBrowserOverlay.classList.contains('d-none')) {
            liveBrowserOverlay.classList.remove('d-none');
            if (liveBrowserBody) liveBrowserBody.style.display = 'block';
            liveBrowserOverlay.style.height = '440px';
            if (liveBrowserPulse) {
              liveBrowserPulse.className = 'spinner-grow spinner-grow-sm text-success flex-shrink-0';
            }
            if (liveBrowserBadge) liveBrowserBadge.textContent = 'LIVE';
            loadUrlInLiveViewer(data.currentUrl || currentTargetUrl);
          }

          if (progressWrapper) progressWrapper.classList.remove('d-none');
          if (progressBar) {
            progressBar.className = 'progress-bar progress-bar-striped progress-bar-animated bg-primary';
          }
          const currentCnt = data.totalVisited || (data.recentNodes ? data.recentNodes.length : 0);
          const remaining = typeof data.remainingQueueCount === 'number' ? data.remainingQueueCount : 0;
          const totalPlan = Math.max(currentCnt + remaining, data.targetPlanCount || data.articleBufferCap || 2800);
          const pct = Math.min(100, Math.max(1, Math.round((currentCnt / Math.max(1, totalPlan)) * 100)));
          if (progressBar) progressBar.style.width = Math.max(3, pct) + '%';
          if (progressPct) progressPct.textContent = pct + '%';
          if (progressLabel) {
            progressLabel.textContent = `정밀 검출 및 저장 진행 중 (${currentCnt} / ${totalPlan}건)`;
          }
        }

        // 새로 추가된 트리 노드 반영
        if (Array.isArray(data.recentNodes)) {
          for (const node of data.recentNodes) {
            if (!processedNodeUids.has(node.uid)) {
              addNodeToTreeGrid(node);
              processedNodeUids.add(node.uid);
            }
          }
        }

        // 새로 추가된 위반 항목 반영
        if (Array.isArray(data.findings)) {
          for (const item of data.findings) {
            if (!processedFindingIds.has(item.id)) {
              processedFindingIds.add(item.id);
              addFinding(item);
            }
          }
        }

        // 점검 완료 처리
        if (data.status === 'COMPLETED') {
          clearInterval(pollInterval);
          isInspecting = false;
          setDetectUIState('completed');

          // 전체 하위 페이지 및 요소 점검 완료 시 팝업 창을 강제로 닫지 않고 유지하여 사용자가 최종 점검 상태를 확인할 수 있도록 보장
          if (liveBrowserBadge) {
            liveBrowserBadge.textContent = '점검완료';
            liveBrowserBadge.className = 'badge bg-success font-monospace small px-2 py-0';
          }
          if (liveBrowserPulse) {
            liveBrowserPulse.className = 'spinner-grow spinner-grow-sm text-secondary flex-shrink-0';
          }
        } else if (data.status === 'STOPPED') {
          clearInterval(pollInterval);
          isInspecting = false;
          setDetectUIState('idle');

          if (liveBrowserBadge) {
            liveBrowserBadge.textContent = '점검중단';
            liveBrowserBadge.className = 'badge bg-warning font-monospace small px-2 py-0';
          }
          if (liveBrowserPulse) {
            liveBrowserPulse.className = 'spinner-grow spinner-grow-sm text-secondary flex-shrink-0';
          }
        } else if (data.status === 'PAUSED') {
          isPaused = true;
          setDetectUIState('paused');
        }
      } catch (pollErr) {
        console.warn('[Polling Error]', pollErr);
      }
    }, 1000);
  }


  // 5. 브라우저 인스펙터 팝업 레이어 연출 함수 (화면에서 요소를 직접 콕 짚어줌)
  function triggerInspectorPopup(tech, item, onFinish) {
    const overlay = document.getElementById('browser-inspector-overlay');
    const urlBar = document.getElementById('inspector-url-bar');
    const stepBadge = document.getElementById('inspector-step-badge');
    const focusBox = document.getElementById('inspector-focus-box');
    const focusLabel = document.getElementById('inspector-focus-label');
    const resultTitle = document.getElementById('inspector-result-title');
    const resultDetail = document.getElementById('inspector-result-detail');
    const viewport = document.getElementById('inspector-viewport');

    if (!overlay) {
      addNodeToTreeGrid(item.node);
      addFinding({
        id: item.finding.id,
        url: item.finding.url,
        is_violation: true,
        location: item.finding.location,
        evidence_text: item.finding.evidence,
        technique: item.finding.tech
      });
      onFinish && onFinish();
      return;
    }

    // 팝업 표시
    overlay.classList.remove('d-none');
    urlBar.textContent = item.finding.url;

    const targetElId = tech === 'TRANSPARENT' ? 'target-elem-transparent' : 'target-elem-offscreen';
    const targetEl = document.getElementById(targetElId);

    if (tech === 'TRANSPARENT') {
      stepBadge.textContent = '투명 텍스트(TRANSPARENT) 시각 은닉 정밀 검사';
      resultTitle.innerHTML = '<i class="bi bi-crosshair text-danger me-1"></i>투명 텍스트 은닉 요소 발견!';
      resultDetail.textContent = 'CSS 속성: color: #ffffff (배경색 동일) | 위치: ' + item.finding.location;
      focusLabel.textContent = '투명 은닉 텍스트 포착 (opacity:0 / 동일색)';
    } else {
      stepBadge.textContent = '화면 밖 은닉(OFFSCREEN) 좌표 은닉 정밀 검사';
      resultTitle.innerHTML = '<i class="bi bi-crosshair text-danger me-1"></i>화면 밖 은닉(iframe) 배너 발견!';
      resultDetail.textContent = 'CSS 속성: position: absolute; left: -9999px | 위치: ' + item.finding.location;
      focusLabel.textContent = '화면 밖 은닉 좌표 포착 (left: -9999px)';
    }

    // 타겟 요소 위치 계산하여 빨간색 포커스 박스로 콕 짚기
    setTimeout(function () {
      if (targetEl && focusBox) {
        const vpRect = viewport.getBoundingClientRect();
        const tRect = targetEl.getBoundingClientRect();

        focusBox.style.left = (targetEl.offsetLeft) + 'px';
        focusBox.style.top = (targetEl.offsetTop) + 'px';
        focusBox.style.width = (targetEl.offsetWidth) + 'px';
        focusBox.style.height = (targetEl.offsetHeight) + 'px';
        focusBox.classList.remove('d-none');
      }

      // 1.8초간 타겟팅 보여준 후 데이터 등록 및 닫기
      setTimeout(function () {
        addNodeToTreeGrid(item.node);
        addFinding({
          id: item.finding.id,
          url: item.finding.url,
          is_violation: true,
          location: item.finding.location,
          evidence_text: item.finding.evidence,
          technique: item.finding.tech
        });

        // 팝업 닫기
        setTimeout(function () {
          overlay.classList.add('d-none');
          if (focusBox) focusBox.classList.add('d-none');
          onFinish && onFinish();
        }, 600);
      }, 1600);
    }, 400);
  }

  // 5. Tree Grid 노드 추가 및 계층형 렌더링 (khan4019/tree-grid-directive 스타일)
  function addNodeToTreeGrid(node) {
    treeNodes.push(node);
    treeTotalBadge.textContent = treeNodes.length + '개 URL';

    const emptyRow = document.getElementById('tree-grid-empty');
    if (emptyRow) emptyRow.remove();

    const rawNodeName = node.pathSegment || node.path_segment || node.name || (node.url ? (new URL(node.url, 'http://localhost')).pathname : '/');
    let nodeName = String(rawNodeName || '').replace(/\\%/g, '%');
    try { nodeName = decodeURI(nodeName); } catch (e) {}
    const fullUrl = String(node.url || node.fullUrl || '#').replace(/\\%/g, '%');
    let nodeTitle = node.title || nodeName;
    try { nodeTitle = decodeURI(String(nodeTitle).replace(/\\%/g, '%')); } catch (e) {}
    const nodeStatus = node.status || node.http_status || 200;
    const nodeViolationCnt = (node.violationCnt !== undefined) ? node.violationCnt : (node.violation_cnt !== undefined ? node.violation_cnt : (node.hasViolation || node.has_violation ? 1 : 0));
    const tech = node.technique || (node.techniques && node.techniques.length > 0 ? node.techniques[0] : '-');
    const rawNodeDepth = node.level !== undefined ? node.level : node.depth;
    const parsedNodeDepth = Number.parseInt(rawNodeDepth, 10);
    const nodeDepth = Number.isFinite(parsedNodeDepth) && parsedNodeDepth >= 0 ? parsedNodeDepth : 0;

    const tr = document.createElement('tr');
    tr.className = `tree-grid-row level-${nodeDepth}`;
    tr.dataset.uid = node.uid || `node_${treeNodes.length}`;
    if (node.parentUid) tr.dataset.parentUid = node.parentUid;

    const indentPx = nodeDepth * 20;
    const toggleIcon = nodeDepth === 0
      ? `<i class="bi bi-folder2-open text-primary me-2"></i>`
      : `<i class="bi bi-file-earmark-text text-secondary me-2"></i>`;

    const violationBadge = nodeViolationCnt > 0
      ? `<button type="button" class="btn btn-sm btn-outline-danger py-0 px-2 fs-7 fw-bold tree-violation-btn" data-url="${escapeHtml(fullUrl)}" title="클릭하여 해당 URL의 위반 ${nodeViolationCnt}건 세부 목록을 펼쳐봅니다.">
           위반 ${nodeViolationCnt}건 <i class="bi bi-chevron-down ms-1 tree-violation-icon"></i>
         </button>`
      : `<span class="badge text-bg-success">정상</span>`;

    const techBadge = (tech && tech !== '-')
      ? `<span class="badge ${getTechBadgeClass(tech)}">${getTechLabel(tech)}</span>`
      : `<span class="text-muted">-</span>`;

    tr.innerHTML = `
      <td style="padding-left: ${indentPx + 12}px;">
        ${toggleIcon}
        <a href="${fullUrl}" class="text-decoration-none link-dark fw-semibold font-monospace small tree-node-link d-inline-block text-truncate align-middle" style="max-width: 380px;" title="${escapeHtml(fullUrl)}">
          ${escapeHtml(nodeName)}
        </a>
      </td>
      <td>
        <span class="small text-secondary text-truncate d-inline-block" style="max-width: 260px;" title="${escapeHtml(nodeTitle)}">
          ${escapeHtml(nodeTitle)}
        </span>
      </td>
      <td>
        <span class="badge text-bg-light border text-monospace">${nodeStatus} OK</span>
      </td>
      <td>
        ${violationBadge}
      </td>
      <td>
        ${techBadge}
      </td>
    `;

    treeGridBody.appendChild(tr);

    // 트리 노드 링크 클릭 시 OS 새 창 팝업 대신 안전한 레이어 팝업으로 즉시 열기
    const nodeLinkEl = tr.querySelector('.tree-node-link');
    if (nodeLinkEl && fullUrl && fullUrl !== '#') {
      nodeLinkEl.addEventListener('click', function (e) {
        e.preventDefault(); // OS 새 창(BrowserWindow) 팝업 생성을 원천 차단
        openLiveBrowserUrl(fullUrl, nodeName);
      });
    }

    // 위반 건수 버튼 클릭 시: 해당 행 아래에 세부 위반 항목 아코디언 펼침 & 우측 목록 필터링
    if (nodeViolationCnt > 0) {
      const vBtn = tr.querySelector('.tree-violation-btn');
      if (vBtn) {
        vBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          toggleNodeViolationDetails(tr, fullUrl, nodeName, nodeViolationCnt, vBtn);
        });
      }
    }

    // +/- 아이콘 클릭 이벤트 리스너 등록 (하위 노드 접기/펼치기)
    const iconEl = tr.querySelector('.tree-icon');
    if (iconEl) {
      iconEl.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleTreeBranch(node.uid, iconEl);
      });
    }
  }

  // 트리 행 아래에 해당 페이지의 위반 내역 세부 아코디언 행 토글
  function toggleNodeViolationDetails(parentTr, targetUrl, nodeName, violationCnt, btnEl) {
    const icon = btnEl ? btnEl.querySelector('.tree-violation-icon') : null;
    const nextRow = parentTr.nextElementSibling;
    const isAlreadyOpen = nextRow && nextRow.classList.contains('tree-violation-detail-row');

    if (isAlreadyOpen) {
      // 이미 열려 있으면 닫기
      nextRow.remove();
      if (icon) {
        icon.classList.remove('bi-chevron-up');
        icon.classList.add('bi-chevron-down');
      }
      return;
    }

    // 다른 열려있는 위반 세부 행이 있으면 정리
    document.querySelectorAll('.tree-violation-detail-row').forEach(el => el.remove());
    document.querySelectorAll('.tree-violation-icon').forEach(ic => {
      ic.classList.remove('bi-chevron-up');
      ic.classList.add('bi-chevron-down');
    });

    if (icon) {
      icon.classList.remove('bi-chevron-down');
      icon.classList.add('bi-chevron-up');
    }

    // 해당 URL의 위반 항목 발췌
    const matched = findings.filter(f => f.url === targetUrl);

    const detailTr = document.createElement('tr');
    detailTr.className = 'tree-violation-detail-row bg-light-subtle border-start border-danger border-4';

    let itemsHtml = '';
    if (matched.length > 0) {
      itemsHtml = matched.map((f, idx) => {
        const cleaned = cleanEvidenceText(f.evidence_text);
        const highlighted = highlightEvidenceSnippet(cleaned, f.matched_keyword);
        const reasonText = f.reason || (f.extra_finding && f.extra_finding.startsWith('REASON:') ? f.extra_finding.replace('REASON:', '').trim() : f.extra_finding) || '불법 스팸/광고 의심 요소 감지';
        const kwBadge = f.matched_keyword ? `<span class="badge text-bg-warning text-dark border ms-1">키워드: ${escapeHtml(f.matched_keyword)}</span>` : '';

        return `
          <div class="p-2 mb-2 bg-white rounded border shadow-sm small" style="word-break: break-all;">
            <div class="d-flex align-items-center mb-1 gap-2">
              <div class="text-truncate" style="min-width: 0;">
                <span class="badge ${getTechBadgeClass(f.technique)} me-1">${getTechLabel(f.technique)}</span>
                <strong class="text-danger">#${idx + 1}</strong>
                ${kwBadge}
                <span class="text-secondary ms-2">${escapeHtml(reasonText)}</span>
              </div>
            </div>
            <div class="text-muted font-monospace bg-light p-2 rounded border" style="white-space: pre-wrap; word-break: break-all; font-size: 0.8rem; line-height: 1.4;">
              ${highlighted || '<span class="text-secondary">(근거 발췌문 없음)</span>'}
            </div>
          </div>
        `;
      }).join('');
    } else {
      itemsHtml = `
        <div class="p-3 bg-white rounded border text-center text-muted small">
          <i class="bi bi-info-circle text-primary me-1"></i>
          해당 페이지에 위반 <strong>${violationCnt}건</strong>이 기록되어 있습니다.
        </div>
      `;
    }

    detailTr.innerHTML = `
      <td colspan="5" class="p-3" style="max-width: 0; width: 100%; box-sizing: border-box;">
        <div class="d-flex align-items-center justify-content-between mb-2 pb-2 border-bottom gap-2">
          <div class="fw-bold text-danger text-truncate pe-2" style="min-width: 0;" title="${escapeHtml(nodeName)}">
            <i class="bi bi-shield-slash-fill me-1"></i>${escapeHtml(nodeName)}
            <span class="text-secondary fw-normal small ms-1">(${matched.length > 0 ? matched.length : violationCnt}건 검출)</span>
          </div>
          <div class="flex-shrink-0">
            <button type="button" class="btn-close" aria-label="닫기" title="닫기" onclick="this.closest('.tree-violation-detail-row').remove();"></button>
          </div>
        </div>
        <div class="tree-violation-list-box" style="max-height: 280px; overflow-y: auto; overflow-x: hidden;">
          ${itemsHtml}
        </div>
      </td>
    `;

    parentTr.parentNode.insertBefore(detailTr, parentTr.nextSibling);

  }

  // 트리 브랜치 접기/펼치기 토글 함수
  function toggleTreeBranch(parentUid, iconEl) {
    const isExpanding = iconEl.classList.contains('bi-plus-square');
    if (isExpanding) {
      iconEl.classList.remove('bi-plus-square');
      iconEl.classList.add('bi-dash-square');
      showChildRows(parentUid);
    } else {
      iconEl.classList.remove('bi-dash-square');
      iconEl.classList.add('bi-plus-square');
      hideChildRows(parentUid);
    }
  }

  function hideChildRows(parentUid) {
    const childRows = treeGridBody.querySelectorAll(`tr[data-parent-uid="${parentUid}"]`);
    childRows.forEach(row => {
      row.classList.add('tree-collapsed');
      const childUid = row.dataset.uid;
      hideChildRows(childUid);
    });
  }

  function showChildRows(parentUid) {
    const childRows = treeGridBody.querySelectorAll(`tr[data-parent-uid="${parentUid}"]`);
    childRows.forEach(row => {
      row.classList.remove('tree-collapsed');
      const icon = row.querySelector('.tree-icon');
      if (icon && icon.classList.contains('bi-dash-square')) {
        showChildRows(row.dataset.uid);
      }
    });
  }

  // 6. 기법 영문 코드 -> 한글 명칭 변환
  function getTechLabel(tech) {
    switch (tech) {
      case 'JAMO': return '자모 분해';
      case 'HOMOGLYPH': return '닮은꼴 글자';
      case 'TRANSPARENT': return '투명 텍스트';
      case 'OFFSCREEN': return '화면 밖 은닉';
      case 'ETC': return '추가 탐지';
      case 'NONSTANDARD_PORT': return '비표준포트오염';
      case 'REFLECTED_SEARCH': return '반사형검색오염';
      default: return tech;
    }
  }

  function getTechBadgeClass(tech) {
    switch (tech) {
      case 'JAMO': return 'text-bg-danger';
      case 'HOMOGLYPH': return 'text-bg-danger';
      case 'TRANSPARENT': return 'text-bg-warning';
      case 'OFFSCREEN': return 'text-bg-warning';
      case 'ETC': return 'text-bg-info';
      case 'NONSTANDARD_PORT': return 'text-bg-info';
      case 'REFLECTED_SEARCH': return 'text-bg-info';
      default: return 'text-bg-secondary';
    }
  }

  // 7. 적발 항목 데이터 추가 및 리스트 렌더링
  function addFinding(item) {
    findings.push(item);
    summaryViolationCnt.textContent = findings.length;
    updateTabCounts();
    renderFindingItem(item);
  }

  // 근거 원문 텍스트 내의 이스케이프 문자열(\r, \n, \t) 및 불필요한 공백을 단일 공백으로 깔끔하게 정제
  function cleanEvidenceText(text) {
    if (!text) return '';
    let cleaned = String(text)
      .replace(/\\r|\\n|\\t/g, ' ')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    // 혹시 과거 이력이나 거대한 스크립트 원문이 들어오더라도 화면을 덮치지 않도록 최대 200자로 안전하게 제한
    if (cleaned.length > 200) {
      cleaned = cleaned.substring(0, 180) + '...';
    }
    return cleaned;
  }

  // 근거 원문 내 매칭된 위반 키워드 노란색 하이라이트 처리
  function highlightEvidenceSnippet(evidenceText, matchedKw) {
    if (!evidenceText) return '';
    const safeText = escapeHtml(evidenceText);
    if (!matchedKw || String(matchedKw).trim().length === 0) return safeText;

    const safeKw = escapeHtml(String(matchedKw).trim());
    try {
      const re = new RegExp(`(${safeKw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
      return safeText.replace(re, '<mark class="bg-warning text-dark px-1 rounded fw-bold">$1</mark>');
    } catch (e) {
      return safeText;
    }
  }

  async function openFindingSolution(panel, item, evidence) {
    const solution = window.FcmsSolution;
    if (!solution) {
      panel.textContent = '솔루션 생성 기능을 불러오지 못했습니다. 화면을 새로고침해 주세요.';
      return;
    }
    panel.textContent = '솔루션을 불러오는 중입니다...';
    const masterId = activeMasterId;
    let saved = null;
    if (masterId) {
      try {
        const response = await fetch('/mgr/api/detect/solution/' + encodeURIComponent(masterId) + '/' + encodeURIComponent(item.id));
        const result = await response.json();
        if (result.success) saved = result.data;
      } catch (err) {
        // 저장된 설정이 없어도 탐지 정보로 코드를 생성합니다.
      }
    }
    const placement = solution.getPlacement(activeCms);
    const isLink = String(item.evidence_text || '').startsWith('외부 연결 URL:');
    panel.innerHTML = `
      <div class="card-header px-3 py-2 d-flex align-items-center justify-content-between gap-2">
        <div class="card-title mb-0 fs-6 fw-semibold"><i class="bi bi-code-square me-2 text-primary"></i>한줄 솔루션</div>
        <span class="badge text-bg-secondary ms-auto fcms-solution-cms"></span>
      </div>
      <div class="card-body p-3">
        <p class="small text-body-secondary mb-3 fcms-solution-intro"></p>
        <div class="mb-3">
          <label class="form-label small fw-semibold mb-1 fcms-solution-target-label"></label>
          <input type="text" class="form-control form-control-sm fcms-solution-target" maxlength="1000" autocomplete="off">
        </div>
        <div class="row g-3 mb-3">
          <div class="col-md-6"><label class="form-label small fw-semibold mb-1">정상 제목 (선택)</label><input type="text" class="form-control form-control-sm fcms-solution-title" maxlength="200" placeholder="비우면 오염 문구만 제거"></div>
          <div class="col-md-6"><label class="form-label small fw-semibold mb-1">대체 본문 (선택)</label><textarea class="form-control form-control-sm fcms-solution-body" rows="1" maxlength="2000" placeholder="비우면 오염 문구만 제거"></textarea></div>
        </div>
        <div class="border-top pt-3">
          <div class="d-flex justify-content-between align-items-center flex-wrap gap-2 mb-2">
            <div class="fw-semibold small"><span class="badge text-bg-primary me-2">1</span>복사해서 붙일 코드</div>
            <div class="d-flex gap-2"><button type="button" class="btn btn-outline-secondary btn-sm fcms-solution-save"><i class="bi bi-floppy me-1"></i>설정 저장</button><button type="button" class="btn btn-primary btn-sm fcms-solution-copy"><i class="bi bi-clipboard me-1"></i>코드 복사</button></div>
          </div>
          <div class="small text-body-secondary mb-2">첫 두 줄의 안내 문구를 실제 제목과 내용으로 바꾼 뒤 사용하세요. 위 입력칸에서 바꾸면 코드에도 반영됩니다.</div>
          <textarea class="form-control font-monospace bg-dark text-light border-dark fcms-solution-code" rows="10" readonly spellcheck="false" wrap="off" aria-label="복사할 코드"></textarea>
          <div class="small mt-2 fcms-solution-status" role="status"></div>
        </div>
        <div class="border-top mt-3 pt-3">
          <div class="fw-semibold small mb-1"><span class="badge text-bg-secondary me-2">2</span>어디에 붙이나요?</div>
          <div class="small text-body-secondary fcms-solution-placement"></div>
        </div>
        <div class="border-top mt-3 pt-3">
          <div class="fw-semibold small mb-1"><span class="badge text-bg-secondary me-2">3</span>추가 해결방안</div>
          <div class="small text-body-secondary fcms-solution-remedy"></div>
        </div>
        <div class="callout callout-warning small py-2 px-3 mt-3 mb-0"><i class="bi bi-info-circle me-1"></i>브라우저 화면과 메타 정보만 바뀝니다. 원본 HTML과 검색 결과는 그대로일 수 있습니다. 인라인 스크립트가 차단되면 실행되지 않으므로, 원본 게시물 삭제와 서버 수정이 필요합니다.</div>
      </div>
    `;
    const target = panel.querySelector('.fcms-solution-target');
    const title = panel.querySelector('.fcms-solution-title');
    const body = panel.querySelector('.fcms-solution-body');
    const code = panel.querySelector('.fcms-solution-code');
    const status = panel.querySelector('.fcms-solution-status');
    const copyButton = panel.querySelector('.fcms-solution-copy');
    const saveButton = panel.querySelector('.fcms-solution-save');
    panel.querySelector('.fcms-solution-intro').textContent = isLink
      ? '이 탐지 URL에서 해당 외부 링크가 한 곳에 있을 때 링크를 제거합니다. 대체 본문을 입력하면 그 문구로 바꿉니다.'
      : '이 탐지 URL에서 원문이 정확히 한 곳에 있을 때만 바꿉니다. 아래 값을 확인한 뒤 복사하세요.';
    panel.querySelector('.fcms-solution-target-label').textContent = isLink ? '제거할 외부 링크 URL' : '바꿀 오염 원문';
    panel.querySelector('.fcms-solution-cms').textContent = placement.label;
    panel.querySelector('.fcms-solution-placement').textContent = placement.text +
      (String(item.location || '').includes(' >>> ') ? ' iframe 내부 탐지는 같은 출처일 때만 부모 페이지에서 접근할 수 있습니다.' : '');
    panel.querySelector('.fcms-solution-remedy').textContent = isLink
      ? '원본 게시물 또는 템플릿에서 이 외부 링크를 제거하고, 같은 링크가 다시 등록되지 않도록 작성 권한을 점검하세요.'
      : solution.getRemedy(item.technique);
    target.value = saved ? saved.target_text : solution.initialTarget(evidence);
    title.value = saved ? saved.clean_title : solution.defaultEditValues.title;
    body.value = saved ? saved.clean_body : solution.defaultEditValues.body;
    function refresh() {
      const result = solution.createSnippet(item, {
        target_text: target.value,
        clean_title: title.value,
        clean_body: body.value
      });
      code.value = result.code;
      copyButton.disabled = !!result.error;
      status.className = 'small mt-2 fcms-solution-status ' + (result.error ? 'text-danger' : 'text-secondary');
      status.textContent = result.error || (isLink ? '입력한 링크 주소가 실제 페이지의 링크와 같아야 적용됩니다.' : '오염 원문과 실제 페이지의 문구가 같아야 적용됩니다.');
    }
    [target, title, body].forEach(input => input.addEventListener('input', refresh));
    refresh();
    saveButton.addEventListener('click', async function () {
      const id = activeMasterId || masterId;
      if (!id) {
        status.textContent = '점검 이력이 생성된 뒤 저장할 수 있습니다.';
        return;
      }
      saveButton.disabled = true;
      try {
        const response = await fetch('/mgr/api/detect/solution/' + encodeURIComponent(id) + '/' + encodeURIComponent(item.id), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target_text: target.value, clean_title: title.value, clean_body: body.value })
        });
        const result = await response.json();
        status.textContent = result.success ? '설정이 저장되었습니다. 이력에서 다시 열어도 유지됩니다.' : (result.message || '저장하지 못했습니다.');
      } catch (err) {
        status.textContent = '저장하지 못했습니다. 연결을 확인해 주세요.';
      } finally {
        saveButton.disabled = false;
      }
    });
    copyButton.addEventListener('click', async function () {
      if (!code.value) return;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(code.value);
        else { code.focus(); code.select(); if (!document.execCommand('copy')) throw new Error('copy failed'); }
        status.textContent = '코드를 복사했습니다.';
      } catch (err) {
        code.focus(); code.select();
        status.textContent = '자동 복사가 차단되었습니다. 선택된 코드를 직접 복사해 주세요.';
      }
    });
  }

  function renderFindingItem(item) {
    if (activeTabType !== 'ALL' && item.technique !== activeTabType) {
      return;
    }
    if (activeUrlFilter && item.url !== activeUrlFilter) {
      return;
    }

    const placeholder = document.getElementById('list-empty-placeholder');
    if (placeholder) placeholder.remove();

    const li = document.createElement('li');
    li.className = 'list-group-item py-3 finding-item';
    li.dataset.tech = item.technique;

    const cleanedEvidence = cleanEvidenceText(item.evidence_text);
    const isSearchPollutionFinding = item.technique === 'NONSTANDARD_PORT' || item.technique === 'REFLECTED_SEARCH';
    const reasonText = item.reason || (item.extra_finding && item.extra_finding.startsWith('REASON:') ? item.extra_finding.replace('REASON:', '').trim() : item.extra_finding);
    const reasonHtml = reasonText ? `
      <div class="mb-2 p-2 rounded bg-danger-subtle border border-danger-subtle text-danger small fw-semibold">
        <i class="bi bi-exclamation-octagon-fill me-1"></i><strong>탐지 사유:</strong> ${escapeHtml(reasonText)}
      </div>
    ` : '';

    const highlightedEvidence = highlightEvidenceSnippet(cleanedEvidence, item.matched_keyword);

    li.innerHTML = `
      <div class="d-flex gap-3">
        <span class="badge ${getTechBadgeClass(item.technique)} flex-shrink-0 d-flex align-items-center justify-content-center" style="height: 2.2rem; width: 2.2rem;">
          <i class="bi bi-exclamation-triangle-fill"></i>
        </span>
        <div class="flex-grow-1 overflow-hidden">
          <div class="d-flex align-items-center gap-2 mb-1 flex-wrap">
            <span class="badge ${getTechBadgeClass(item.technique)}">${getTechLabel(item.technique)}</span>
            <span class="badge text-bg-light border font-monospace text-secondary">${escapeHtml(item.id)}</span>
            <span class="text-danger small fw-bold"><i class="bi bi-shield-slash-fill me-1"></i>위반 검출 (true)</span>
          </div>
          <h2 class="fs-6 mb-1 text-break">
            <a href="${escapeHtml(item.url)}" class="link-dark text-decoration-none fw-bold finding-url-link" title="${escapeHtml(item.url)}">
              ${escapeHtml(item.url)}
            </a>
          </h2>
          ${reasonHtml}
          <div class="p-2 my-2 bg-body-tertiary border-start border-3 border-danger rounded small">
            <div class="text-secondary small mb-1">
              <i class="bi bi-code-slash me-1"></i>위치 (CSS 선택자):
              <code class="text-primary font-monospace">${escapeHtml(item.location)}</code>
            </div>
            <div class="fw-semibold text-body text-break pt-1">
              <i class="bi bi-chat-left-quote me-1 text-danger"></i>근거 원문:
              <span class="text-danger fw-bold">&ldquo;${highlightedEvidence}&rdquo;</span>
            </div>
            <div class="d-flex flex-wrap justify-content-start gap-1 mt-2 ${isSearchPollutionFinding ? 'd-none' : ''}">
              <button type="button" class="btn btn-outline-primary btn-sm py-0 px-2 fs-7 fw-semibold fcms-solution-toggle" aria-expanded="false">
                <i class="bi bi-code-square me-1"></i>한줄 솔루션<i class="bi bi-chevron-down ms-1 fcms-solution-chevron"></i>
              </button>
              <button type="button" class="btn btn-outline-primary btn-sm py-0 px-2 fs-7 fw-semibold fcms-cleanse-button">
                <i class="bi bi-funnel me-1"></i>정화소 이동
              </button>
            </div>
          </div>
          <div class="card card-outline card-primary fcms-solution-panel mt-2 mb-0" hidden></div>
        </div>
      </div>
    `;

    // 위반 항목 링크 클릭 시에도 레이어 팝업으로 안전하게 열기
    const findingLinkEl = li.querySelector('.finding-url-link');
    if (findingLinkEl && item.url) {
      findingLinkEl.addEventListener('click', function (e) {
        e.preventDefault();
        openLiveBrowserUrl(item.url, `위반 항목: ${item.id}`);
      });
    }
    const cleanseButton = li.querySelector('.fcms-cleanse-button');
    if (cleanseButton) {
      cleanseButton.addEventListener('click', function () {
        window.moveToCleanse(item.id, encodeURIComponent(cleanedEvidence), encodeURIComponent(item.url));
      });
    }

    const solutionButton = li.querySelector('.fcms-solution-toggle');
    const solutionPanel = li.querySelector('.fcms-solution-panel');
    if (solutionButton && solutionPanel) {
      solutionButton.addEventListener('click', function () {
        const willOpen = solutionPanel.hidden;
        if (willOpen) {
          listContainer.querySelectorAll('.fcms-solution-panel:not([hidden])').forEach(otherPanel => {
            if (otherPanel === solutionPanel) return;
            otherPanel.hidden = true;
            const otherButton = otherPanel.closest('.finding-item')?.querySelector('.fcms-solution-toggle');
            if (otherButton) otherButton.setAttribute('aria-expanded', 'false');
          });
        }
        solutionPanel.hidden = !willOpen;
        solutionButton.setAttribute('aria-expanded', String(willOpen));
        if (willOpen && !solutionPanel.dataset.loaded) {
          solutionPanel.dataset.loaded = 'true';
          openFindingSolution(solutionPanel, item, cleanedEvidence);
        }
      });
    }

    listContainer.prepend(li);
  }

  // 8. 탭별 건수 뱃지 갱신
  function updateTabCounts() {
    const counts = {
      ALL: findings.length,
      JAMO: 0,
      HOMOGLYPH: 0,
      TRANSPARENT: 0,
      OFFSCREEN: 0,
      ETC: 0,
      NONSTANDARD_PORT: 0,
      REFLECTED_SEARCH: 0
    };
    findings.forEach(f => {
      if (counts[f.technique] !== undefined) counts[f.technique]++;
    });

    for (const key in counts) {
      const el = document.getElementById('tab-cnt-' + key);
      if (el) el.textContent = counts[key];
    }
  }

  // 9. 탭 전환 처리
  function handleTabClick(e) {
    const btn = e.target.closest('button[data-type]');
    if (!btn) return;

    document.querySelectorAll('#detect-type-tabs .nav-link').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    activeTabType = btn.dataset.type;
    filterFindings();
  }

  let activeUrlFilter = null;

  // 특정 URL로 위반 항목 필터링 (트리 노드 위반 버튼 클릭 연동)
  window.filterFindingsByUrl = function (targetUrl, urlLabel) {
    activeUrlFilter = targetUrl;
    const banner = document.getElementById('url-filter-banner');
    const labelEl = document.getElementById('url-filter-label');
    if (banner && labelEl) {
      banner.classList.remove('d-none');
      const displayLabel = urlLabel || (targetUrl ? (new URL(targetUrl, 'http://localhost')).pathname : targetUrl);
      const matchCnt = findings.filter(f => f.url === targetUrl).length;
      labelEl.textContent = `선택한 페이지 위반 내역: ${displayLabel} (${matchCnt}건)`;
      labelEl.title = targetUrl;
    }
    filterFindings();
  };

  // URL 필터 해제
  window.clearFindingsUrlFilter = function () {
    activeUrlFilter = null;
    const banner = document.getElementById('url-filter-banner');
    if (banner) {
      banner.classList.add('d-none');
    }
    filterFindings();
  };

  const btnClearUrlFilter = document.getElementById('btn-clear-url-filter');
  if (btnClearUrlFilter) {
    btnClearUrlFilter.addEventListener('click', function () {
      clearFindingsUrlFilter();
    });
  }

  function filterFindings() {
    listContainer.innerHTML = '';
    let filtered = activeTabType === 'ALL'
      ? findings
      : findings.filter(f => f.technique === activeTabType);

    if (activeUrlFilter) {
      filtered = filtered.filter(f => f.url === activeUrlFilter);
    }

    if (filtered.length === 0) {
      listContainer.innerHTML = `
        <li class="list-group-item py-5 text-center text-muted" id="list-empty-placeholder">
          <i class="bi bi-info-circle fs-1 d-block mb-2 text-secondary"></i>
          <p class="fw-semibold mb-1">선택된 조건에 해당하는 위반 항목이 없습니다.</p>
          ${activeUrlFilter ? '<button type="button" class="btn btn-outline-danger btn-sm mt-2" onclick="clearFindingsUrlFilter()">전체 위반 내역 보기</button>' : ''}
        </li>
      `;
      return;
    }

    filtered.slice().reverse().forEach(renderFindingItem);
  }

  // 10. 점검 중지 / 진행 토글 (Clear filters 버튼 위치)
  async function toggleInspection() {
    if (!isInspecting) {
      if (confirm('현재 점검 결과 화면을 정리하고 새로운 탐지를 준비하시겠습니까?')) {
        window.location.href = '/mgr/search';
      }
      return;
    }

    if (!confirm('현재 진행 중인 불법광고 점검을 중지하시겠습니까?\n중지 시점까지의 탐지 결과가 데이터베이스에 저장됩니다.')) return;
    try {
      const res = await fetch('/mgr/api/detect/stop', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        isInspecting = false;
        isPaused = false;
        clearInterval(pollInterval);
        setDetectUIState('completed');
        textStep.textContent = '점검이 사용자에 의해 중지되었습니다. (현재까지 결과 저장 완료)';
        alert('점검이 중지되었으며, 현재까지의 탐지 결과가 저장되었습니다.');
      } else {
        alert('점검 중지 실패: ' + (data.message || '상태 이상'));
      }
    } catch (e) {
      alert('서버 통신 실패: ' + e.message);
    }
  }

  // 11. 점검 회차별 결과 파일 확인 및 저장 모달 열기
  async function exportResultJson(type = 'auto') {
    if (!activeMasterId) {
      alert('점검 회차가 아직 생성되지 않았습니다. 탐지를 시작한 뒤 다시 확인해 주세요.');
      return;
    }
    const modalEl = document.getElementById('modal-result-json');
    const pathEl = document.getElementById('modal-result-json-path');
    const metaEl = document.getElementById('modal-result-json-meta');
    const codeEl = document.getElementById('modal-result-json-code');
    const btnCopy = document.getElementById('btn-modal-copy-json');
    const btnSave = document.getElementById('btn-modal-save-file');
    const saveStatusEl = document.getElementById('modal-result-json-save-status');
    const btnOpenFolder = document.getElementById('btn-modal-open-folder');
    const btnMain = document.getElementById('btn-modal-result-main');
    const btnExtra = document.getElementById('btn-modal-result-extra');

    if (saveStatusEl) saveStatusEl.textContent = '';
    if (btnSave) btnSave.disabled = true;

    let resultData = null;
    let selectedFilename = 'result.json';

    try {
      const res = await fetch(`/mgr/api/detect/result-json?view=1&masterId=${encodeURIComponent(activeMasterId)}&type=${encodeURIComponent(type)}`);
      const json = await res.json();
      if (json.success && json.data) {
        resultData = json.data;
        selectedFilename = json.filename;
        if (pathEl) pathEl.textContent = `점검 회차 #${activeMasterId} · 이력 DB (${selectedFilename})`;
        if (metaEl) {
          metaEl.textContent = `파일 크기: ${(json.size / 1024).toFixed(1)} KB | 이 파일: ${json.data.findings.length}건 | 중복 제외: ${json.counts.duplicate}건`;
        }
        if (btnMain) {
          btnMain.textContent = `result.json (${json.counts.main})`;
          btnMain.classList.toggle('active', json.type === 'main');
        }
        if (btnExtra) {
          btnExtra.textContent = `result_extra.json (${json.counts.extra})`;
          btnExtra.classList.toggle('active', json.type === 'extra');
        }
        if (btnSave) btnSave.disabled = false;
      } else {
        if (codeEl) codeEl.textContent = json.message || '결과 파일을 만들 수 없습니다.';
        return;
      }
    } catch (error) {
      if (codeEl) codeEl.textContent = '결과 파일 조회 실패: ' + error.message;
      return;
    }

    if (btnMain) btnMain.onclick = () => exportResultJson('main');
    if (btnExtra) btnExtra.onclick = () => exportResultJson('extra');

    const formattedJson = JSON.stringify(resultData, null, 2);

    // 모달 내용 갱신 및 표시
    if (codeEl) {
      codeEl.textContent = formattedJson;
    }

    if (modalEl && typeof bootstrap !== 'undefined' && bootstrap.Modal) {
      if (modalEl.parentNode !== document.body) {
        document.body.appendChild(modalEl);
      }
      const modalInstance = bootstrap.Modal.getOrCreateInstance(modalEl);
      modalInstance.show();
    }

    // 복사 버튼 이벤트 바인딩
    if (btnCopy) {
      btnCopy.onclick = async function () {
        try {
          await navigator.clipboard.writeText(formattedJson);
          btnCopy.innerHTML = `<i class="bi bi-check-lg me-1 text-success"></i>복사 완료`;
          setTimeout(() => {
            btnCopy.innerHTML = `<i class="bi bi-clipboard me-1"></i>전체 복사`;
          }, 2000);
        } catch (err) {
          alert('클립보드 복사 실패: ' + err.message);
        }
      };
    }

    // 화면에 표시한 JSON을 그대로 저장
    if (btnSave) {
      btnSave.onclick = async function () {
        await window.saveDisplayedResultJson(formattedJson, selectedFilename, btnSave, saveStatusEl);
      };
    }

    // 탐색기 폴더 열기 이벤트 바인딩
    if (btnOpenFolder) {
      btnOpenFolder.onclick = async function () {
        try {
          const res = await fetch('/mgr/api/detect/open-result-folder', { method: 'POST' });
          const json = await res.json();
          if (!json.success) {
            alert(json.message || '폴더 열기 실패');
          }
        } catch (e) {
          alert('폴더 열기 오류: ' + e.message);
        }
      };
    }
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // 이번만 적용 / 제외 키워드 태그 렌더링 함수
  function renderKeywordTags(type) {
    const isBusy = Boolean(isInspecting);
    if (type === 'polluted') {
      if (!listTempPolluted) return;
      listTempPolluted.innerHTML = tempPollutedKeywords.map((kw, idx) => `
        <span class="badge bg-light text-dark border border-danger-subtle d-inline-flex align-items-center py-1 px-2 mb-1" style="font-size: 0.8rem;">
          <span class="text-danger fw-semibold me-1">${escapeHtml(kw)}</span>
          ${isBusy ? '' : `<button type="button" class="btn-close ms-1" style="width: 0.35rem; height: 0.35rem; font-size: 0.5rem;" aria-label="삭제" data-keyword-type="polluted" data-keyword-idx="${idx}"></button>`}
        </span>
      `).join('');
    } else if (type === 'allowed') {
      if (!listTempAllowed) return;
      listTempAllowed.innerHTML = tempAllowedKeywords.map((kw, idx) => `
        <span class="badge bg-light text-dark border border-success-subtle d-inline-flex align-items-center py-1 px-2 mb-1" style="font-size: 0.8rem;">
          <span class="text-success fw-semibold me-1">${escapeHtml(kw)}</span>
          ${isBusy ? '' : `<button type="button" class="btn-close ms-1" style="width: 0.35rem; height: 0.35rem; font-size: 0.5rem;" aria-label="삭제" data-keyword-type="allowed" data-keyword-idx="${idx}"></button>`}
        </span>
      `).join('');
    }
  }

  function addTempKeyword(type, val) {
    if (isInspecting) return;
    const trimmed = (val || '').trim();
    if (!trimmed) return;
    if (type === 'polluted') {
      if (!tempPollutedKeywords.includes(trimmed)) {
        tempPollutedKeywords.push(trimmed);
        renderKeywordTags('polluted');
      }
      if (inputTempPolluted) inputTempPolluted.value = '';
    } else if (type === 'allowed') {
      if (!tempAllowedKeywords.includes(trimmed)) {
        tempAllowedKeywords.push(trimmed);
        renderKeywordTags('allowed');
      }
      if (inputTempAllowed) inputTempAllowed.value = '';
    }
  }

  function removeTempKeyword(type, idx) {
    if (isInspecting) return;
    if (type === 'polluted') {
      tempPollutedKeywords.splice(idx, 1);
      renderKeywordTags('polluted');
    } else if (type === 'allowed') {
      tempAllowedKeywords.splice(idx, 1);
      renderKeywordTags('allowed');
    }
  }

  // 초기화 이벤트 리스너 등록
  document.addEventListener('DOMContentLoaded', function () {
    if (inputUrl) {
      inputUrl.addEventListener('input', handleUrlInput);
      inputUrl.addEventListener('paste', () => setTimeout(handleUrlInput, 50));
      inputUrl.addEventListener('keyup', (e) => {
        if (e.key === 'Enter' && !btnStart.disabled) {
          startInspection();
        }
      });
    }

    // 이번만 적용 키워드 입력 이벤트
    if (inputTempPolluted) {
      inputTempPolluted.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          addTempKeyword('polluted', this.value);
        }
      });
    }

    if (listTempPolluted) {
      listTempPolluted.addEventListener('click', function (e) {
        const btn = e.target.closest('button[data-keyword-type="polluted"]');
        if (btn) {
          const idx = Number(btn.getAttribute('data-keyword-idx'));
          removeTempKeyword('polluted', idx);
        }
      });
    }

    // 이번만 제외 키워드 입력 이벤트
    if (inputTempAllowed) {
      inputTempAllowed.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          addTempKeyword('allowed', this.value);
        }
      });
    }

    if (listTempAllowed) {
      listTempAllowed.addEventListener('click', function (e) {
        const btn = e.target.closest('button[data-keyword-type="allowed"]');
        if (btn) {
          const idx = Number(btn.getAttribute('data-keyword-idx'));
          removeTempKeyword('allowed', idx);
        }
      });
    }

    if (btnStart) {
      btnStart.addEventListener('click', startInspection);
    }

    if (btnToggle) {
      btnToggle.addEventListener('click', toggleInspection);
    }

    const tabsContainer = document.getElementById('detect-type-tabs');
    if (tabsContainer) {
      tabsContainer.addEventListener('click', handleTabClick);
    }

    if (btnExportJson) {
      btnExportJson.addEventListener('click', () => exportResultJson());
    }

    // AI 모델 실시간 판정 테스트 이벤트 연결
    const btnRunAiTest = document.getElementById('btn-run-ai-test');
    if (btnRunAiTest) {
      btnRunAiTest.addEventListener('click', runAiTest);
    }
    const inputAiTest = document.getElementById('input-ai-test-text');
    if (inputAiTest) {
      inputAiTest.addEventListener('keyup', (e) => {
        if (e.key === 'Enter') runAiTest();
      });
    }

    // 초기 상태 룩앤필 적용 및 진행 중인 세션 자동 복원
    setDetectUIState('idle');
    handleUrlInput();
    checkExistingSession();
  });

  // 페이지 이동 후 재진입 시 백그라운드 진행 세션 또는 과거 점검 이력 자동 복원 함수
  async function checkExistingSession() {
    const urlParams = new URLSearchParams(window.location.search);
    const autoUrl = urlParams.get('entryUrl') || urlParams.get('url');
    const isAutoStart = urlParams.get('autoStart') === 'true' || urlParams.get('start') === '1';

    // 0. 대시보드에서 '재탐지' 요청으로 진입한 경우 즉시 탐지 자동 구동
    if (autoUrl && isAutoStart) {
      if (inputUrl) {
        inputUrl.value = autoUrl;
        handleUrlInput();
      }
      setTimeout(() => {
        if (!isInspecting) {
          startInspection(true);
        }
      }, 400);
      return;
    }

    const historyId = urlParams.get('id') || urlParams.get('masterId');

    // 1. 대시보드나 외부에서 특정 점검 회차(historyId)를 클릭하여 진입한 경우
    if (historyId) {
      try {
        const res = await fetch('/mgr/api/detect/history/' + encodeURIComponent(historyId));
        const json = await res.json();
        if (json.success && json.data) {
          const { master, findings: historyFindings, nodes: historyNodes } = json.data;
          currentTargetUrl = master.entry_url || '';
          activeMasterId = master.id;
          activeCms = master.detected_cms || null;
          if (inputUrl) {
            inputUrl.value = currentTargetUrl;
            handleUrlInput();
          }

          // 현재 백엔드 실시간 세션 상태 조회
          let liveStatus = null;
          try {
            const statusRes = await fetch('/mgr/api/detect/status');
            const statusJson = await statusRes.json();
            if (statusJson && statusJson.success && statusJson.data) {
              liveStatus = statusJson.data;
            }
          } catch (e) {}

          const isCurrentlyLive = (master.status === 'RUNNING' || (liveStatus && liveStatus.status === 'RUNNING' && String(liveStatus.masterId) === String(master.id)));

          if (isCurrentlyLive) {
            // [LIVE 점검 중인 경우]: 실시간 점검 화면으로 완벽 복원 및 폴링 재개
            isInspecting = true;
            isPaused = (liveStatus && liveStatus.status === 'PAUSED');
            setDetectUIState(isPaused ? 'paused' : 'running');

            const curUrl = (liveStatus && liveStatus.currentUrl) ? liveStatus.currentUrl : currentTargetUrl;
            const curStep = (liveStatus && liveStatus.currentStep) ? liveStatus.currentStep : '실시간 점검 수행 중...';
            elapsedSec = (liveStatus && typeof liveStatus.elapsedSec === 'number') ? liveStatus.elapsedSec : (master.elapsed_sec || 0);

            if (textUrl) { textUrl.textContent = curUrl; textUrl.title = curUrl; }
            if (textStep) { textStep.textContent = curStep; textStep.title = curStep; }
            if (summaryElapsedTime) summaryElapsedTime.textContent = elapsedSec;
            if (summaryViolationCnt) summaryViolationCnt.textContent = (liveStatus && liveStatus.violationCount) || master.violation_count || historyFindings.length;

            // 실시간 브라우저 뷰어 표시
            if (liveBrowserOverlay) {
              liveBrowserOverlay.classList.remove('d-none');
              loadUrlInLiveViewer(curUrl);
            }

            // 위반 목록 복원
            findings = [];
            listContainer.innerHTML = '';
            processedFindingIds.clear();
            const sourceFindings = (liveStatus && Array.isArray(liveStatus.findings) && liveStatus.findings.length > 0) ? liveStatus.findings : historyFindings;
            if (Array.isArray(sourceFindings) && sourceFindings.length > 0) {
              for (const item of sourceFindings) {
                const findingObj = {
                  id: item.finding_id || item.id,
                  url: item.url,
                  is_violation: item.is_violation === 1 || item.is_violation === true,
                  location: item.location,
                  evidence_text: item.evidence_text,
                  technique: item.technique,
                  reason: item.reason || item.extra_finding,
                  matched_keyword: item.matched_keyword,
                  extra_finding: item.extra_finding
                };
                processedFindingIds.add(findingObj.id);
                addFinding(findingObj);
              }
            } else {
              updateTabCounts();
            }

            // 트리 노드 복원
            if (treeGridBody && Array.isArray(historyNodes) && historyNodes.length > 0) {
              treeGridBody.innerHTML = '';
              processedNodeUids.clear();
              for (const node of historyNodes) {
                const matchedFindings = (sourceFindings || []).filter(f => f.url === node.url);
                const nodeTechs = matchedFindings.map(f => f.technique).filter(Boolean);

                addNodeToTreeGrid({
                  uid: `node_${node.id}`,
                  parentUid: node.parent_id ? `node_${node.parent_id}` : null,
                  depth: node.depth || 0,
                  url: node.url,
                  pathSegment: node.path_segment || node.url,
                  title: node.title || node.path_segment,
                  status: node.http_status || 200,
                  violationCnt: (node.violation_cnt !== undefined && node.violation_cnt !== null) ? node.violation_cnt : matchedFindings.length,
                  technique: node.technique || (nodeTechs.length > 0 ? nodeTechs[0] : null),
                  techniques: nodeTechs
                });
              }
            }

            // 실시간 폴링 재개
            startRealtimePolling();
            return;
          }

          // [점검 완료 또는 중지인 경우]
          showHistoryExcludeOption(master.id, historyNodes, historyFindings);
          if (master.status === 'STOPPED') {
            setDetectUIState('idle');
          } else {
            setDetectUIState('completed');
          }

          if (textUrl) {
            textUrl.textContent = currentTargetUrl;
            textUrl.title = currentTargetUrl;
          }
          if (textStep) {
            const timeStr = master.finished_at ? master.finished_at.substring(0, 19).replace('T', ' ') : '';
            if (master.status === 'STOPPED') {
              textStep.textContent = `점검 중지 내역 (회차 #${master.id}, ${timeStr}, 총 ${historyFindings.length}건 검출)`;
            } else {
              textStep.textContent = `점검 완료 내역 (회차 #${master.id}, ${timeStr}, 총 ${historyFindings.length}건 검출)`;
            }
            textStep.title = textStep.textContent;
          }
          if (summaryViolationCnt) {
            summaryViolationCnt.textContent = master.violation_count || historyFindings.length;
          }
          if (summaryElapsedTime) {
            summaryElapsedTime.textContent = master.elapsed_sec || 0;
          }

          // 위반 목록 복원 및 렌더링
          findings = [];
          listContainer.innerHTML = '';
          processedFindingIds.clear();
          clearFindingsUrlFilter();

          let resolvedFindings = (Array.isArray(historyFindings) && historyFindings.length > 0) ? historyFindings : [];

          if (resolvedFindings.length > 0) {
            for (const item of resolvedFindings) {
              const findingObj = {
                id: item.finding_id || item.id,
                url: item.url,
                is_violation: item.is_violation === 1 || item.is_violation === true,
                location: item.location,
                evidence_text: item.evidence_text,
                technique: item.technique || 'ETC',
                reason: item.reason || item.extra_finding,
                matched_keyword: item.matched_keyword,
                extra_finding: item.extra_finding
              };
              processedFindingIds.add(findingObj.id);
              addFinding(findingObj);
            }
          } else {
            updateTabCounts();
          }

          // 트리 노드 복원 및 렌더링
          if (treeGridBody && Array.isArray(historyNodes) && historyNodes.length > 0) {
            treeGridBody.innerHTML = '';
            processedNodeUids.clear();
            for (const node of historyNodes) {
              const matchedFindings = resolvedFindings.filter(f => f.url === node.url);
              const nodeTechs = matchedFindings.map(f => f.technique).filter(Boolean);

              addNodeToTreeGrid({
                uid: `node_${node.id}`,
                parentUid: node.parent_id ? `node_${node.parent_id}` : null,
                depth: node.depth || 0,
                url: node.url,
                pathSegment: node.path_segment || node.url,
                title: node.title || node.path_segment,
                status: node.http_status || 200,
                violationCnt: (node.violation_cnt !== undefined && node.violation_cnt !== null) ? node.violation_cnt : matchedFindings.length,
                technique: node.technique || (nodeTechs.length > 0 ? nodeTechs[0] : null),
                techniques: nodeTechs
              });
            }
          }

          return; // 과거 점검 이력 복원 완료 후 종료
        }
      } catch (histErr) {
        console.warn('[History Restore Error]', histErr);
      }
    }

    // 2. 현재 백엔드에서 실시간 수행 중인 세션이 있는지 확인 및 복원
    try {
      const res = await fetch('/mgr/api/detect/status');
      const json = await res.json();
      if (!json.success || !json.data) return;

      const data = json.data;
      if (data.status === 'RUNNING' || data.status === 'PAUSED' || data.status === 'PLANNING') {
        isInspecting = true;
        isPaused = (data.status === 'PAUSED');
        currentTargetUrl = data.entryUrl || '';
        activeMasterId = data.masterId || null;
        activeCms = data.detectedCms || null;
        if (inputUrl) {
          inputUrl.value = currentTargetUrl;
          handleUrlInput();
        }

        // 백엔드에서 실제로 진행 중인 점검 시간 드롭다운 동기화
        if (data.maxTimeSec) {
          const selectTimeEl = document.getElementById('select-max-time');
          if (selectTimeEl) {
            selectTimeEl.value = String(data.maxTimeSec);
          }
        }

        const uiState = (data.status === 'PLANNING') ? 'planning' : (data.status === 'PAUSED' ? 'paused' : 'running');
        setDetectUIState(uiState);

        if (data.currentUrl) {
          textUrl.textContent = data.currentUrl;
          textUrl.title = data.currentUrl;
        }
        if (data.currentStep) {
          textStep.textContent = data.currentStep;
          textStep.title = data.currentStep;
        }
        if (typeof data.elapsedSec === 'number') {
          elapsedSec = data.elapsedSec;
          summaryElapsedTime.textContent = elapsedSec;
        }

        // 기존 수집된 위반 목록 복원
        if (Array.isArray(data.findings) && data.findings.length > 0) {
          findings = [];
          listContainer.innerHTML = '';
          processedFindingIds.clear();
          for (const item of data.findings) {
            processedFindingIds.add(item.id);
            addFinding(item);
          }
        }

        // 새로고침 전까지 저장된 트리 노드를 DB에서 한 번 복원합니다.
        if (activeMasterId && treeGridBody) {
          try {
            const historyRes = await fetch('/mgr/api/detect/history/' + encodeURIComponent(activeMasterId));
            const historyJson = await historyRes.json();
            const storedNodes = historyJson && historyJson.success && historyJson.data && Array.isArray(historyJson.data.nodes)
              ? historyJson.data.nodes
              : [];

            if (storedNodes.length > 0) {
              treeNodes = [];
              treeGridBody.innerHTML = '';
              processedNodeUids.clear();

              for (const node of storedNodes) {
                const uid = `node_${node.id}`;
                const matchedFindings = (data.findings || []).filter(f => f.url === node.url);
                const nodeTechs = matchedFindings.map(f => f.technique).filter(Boolean);
                addNodeToTreeGrid({
                  uid,
                  parentUid: node.parent_id ? `node_${node.parent_id}` : null,
                  depth: node.depth || 0,
                  url: node.url,
                  pathSegment: node.path_segment || node.url,
                  title: node.title || node.path_segment,
                  status: node.http_status || 200,
                  violationCnt: (node.violation_cnt !== undefined && node.violation_cnt !== null) ? node.violation_cnt : matchedFindings.length,
                  technique: node.technique || (nodeTechs.length > 0 ? nodeTechs[0] : null),
                  techniques: nodeTechs
                });
                processedNodeUids.add(uid);
              }
            }
          } catch (treeRestoreErr) {
            console.warn('[Tree Restore Error]', treeRestoreErr);
          }
        }

        // 임시 키워드 목록 복원
        if (Array.isArray(data.tempPollutedKeywords) && data.tempPollutedKeywords.length > 0) {
          tempPollutedKeywords = [...data.tempPollutedKeywords];
          renderKeywordTags('polluted');
        }
        if (Array.isArray(data.tempAllowedKeywords) && data.tempAllowedKeywords.length > 0) {
          tempAllowedKeywords = [...data.tempAllowedKeywords];
          renderKeywordTags('allowed');
        }

        // 실시간 폴링 재개
        startRealtimePolling();
      }
    } catch (err) {
      console.warn('[Session Restore Error]', err);
    }
  }

  // 정화소 이동 전역 함수 (confirm 가드 준수)
  window.moveToCleanse = function (id, encodedEvidence, encodedUrl) {
    const evidence = decodeURIComponent(encodedEvidence || '');
    const url = decodeURIComponent(encodedUrl || '');
    if (confirm('선택한 항목을 [데이터 정화소]로 이동하여 오탐 검토 및 AI 정화 피드백을 진행하시겠습니까?\n\n' + '항목 ID: ' + id + '\n' + '근거 원문: ' + evidence)) {
      window.location.href = '/mgr/train?id=' + encodeURIComponent(id) + '&text=' + encodeURIComponent(evidence) + '&url=' + encodeURIComponent(url);
    }
  };

  // AI 테스트 샘플 설정 전역 함수
  window.setAiTestSample = function (sampleText) {
    const inputEl = document.getElementById('input-ai-test-text');
    if (inputEl) {
      inputEl.value = sampleText;
    }
  };

  // AI 테스트 실행 함수
  async function runAiTest() {
    const inputEl = document.getElementById('input-ai-test-text');
    const resultBox = document.getElementById('ai-test-result-box');
    const labelEl = document.getElementById('ai-test-result-label');
    const badgeEl = document.getElementById('ai-test-confidence-badge');
    const transEl = document.getElementById('ai-test-trans-text');
    const reasonEl = document.getElementById('ai-test-reason-text');
    const deviceBadge = document.getElementById('ai-test-device-badge');
    const btnRun = document.getElementById('btn-run-ai-test');

    const text = (inputEl ? inputEl.value : '').trim();
    if (!text) {
      alert('판정할 텍스트를 입력해 주세요.');
      return;
    }

    if (btnRun) {
      btnRun.disabled = true;
      btnRun.textContent = '분석 중...';
    }

    if (resultBox) {
      resultBox.classList.remove('d-none');
    }
    if (labelEl) labelEl.textContent = '3단계 AI 모델 심층 분석 중...';
    if (badgeEl) {
      badgeEl.className = 'badge text-bg-warning';
      badgeEl.textContent = '연산 중';
    }
    if (transEl) transEl.textContent = '번역 모델(opus-mt) 및 LLM(Qwen2.5) 추론 중...';
    if (reasonEl) reasonEl.textContent = '잠시만 기다려 주세요.';

    try {
      const res = await fetch('/mgr/api/test-ai-classify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });
      const data = await res.json();

      if (data.success && data.result) {
        const r = data.result;
        if (deviceBadge && r.deviceMode) {
          deviceBadge.textContent = r.deviceMode;
          deviceBadge.className = r.deviceMode.includes('GPU') ? 'badge text-bg-success' : 'badge text-bg-info';
        }

        if (r.isViolation) {
          labelEl.innerHTML = '<span class="text-danger fw-bold">[위반] 불법 도박/사행성 스팸 광고</span>';
          badgeEl.className = 'badge text-bg-danger';
          badgeEl.textContent = `위반 확정 (${r.confidence}%)`;
        } else {
          labelEl.innerHTML = '<span class="text-success fw-bold">[정상] 공공 안내 또는 일반 콘텐츠</span>';
          badgeEl.className = 'badge text-bg-success';
          badgeEl.textContent = `정상 판정 (${r.confidence}%)`;
        }

        transEl.textContent = `영문 번역: "${r.englishText || '-'}" (유사도: ${r.similarityScore || 0})`;
        reasonEl.textContent = `판정 이유: ${r.reason || '-'}`;
      } else {
        labelEl.textContent = '판정 실패: ' + (data.msg || '알 수 없는 오류');
      }
    } catch (err) {
      labelEl.textContent = '분석 오류: ' + (err.message || '서버 통신 실패');
    } finally {
      if (btnRun) {
        btnRun.disabled = false;
        btnRun.textContent = '판정 실행';
      }
    }
  }
})();
