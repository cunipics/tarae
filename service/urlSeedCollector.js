/**
 * 외부 URL 씨드 수집기 (urlSeedCollector.js)
 * - Common Crawl CDX Index API 역조회: 과거에 존재했던 URL 발굴
 * - urlscan.io 공개 검색 API: 보안 연구자 스캔 기록에서 URL 발굴
 * 두 소스 모두 API 키 없이 무료 사용 가능
 */

// Common Crawl 최신 인덱스명을 캐시 (프로세스 수명 동안 1회만 조회)
let _cachedCcIndex = null;

/**
 * Common Crawl 최신 인덱스명 조회 (예: CC-MAIN-2026-39)
 */
async function getLatestCommonCrawlIndex() {
  if (_cachedCcIndex) return _cachedCcIndex;
  try {
    const resp = await fetch('https://index.commoncrawl.org/collinfo.json', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000)
    });
    if (!resp.ok) return null;
    const list = await resp.json();
    if (Array.isArray(list) && list.length > 0) {
      // 첫 번째 항목이 가장 최신 인덱스
      const latest = list[0].id || list[0].cdx_api || null;
      // id 형식: "CC-MAIN-2026-39" 또는 cdx_api URL에서 추출
      let indexName = null;
      if (list[0].id) {
        indexName = list[0].id;
      } else if (list[0].cdx_api) {
        const m = list[0].cdx_api.match(/CC-MAIN-[\d-]+/);
        indexName = m ? m[0] : null;
      }
      _cachedCcIndex = indexName;
      return indexName;
    }
  } catch (e) {
    console.warn('[UrlSeedCollector] Common Crawl 인덱스 조회 실패:', e.message);
  }
  return null;
}

/**
 * Common Crawl CDX Index API로 도메인의 과거 URL 역조회
 * @param {string} domain - 도메인 (예: example.go.kr)
 * @param {string} entryUrl - 진입 URL (동일 도메인 필터용)
 * @returns {Map} url -> { linkText } 맵
 */
async function fetchCommonCrawlUrls(domain, entryUrl) {
  const result = new Map();
  try {
    const indexName = await getLatestCommonCrawlIndex();
    if (!indexName) {
      console.warn('[UrlSeedCollector] Common Crawl 인덱스명 조회 실패, 건너뜁니다.');
      return result;
    }

    const apiUrl = `https://index.commoncrawl.org/${indexName}-index?url=*.${domain}&output=json&limit=500`;
    console.log(`[UrlSeedCollector] Common Crawl 역조회: ${apiUrl}`);

    const resp = await fetch(apiUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(15000)
    });

    if (!resp.ok) {
      console.warn(`[UrlSeedCollector] Common Crawl 응답 오류: ${resp.status}`);
      return result;
    }

    const text = await resp.text();
    // 응답은 JSON Lines (한 줄에 JSON 객체 1개) 형식
    const lines = text.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        const url = obj.url;
        if (!url) continue;
        // 동일 도메인 확인 (www 차이 허용)
        try {
          const parsedHost = new URL(url).hostname.replace(/^www\./, '');
          const entryHost = new URL(entryUrl).hostname.replace(/^www\./, '');
          if (parsedHost !== entryHost) continue;
        } catch (e) { continue; }

        if (!result.has(url)) {
          result.set(url, { linkText: '[Common Crawl] 과거 크롤 URL', riskScore: 30 });
        }
      } catch (e) {}
    }

    console.log(`[UrlSeedCollector] Common Crawl 역조회 완료: ${result.size}개 URL 확보`);
  } catch (e) {
    console.warn('[UrlSeedCollector] Common Crawl 조회 오류:', e.message);
  }
  return result;
}

/**
 * urlscan.io 공개 검색 API로 도메인의 히스토리 URL 조회
 * @param {string} domain - 도메인 (예: example.go.kr)
 * @param {string} entryUrl - 진입 URL (동일 도메인 필터용)
 * @returns {Map} url -> { linkText } 맵
 */
