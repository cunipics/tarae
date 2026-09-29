/**
 * Electron 실제 브라우저 윈도우 기반 CSS 시각 은닉 점검 서비스 (electronBrowserInspector.js)
 * - Electron BrowserWindow를 화면(보조 창 또는 레이어 윈도우)에 직접 띄움
 * - 점검 대상 URL을 실제 로드하며 화면에 실시간 표시
 * - 페이지 내 DOM 요소의 getComputedStyle 계산 및 은닉 요소 시각적 하이라이트(빨간 테두리)
 */

let inspectorWindow = null;
let electronModule = null;

function getElectron() {
  if (!electronModule) {
    try {
      electronModule = require('electron');
    } catch (e) {
      return null;
    }
  }
  return electronModule;
}

// 점검용 BrowserWindow 생성 및 반환 (싱글톤 보조 창)
async function getOrCreateInspectorWindow() {
  const electron = getElectron();
  if (!electron || !electron.BrowserWindow) {
    return null;
  }

  const { BrowserWindow } = electron;

  if (inspectorWindow && !inspectorWindow.isDestroyed()) {
    return inspectorWindow;
  }

  inspectorWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    title: '불법광고 시각 은닉 실시간 점검 브라우저',
    show: true, // 사용자가 볼 수 있도록 실제 창 표시
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false // 교차 출처 및 iframe 검사 허용
    }
  });

  inspectorWindow.on('closed', () => {
    inspectorWindow = null;
  });

  return inspectorWindow;
}

/**
 * 실제 Electron BrowserWindow에서 URL을 로드하고 투명/화면밖 은닉 요소를 점검합니다.
 * 은닉 요소 발견 시 웹페이지 내에 빨간색 하이라이트 박스를 그려줍니다.
 */
