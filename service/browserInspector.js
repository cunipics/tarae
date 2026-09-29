/**
 * 브라우저 기반 CSS 시각 은닉 정밀 검사 서비스 (browserInspector.js)
 * - Puppeteer 헤드리스 크롬으로 페이지를 실제 렌더링
 * - window.getComputedStyle()로 모든 요소의 최종 계산 스타일 검사
 * - TRANSPARENT: 배경색과 글자색 동일, opacity:0, visibility:hidden 등
 * - OFFSCREEN: position+left:-9999px, font-size:0, display:none, clip 은닉 등
 */

let puppeteer = null;
let browser = null;

// Puppeteer 모듈 지연 로딩
async function getPuppeteer() {
  if (!puppeteer) {
    puppeteer = require('puppeteer');
  }
  return puppeteer;
}

// 브라우저 인스턴스 획득 (싱글톤 재사용)
async function getBrowser() {
  if (browser && browser.connected) {
    return browser;
  }

  const ppt = await getPuppeteer();
  browser = await ppt.launch({
    headless: true, // 바탕화면에 about:blank 빈 창이 뜨지 않도록 헤드리스로 안정 구동
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-web-security',
      // CPU/메모리 절약 옵션
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=TranslateUI',
      '--disable-ipc-flooding-protection'
    ]
  });

  console.log('[BrowserInspector] Puppeteer 헤드리스 크롬 브라우저 시작 완료');
  return browser;
}

// 브라우저 종료
async function closeBrowser() {
  if (browser && browser.connected) {
    try {
      await browser.close();
    } catch (e) {}
    browser = null;
  }
}

/**
 * 페이지를 실제 렌더링하고 CSS 시각 은닉 요소를 정밀 검사합니다.
 * @param {string} url - 검사할 페이지 URL
 * @param {number} timeoutMs - 페이지 로딩 타임아웃 (기본 15초)
 * @returns {Array} 검출된 은닉 요소 목록
 */