async function fetchUrlscanUrls(domain, entryUrl) {
  const result = new Map();
  try {
    // urlscan.io 공개 검색 (API 키 없이 사용 가능, rate limit: 1req/sec 수준)
    const apiUrl = `https://urlscan.io/api/v1/search/?q=page.domain:${domain}&size=100`;
    console.log(`[UrlSeedCollector] urlscan.io 역조회: ${apiUrl}`);

    const resp = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(10000)
    });

    if (!resp.ok) {
      console.warn(`[UrlSeedCollector] urlscan.io 응답 오류: ${resp.status}`);
      return result;
    }

    const json = await resp.json();
    const items = json.results || [];

    const entryHost = new URL(entryUrl).hostname.replace(/^www\./, '');

    for (const item of items) {
      const pageUrl = item?.page?.url;
      if (!pageUrl) continue;
      try {
        const parsedHost = new URL(pageUrl).hostname.replace(/^www\./, '');
        if (parsedHost !== entryHost) continue;
      } catch (e) { continue; }

      if (!result.has(pageUrl)) {
        result.set(pageUrl, { linkText: '[urlscan.io] 보안스캔 기록 URL', riskScore: 25 });
      }
    }

    console.log(`[UrlSeedCollector] urlscan.io 역조회 완료: ${result.size}개 URL 확보`);
  } catch (e) {
    console.warn('[UrlSeedCollector] urlscan.io 조회 오류:', e.message);
  }
  return result;
}

/**
 * RSS/Atom 피드 URL 씨드 수집
 * @param {string} origin - https://example.go.kr
 * @param {string} entryUrl - 진입 URL
 * @returns {Map} url -> { linkText } 맵
 */
async function fetchRssFeedUrls(origin, entryUrl) {
  const result = new Map();
  const feedEndpoints = [
    `${origin}/feed`,
    `${origin}/feed.xml`,
    `${origin}/rss`,
    `${origin}/rss.xml`,
    `${origin}/atom.xml`,
    `${origin}/feed/rss`,
    `${origin}/index.xml`
  ];

  const entryHost = new URL(entryUrl).hostname.replace(/^www\./, '');

  await Promise.allSettled(feedEndpoints.map(async (feedUrl) => {
    try {
      const resp = await fetch(feedUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/rss+xml,application/atom+xml,application/xml,text/xml' },
        signal: AbortSignal.timeout(4000)
      });
      if (!resp.ok) return;

      const contentType = resp.headers.get('content-type') || '';
      // RSS/Atom XML 응답만 처리 (HTML 페이지 제외)
      if (!contentType.includes('xml') && !contentType.includes('rss') && !contentType.includes('atom')) return;

      const xmlText = await resp.text();

      // <link> 태그 및 <guid> 태그에서 URL 추출 (RSS/Atom 공통)
      const linkMatches = xmlText.matchAll(/<(?:link|guid)[^>]*>([^<]+)<\/(?:link|guid)>/gi);
      for (const m of linkMatches) {
        const candidate = m[1].trim();
        if (!candidate.startsWith('http')) continue;
        try {
          const parsedHost = new URL(candidate).hostname.replace(/^www\./, '');
          if (parsedHost !== entryHost) continue;
        } catch (e) { continue; }
        if (!result.has(candidate)) {
          result.set(candidate, { linkText: '[RSS/Atom] 피드 게시물 URL' });
        }
      }
    } catch (e) {}
  }));

  if (result.size > 0) {
    console.log(`[UrlSeedCollector] RSS/Atom 피드 수집 완료: ${result.size}개 URL 확보`);
  }

  return result;
}

const { getRandomHumanHeaders } = require('../config/browserHeaders.config');
const config = require('../config/config');
const { write: logWrite } = require('../utils/logger');
const htmlparser2 = require('htmlparser2');
const domutils = require('domutils');

function collectDuckDuckGoResultLinks(html, entryHost) {
  const links = new Set();
  const document = htmlparser2.parseDocument(html, { decodeEntities: true });
  const anchors = domutils.findAll(node => node.type === 'tag' && node.name === 'a', document.children);

  for (const anchor of anchors) {
    const href = anchor.attribs && anchor.attribs.href;
    if (!href) continue;

    try {
      const link = new URL(href, 'https://duckduckgo.com');
      const isDuckDuckGoLink = link.hostname === 'duckduckgo.com' || link.hostname.endsWith('.duckduckgo.com');
      const target = isDuckDuckGoLink && link.searchParams.has('uddg')
        ? new URL(link.searchParams.get('uddg'))
        : link;
      const targetHost = target.hostname.toLowerCase().replace(/^www\./, '');
      if ((target.protocol === 'http:' || target.protocol === 'https:') && targetHost === entryHost) {
        target.hash = '';
        links.add(target.href);
      }
    } catch (e) {}
  }

  return links;
}

/**
 * DuckDuckGo Lite 검색엔진 Dorking URL 역조회 (알려진 검색내용 활용)
 * @param {string} domain - 대상 도메인 (예: example.go.kr)
 * @param {string} entryUrl - 진입 URL (동일 도메인 필터용)
 * @param {Array<string>} keywords - .env 등에서 전달된 오염 키워드 목록
 * @param {number} requestDelayMs - 탐지 화면에서 선택한 요청 간 지연 시간
 * @returns {Map} url -> metadata 맵
 */