async function inspectPage(url, timeoutMs = 15000) {
  const win = await getOrCreateInspectorWindow();
  if (!win) {
    console.warn('[ElectronInspector] Electron 환경이 아니므로 브라우저 창 생성을 건너뜁니다.');
    return [];
  }

  try {
    // 1. 실제 브라우저 창에 대상 웹페이지 로드
    await win.loadURL(url);

    // 2. 렌더링 완료 대기 (0.5초 대기)
    await new Promise(resolve => setTimeout(resolve, 500));

    // 3. 브라우저 창 내에서 DOM 및 getComputedStyle 실시간 검사 & 하이라이트
    const script = `
      (function() {
        const detected = [];

        function buildSelector(el) {
          const parts = [];
          let curr = el;
          while (curr && curr !== document.body && curr !== document.documentElement) {
            const tag = curr.tagName.toLowerCase();
            const cls = curr.className && typeof curr.className === 'string'
              ? curr.className.trim().split(/\\s+/)[0]
              : '';
            if (cls) {
              parts.unshift(tag + '.' + cls);
            } else {
              let idx = 1;
              if (curr.parentElement) {
                const siblings = Array.from(curr.parentElement.children).filter(c => c.tagName === curr.tagName);
                idx = siblings.indexOf(curr) + 1;
              }
              parts.unshift(tag + ':nth-of-type(' + Math.max(1, idx) + ')');
            }
            curr = curr.parentElement;
          }
          return parts.join(' > ') || 'body';
        }

        function parseColor(colorStr) {
          if (!colorStr) return null;
          const m = colorStr.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([0-9.]+))?\\)/);
          if (m) {
            return {
              r: parseInt(m[1]),
              g: parseInt(m[2]),
              b: parseInt(m[3]),
              a: m[4] !== undefined ? parseFloat(m[4]) : 1
            };
          }
          if (colorStr === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
          return null;
        }

        function isSameColor(c1, c2) {
          if (!c1 || !c2) return false;
          return Math.abs(c1.r - c2.r) <= 5 && Math.abs(c1.g - c2.g) <= 5 && Math.abs(c1.b - c2.b) <= 5;
        }

        const skipTags = new Set(['script', 'style', 'meta', 'link', 'noscript', 'head', 'br', 'hr', 'img', 'svg', 'path']);
        const allElements = document.querySelectorAll('*');

        for (const el of allElements) {
          const tag = el.tagName.toLowerCase();
          if (skipTags.has(tag)) continue;

          const directText = Array.from(el.childNodes)
            .filter(n => n.nodeType === 3)
            .map(n => n.textContent.trim())
            .join('')
            .trim();

          if (!directText || directText.length < 2) continue;

          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          const selector = buildSelector(el);

          // TRANSPARENT (투명 텍스트)
          const textColor = parseColor(style.color);
          const bgColor = parseColor(style.backgroundColor);
          const opacity = parseFloat(style.opacity);
          const visibility = style.visibility;

          let isTransparent = false;
          let transparentReason = '';

          if (opacity <= 0.01) {
            isTransparent = true;
            transparentReason = 'opacity: ' + opacity;
          } else if (visibility === 'hidden') {
            isTransparent = true;
            transparentReason = 'visibility: hidden';
          } else if (textColor && textColor.a <= 0.01) {
            isTransparent = true;
            transparentReason = 'color alpha: ' + textColor.a;
          } else if (textColor && bgColor && bgColor.a > 0.5 && isSameColor(textColor, bgColor)) {
            isTransparent = true;
            transparentReason = 'color(' + style.color + ') == background(' + style.backgroundColor + ')';
          }

          if (isTransparent) {
            // 화면에 시각적 하이라이트 표시 (빨간 점선 테두리 + 배경)
            try {
              el.style.outline = '3px dashed #dc3545';
              el.style.backgroundColor = 'rgba(220, 53, 69, 0.15)';
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            } catch(e) {}

            detected.push({
              technique: 'TRANSPARENT',
              location: selector,
              evidence_text: directText.substring(0, 200),
              reason: transparentReason
            });
            continue;
          }

          // OFFSCREEN (화면 밖 은닉)
          let isOffscreen = false;
          let offscreenReason = '';
          const position = style.position;
          const display = style.display;
          const fontSize = parseFloat(style.fontSize);
          const overflow = style.overflow;
          const clipPath = style.clipPath;
          const clip = style.clip;

          if (display === 'none') {
            isOffscreen = true;
            offscreenReason = 'display: none';
          } else if (fontSize <= 1) {
            isOffscreen = true;
            offscreenReason = 'font-size: ' + style.fontSize;
          } else if (position === 'absolute' || position === 'fixed') {
            if (rect.right < 0 || rect.bottom < 0 || rect.left > 10000 || rect.top > 10000) {
              isOffscreen = true;
              offscreenReason = 'position: ' + position + '; left=' + Math.round(rect.left) + ' top=' + Math.round(rect.top);
            }
          } else if (clipPath === 'inset(50%)' || clip === 'rect(0px, 0px, 0px, 0px)' || clip === 'rect(1px, 1px, 1px, 1px)') {
            isOffscreen = true;
            offscreenReason = 'clip: ' + (clipPath || clip);
          } else if (rect.width <= 1 && rect.height <= 1 && overflow === 'hidden') {
            isOffscreen = true;
            offscreenReason = 'size: ' + Math.round(rect.width) + 'x' + Math.round(rect.height);
          }

          if (isOffscreen) {
            detected.push({
              technique: 'OFFSCREEN',
              location: selector,
              evidence_text: directText.substring(0, 200),
              reason: offscreenReason
            });
          }
        }

        return detected;
      })();
    `;

    const findings = await win.webContents.executeJavaScript(script);
    return Array.isArray(findings) ? findings : [];
  } catch (err) {
    console.warn('[ElectronInspector] 점검 오류:', url, err.message);
    return [];
  }
}

// 브라우저 윈도우 닫기
function closeInspectorWindow() {
  if (inspectorWindow && !inspectorWindow.isDestroyed()) {
    try {
      inspectorWindow.close();
    } catch (e) {}
    inspectorWindow = null;
  }
}

module.exports = {
  inspectPage,
  closeInspectorWindow
};