async function inspectPageDetails(url, timeoutMs = 15000, options = {}) {
  const results = [];
  const renderedLinks = [];
  let renderedHtml = '';
  let page = null;
  const waitForDynamicNetwork = options.waitForDynamicNetwork !== false;
  const collectDynamicPagination = options.collectDynamicPagination !== false;

  try {
    const br = await getBrowser();
    page = await br.newPage();

    // 브라우저에서 alert, confirm, prompt 등 대화상자 발생 시 자동으로 즉시 닫기
    page.on('dialog', async dialog => {
      try {
        await dialog.dismiss();
      } catch (e) {}
    });

    // 실제 브라우저 유저에이전트 설정
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1920, height: 1080 });

    // CSS 검사에 불필요한 대용량 이미지, 미디어, 폰트 및 외부 광고/통계 추적기 차단 (검사 속도 대폭 향상)
    try {
      await page.setRequestInterception(true);
      page.on('request', req => {
        const rt = req.resourceType();
        const reqUrl = req.url().toLowerCase();
        if (
          rt === 'image' ||
          rt === 'media' ||
          rt === 'font' ||
          reqUrl.includes('google-analytics') ||
          reqUrl.includes('googletagmanager') ||
          reqUrl.includes('facebook.net') ||
          reqUrl.includes('criteo') ||
          reqUrl.includes('channel.io') ||
          reqUrl.includes('clarity.ms') ||
          reqUrl.includes('daumcdn.net/kas')
        ) {
          req.abort();
        } else {
          req.continue();
        }
      });
    } catch (icErr) {}

    // 페이지 로딩 (외부 통신 무한 대기를 막기 위해 domcontentloaded 완료 즉시 검사)
    try {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: Math.min(timeoutMs, 10000)
      });
      await new Promise(r => setTimeout(r, 400));
      if (waitForDynamicNetwork) {
        try {
          await page.waitForNetworkIdle({ idleTime: 300, timeout: 2500 });
        } catch (e) {}
      }
    } catch (gotoErr) {
      console.warn('[BrowserInspector] goto warning:', gotoErr.message);
    }

    // 스크롤 인터랙션(AOS 등) 트리거하여 화면 페이드인 애니메이션 활성화
    try {
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight / 2);
      });
      await new Promise(r => setTimeout(r, 150));
      await page.evaluate(() => {
        window.scrollTo(0, 0);
      });
    } catch(e) {}

    // 동적 웹사이트가 브라우저 실행 후 만든 HTML과 내부 링크를 함께 확보
    try {
      renderedHtml = await page.content();
      const collectedLinkUrls = new Set();
      const collectCurrentLinks = async () => {
        const links = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).map(anchor => ({
          href: anchor.href || anchor.getAttribute('href') || '',
          text: (anchor.innerText || anchor.textContent || '').replace(/\s+/g, ' ').trim()
        })));
        for (const link of links) {
          if (!link.href || collectedLinkUrls.has(link.href)) continue;
          collectedLinkUrls.add(link.href);
          renderedLinks.push(link);
        }
      };

      await collectCurrentLinks();

      // 주소가 없는 버튼 방식의 동적 쪽 이동도 실제 버튼을 순서대로 눌러 링크를 수집
      const paginationStartedAt = Date.now();
      const seenPaginationStates = new Set();
      for (let pageIndex = 0; collectDynamicPagination && pageIndex < 100; pageIndex++) {
        if (Date.now() - paginationStartedAt >= Math.max(2000, timeoutMs - 2000)) break;

        const state = await page.evaluate((iteration) => {
          const containers = Array.from(document.querySelectorAll(
            '[class*="pagination"], [class*="paging"], [id*="pagination"], [id*="paging"], nav[aria-label]'
          ));
          const container = containers.find(element => {
            const controls = Array.from(element.querySelectorAll('button, [role="button"]'));
            const numericCount = controls.filter(control => /^\d+$/.test((control.textContent || '').trim())).length;
            const hasMoveControl = controls.some(control => {
              const label = `${control.className || ''} ${control.getAttribute('aria-label') || ''} ${control.textContent || ''}`;
              return /다음|next|더보기|load\s*more|show\s*more/i.test(label);
            });
            return numericCount >= 2 || hasMoveControl;
          });
          if (!container) return { clicked: false, state: '' };

          const controls = Array.from(container.querySelectorAll('button, [role="button"]'));
          const active = container.querySelector('[aria-current="page"], .is-active, .active, .current');
          const current = (active?.textContent || '').trim();
          const isDisabled = control => !control || control.disabled ||
            control.getAttribute('aria-disabled') === 'true' ||
            /(?:^|\s)(?:disabled|is-disabled)(?:\s|$)/i.test(control.className || '');

          let target = controls.find(control => {
            const label = `${control.className || ''} ${control.getAttribute('aria-label') || ''}`;
            return /다음|next/i.test(label) && !isDisabled(control);
          });

          if (!target) {
            const currentNumber = Number(current);
            const numericControls = controls
              .map(control => ({ control, number: Number((control.textContent || '').trim()) }))
              .filter(item => Number.isInteger(item.number) && item.number > 0 && !isDisabled(item.control))
              .sort((a, b) => a.number - b.number);
            if (Number.isInteger(currentNumber) && currentNumber > 0) {
              target = numericControls.find(item => item.number > currentNumber)?.control || null;
            } else {
              target = numericControls[Math.min(iteration + 1, numericControls.length - 1)]?.control || null;
            }
          }

          if (!target) {
            target = controls.find(control => {
              const label = `${control.className || ''} ${control.getAttribute('aria-label') || ''} ${control.textContent || ''}`;
              return /더보기|load\s*more|show\s*more/i.test(label) && !isDisabled(control);
            });
          }

          if (!target) return { clicked: false, state: current };
          const targetLabel = (target.textContent || target.getAttribute('aria-label') || '').trim();
          const beforeLinkCount = document.querySelectorAll('a[href]').length;
          target.click();
          return { clicked: true, state: `${current}:${targetLabel}:${beforeLinkCount}` };
        }, pageIndex);

        if (!state.clicked || seenPaginationStates.has(state.state)) break;
        seenPaginationStates.add(state.state);
        await new Promise(resolve => setTimeout(resolve, 250));
        try {
          await page.waitForNetworkIdle({ idleTime: 150, timeout: 1000 });
        } catch (e) {}
        await collectCurrentLinks();
      }
    } catch (e) {}

    // 브라우저 컨텍스트에서 모든 요소의 computed style 검사 실행
    const findings = await page.evaluate(() => {
      const detected = [];

      // CSS 선택자 경로 생성 함수 (가이드 규칙 준수)
      function buildSelector(el) {
        const parts = [];
        let curr = el;
        while (curr && curr !== document.body && curr !== document.documentElement) {
          const tag = curr.tagName.toLowerCase();
          const cls = curr.className && typeof curr.className === 'string'
            ? curr.className.trim().split(/\s+/)[0]
            : '';

          if (cls) {
            parts.unshift(tag + '.' + cls);
          } else {
            // 클래스 없으면 nth-of-type
            let idx = 1;
            if (curr.parentElement) {
              const siblings = Array.from(curr.parentElement.children).filter(
                c => c.tagName === curr.tagName
              );
              idx = siblings.indexOf(curr) + 1;
            }
            parts.unshift(tag + ':nth-of-type(' + Math.max(1, idx) + ')');
          }
          curr = curr.parentElement;
        }
        return parts.join(' > ') || 'body';
      }

      // 색상 문자열을 RGBA 배열로 변환
      function parseColor(colorStr) {
        if (!colorStr) return null;
        const m = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)/);
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

      // 두 색상이 동일하거나 매우 유사한지 판정
      function isSameColor(c1, c2) {
        if (!c1 || !c2) return false;
        return Math.abs(c1.r - c2.r) <= 5
          && Math.abs(c1.g - c2.g) <= 5
          && Math.abs(c1.b - c2.b) <= 5;
      }

      // 스크립트, 스타일, 메타, 헤더 문서 태그 등 화면 렌더링 목적이 아닌 태그 제외
      const skipTags = new Set([
        'script', 'style', 'meta', 'link', 'noscript', 'head', 'title', 'base', 'template',
        'br', 'hr', 'img', 'svg', 'path', 'audio', 'video', 'canvas', 'caption', 'colgroup', 'col'
      ]);

      // 모든 DOM 요소 순회
      const allElements = document.querySelectorAll('*');

      for (const el of allElements) {
        const tag = el.tagName.toLowerCase();
        if (skipTags.has(tag)) continue;

        // head 내부 요소는 전부 제외
        if (el.closest('head')) continue;

        // 웹접근성 스크린리더용 표준 클래스는 시각적 은닉 악용이 아닌 표준 웹 기술이므로 제외
        const clsStr = (el.className && typeof el.className === 'string') ? el.className.toLowerCase() : '';
        if (clsStr.includes('sound_only') || clsStr.includes('sr-only') || clsStr.includes('sd_hidden') || clsStr.includes('blind') || clsStr.includes('skip-nav') || clsStr.includes('img_zoom') || clsStr.includes('btn_zoom')) {
          continue;
        }

        // 스크롤 및 등장 애니메이션 라이브러리(AOS, WOW.js 등)는 스크롤 전 opacity:0 이 기본 동작이므로 오탐 배제
        if (clsStr.includes('aos-') || el.hasAttribute('data-aos') || el.closest('.aos-init, [data-aos], .wow, .animated, .animate__animated')) {
          continue;
        }

        // 텍스트 노드가 있는 요소만 검사 (직접 텍스트가 있는 경우)
        const directText = Array.from(el.childNodes)
          .filter(n => n.nodeType === 3) // TEXT_NODE
          .map(n => n.textContent.trim())
          .join('')
          .trim();

        if (!directText || directText.length < 2) continue;

        // 스크린리더(웹 접근성) 전용 단어는 은닉 불법광고가 아니므로 제외
        const accessTerms = ['초기화', '축소', '확대', '검색', '닫기', '열기', '이전', '다음', '메뉴', '선택', '바로가기', '열린', '새창', '새창열림', '다운로드', '목록', '더보기', '페이지', '홈', '인쇄', '공유', '상세보기'];
        if (accessTerms.includes(directText)) continue;

        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const selector = buildSelector(el);

        // [TRANSPARENT 검사] 투명 텍스트 은닉
        const textColor = parseColor(style.color);
        const bgColor = parseColor(style.backgroundColor);
        const opacity = parseFloat(style.opacity);
        const visibility = style.visibility;

        let isTransparent = false;
        let transparentReason = '';

        // 1) opacity가 0이거나 0에 가까움
        if (opacity <= 0.01) {
          isTransparent = true;
          transparentReason = 'opacity: ' + opacity;
        }
        // 2) visibility: hidden
        else if (visibility === 'hidden') {
          isTransparent = true;
          transparentReason = 'visibility: hidden';
        }
        // 3) 글자색 투명 (alpha 0)
        else if (textColor && textColor.a <= 0.01) {
          isTransparent = true;
          transparentReason = 'color alpha: ' + textColor.a;
        }
        // 4) 글자색과 배경색 동일 (사람 눈에 안 보임)
        else if (textColor && bgColor && bgColor.a > 0.5 && isSameColor(textColor, bgColor)) {
          isTransparent = true;
          transparentReason = 'color(' + style.color + ') == background(' + style.backgroundColor + ')';
        }

        if (isTransparent) {
          detected.push({
            technique: 'TRANSPARENT',
            location: selector,
            evidence_text: directText.substring(0, 200),
            reason: transparentReason,
            computedStyle: {
              color: style.color,
              backgroundColor: style.backgroundColor,
              opacity: style.opacity,
              visibility: style.visibility
            }
          });
          continue;
        }

        // [OFFSCREEN 검사] 화면 밖 은닉
        let isOffscreen = false;
        let offscreenReason = '';

        const position = style.position;
        const display = style.display;
        const fontSize = parseFloat(style.fontSize);
        const overflow = style.overflow;
        const clipPath = style.clipPath;
        const clip = style.clip;

        // 1) display: none
        if (display === 'none') {
          isOffscreen = true;
          offscreenReason = 'display: none';
        }
        // 2) font-size: 0~1px
        else if (fontSize <= 1) {
          isOffscreen = true;
          offscreenReason = 'font-size: ' + style.fontSize;
        }
        // 3) position:absolute/fixed 로 화면 밖 좌표
        else if (position === 'absolute' || position === 'fixed') {
          if (rect.right < 0 || rect.bottom < 0 || rect.left > 10000 || rect.top > 10000) {
            isOffscreen = true;
            offscreenReason = 'position: ' + position + '; rect: left=' + Math.round(rect.left) + ' top=' + Math.round(rect.top);
          }
        }
        // 4) clip/clip-path로 0 크기 렌더링
        else if (clipPath === 'inset(50%)' || clip === 'rect(0px, 0px, 0px, 0px)' || clip === 'rect(1px, 1px, 1px, 1px)') {
          isOffscreen = true;
          offscreenReason = 'clip: ' + (clipPath || clip);
        }
        // 5) 요소 크기 0 (width/height 0이면서 overflow hidden)
        else if (rect.width <= 1 && rect.height <= 1 && overflow === 'hidden') {
          isOffscreen = true;
          offscreenReason = 'size: ' + Math.round(rect.width) + 'x' + Math.round(rect.height) + ' overflow:hidden';
        }

        if (isOffscreen) {
          detected.push({
            technique: 'OFFSCREEN',
            location: selector,
            evidence_text: directText.substring(0, 200),
            reason: offscreenReason,
            computedStyle: {
              display: display,
              position: position,
              fontSize: style.fontSize,
              clip: style.clip,
              clipPath: style.clipPath,
              rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
            }
          });
        }
      }

      return detected;
    });

    // iframe 및 frame 내부 요소 정밀 검사 (가이드 규격: iframe[src="..."] >>> selector)
    const iframes = await page.$$('iframe, frame');
    for (const iframe of iframes) {
      try {
        const src = await iframe.evaluate(el => el.src || el.getAttribute('src') || '');
        if (!src) continue;

        const lowerSrc = src.toLowerCase();
        if (
          lowerSrc.includes('google') ||
          lowerSrc.includes('facebook') ||
          lowerSrc.includes('kakao') ||
          lowerSrc.includes('criteo') ||
          lowerSrc.includes('channel.io') ||
          lowerSrc.includes('youtube') ||
          lowerSrc.includes('vimeo') ||
          lowerSrc.includes('recaptcha')
        ) {
          continue;
        }

        const frame = await iframe.contentFrame();
        if (!frame) continue;

        const iframeFindings = await frame.evaluate((iframeSrc) => {
          const detected = [];

          function buildSelector(el) {
            const parts = [];
            let curr = el;
            while (curr && curr !== document.body && curr !== document.documentElement) {
              const tag = curr.tagName.toLowerCase();
              const cls = curr.className && typeof curr.className === 'string'
                ? curr.className.trim().split(/\s+/)[0]
                : '';
              if (cls) {
                parts.unshift(tag + '.' + cls);
              } else {
                let idx = 1;
                if (curr.parentElement) {
                  const siblings = Array.from(curr.parentElement.children).filter(
                    c => c.tagName === curr.tagName
                  );
                  idx = siblings.indexOf(curr) + 1;
                }
                parts.unshift(tag + ':nth-of-type(' + Math.max(1, idx) + ')');
              }
              curr = curr.parentElement;
            }
            return 'iframe[src="' + iframeSrc + '"] >>> ' + (parts.join(' > ') || 'body');
          }

          function parseColor(colorStr) {
            if (!colorStr) return null;
            const m = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)/);
            if (m) return { r: parseInt(m[1]), g: parseInt(m[2]), b: parseInt(m[3]), a: m[4] !== undefined ? parseFloat(m[4]) : 1 };
            if (colorStr === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
            return null;
          }

          function isSameColor(c1, c2) {
            if (!c1 || !c2) return false;
            return Math.abs(c1.r - c2.r) <= 5 && Math.abs(c1.g - c2.g) <= 5 && Math.abs(c1.b - c2.b) <= 5;
          }

          const skipTags = new Set(['script','style','meta','link','noscript','head','br','hr','img','svg','path']);
          const allElements = document.querySelectorAll('*');

          for (const el of allElements) {
            if (skipTags.has(el.tagName.toLowerCase())) continue;
            const directText = Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('').trim();
            if (!directText || directText.length < 2) continue;

            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            const selector = buildSelector(el);
            const textColor = parseColor(style.color);
            const bgColor = parseColor(style.backgroundColor);
            const opacity = parseFloat(style.opacity);

            // TRANSPARENT
            if (opacity <= 0.01 || style.visibility === 'hidden' || (textColor && textColor.a <= 0.01) || (textColor && bgColor && bgColor.a > 0.5 && isSameColor(textColor, bgColor))) {
              detected.push({ technique: 'TRANSPARENT', location: selector, evidence_text: directText.substring(0, 200), reason: 'iframe 내부 투명 은닉' });
              continue;
            }

            // OFFSCREEN
            const fontSize = parseFloat(style.fontSize);
            if (style.display === 'none' || fontSize <= 1 || ((style.position === 'absolute' || style.position === 'fixed') && (rect.right < 0 || rect.left > 10000))) {
              detected.push({ technique: 'OFFSCREEN', location: selector, evidence_text: directText.substring(0, 200), reason: 'iframe 내부 화면밖 은닉' });
            }
          }

          return detected;
        }, src);

        results.push(...iframeFindings);
      } catch (iframeErr) {
        // 교차 출처 iframe 접근 불가시 건너뜀
      }
    }

    results.push(...findings);
  } catch (err) {
    console.error('[BrowserInspector] 페이지 검사 오류:', url, err.message);
  } finally {
    if (page) {
      try { await page.close(); } catch (e) {}
    }
  }

  return {
    findings: results,
    links: renderedLinks,
    html: renderedHtml
  };
}

async function inspectPage(url, timeoutMs = 15000) {
  const details = await inspectPageDetails(url, timeoutMs);
  return details.findings;
}

module.exports = {
  inspectPage,
  inspectPageDetails,
  closeBrowser,
  getBrowser
};