async function fetchDuckDuckGoDorkUrls(domain, entryUrl, keywords = ['카톡', '텔레'], requestDelayMs = 500) {
  const result = new Map();
  if (!keywords || keywords.length === 0) return result;

  try {
    const entryHost = new URL(entryUrl).hostname.toLowerCase().replace(/^www\./, '');
    const uniqueKeywords = [...new Set(keywords.map(keyword => String(keyword).trim()).filter(Boolean))];
    if (uniqueKeywords.length === 0) return result;
    let successfulResponses = 0;
    let limitedResponses = 0;
    const delayMs = Number.isFinite(Number(requestDelayMs)) ? Math.max(0, Number(requestDelayMs)) : 500;
    console.log(`[UrlSeedCollector] DuckDuckGo 조회 간격: ${delayMs}ms`);
    for (const [index, keyword] of uniqueKeywords.entries()) {
        const query = `site:${domain} ${keyword}`;
        const source = {
          name: 'Lite',
          url: 'https://lite.duckduckgo.com/lite/',
          options: {
            method: 'POST',
            headers: { ...getRandomHumanHeaders('https://lite.duckduckgo.com/', 'https://lite.duckduckgo.com'), 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ q: query }).toString()
          }
        };
        try {
          if (index > 0 && delayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
          }
          console.log(`[UrlSeedCollector] DuckDuckGo ${source.name} 색인 역조회 시작: "${query}"`);
          const response = await fetch(source.url, { ...source.options, signal: AbortSignal.timeout(8000) });
          const html = await response.text();
          const isLimited = response.status === 202 || response.status === 403 || response.status === 429;
          const isSearchResponse = response.status === 200;
          const links = isSearchResponse ? collectDuckDuckGoResultLinks(html, entryHost) : new Set();
          const pageTitle = (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').slice(0, 100);
          logWrite(config.paths.logsDir, {
            event: 'duckduckgo_search_response', source: source.name, query,
            status: response.status, finalUrl: response.url || source.url,
            userAgent: source.options.headers['User-Agent'], htmlLength: html.length,
            pageTitle, responseKind: isLimited ? 'limited' : (isSearchResponse ? 'search_page' : 'http_error'),
            resultLinks: isSearchResponse ? links.size : null
          });
          if (isLimited) {
            limitedResponses++;
            console.warn(`[UrlSeedCollector] DuckDuckGo ${source.name} 검색 제한/검증 응답: HTTP ${response.status} (색인 여부 미확인)`);
            continue;
          }
          if (!isSearchResponse) {
            console.warn(`[UrlSeedCollector] DuckDuckGo ${source.name} 응답 오류: ${response.status}`);
            continue;
          }

          successfulResponses++;
          console.log(`[UrlSeedCollector] DuckDuckGo ${source.name} 결과 링크: ${links.size}개`);
          for (const url of links) {
            result.set(url, { linkText: '[DuckDuckGo] 검색엔진 색인 URL', isDorkTarget: true, riskScore: 90 });
          }
        } catch (error) {
          logWrite(config.paths.logsDir, {
            event: 'duckduckgo_search_response', source: source.name, query,
            status: 'request_error', userAgent: source.options.headers['User-Agent'], error: error.message
          });
          console.warn(`[UrlSeedCollector] DuckDuckGo ${source.name} 요청 실패: ${error.message}`);
        }
    }

    if (result.size > 0) {
      console.log(`[UrlSeedCollector] DuckDuckGo 색인 발견: ${result.size}개 실제 결과 링크 확보`);
    } else if (limitedResponses > 0 && successfulResponses === 0) {
      console.warn('[UrlSeedCollector] DuckDuckGo 검색 제한으로 색인 여부를 확인하지 못했습니다.');
    } else if (successfulResponses === 0) {
      console.warn('[UrlSeedCollector] DuckDuckGo 검색 요청이 모두 실패하여 색인 여부를 확인하지 못했습니다.');
    } else {
      console.log('[UrlSeedCollector] DuckDuckGo 응답에서 해당 도메인의 결과 링크를 찾지 못했습니다.');
    }
  } catch (err) {
    console.warn('[UrlSeedCollector] DuckDuckGo 검색 오류 (안전 통과):', err.message);
  }

  return result;
}

module.exports = { fetchDuckDuckGoDorkUrls, fetchCommonCrawlUrls, fetchUrlscanUrls, fetchRssFeedUrls };
