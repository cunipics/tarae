/**
 * 공공 웹사이트 불법광고 전체 점검 및 크롤링 탐지 엔진 (detectEngine.js)
 * - 동일 도메인 재귀 크롤러 및 트리뷰 노드 구축
 * - 가이드 4대 은닉 기법 정밀 분석 (JAMO, HOMOGLYPH, TRANSPARENT, OFFSCREEN)
 * - iframe 내부 요소 식별 (iframe[src="..."] >>> selector)
 * - 설정된 판정 모델 및 데이터 정화소(t_cleanroom) 교차 판정
 * - 차단 및 먹통 방지를 위한 점검 속도(요청 지연시간 delayMs) 제어
 * - 가이드 붙임4 표준 스키마 준수 result.json 생성 및 SQLite DB 저장
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const htmlparser2 = require('htmlparser2');
const domutils = require('domutils');
const commonDAO = require('./commonDAO');
const llmPipelineService = require('./llmPipelineService');
const browserInspector = require('./browserInspector');
const config = require('../config/config');
const { write: logWrite } = require('../utils/logger');
const adPlatforms = require('../config/adPlatforms.config');
let iconv = null;
try {
  iconv = require('iconv-lite');
} catch (e) {}

// 지능형 URL 씨드 수집기 모듈 (Common Crawl, urlscan.io, RSS/Atom)
const urlSeedCollector = require('./urlSeedCollector');
// CMS 지문 탐지 + 알려진 취약 경로 딕셔너리
const cmsFingerprint = require('./cmsFingerprint');
// URL 무한증식 방지 정규화
const { resolveCrawlUrl, normalizeUrl, normalizeAndFilter } = require('./urlNormalizer');
// 크롤러 URL 수집 설정
const crawlerConfig = require('../config/crawler.config');
// 사람다운 랜덤 브라우저 헤더 생성 유틸리티 (.env 연동)
const { getRandomHumanHeaders } = require('../config/browserHeaders.config');
const aiModelConfig = require('../config/aiModel.config');
const { getVisibleCandidateText, splitTextForInference } = require('../utils/inferenceText');
const { classifyPollutedPattern } = require('../utils/obfuscationTechnique');
const { buildResultReports } = require('./resultReport');
const {
  generateRandomStratifiedPageNumbers,
  roundRobinByKey,
  shuffleSecure,
  conservativePageDurationMs,
  estimateRemainingCapacity,
  planBoardSampling,
  getBoardPriorityWeight,
  applyBoardPriorityWeight,
  partitionInOrder
} = require('./crawlScheduler');

// 공공기관 웹사이트 SSL(GPKI 등) 인증서 호환성 보장
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// 점검 시간 및 요청 딜레이 기반 동적 페이지 예산/수집 한계 산출 함수
// cms1.db, cms2.db, cms3.db 실측 데이터 반영: 초당 약 0.95~1.0페이지 처리 (딜레이 500ms + HTML수신/파싱 + AI/텍스트검사)
function calculateDynamicBudget(maxTimeSec = 1800, speedDelayMs = 500) {
  const safeTimeSec = Math.min(3600, Math.max(60, Number(maxTimeSec) || 1800));
  const secPerPage = Math.max(0.6, (speedDelayMs + 450) / 1000);
  const targetPageBudget = Math.max(50, Math.floor(safeTimeSec / secPerPage));

  // 예산에 따른 동적 Depth 한계 (과도한 깊이 링크 탐색 방지)
  let maxDepth = 6;
  if (targetPageBudget <= 400) maxDepth = 4;        // 5분: depth 4
  else if (targetPageBudget <= 1000) maxDepth = 5;  // 10~15분: depth 5
  else if (targetPageBudget <= 2200) maxDepth = 6;  // 30분: depth 6
  else maxDepth = 7;                                // 60분: depth 7

  return { targetPageBudget, maxDepth };
}

// 동일 도메인 판별 함수 (www 접두사 및 프로토콜 차이 안전 허용)
function isSameDomain(urlA, urlB) {
  if (!urlA || !urlB) return false;
  try {
    const a = new URL(urlA);
    const b = new URL(urlB);
    const hostA = a.hostname.toLowerCase().replace(/^www\./, '');
    const hostB = b.hostname.toLowerCase().replace(/^www\./, '');
    return hostA === hostB;
  } catch (e) {
    return false;
  }
}

function getNonstandardPort(urlValue) {
  try {
    const parsed = new URL(urlValue);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.port) return null;
    const standardPort = parsed.protocol === 'https:' ? '443' : '80';
    return parsed.port === standardPort ? null : parsed.port;
  } catch (e) {
    return null;
  }
}

function decodeHtmlBuffer(buffer, contentType = '') {
  let encoding = 'utf-8';
  const charsetMatch = String(contentType).match(/charset=([a-zA-Z0-9_-]+)/i);
  if (charsetMatch && charsetMatch[1]) {
    encoding = charsetMatch[1].toLowerCase();
  } else {
    const snippet = buffer.subarray(0, 2048).toString('ascii');
    const metaCharsetMatch = snippet.match(/<meta[^>]*charset=["']?([a-zA-Z0-9_-]+)/i) ||
      snippet.match(/<meta[^>]*http-equiv=["']?Content-Type["']?[^>]*content=["'][^"']*charset=([a-zA-Z0-9_-]+)/i);
    if (metaCharsetMatch && metaCharsetMatch[1]) encoding = metaCharsetMatch[1].toLowerCase();
  }

  if (encoding.includes('euc-kr') || encoding.includes('cp949') || encoding.includes('korean') || encoding.includes('ks_c_5601')) {
    try {
      return iconv ? iconv.decode(buffer, 'cp949') : new TextDecoder('euc-kr').decode(buffer);
    } catch (e) {}
  }
  return buffer.toString('utf-8');
}

function extractGetSearchForms(dom, pageUrl) {
  if (!dom || !Array.isArray(dom.children)) return [];
  const forms = domutils.findAll(el => el.type === 'tag' && el.name === 'form', dom.children);
  const specs = [];

  for (const form of forms) {
    const attrs = form.attribs || {};
    const method = String(attrs.method || 'get').trim().toLowerCase();
    if (method !== 'get') continue;

    let actionUrl;
    try {
      actionUrl = new URL(attrs.action || pageUrl, pageUrl);
    } catch (e) {
      continue;
    }
    if (!isSameDomain(actionUrl.href, pageUrl)) continue;

    const controls = domutils.findAll(
      el => el.type === 'tag' && ['input', 'select', 'button'].includes(el.name),
      form.children || []
    );
    const hasPassword = controls.some(el => el.name === 'input' && String((el.attribs || {}).type || '').toLowerCase() === 'password');
    if (hasPassword) continue;

    const formText = (domutils.getText(form) || '').replace(/\s+/g, ' ').trim();
    const signalText = [
      attrs.role,
      attrs.id,
      attrs.class,
      attrs['aria-label'],
      actionUrl.pathname,
      formText,
      ...controls.flatMap(el => {
        const controlAttrs = el.attribs || {};
        return [controlAttrs.type, controlAttrs.name, controlAttrs.id, controlAttrs.placeholder, controlAttrs.value, controlAttrs['aria-label']];
      })
    ].filter(Boolean).join(' ');

    const textInputs = controls.filter(el => {
      if (el.name !== 'input') return false;
      const inputAttrs = el.attribs || {};
      const type = String(inputAttrs.type || 'text').toLowerCase();
      return Boolean(inputAttrs.name) && (type === 'search' || type === 'text');
    });
    const explicitSearchInput = textInputs.find(el => String((el.attribs || {}).type || '').toLowerCase() === 'search');
    const hasSearchSignal = Boolean(explicitSearchInput) || /(?:검색|찾기|search|find|query)/i.test(signalText);
    if (!hasSearchSignal || textInputs.length === 0) continue;

    const searchInput = explicitSearchInput || textInputs.find(el => {
      const inputAttrs = el.attribs || {};
      return /(?:검색|search|query|keyword|term|word|text)/i.test([
        inputAttrs.name,
        inputAttrs.id,
        inputAttrs.placeholder,
        inputAttrs['aria-label']
      ].filter(Boolean).join(' '));
    }) || (textInputs.length === 1 ? textInputs[0] : null);
    if (!searchInput) continue;

    const fixedParams = [];
    for (const control of controls) {
      const controlAttrs = control.attribs || {};
      const name = String(controlAttrs.name || '').trim();
      if (!name || name === searchInput.attribs.name || control.name === 'button') continue;

      if (control.name === 'input') {
        const type = String(controlAttrs.type || 'text').toLowerCase();
        if (['submit', 'button', 'reset', 'file', 'password'].includes(type)) continue;
        if ((type === 'checkbox' || type === 'radio') && !Object.prototype.hasOwnProperty.call(controlAttrs, 'checked')) continue;
        fixedParams.push([name, String(controlAttrs.value || '')]);
      } else if (control.name === 'select') {
        const options = domutils.findAll(el => el.type === 'tag' && el.name === 'option', control.children || []);
        const selected = options.find(option => Object.prototype.hasOwnProperty.call(option.attribs || {}, 'selected')) || options[0];
        if (selected) fixedParams.push([name, String((selected.attribs || {}).value || domutils.getText(selected) || '')]);
      }
    }

    const signatureParams = fixedParams
      .map(([key, value]) => `${key}=${value}`)
      .sort()
      .join('&');
    const searchParam = String(searchInput.attribs.name);
    const signature = `${actionUrl.origin}${actionUrl.pathname}|${searchParam}|${signatureParams}`;
    specs.push({
      actionUrl: actionUrl.href,
      searchParam,
      fixedParams,
      signature
    });
  }

  const unique = new Map();
  for (const spec of specs) {
    if (!unique.has(spec.signature)) unique.set(spec.signature, spec);
  }
  return [...unique.values()];
}

function selectReflectionProbePattern(patterns) {
  const candidates = (Array.isArray(patterns) ? patterns : [])
    .map(value => String(value || '').trim())
    .filter(value => value.length >= 3 && value.length <= 30 && !/[\r\n]/.test(value));
  return candidates.find(value => /[ㄱ-ㅎㅏ-ㅣ]/.test(value)) || candidates[0] || null;
}

function buildReflectionProbeUrl(spec, payload) {
  const target = new URL(spec.actionUrl);
  for (const [key, value] of spec.fixedParams || []) target.searchParams.set(key, value);
  target.searchParams.set(spec.searchParam, payload);
  return target.href;
}

function inspectReflectedProbeHtml(html, payload, responseHeaders = null, responseUrl = '') {
  const dom = htmlparser2.parseDocument(String(html || ''));
  const visibleText = (domutils.getText(dom.children) || '').replace(/\s+/g, ' ').trim();
  const reflected = visibleText.includes(payload);

  const robotsMeta = domutils.findAll(el => {
    if (el.type !== 'tag' || el.name !== 'meta' || !el.attribs) return false;
    const name = String(el.attribs.name || '').toLowerCase();
    return name === 'robots' || name === 'googlebot';
  }, dom.children);
  const metaNoindex = robotsMeta.some(el => /(?:^|[,\s])noindex(?:$|[,\s])/i.test(String(el.attribs.content || '')));
  const headerNoindex = responseHeaders && typeof responseHeaders.get === 'function'
    ? /(?:^|[,\s])noindex(?:$|[,\s])/i.test(String(responseHeaders.get('x-robots-tag') || ''))
    : false;

  let canonicalLimited = false;
  const canonical = domutils.findOne(el => el.type === 'tag' && el.name === 'link' && el.attribs &&
    String(el.attribs.rel || '').toLowerCase().split(/\s+/).includes('canonical') && el.attribs.href, dom.children);
  if (canonical && responseUrl) {
    try {
      const canonicalUrl = new URL(canonical.attribs.href, responseUrl);
      canonicalLimited = !canonicalUrl.search.includes(encodeURIComponent(payload)) && !canonicalUrl.search.includes(payload);
    } catch (e) {}
  }

  return {
    reflected,
    visibleText,
    indexLimited: metaNoindex || headerNoindex || canonicalLimited,
    limitReason: metaNoindex || headerNoindex ? 'noindex' : (canonicalLimited ? 'canonical' : '')
  };
}

// 클라이언트 사이드 포워딩(JS 이동, 메타 새로고침) 대상 URL 추출 함수
function extractClientRedirectUrl(htmlText, baseUrl) {
  if (!htmlText || typeof htmlText !== 'string') return null;

  // 1. 자바스크립트 기반 포워딩 (location.href, location.replace, window.location 등)
  const jsRegexes = [
    /(?:(?:window|document|self|top)\.)?location(?:\.href|\.replace|\.assign)?\s*(?:=|(?:\())\s*['"]([^'"]+)['"]/i,
    /(?:window|self|top)\.location\s*=\s*['"]([^'"]+)['"]/i
  ];

  for (const reg of jsRegexes) {
    const match = htmlText.match(reg);
    if (match && match[1]) {
      const target = match[1].trim();
      if (target && !target.startsWith('javascript:') && !target.startsWith('#')) {
        try {
          return new URL(target, baseUrl).href;
        } catch (e) {}
      }
    }
  }

  // 2. HTML 메타 태그 포워딩 (meta refresh)
  const metaMatch = htmlText.match(/<meta[^>]*http-equiv=["']?refresh["']?[^>]*content=["']?[^"'>]*url=([^"'>\s]+)/i);
  if (metaMatch && metaMatch[1]) {
    const target = metaMatch[1].replace(/['"]/g, '').trim();
    if (target && !target.startsWith('javascript:') && !target.startsWith('#')) {
      try {
        return new URL(target, baseUrl).href;
      } catch (e) {}
    }
  }

  return null;
}

// frame 및 iframe 태그 내부 src 주소 추출 함수
function extractFrameUrls(dom, baseUrl) {
  if (!dom || !dom.children) return [];
  const frameElements = domutils.findAll(
    el => el.type === 'tag' && (el.name === 'frame' || el.name === 'iframe') && el.attribs && el.attribs.src,
    dom.children
  );

  const frameUrls = [];
  for (const el of frameElements) {
    const rawSrc = (el.attribs.src || '').trim();
    if (!rawSrc || rawSrc.startsWith('javascript:') || rawSrc.startsWith('#') || rawSrc === 'about:blank') {
      continue;
    }
    try {
      const resolved = new URL(rawSrc, baseUrl).href;
      if (isSameDomain(resolved, baseUrl) && !isNonContentLink(resolved, el)) {
        frameUrls.push({
          url: resolved,
          type: el.name.toUpperCase()
        });
      }
    } catch (e) {}
  }
  return frameUrls;
}

// 댓글 영역 요소 판별 함수 (가이드 지침: 게시글 및 댓글 영역 탐지 지원)
function isCommentAreaElement(elem) {
  if (!elem) return false;
  let curr = elem;
  let depth = 0;
  while (curr && depth < 6) {
    if (curr.attribs) {
      const cls = (curr.attribs.class || '').toLowerCase();
      const id = (curr.attribs.id || '').toLowerCase();
      if (/(?:comment|reply|cmt|memo_list|talk|opinion|disqus|utteranc)/i.test(cls) ||
          /(?:comment|reply|cmt|memo_list|talk|opinion)/i.test(id)) {
        return true;
      }
    }
    curr = curr.parent;
    depth++;
  }
  return false;
}

function isArticleDetailPageUrl(urlStr) {
  try {
    const url = new URL(urlStr);
    const params = url.searchParams;
    const mode = (params.get('mod') || params.get('mode') || params.get('view') || '').toLowerCase();
    if (/^(?:list|index)$/.test(mode)) return false;

    const hasId = ['uid', 'wr_id', 'document_srl', 'post_id', 'article', 'b_no', 'id', 'no', 'idx', 'seq']
      .some(key => /^\d+$/.test(params.get(key) || ''));
    if (/^(?:document|view|read|article|detail|post|entry)$/.test(mode) && hasId) return true;
    if (['wr_id', 'document_srl', 'post_id', 'article', 'b_no']
      .some(key => /^\d+$/.test(params.get(key) || ''))) return true;

    return /\/(?:view|read|article|detail|post|entry)\/[^/]+\/?$/i.test(url.pathname);
  } catch (e) {
    return false;
  }
}

// 쿼리스트링 및 경로(Path) 기반 페이징 패턴 통합 식별 함수
function parsePagingInfoFromHref(hrefStr, linkText = '') {
  if (!hrefStr) return null;
  const clean = hrefStr.replace(/&amp;/g, '&');
  const text = (linkText || '').trim();

  // 1. 쿼리스트링 기반: ?page=2, ?p=3, ?cpage=4, ?page_no=5, ?pageIndex=2, ?curPage=3 등
  const queryMatch = clean.match(/(?:[&?]|^)(page|pageid|p|pg|cpage|page_no|pageindex|pagenum|curpage)=(\d+)/i);
  if (queryMatch) {
    return {
      type: 'query',
      paramKey: queryMatch[1],
      pageNum: parseInt(queryMatch[2], 10)
    };
  }

  // 2. 명시적 경로 키워드 기반: /page/2, /p/3, /pages/4, /page-2 등
  const pathWordMatch = clean.match(/\/(page|p|pg|pages)(?:[\/-])(\d+)(?:\/|\.html|\.php|\?|#|$)/i);
  if (pathWordMatch) {
    return {
      type: 'path_keyword',
      keyword: pathWordMatch[1].toLowerCase(),
      pageNum: parseInt(pathWordMatch[2], 10)
    };
  }

  // 3. 목록 경로 말단 숫자 페이징: /blog/all/2, /board/list/3 등
  const isNumberText = /^\d+$/.test(text);
  const isPagingSymbolText = /^(?:이전|다음|맨앞|맨뒤|맨끝|끝|처음|마지막|prev|next|first|last|«|»|[<>]|>>|<<)$/i.test(text);

  const pathNumMatch = clean.match(/(.*\/)(\d+)(?:\/|\.html|\.php|\?|#|$)/);
  if (pathNumMatch) {
    const num = parseInt(pathNumMatch[2], 10);
    const basePath = pathNumMatch[1];

    // 링크 텍스트가 숫자이고 URL 말단 숫자와 일치하는 경우 (가장 확실한 1~10 페이징 번호 버튼)
    if (isNumberText && String(num) === text && num > 0 && num < 1000000) {
      return {
        type: 'path_number',
        basePath,
        pageNum: num
      };
    }

    // 링크 텍스트가 페이징 기호(다음, 맨끝 등)이고 basePath에 목록 관련 키워드가 있는 경우
    if (isPagingSymbolText && /(?:list|all|board|bbs|category|posts?|articles?)/i.test(basePath) && num > 0 && num < 1000000) {
      return {
        type: 'path_number',
        basePath,
        pageNum: num
      };
    }
  }

  return null;
}

// 네비게이션(GNB/LNB/헤더/푸터/사이드바) 내부 요소 판별 함수
function isInsideNavigationElement(elem) {
  if (!elem) return false;
  let curr = elem;
  let depth = 0;
  while (curr && depth < 7) {
    if (curr.type === 'tag') {
      const name = curr.name.toLowerCase();
      if (name === 'nav' || name === 'header' || name === 'footer') {
        return true;
      }
      if (curr.attribs) {
        const cls = (curr.attribs.class || '').toLowerCase();
        const id = (curr.attribs.id || '').toLowerCase();
        if (/(?:gnb|lnb|snb|menu|nav|navbar|sidebar|topnavi|subnavi|allmenu|quick|masternav)/i.test(cls) ||
            /(?:gnb|lnb|snb|menu|nav|navbar|sidebar|topnavi|subnavi|allmenu|quick|masternav)/i.test(id)) {
          return true;
        }
      }
    }
    curr = curr.parent;
    depth++;
  }
  return false;
}

// 링크 텍스트 추출 및 img alt/title 속성 보존 함수 (텍스트 없는 이미지 메뉴 누락 원천 방지)
function extractLinkTextAndAlt(linkElem) {
  if (!linkElem) return '';
  let text = domutils.getText(linkElem).trim();
  if (text) return text;
  const img = domutils.findOne(el => el.type === 'tag' && el.name === 'img', linkElem.children || []);
  if (img && img.attribs) {
    text = (img.attribs.alt || img.attribs.title || '').trim();
    if (text) return text;
  }
  if (linkElem.attribs && linkElem.attribs.title) {
    return linkElem.attribs.title.trim();
  }
  return '';
}

// 웹 구조(DOM) 분석 기반 게시판 본문 상세 뷰 링크 자동 판별 (하드코딩 배제)
function isArticleDetailLink(linkElem, domRoot, resolvedUrl) {
  if (!linkElem || !resolvedUrl) return false;
  try {
    // 0. 비콘텐츠 링크(다운로드, 이미지 팝업, 인쇄 등)는 절대 본문 상세 뷰가 될 수 없음
    if (isNonContentLink(resolvedUrl, linkElem)) {
      return false;
    }

    // 0-1. 네비게이션(GNB/LNB/메뉴바) 영역 내부 링크는 본문 글이 아닌 사이트 메뉴이므로 배제
    if (isInsideNavigationElement(linkElem)) {
      return false;
    }

    if (isArticleDetailPageUrl(resolvedUrl)) {
      return true;
    }

    const urlObj = new URL(resolvedUrl);
    const search = urlObj.search.toLowerCase();
    const pathname = urlObj.pathname.toLowerCase();

    // 1. 단순 페이징 링크는 본문 글이 아니므로 제외 (쿼리스트링 및 경로 기반 페이징)
    if (/(?:[&?]page=\d+|[&?]pageid=\d+|[&?]p=\d+|[&?]cpage=\d+|[&?]pg=\d+|[&?]pageindex=\d+|[&?]pagenum=\d+|[&?]curpage=\d+)/i.test(search)) {
      if (!/(?:id=\d+|no=\d+|seq=\d+|idx=\d+|srl=\d+|wr_id=)/i.test(search)) {
        return false;
      }
    }
    if (/\/(?:page|p|pg|pages)(?:[\/-])\d+(?:\/|\.html|\.php|\?|#|$)/i.test(pathname)) {
      return false;
    }

    // 2. 링크 텍스트(제목) 분석
    const linkText = extractLinkTextAndAlt(linkElem);
    // 텍스트가 숫자만 있거나 1~2자 기호([1], >, >>, 이전, 다음 등)면 페이징이므로 제외
    if (/^[\d\[\]<>«»\s\-\.\/]+$/.test(linkText) || /^(?:이전|다음|맨앞|맨뒤|맨끝|끝|처음|마지막|prev|next|first|last)$/i.test(linkText)) {
      return false;
    }

    // 3. DOM 반복 행(Row/Card) 구조 판별: 
    // 자기 자신 또는 부모/조상이 <tr>(테이블 행), <li>(리스트 항목), <article>, 또는 카드형 <div>인지 확인
    let isInsideRepeatedRow = false;
    let curr = (linkElem && linkElem.type === 'tag' && (linkElem.name === 'tr' || linkElem.name === 'li' || linkElem.name === 'article')) ? linkElem : (linkElem ? linkElem.parent : null);
    let depthCount = 0;
    while (curr && depthCount < 4) {
      if (curr.type === 'tag') {
        const tagName = curr.name.toLowerCase();
        if (tagName === 'tr' || tagName === 'li' || tagName === 'article' || (tagName === 'div' && curr.attribs && curr.attribs.class && /(?:item|card|post|entry|board|list|row)/i.test(curr.attribs.class))) {
          if (curr.parent && Array.isArray(curr.parent.children)) {
            const siblings = curr.parent.children.filter(c => c.type === 'tag' && c.name.toLowerCase() === tagName);
            if (siblings.length >= 3) {
              isInsideRepeatedRow = true;
              break;
            }
          }
        }
      }
      curr = curr.parent;
      depthCount++;
    }

    // 4. URL 구조적 지표: 식별자(ID, 번호) 파라미터 또는 경로 끝자리 숫자 패턴
    const hasIdentifierParam = /(?:[&?](?:wr_id|id|no|num|idx|seq|article|document_srl|post_id|b_no)=\d+)/i.test(search) ||
                               /\/(?:view|read|article|detail|post|entry|archives?)\b/i.test(pathname) ||
                               /\/\d+(?:\.html|\.php|\/)?$/i.test(pathname);

    // 식별자 파라미터가 있는 경우 본문 상세 링크로 판정
    if (hasIdentifierParam) {
      return true;
    }

    // 반복 구조 안에 있고 문장형 제목(8자 이상 및 띄어쓰기 포함)인 경우 본문으로 판정 (단, 태그명이 li인 일반 메뉴는 제외)
    if (isInsideRepeatedRow && linkText.length >= 8 && /\s/.test(linkText) && !/\/(?:sub\d+|menu|intro|about|guide)/i.test(pathname)) {
      return true;
    }

    return false;
  } catch (e) {
    return false;
  }
}

// 단순 이미지/미디어 뷰어, 다운로드, 인쇄 등 텍스트 검출 취지에 맞지 않는 비콘텐츠 링크 판별
function isNonContentLink(urlStr, linkElem = null) {
  if (!urlStr) return true;
  try {
    const urlObj = new URL(urlStr);
    const pathname = urlObj.pathname.toLowerCase();
    const search = urlObj.search.toLowerCase();

    // 1. [DOM 문맥 사전 검사] 링크 태그 자체의 속성 및 자식 요소 분석
    if (linkElem && linkElem.attribs) {
      const attribs = linkElem.attribs;
      // 1-1. download 속성이 명시된 파일 다운로드 링크
      if (attribs.download !== undefined) return true;

      // 1-2. onclick 이벤트로 window.open 팝업창을 띄우는 미디어 뷰어
      const onclickStr = (attribs.onclick || '').toLowerCase();
      if (/popupimage|image_window|view_image/i.test(onclickStr)) {
        return true;
      }

      // 1-3. 읽을 수 있는 글 텍스트가 없고 오직 <img> 태그만 들어있으며 alt도 없고 미디어 팝업인 경우
      const linkText = extractLinkTextAndAlt(linkElem);
      const hasImg = domutils.findOne(el => el.type === 'tag' && el.name === 'img', linkElem.children || []);
      const isPureMediaFile = /\.(?:jpe?g|png|gif|webp|bmp)(?:$|\?)/i.test(pathname);
      if (hasImg && !linkText && isPureMediaFile) {
        return true;
      }
    }

    // 2. [URL 구조 사전 검사] IANA 표준 파일 확장자 (.jpg, .pdf, .zip 등)
    if (/\.(?:jpe?g|png|gif|webp|svg|bmp|ico|pdf|hwp|hwpx|docx?|xlsx?|pptx?|zip|tar|gz|7z|mp[34]|avi|mov|wmv|wav|flv)(?:$|\?)/i.test(pathname)) {
      return true;
    }

    // 3. 단순 이미지 뷰어/미디어 팝업 (view_image.php, image_view, show_image, popup_image 등)
    if (/(?:view_image|image_view|show_image|popup_image|imageview|viewimage|image_viewer|media_view)\b/i.test(pathname)) {
      return true;
    }

    // 4. 피드(RSS/Atom), 미디어 첨부, 파일 다운로드(KBoard, 그누보드 등), 중복 댓글, 인쇄, API 등 비콘텐츠 링크 원천 차단
    if (/(?:download\.php|down\.php|file_down|filedown|print\.php|export|captcha|xmlrpc\.php)\b/i.test(pathname) ||
        /\/(?:feed|rss|atom|wp-json|wp-admin|wp-includes)(?:\/|$)/i.test(pathname) ||
        /(?:download|file_down|filedown|attachment_id|replytocom|feed)/i.test(search) ||
        /(?:[&?](?:mode|act|action|process|job)=(?:.*download.*|down\b))/i.test(search)) {
      return true;
    }

    // 5. 파라미터가 단순 파일명/이미지명 단독인 미디어 팝업 (?fn=xxx.jpg, ?file=xxx.png 등)
    if (/(?:[&?](?:fn|file|img|image|attach)=[^&]+\.(?:jpe?g|png|gif|webp|bmp))/i.test(search)) {
      return true;
    }

    return false;
  } catch (e) {
    return true;
  }
}

// 문서가 불러오는 정적 리소스와 사용자가 이동할 수 있는 링크를 DOM 구조로 구분
function isNavigableLinkElement(el) {
  if (!el || el.type !== 'tag') return false;

  const tagName = String(el.name || '').toLowerCase();
  const attribs = el.attribs || {};

  // CSS, 스크립트, 글꼴, 미디어 등을 불러오는 태그는 페이지 이동 링크가 아님
  if (['link', 'base', 'script', 'style', 'img', 'source', 'track', 'video', 'audio', 'object', 'embed'].includes(tagName)) {
    return false;
  }

  if (tagName === 'a' || tagName === 'area' || tagName === 'iframe' || tagName === 'frame') {
    return true;
  }

  if (attribs.href || attribs['data-href'] || attribs['data-url']) return true;
  return Boolean(attribs.onclick && /(?:location(?:\.href)?\s*=|window\.open)/i.test(attribs.onclick));
}

// 웹 구조(DOM) 분석 기반 게시판 목록 페이지 판정 (반복 행/카드 + 쿼리/경로 페이징 네비게이션)
function isBoardListPage(dom, resolvedUrl) {
  if (!dom || !dom.children || !resolvedUrl) return false;
  try {
    // 1. 반복되는 행(Row/Card) 구조 검사 (tr, li 요소 또는 article, card/item div)
    const allRows = domutils.findAll(el => el.type === 'tag' && (el.name === 'tr' || el.name === 'li'), dom.children);
    let repeatedRowCount = 0;
    for (const r of allRows) {
      if (r.parent && Array.isArray(r.parent.children)) {
        const siblings = r.parent.children.filter(c => c.type === 'tag' && c.name.toLowerCase() === r.name.toLowerCase());
        if (siblings.length >= 4) {
          const hasLink = domutils.findOne(el => el.type === 'tag' && el.name === 'a', r.children || []);
          if (hasLink) {
            repeatedRowCount = siblings.length;
            break;
          }
        }
      }
    }

    // 최신 웹의 article 또는 카드형 div 반복 구조 검사
    if (repeatedRowCount < 4) {
      const allCards = domutils.findAll(el => el.type === 'tag' && (el.name === 'article' || (el.name === 'div' && el.attribs && el.attribs.class && /(?:item|card|post|entry|board|list|row)/i.test(el.attribs.class))), dom.children);
      for (const c of allCards) {
        if (c.parent && Array.isArray(c.parent.children)) {
          const siblings = c.parent.children.filter(s => s.type === 'tag' && s.name.toLowerCase() === c.name.toLowerCase());
          if (siblings.length >= 3) {
            const hasLink = domutils.findOne(el => el.type === 'tag' && el.name === 'a', c.children || []);
            if (hasLink) {
              repeatedRowCount = siblings.length;
              break;
            }
          }
        }
      }
    }

    if (repeatedRowCount < 3) return false;

    // 2. 하단 페이징 영역(Pagination) 구조 검사 (단어 매칭 없이 URL 파라미터 및 경로 수열 구조 검사)
    const allLinks = domutils.findAll(el => el.type === 'tag' && el.name === 'a', dom.children);
    let numberPageLinkCount = 0;
    let hasPagingParam = false;

    for (const a of allLinks) {
      const text = domutils.getText(a).trim();
      const rawHref = a.attribs ? (a.attribs.href || '') : '';
      const pagingInfo = parsePagingInfoFromHref(rawHref, text);
      if (pagingInfo) {
        hasPagingParam = true;
        if (/^\d+$/.test(text)) {
          numberPageLinkCount++;
        }
      }
    }

    return (numberPageLinkCount >= 2 || (numberPageLinkCount >= 1 && hasPagingParam));
  } catch (e) {
    return false;
  }
}

// 게시판 목록 안에서 새 게시물을 만드는 실제 조작 요소가 노출됐는지 판정
function hasBoardAuthoringControl(dom) {
  if (!dom || !dom.children) return false;

  try {
    const controls = domutils.findAll(el => {
      if (!el || el.type !== 'tag') return false;
      const tagName = String(el.name || '').toLowerCase();
      const attrs = el.attribs || {};
      const role = String(attrs.role || '').toLowerCase();
      const inputType = String(attrs.type || '').toLowerCase();
      return tagName === 'a' || tagName === 'button' || role === 'button' ||
        (tagName === 'input' && ['button', 'submit', 'image'].includes(inputType));
    }, dom.children);

    for (const control of controls) {
      const attrs = control.attribs || {};
      if ('disabled' in attrs || String(attrs['aria-disabled'] || '').toLowerCase() === 'true') continue;

      const label = [
        domutils.getText(control),
        attrs.value,
        attrs.title,
        attrs['aria-label']
      ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      const action = [
        attrs.href,
        attrs['data-href'],
        attrs['data-url'],
        attrs.formaction,
        attrs.onclick,
        attrs.name,
        attrs.id,
        attrs.class
      ].filter(Boolean).join(' ');
      const combined = `${label} ${action}`;

      const isUnrelatedAction = /(?:회원\s*가입|로그인|검색|댓글|답글|수정|삭제|취소|목록|signup|sign\s*up|login|search|comment|reply|edit|delete|cancel)/i.test(combined);
      if (isUnrelatedAction) continue;

      const hasAuthoringLabel = /(?:^(?:등록|작성|쓰기)$|글\s*쓰기|글\s*작성|게시(?:물|글)\s*(?:작성|등록)|새\s*글|write\s*(?:post|article)?|new\s*(?:post|article)|create\s*(?:post|article)|compose)/i.test(label);
      const hasAuthoringAction = /(?:[?&](?:mode|mod|act|action|cmd|proc)=(?:write|create|insert|add|register)\b|\/(?:write|create|compose|new)(?:[/?#.]|$)|(?:fn|go|open)?(?:write|create|compose)(?:form|view)?\s*\()/i.test(action);

      if (hasAuthoringLabel || hasAuthoringAction) return true;
    }
  } catch (e) {}

  return false;
}

function isExposedIndexBoard(spec, exposedUrls, origin) {
  if (!spec || !exposedUrls) return false;
  try {
    const boardUrl = new URL(spec.sampleUrl || spec.baseKey, origin).toString();
    const boardKey = getBoardIdentityKey(boardUrl);
    return Array.from(exposedUrls).some(exposedUrl => getBoardIdentityKey(exposedUrl) === boardKey);
  } catch (e) {
    return false;
  }
}

function needsDynamicLinkDiscovery(dom, currentUrl = '') {
  if (!dom || !dom.children) return false;
  const links = domutils.findAll(
    el => el.type === 'tag' && el.name === 'a' && el.attribs && (el.attribs.href || el.attribs['data-href']),
    dom.children
  );
  const scripts = domutils.findAll(
    el => el.type === 'script' && (domutils.getText(el).trim().length > 0 || (el.attribs && el.attribs.src)),
    dom.children
  );
  const textLength = (domutils.getText(dom.children) || '').replace(/\s+/g, ' ').trim().length;
  let routeLooksLikeList = false;
  try {
    const url = new URL(currentUrl);
    routeLooksLikeList = /\/(?:board|bbs|notice|news|press|gallery|qna|list)(?:\/|$)/i.test(url.pathname) ||
      /(?:[&?])(?:bo_table|board_id|bbs_id)=/i.test(url.search);
  } catch (e) {}
  return scripts.length > 0 && (
    (links.length <= 3 && textLength < 300) ||
    (routeLooksLikeList && !isBoardListPage(dom, currentUrl))
  );
}

// 게시판 고유 식별키 추출 (경로 및 bo_table, board_id 등 주요 식별 파라미터 조합)
function getBoardIdentityKey(urlStr) {
  if (!urlStr) return '';
  try {
    const u = new URL(urlStr);
    const boardIdentityKeys = ['bo_table', 'board_id', 'bid', 'bbs_id', 'code', 'page_id', 'mid'];
    for (const key of boardIdentityKeys) {
      const value = u.searchParams.get(key);
      if (value) return `${u.pathname}?${key}=${value}`;
    }
    return u.pathname;
  } catch (e) {
    return String(urlStr).split(/[?#]/)[0];
  }
}

// 게시판의 기준 URL(Base Key), 전체 페이지 수(totalPage), 페이징 규격 추출
// 쿼리스트링 및 경로 기반 페이징을 통합 지원하며, 파라미터 최댓값 및 메타데이터 역산 적용
function extractBoardSpec(dom, currentUrl) {
  if (!dom || !currentUrl) return null;
  try {
    const urlObj = new URL(currentUrl);
    const searchParams = urlObj.searchParams;

    // 모든 링크에서 페이징 패턴 수집
    const allLinks = domutils.findAll(el => el.type === 'tag' && el.name === 'a', dom.children);
    let maxPageFromLinks = 1;
    let detectedPagingType = 'query';
    let detectedPageParam = 'page';
    let detectedPathKeyword = 'page';
    let detectedBasePath = null;

    for (const a of allLinks) {
      const text = domutils.getText(a).trim();
      const rawHref = a.attribs ? (a.attribs.href || '') : '';
      const pagingInfo = parsePagingInfoFromHref(rawHref, text);
      if (pagingInfo) {
        if (pagingInfo.pageNum > maxPageFromLinks) {
          maxPageFromLinks = pagingInfo.pageNum;
        }
        if (pagingInfo.type === 'path_number') {
          detectedPagingType = 'path_number';
          detectedBasePath = pagingInfo.basePath;
        } else if (pagingInfo.type === 'path_keyword') {
          detectedPagingType = 'path_keyword';
          detectedPathKeyword = pagingInfo.keyword;
        } else if (pagingInfo.type === 'query') {
          detectedPagingType = 'query';
          detectedPageParam = pagingInfo.paramKey;
        }
      }
    }

    // 현재 URL 파라미터 확인 (URL 자체가 이미 쿼리스트링 페이징을 품고 있는 경우 우선 반영)
    for (const key of ['page', 'pageid', 'p', 'cpage', 'pg', 'page_no', 'pageindex', 'pagenum', 'curpage']) {
      if (searchParams.has(key)) {
        detectedPagingType = 'query';
        detectedPageParam = key;
        break;
      }
    }

    // baseKey 결정
    let baseKey = '';
    if (detectedPagingType === 'query') {
      const baseSearchParams = new URLSearchParams(searchParams);
      baseSearchParams.delete(detectedPageParam);
      const baseQuery = baseSearchParams.toString();
      baseKey = urlObj.origin + urlObj.pathname + (baseQuery ? '?' + baseQuery : '');
    } else if (detectedPagingType === 'path_keyword') {
      const cleanPath = urlObj.pathname.replace(new RegExp(`/${detectedPathKeyword}(?:[/-])\\d+.*$`, 'i'), '');
      baseKey = urlObj.origin + cleanPath;
    } else if (detectedPagingType === 'path_number') {
      if (detectedBasePath) {
        baseKey = detectedBasePath.startsWith('http') ? detectedBasePath : (urlObj.origin + (detectedBasePath.startsWith('/') ? '' : '/') + detectedBasePath);
      } else {
        const cleanPath = urlObj.pathname.replace(/\/\d+(?:\/|\.html|\.php|\?|#|$)/, '/');
        baseKey = urlObj.origin + cleanPath;
      }
      baseKey = baseKey.replace(/\/+$/, '');
    }

    let totalPage = maxPageFromLinks;

    // 메타데이터("총 N건", "1 / N 페이지") 검색
    const fullPageText = domutils.getText(dom.children) || '';
    const totalMatch = fullPageText.match(/(?:총|전체|Total|TOTAL)\s*:?\s*([0-9,]{1,8})\s*(?:건|개|건의|posts|articles)?/i);
    const pageOfMatch = fullPageText.match(/(?:page\s*\d+\s*(?:of|\/)\s*(\d+)|\/\s*(\d+)\s*(?:페이지|page))/i);

    if (pageOfMatch) {
      const metaPages = parseInt(pageOfMatch[1] || pageOfMatch[2], 10);
      if (!isNaN(metaPages) && metaPages > totalPage) {
        totalPage = metaPages;
      }
    }

    // 명시적인 '총 N건', '전체 N개' 메타 텍스트가 존재할 때만 전체 페이지 수 추정 반영
    if (totalPage <= 15 && totalMatch) {
      const totalCount = parseInt(totalMatch[1].replace(/,/g, ''), 10);
      if (!isNaN(totalCount) && totalCount > 0) {
        const estimatedByTotal = Math.ceil(totalCount / 10);
        if (estimatedByTotal > totalPage) {
          totalPage = Math.min(1000, estimatedByTotal);
        }
      }
    }

    return {
      baseKey,
      pageParam: detectedPageParam,
      pagingType: detectedPagingType,
      pathKeyword: detectedPathKeyword,
      totalPage: Math.max(1, totalPage)
    };
  } catch (e) {
    return null;
  }
}

// 최신 1페이지는 반드시 포함하고 나머지는 근거리 및 원거리 구간에서 운영체제 난수로 추출
function generateStratifiedPages(spec, pagesToSample) {
  if (!spec || !spec.baseKey) return [];
  const total = Math.max(1, spec.totalPage);
  const selectedPages = generateRandomStratifiedPageNumbers(total, pagesToSample);
  return selectedPages.map(pageNum => buildBoardPage(spec, pageNum));
}

function buildBoardPage(spec, pageNum) {
  let url = '';
  if (spec.pagingType === 'path_keyword') {
    const cleanBase = spec.baseKey.replace(/\/+$/, '');
    url = `${cleanBase}/${spec.pathKeyword || 'page'}/${pageNum}`;
  } else if (spec.pagingType === 'path_number') {
    const cleanBase = spec.baseKey.replace(/\/+$/, '');
    url = `${cleanBase}/${pageNum}`;
  } else {
    const urlObj = new URL(spec.baseKey);
    urlObj.searchParams.set(spec.pageParam || 'page', String(pageNum));
    url = urlObj.toString();
  }
  return {
    url,
    pageNum,
    isLatest: pageNum <= 3
  };
}

function generateRemainingBoardPages(spec, selectedPages, limit = 5000) {
  if (!spec || !spec.baseKey) return [];
  const selected = new Set(selectedPages.map(page => Number(page)));
  const total = Math.max(1, Math.floor(Number(spec.totalPage) || 1));
  const result = [];
  for (let pageNum = 1; pageNum <= total && result.length < limit; pageNum++) {
    if (!selected.has(pageNum)) result.push(buildBoardPage(spec, pageNum));
  }
  return result;
}

// 표준 XML 사이트맵 및 robots.txt 자동 탐색 (Sitemap Auto-Discovery)
async function fetchSitemapUrls(origin, entryUrl) {
  const discovered = new Set();
  const sitemapEndpoints = [
    `${origin}/sitemap.xml`,
    `${origin}/sitemap_index.xml`
  ];

  // 1. robots.txt에서 Sitemap 지시어 확인
  try {
    const robotsResp = await fetch(`${origin}/robots.txt`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(3000)
    });
    if (robotsResp.ok) {
      const robotsText = await robotsResp.text();
      const sitemapMatches = robotsText.matchAll(/Sitemap:\s*([^\r\n]+)/gi);
      for (const m of sitemapMatches) {
        const smUrl = m[1].trim();
        if (smUrl.startsWith('http') && isSameDomain(smUrl, entryUrl)) {
          sitemapEndpoints.push(smUrl);
        }
      }
    }
  } catch (e) {}

  // 2. 사이트맵 XML 수신 및 loc 태그 파싱
  for (const smUrl of sitemapEndpoints) {
    try {
      const resp = await fetch(smUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(4000)
      });
      if (!resp.ok) continue;
      const xmlText = await resp.text();
      const locMatches = xmlText.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi);
      for (const lm of locMatches) {
        const u = lm[1].trim();
        if (isSameDomain(u, entryUrl) && !u.endsWith('.xml')) {
          if (!isNonContentLink(u, null)) {
            discovered.add(normalizeUrl(u));
          }
        } else if (u.endsWith('.xml') && isSameDomain(u, entryUrl) && discovered.size < 5000) {
          try {
            const subSmResp = await fetch(u, { signal: AbortSignal.timeout(3000) });
            if (subSmResp.ok) {
              const subXml = await subSmResp.text();
              const subLocs = subXml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi);
              for (const sl of subLocs) {
                const subU = sl[1].trim();
                if (isSameDomain(subU, entryUrl) && !isNonContentLink(subU, null)) {
                  discovered.add(normalizeUrl(subU));
                }
              }
            }
          } catch (se) {}
        }
      }
      if (discovered.size > 0) {
        console.log(`[DetectEngine] 표준 Sitemap XML 확인 (${smUrl}): 유효 URL ${discovered.size}개 일괄 확보`);
      }
    } catch (e) {}
  }

  return Array.from(discovered);
}

// 자바스크립트 라우트 자동 추출기 (JS Route Harvester)
// 인라인 <script> 및 외부 JS 파일(/js/url.js 등) 내부의 location.href, window.open 경로 추출
async function harvestJavaScriptUrls(dom, baseUrl, origin, entryUrl) {
  const discovered = new Map(); // url -> { linkText }
  if (!dom || !dom.children) return discovered;

  // htmlparser2에서 script 태그의 type은 'script'이므로 el.name === 'script'로 탐색
  const scriptTags = domutils.findAll(el => el.name === 'script', dom.children);
  const scriptTexts = [];
  const functionRouteMap = new Map(); // 함수명(menu1sub1 등) -> 실제 URL

  // 3rd-party 공통 라이브러리(경로 정보가 없는 외부 유틸리티) 필터링
  const isVendorLibrary = (s) => /(?:jquery|bootstrap|swiper|slider|slick|moment|lodash|axios|polyfill|vue|react|angular|chart|sweetalert|fontawesome|jssor)\b/i.test(s);

  let fetchedScriptCount = 0;
  for (const sc of scriptTags) {
    const inline = domutils.getText(sc).trim();
    if (inline) {
      scriptTexts.push(inline);
    }
    const src = sc.attribs ? (sc.attribs.src || '').trim() : '';
    if (src && fetchedScriptCount < 8) {
      try {
        const resolvedSrc = new URL(src, baseUrl).href;
        const srcLower = resolvedSrc.toLowerCase();
        // 동일 도메인의 자체 작성 스크립트 파일 수신 (단순 벤더 라이브러리 제외)
        if (isSameDomain(resolvedSrc, entryUrl) && !isVendorLibrary(srcLower) && /\.js(?:$|\?)/i.test(srcLower)) {
          fetchedScriptCount++;
          const jsResp = await fetch(resolvedSrc, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            signal: AbortSignal.timeout(3000)
          });
          if (jsResp.ok) {
            const jsCode = await jsResp.text();
            scriptTexts.push(jsCode);
            console.log(`[DetectEngine] 내부 자바스크립트 스크립트 수신 완료: ${resolvedSrc} (${jsCode.length}자)`);
          }
        }
      } catch (e) {}
    }
  }

  // 범용 자바스크립트 라우트 추출 (특정 CMS나 패턴에 구애받지 않는 범용 정규식)
  for (const code of scriptTexts) {
    // 1. 자바스크립트 함수 정의 및 location.href 매핑 (어떤 함수명이든 지원)
    const funcMatches = code.matchAll(/function\s+([a-zA-Z0-9_$]+)\s*\([^)]*\)\s*\{[^}]*location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/gi);
    for (const fm of funcMatches) {
      const funcName = fm[1].trim();
      const rawTarget = fm[2].trim();
      try {
        const targetUrl = new URL(rawTarget, baseUrl).href;
        if (isSameDomain(targetUrl, entryUrl) && !isNonContentLink(targetUrl, null)) {
          functionRouteMap.set(funcName, targetUrl);
          if (!discovered.has(targetUrl)) {
            discovered.set(targetUrl, { linkText: funcName });
          }
        }
      } catch (e) {}
    }

    // 2. 일반 location.href / window.open 경로 추출
    const directMatches = code.matchAll(/(?:location(?:\.href)?\s*=\s*|window\.open\(\s*)['"]([^'"]+)['"]/gi);
    for (const dm of directMatches) {
      const rawPath = dm[1].trim();
      if (rawPath && !rawPath.startsWith('javascript:') && !rawPath.startsWith('#') && !rawPath.startsWith('mailto:')) {
        try {
          const fullUrl = new URL(rawPath, baseUrl).href;
          if (isSameDomain(fullUrl, entryUrl) && !isNonContentLink(fullUrl, null)) {
            if (!discovered.has(fullUrl)) {
              discovered.set(fullUrl, { linkText: 'JS라우트' });
            }
          }
        } catch (e) {}
      }
    }

    // 3. 웹 애플리케이션 공통 내부 경로 패턴 (.php, .html, .jsp, .asp, .do 등 모든 확장자 및 쿼리 파라미터 경로, 상대/절대 경로 통합)
    const pathMatches = code.matchAll(/['"]((?:\/|[a-zA-Z0-9_\-]+\/)*[a-zA-Z0-9_\-]+\.(?:php|html?|jsp|asp|aspx|do|action)(?:\?[a-zA-Z0-9_=&%-]+)?|\/[a-zA-Z0-9_\-\/]+\?[a-zA-Z0-9_=&%-]+)['"]/gi);
    for (const pm of pathMatches) {
      const rawP = pm[1].trim();
      try {
        const fullUrl = new URL(rawP, baseUrl).href;
        if (isSameDomain(fullUrl, entryUrl) && !isNonContentLink(fullUrl, null)) {
          if (!discovered.has(fullUrl)) {
            discovered.set(fullUrl, { linkText: 'JS경로' });
          }
        }
      } catch (e) {}
    }

    // 4. RESTful 2-Depth 이상 디렉토리 경로 (예: /contents/service/cloud, /kr/intro/overview)
    const restMatches = code.matchAll(/['"](\/[a-zA-Z0-9_\-]{2,}(?:\/[a-zA-Z0-9_\-]+){1,4})['"]/gi);
    for (const rm of restMatches) {
      const rawR = rm[1].trim();
      if (!/\.(?:js|css|png|jpg|gif|svg|ico)$/i.test(rawR)) {
        try {
          const fullUrl = new URL(rawR, baseUrl).href;
          if (isSameDomain(fullUrl, entryUrl) && !isNonContentLink(fullUrl, null)) {
            if (!discovered.has(fullUrl)) {
              discovered.set(fullUrl, { linkText: 'REST경로' });
            }
          }
        } catch (e) {}
      }
    }
  }

  // DOM 내부의 <a href="javascript:func()"> 태그와 functionRouteMap 결합
  const jsAnchors = domutils.findAll(el => el.type === 'tag' && el.name === 'a' && el.attribs && (el.attribs.href || el.attribs.onclick), dom.children);
  for (const a of jsAnchors) {
    const rawCall = (a.attribs.href || '') + ' ' + (a.attribs.onclick || '');
    const callMatch = rawCall.match(/(?:javascript:)?\s*([a-zA-Z0-9_$]+)\s*\(/i);
    if (callMatch) {
      const calledFunc = callMatch[1];
      if (functionRouteMap.has(calledFunc)) {
        const mappedUrl = functionRouteMap.get(calledFunc);
        const titleText = extractLinkTextAndAlt(a) || calledFunc;
        discovered.set(mappedUrl, { linkText: titleText });
      }
    }
  }

  if (discovered.size > 0) {
    console.log(`[DetectEngine] 자바스크립트 라우트 파싱 성공: 총 ${discovered.size}개 내부 URL 발굴`);
  }

  return discovered;
}

// 전각 문자 -> 반각 문자 정규화 테이블
function normalizeFullwidth(str) {
  if (!str) return '';
  return str.replace(/[\uFF01-\uFF5E]/g, function (ch) {
    return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
  }).replace(/\u3000/g, ' '); // 전각 공백
}

// 한글 자모 복원 정규화 (자모 분해된 텍스트 합치기)
const CHOSUNG = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
const JUNGSUNG = ['ㅏ','ㅐ','ㅑ','ㅒ','ㅓ','ㅔ','ㅕ','ㅖ','ㅗ','ㅘ','ㅙ','ㅚ','ㅛ','ㅜ','ㅝ','ㅞ','ㅟ','ㅠ','ㅡ','ㅢ','ㅣ'];
const JONGSUNG = ['', 'ㄱ','ㄲ','ㄳ','ㄴ','ㄵ','ㄶ','ㄷ','ㄹ','ㄺ','ㄻ','ㄼ','ㄽ','ㄾ','ㄿ','ㅀ','ㅁ','ㅂ','ㅄ','ㅅ','ㅆ','ㅇ','ㅈ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];

// 한글 완성형 단어를 자모 분해하여 '분리 상태' 키워드 생성 (예: '성매매' -> 'ㅅㅓㅇㅁㅐㅁㅐ', '카지노' -> 'ㅋㅏㅈㅣㄴㅗ')
function decomposeToJamo(str) {
  if (!str) return '';
  let res = '';
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xAC00 && code <= 0xD7A3) {
      const syl = code - 0xAC00;
      const cho = Math.floor(syl / (21 * 28));
      const jung = Math.floor((syl % (21 * 28)) / 28);
      const jong = syl % 28;
      res += CHOSUNG[cho] + JUNGSUNG[jung] + (jong > 0 ? JONGSUNG[jong] : '');
    } else {
      res += str[i];
    }
  }
  return res;
}

// 본문에서 특수기호, 공백, 유령문자, 변칙 자모(ㅋ r, ㅈ l 등)를 정규화한 순수 분리 상태 스트림 추출
function extractNormalizedJamoStream(str) {
  if (!str) return '';
  let s = String(str).replace(/[\u00AD\u200B-\u200D\uFEFF\u2060]/g, '');
  s = s.replace(/([ㄱ-ㅎ])\s*r(?=[^a-zA-Z]|$)/gi, '$1ㅏ');
  s = s.replace(/\(?([ㄱ-ㅎ])\s*[l1|!]\)?/gi, '$1ㅣ');
  s = normalizeJamoUnicode(s);
  return s.replace(/[\s._\-\/\*\^~=<>%『』\(\)\[\]\{\}]+/g, '');
}

// U+1100 조합 자모 영역을 U+3131 호환 자모 영역으로 변환 (완성형 한글 '가-힣'은 절대 분해하지 않고 원형 보존)
function normalizeJamoUnicode(str) {
  if (!str) return '';
  // 1. 유령 문자 (소프트 하이픈, 제로 위스 공백, BOM, 워드 조이너 등) 원천 제거
  let s = String(str).replace(/[\u00AD\u200B-\u200D\uFEFF\u2060]/g, '');

  // 2. 한글 자음 뒤의 소문자 r을 모음 'ㅏ'로 복원 (예: ㅋ r -> ㅋ ㅏ)
  s = s.replace(/([ㄱ-ㅎ])\s*r(?=[^a-zA-Z]|$)/gi, '$1ㅏ');

  // 3. 한글 자음 뒤의 소문자 l, 숫자 1, 파이프 등을 모음 'ㅣ'로 복원 (예: (ㅈl) -> ㅈㅣ, ㅈ1 -> ㅈㅣ)
  s = s.replace(/\(?([ㄱ-ㅎ])\s*[l1|!]\)?/gi, '$1ㅣ');

  // 4. 이미 낱자로 분리되어 있는 U+1100 조합 자모 영역만 U+3131 호환 자모로 변환
  // [절대 주의] s.normalize('NFD')를 호출하면 '조건만남' 같은 완성형 단어가 낱자로 쪼개져 '조[건만]남' -> 'ㄱㅓㄴㅁㅏ'(건마)로 오탐되므로 절대 NFD 금지!
  return s
    .replace(/[\u1100-\u1112]/g, ch => CHOSUNG[ch.charCodeAt(0) - 0x1100] || ch)
    .replace(/[\u1161-\u1175]/g, ch => JUNGSUNG[ch.charCodeAt(0) - 0x1161] || ch)
    .replace(/[\u11A8-\u11C2]/g, ch => JONGSUNG[ch.charCodeAt(0) - 0x11A7] || ch);
}

// 원문에 실제로 흩어져 있는 자모(또는 ㅋ r, ㅈ l 등 변칙 은닉 자모)가 연속 존재하는지 검사 (정상 완성형 한글은 절대 분해하지 않음)
function hasRealJamoSequence(str) {
  if (!str) return false;
  // 1. 유령 문자 제거
  let s = String(str).replace(/[\u00AD\u200B-\u200D\uFEFF\u2060]/g, '');
  // 2. 한글 자음 뒤의 소문자 r을 모음 'ㅏ'로 복원 (예: ㅋ r -> ㅋ ㅏ)
  s = s.replace(/([ㄱ-ㅎ])\s*r(?=[^a-zA-Z]|$)/gi, '$1ㅏ');
  // 3. 한글 자음 뒤의 소문자 l, 숫자 1, 파이프 등을 모음 'ㅣ'로 복원 (예: ㅈl -> ㅈㅣ)
  s = s.replace(/\(?([ㄱ-ㅎ])\s*[l1|!]\)?/gi, '$1ㅣ');
  // 4. 특수기호 및 공백 제거
  const clean = s.replace(/[\s._\-\/\*\^~=<>%『』\(\)\[\]\{\}]+/g, '');
  // 5. 순수 자음/모음 낱자([ㄱ-ㅎㅏ-ㅣ])가 2개 이상 연속되어 있는지 확인 (완성형 한글 '가-힣'은 매칭 안 됨!)
  return /[ㄱ-ㅎㅏ-ㅣ]{2,}/.test(clean);
}

function combineJamo(str) {
  if (!str) return '';
  const normalized = normalizeJamoUnicode(str);
  let result = '';
  let i = 0;
  const chars = Array.from(normalized);
  // 결합 시 건너뛸 특수문자 및 기호 범위 (등호, 꺾쇠, 퍼센트, 괄호 등 포함)
  const skipRegex = /[\s._\-\/\*\^~=<>%『』\(\)\[\]\{\}]/;

  while (i < chars.length) {
    const ch = chars[i];
    const choIdx = CHOSUNG.indexOf(ch);

    if (choIdx !== -1) {
      // 다음 유의미한 중성(모음) 문자 탐색 (공백 및 특수기호 건너뛰기)
      let j = i + 1;
      while (j < chars.length && skipRegex.test(chars[j])) {
        j++;
      }

      if (j < chars.length) {
        const nextCh = chars[j];
        const jungIdx = JUNGSUNG.indexOf(nextCh);

        if (jungIdx !== -1) {
          // 초성 + 중성 결합 성립
          let jongIdx = 0;
          let nextIndex = j + 1;

          // 종성(받침) 탐색
          let k = j + 1;
          while (k < chars.length && skipRegex.test(chars[k])) {
            k++;
          }

          if (k < chars.length) {
            const testJong = JONGSUNG.indexOf(chars[k]);
            if (testJong > 0) {
              // 그 다음 유효 문자가 모음이면 종성이 아니라 다음 음절의 초성으로 배분
              let m = k + 1;
              while (m < chars.length && skipRegex.test(chars[m])) {
                m++;
              }
              if (m < chars.length && JUNGSUNG.indexOf(chars[m]) !== -1) {
                jongIdx = 0;
                nextIndex = j + 1;
              } else {
                jongIdx = testJong;
                nextIndex = k + 1;
              }
            }
          }

          const code = 0xAC00 + (choIdx * 21 * 28) + (jungIdx * 28) + jongIdx;
          result += String.fromCharCode(code);
          i = nextIndex;
          continue;
        }
      }
    }

    result += ch;
    i++;
  }

  return result;
}

// 초강력 변칙 스팸 탈은닉(Deobfuscation) 복원 유틸리티
function deobfuscateSpamText(text) {
  if (!text) return '';
  // 1. 유령 문자 원천 제거
  let s = String(text).replace(/[\u00AD\u200B-\u200D\uFEFF\u2060]/g, '');

  // 2. 단어/자모 사이 방해 특수기호 제거 (꺾쇠 감싼 단어, 등호, 퍼센트, 물결 등)
  s = s.replace(/<([가-힣a-zA-Z0-9])>/g, '$1');
  s = s.replace(/([가-힣a-zA-Z0-9])\s*[=_%~^*]+\s*([가-힣a-zA-Z0-9])/g, '$1$2');

  // 3. 자음 + 알파벳/특수기호 위장 사전 복원 (자모 결합기 받침 흡수 오류 사전 차단)
  s = s.replace(/ㅁ\s*ㅔ\s*ㄱ\s*[rR가]/g, '메가');
  s = s.replace(/([ㄱ-ㅎ])\s*[rR](?=[^a-zA-Z]|$)/gi, (match, cho) => {
    const choIdx = CHOSUNG.indexOf(cho);
    if (choIdx !== -1) {
      return String.fromCharCode(0xAC00 + (choIdx * 21 * 28)); // 'ㅏ' 모음 결합 음절
    }
    return cho + 'ㅏ';
  });
  s = s.replace(/\(?([ㄱ-ㅎ])\s*[l1|!]\)?/gi, (match, cho) => {
    const choIdx = CHOSUNG.indexOf(cho);
    if (choIdx !== -1) {
      return String.fromCharCode(0xAC00 + (choIdx * 21 * 28) + (20 * 28)); // 'ㅣ' 모음 결합 음절
    }
    return cho + 'ㅣ';
  });
  s = s.replace(/ㄱ\s*ㅔ\s*\(?임\)?/g, '게임');
  s = s.replace(/([ㄱ-ㅎ])\s*ㅔ(?=[^a-zA-Z]|$)/g, (match, cho) => {
    const choIdx = CHOSUNG.indexOf(cho);
    if (choIdx !== -1) {
      return String.fromCharCode(0xAC00 + (choIdx * 21 * 28) + (5 * 28)); // 'ㅔ' 모음 결합 음절
    }
    return cho + 'ㅔ';
  });

  // 4. 모음 비틀기 사행성 은어 복원 (바카라, 라이브 등)
  s = s.replace(/뱌\s*[=_\-~*]*\s*캬\s*[=_\-~*]*\s*랴/g, '바카라');
  s = s.replace(/바\s*[=_\-~*]*\s*캬\s*[=_\-~*]*\s*라/g, '바카라');
  s = s.replace(/뱌\s*[=_\-~*]*\s*카\s*[=_\-~*]*\s*랴/g, '바카라');
  s = s.replace(/랴\s*[=_\-~*]*\s*(?:ㅇ\s*ㅣ|이)\s*[=_\-~*]*\s*브/g, '라이브');

  // 5. 입출금 및 계좌 유혹 은어 복원
  s = s.replace(/내\s*통\s*[=_\-~*]*\s*장/g, '내통장');
  s = s.replace(/입\s*[=_\-~*]*\s*금/g, '입금');
  s = s.replace(/출\s*[=_\-~*]*\s*금/g, '출금');

  // 6. 자모 결합 (combineJamo)
  return combineJamo(s);
}

// 공백/특수문자로 분리된 도메인 위장 추출 (예: B M W 5 8 5 8 . C O M -> bmw5858.com)
function extractSpacedDomain(text) {
  if (!text) return null;
  const clean = String(text).replace(/[\u00AD\u200B-\u200D\uFEFF\u2060]/g, '');
  const match = clean.match(/(?:[a-zA-Z0-9]\s+){3,}[a-zA-Z0-9]\s*\.\s*(?:com|net|org|kr|co|xyz|top|vip|live|club|me|cc|io|biz|info)/i);
  if (match) {
    return match[0].replace(/\s+/g, '').toLowerCase();
  }
  return null;
}

// 비동기 슬립 유틸리티
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}



// 탐지 사유를 결과 카테고리만 깔끔하게 짧게 반환하는 함수 (LLM 횡설수설 영문 노출 원천 차단)
function getRefinedCategoryReason(keyword, memo, aiRes) {
  const kw = String(keyword || '').toLowerCase();
  const mm = String(memo || '').toLowerCase();
  const aiReason = (aiRes && aiRes.reason) ? String(aiRes.reason).toLowerCase() : '';

  if (/(?:도박|카지노|바카라|슬롯|토토|홀덤|포커|베팅|꽁머니|환전|머니상|먹튀|놀이터)/i.test(kw) || /(?:도박|카지노|사행)/i.test(mm) || /(?:도박|카지노|사행)/i.test(aiReason)) {
    return '불법 사행성/도박 광고 판정';
  }
  if (/(?:성매매|조건만남|호빠|풀싸롱|룸싸롱|출장안마|출장마사지|오피|유흥|셔츠룸|가라오케)/i.test(kw) || /(?:성매매|유흥)/i.test(mm) || /(?:성매매|유흥)/i.test(aiReason)) {
    return '불법 유흥/성매매 광고 판정';
  }
  if (/(?:대출|급전|대포통장|대포폰|개인돈|카드현금화|소액결제|통장팝니다|선불유심)/i.test(kw) || /(?:대출|금융|통장)/i.test(mm) || /(?:대출|금융)/i.test(aiReason)) {
    return '불법 대출/금융사기 광고 판정';
  }
  if (/(?:비아그라|시알리스|발기부전|정력제|최음제)/i.test(kw) || /(?:의약품)/i.test(mm) || /(?:의약품)/i.test(aiReason)) {
    return '불법 의약품 광고 판정';
  }
  if (/(?:찌라시|백링크|도배|프로그램|텔레|상위노출)/i.test(kw) || /(?:스팸)/i.test(mm) || /(?:스팸)/i.test(aiReason)) {
    return '불법 홍보/스팸 광고 판정';
  }
  return '노출 텍스트 의심 패턴 판정';
}

// 웹 접근성 (스크린리더용 화면 은닉 단어 화이트리스트 - 오탐 원천 차단)
const ACCESSIBILITY_UI_TERMS = new Set([
  '초기화', '축소', '확대', '검색', '닫기', '열기', '이전', '다음', '메뉴', '선택',
  '바로가기', '본문 바로가기', '주메뉴 바로가기', '하단 바로가기', '열린', '새창', '새창열림',
  '다운로드', '목록', '더보기', '페이지', '홈', '인쇄', '공유', '상세보기', '필터', '설정'
]);

// 스크린리더용 표준 접근성 클래스명
const ACCESSIBILITY_CLASSES = [
  'sound_only', 'sr-only', 'visually-hidden', 'blind', 'sd_hidden', 'skip-nav',
  'txt_blind', 'screen_out', 'hidden-txt', 'ir_wa', 'ir_pm', 'readable-hidden', 'img_zoom'
];

function isAccessibilityContent(text, classAttr = '') {
  if (!text) return true;
  const trimmed = text.trim();
  // 1. 단어 자체가 스크린리더용 UI 단어이거나 건너뛰기 네비게이션인 경우
  if (ACCESSIBILITY_UI_TERMS.has(trimmed) || /^skip\s+to\s+(?:content|main|navigation|menu)/i.test(trimmed)) return true;
  // 2. 접근성 클래스가 적용되어 있는 경우
  const cls = (classAttr || '').toLowerCase();
  if (ACCESSIBILITY_CLASSES.some(c => cls.includes(c))) return true;
  // 3. 길이가 4글자 이하인 단순 단어는 스크린리더 UI로 판정
  if (trimmed.length <= 4) return true;
  return false;
}

// 정상 웹 콘텐츠 판별 (애니메이션/스크롤 라이브러리 클래스 등)
function isNormalWebContent(text, locationOrClass = '') {
  if (!text) return true;
  const locStr = String(locationOrClass).toLowerCase();

  // AOS/애니메이션 클래스 요소는 콘텐츠가 아님
  if (locStr.includes('aos-') || locStr.includes('data-aos') || locStr.includes('wow') || locStr.includes('animate')) {
    return true;
  }

  return false;
}

// 스크립트, 스타일, 메타, 주석 태그 등을 배제한 순수 렌더링 텍스트만 추출 (<br>은 줄바꿈으로 변환)
function getPureElementText(el) {
  if (!el) return '';
  if (el.type === 'text') {
    return (el.data || '').trim();
  }
  if (el.type === 'tag') {
    // 자바스크립트 코드, CSS 스타일, 헤더 메타 등 비화면 태그는 완벽 배제
    if (['script', 'style', 'noscript', 'template', 'head', 'meta', 'link'].includes(el.name)) {
      return '';
    }
    // <br> 태그는 줄바꿈(\n)으로 변환하여 문장 결합 및 분할(chunking) 보존
    if (el.name === 'br') {
      return '\n';
    }
    if (el.children && el.children.length > 0) {
      return el.children
        .map(child => getPureElementText(child))
        .filter(t => t.length > 0)
        .join(' ')
        .replace(/\s*\n\s*/g, '\n');
    }
  }
  return '';
}

// 위반 판정을 유발한 구체적인 매칭 키워드 및 원인, 은어 뜻(memo) 분석
function findMatchedKeyword(text, targetPatterns = [], memoMap = null) {
  if (!text) return null;
  const str = String(text);

  // 전달받은 패턴 목록(오염 패턴 또는 의심 패턴)이 있으면 해당 목록 정밀 매칭
  if (targetPatterns && targetPatterns.length > 0) {
    for (const p of targetPatterns) {
      if (p && p.trim().length >= 2) {
        if (!str.includes(p)) {
          continue;
        }
        const memo = (memoMap && memoMap.get) ? (memoMap.get(p) || '') : '';
        return { keyword: p, type: '등록패턴', reason: `등록 패턴 문구 검출 ('${p}')`, memo };
      }
    }
  }

  return null;
}

function parseRequiredTerms(value) {
  if (!value) return [];
  return [...new Set(String(value)
    .split(/[,，\n\r]+/)
    .map(term => term.trim())
    .filter(Boolean))];
}

// 짝 단어가 등록된 의심 패턴은 같은 검사 문장 안에 짝 단어가 하나 이상 있어야 유효하다.
function findMatchedSuspectKeyword(textValues, targetPatterns = [], memoMap = null, requiredTermsMap = null) {
  const texts = (Array.isArray(textValues) ? textValues : [textValues])
    .filter(value => value !== null && value !== undefined)
    .map(value => String(value));
  if (texts.length === 0) return null;

  const loweredTexts = texts.map(text => text.toLowerCase());
  const combinedLower = loweredTexts.join(' ');
  for (const pattern of targetPatterns || []) {
    if (!pattern || pattern.trim().length < 2) continue;
    const patternLower = pattern.toLowerCase();

    const requiredTerms = requiredTermsMap && requiredTermsMap.get
      ? (requiredTermsMap.get(pattern) || [])
      : [];
    if (requiredTerms.length === 0) {
      if (!loweredTexts.some(text => text.includes(patternLower))) continue;
    } else {
      const requiredLower = requiredTerms.map(term => term.toLowerCase());
      if (!requiredLower.some(term => combinedLower.includes(term))) continue;

      // 정상 단어 내부의 부분 일치는 제외한다. 단독 표기이거나 짝 단어와 바로 붙은 경우만 인정한다.
      const hasEligibleOccurrence = loweredTexts.some(text => {
        let index = text.indexOf(patternLower);
        while (index !== -1) {
          const end = index + patternLower.length;
          const left = index > 0 ? text[index - 1] : '';
          const right = end < text.length ? text[end] : '';
          const leftBoundary = !left || !/[가-힣ㄱ-ㅎㅏ-ㅣa-z0-9]/i.test(left);
          const rightBoundary = !right || !/[가-힣ㄱ-ㅎㅏ-ㅣa-z0-9]/i.test(right);
          const adjacentRequired = requiredLower.some(term =>
            text.slice(0, index).endsWith(term) || text.slice(end).startsWith(term)
          );
          if ((leftBoundary && rightBoundary) || adjacentRequired) return true;
          index = text.indexOf(patternLower, index + 1);
        }
        return false;
      });
      if (!hasEligibleOccurrence) continue;
    }

    const memo = (memoMap && memoMap.get) ? (memoMap.get(pattern) || '') : '';
    return { keyword: pattern, type: '등록패턴', reason: `등록 패턴 문구 검출 ('${pattern}')`, memo };
  }
  return null;
}

// 위반 키워드를 중심으로 앞뒤 문맥(Snippet)만 단정하게 발췌 (최대 약 140자)
function extractEvidenceSnippet(fullText, targetWord, maxLen = 140) {
  if (!fullText) return '';
  // 줄바꿈, 탭, 연속 공백을 단일 공백으로 정규화
  const cleaned = fullText.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (!targetWord || targetWord.trim().length === 0) {
    return cleaned.length > maxLen ? cleaned.slice(0, maxLen) + '...' : cleaned;
  }

  const idx = cleaned.toLowerCase().indexOf(targetWord.toLowerCase());
  if (idx === -1) {
    return cleaned.length > maxLen ? cleaned.slice(0, maxLen) + '...' : cleaned;
  }

  const half = Math.floor((maxLen - targetWord.length) / 2);
  const start = Math.max(0, idx - half);
  const end = Math.min(cleaned.length, idx + targetWord.length + half);

  let snippet = cleaned.slice(start, end).trim();
  if (start > 0) snippet = '...' + snippet;
  if (end < cleaned.length) snippet = snippet + '...';
  return snippet;
}

class DetectEngine {
  constructor() {
    this.currentSessionId = null;
    this.workflowPromise = null;
    this.cleanroomPatternCache = null;
    this.cleanroomPatternLoadPromise = null;
    this.cleanroomPatternCacheVersion = 0;
    this.session = {
      masterId: null,
      masterTitle: null,
      siteProfile: '',
      entryUrl: '',
      status: 'IDLE', // IDLE, RUNNING, PAUSED, COMPLETED, STOPPED
      startedAt: null,
      finishedAt: null,
      elapsedSec: 0,
      currentUrl: '',
      currentStep: '대기 중',
      speedDelayMs: 500, // 기본 요청 지연 시간 (0.5초)
      maxPages: 5000,    // 최대 점검 페이지 수
      maxTimeSec: 1800,  // 기본 점검 제한 시간 (30분 = 1800초, 최대 60분 안전 통제)
      resultReserveSec: 90,
      startedAtMs: null,
      scanDeadlineAtMs: null,
      pageDurationSamples: [],
      observedPageMs: 0,
      adaptivePageLimit: 0,
      schedulerCursor: 0,
      visitedUrls: new Set(),
      excludedUrlKeys: new Set(),
      exposedIndexUrls: new Set(),
      nonstandardPortFindingUrls: new Set(),
      reflectionProbeSignatures: new Set(),
      reflectionCheckedBoardKeys: new Set(),
      siteSearchProbeDone: false,
      contentQueue: [],  // 일반 콘텐츠/메뉴/카테고리 대기열
      articleQueue: [],  // 게시물 본문 상세 뷰 대기열
      reserveBoardPageQueue: [],
      reserveArticleQueue: [],
      precisionMode: false,
      urlQueue: [],      // UI 및 외부 호환용 통합 대기열
      articleBufferCap: 1800,
      estimatedTotalPages: 0,
      contentQuota: 0,
      articleQuota: 0,
      visitedContentCount: 0,
      visitedArticleCount: 0,
      treeNodes: [],
      findings: [],
      timerId: null
    };
  }

  async probeReflectedSearch(spec, pollutedPattern, allowRenderedFallback = false) {
    if (!spec || !pollutedPattern) return null;
    const nonce = crypto.randomBytes(6).toString('hex');
    const payload = `TARAE_${nonce}_${pollutedPattern}_${nonce}`;
    const probeUrl = buildReflectionProbeUrl(spec, payload);
    let inspection = null;
    let status = 0;

    try {
      await sleep(this.session.speedDelayMs);
      const response = await fetch(probeUrl, {
        headers: {
          ...getRandomHumanHeaders(this.session.entryUrl),
          'Cache-Control': 'no-store',
          Pragma: 'no-cache'
        },
        signal: AbortSignal.timeout(10000)
      });
      status = response.status;
      if (isSameDomain(response.url || probeUrl, this.session.entryUrl)) {
        const contentType = response.headers.get('content-type') || '';
        // 서버 오류 화면은 콘텐츠 분석과 브라우저 정밀 검사의 대상에서 제외
        if (response.status < 500 && contentType.includes('text/html')) {
          const buffer = Buffer.from(await response.arrayBuffer());
          const html = decodeHtmlBuffer(buffer, contentType);
          inspection = inspectReflectedProbeHtml(html, payload, response.headers, response.url || probeUrl);
        }
      }
    } catch (e) {
      console.warn('[DetectEngine] 반사형 검색 검사 요청 오류:', e.message);
    }

    if ((!inspection || !inspection.reflected) && allowRenderedFallback &&
        Date.now() + 12000 < this.session.scanDeadlineAtMs) {
      try {
        const rendered = await browserInspector.inspectPageDetails(probeUrl, 10000, {
          waitForDynamicNetwork: true,
          collectDynamicPagination: false
        });
        if (rendered && rendered.html) {
          const renderedInspection = inspectReflectedProbeHtml(rendered.html, payload, null, probeUrl);
          if (renderedInspection.reflected) {
            if (inspection && inspection.indexLimited) {
              renderedInspection.indexLimited = true;
              renderedInspection.limitReason = inspection.limitReason;
            }
            inspection = renderedInspection;
          }
        }
      } catch (e) {
        console.warn('[DetectEngine] 반사형 검색 동적 화면 검사 오류:', e.message);
      }
    }

    if (!inspection || !inspection.reflected || status < 200 || status >= 300) return null;
    const evidence = extractEvidenceSnippet(inspection.visibleText, payload, 220);
    return {
      probeUrl,
      payload,
      status,
      evidence,
      indexLimited: inspection.indexLimited,
      limitReason: inspection.limitReason
    };
  }

  async inspectReflectedSearchForms(dom, currentUrl, currentItem, isCurrentBoardList, isCurrentArticle, pollutedPatterns, allowRenderedFallback) {
    const forms = extractGetSearchForms(dom, currentUrl);
    if (forms.length === 0) return [];

    let scopeKey = null;
    if (isCurrentBoardList) {
      const pagingInfo = parsePagingInfoFromHref(currentUrl, '');
      const pageNum = Number(currentItem.pageNum || (pagingInfo && pagingInfo.pageNum) || 1);
      if (pageNum > 1) return [];
      scopeKey = currentItem.boardKey || getBoardIdentityKey(currentUrl);
      if (this.session.reflectionCheckedBoardKeys.has(scopeKey)) return [];
      this.session.reflectionCheckedBoardKeys.add(scopeKey);
    } else {
      if (isCurrentArticle || this.session.siteSearchProbeDone) return [];
      scopeKey = 'site-search';
      this.session.siteSearchProbeDone = true;
    }

    const untested = forms.filter(spec => !this.session.reflectionProbeSignatures.has(spec.signature));
    if (untested.length === 0) return [];

    let selected = untested[0];
    if (isCurrentBoardList && untested.length > 1) {
      const current = new URL(currentUrl);
      selected = [...untested].sort((left, right) => {
        const score = spec => {
          const action = new URL(spec.actionUrl);
          let value = action.pathname === current.pathname ? 4 : 0;
          for (const [key, fixedValue] of spec.fixedParams || []) {
            if (current.searchParams.has(key) && current.searchParams.get(key) === fixedValue) value += 3;
          }
          return value;
        };
        return score(right) - score(left);
      })[0];
    }

    this.session.reflectionProbeSignatures.add(selected.signature);
    const pollutedPattern = selectReflectionProbePattern(pollutedPatterns);
    if (!pollutedPattern || Date.now() + 12000 >= this.session.scanDeadlineAtMs) return [];

    this.session.currentStep = `반사형 검색 오염 검사 중: ${isCurrentBoardList ? '게시판 검색' : '대표 검색'}`;
    const result = await this.probeReflectedSearch(selected, pollutedPattern, allowRenderedFallback);
    if (!result) return [];

    const limitText = result.indexLimited
      ? `색인 제한 신호 확인: ${result.limitReason}`
      : '색인 제한 신호 없음';
    const reason = `반사형 검색 입력값 노출 확인 (${limitText})`;
    return [{
      url: result.probeUrl,
      is_violation: true,
      location: `${isCurrentBoardList ? '게시판' : '사이트'} GET 검색 결과`,
      evidence_text: result.evidence,
      technique: 'REFLECTED_SEARCH',
      reason,
      matched_keyword: pollutedPattern,
      extra_finding: reason,
      scope_key: scopeKey
    }];
  }

  // [1단계: 사전 탐색 및 계획 수립] 메인 화면 및 전체 메뉴(GNB/LNB/푸터) 고속 스캔을 통해
  // 정적 콘텐츠, 게시판별 페이징/게시물 규모를 파악하고 버퍼(기본 2,800건) 비례 배분 계획 수립
  async scoutAndPlanSite(entryUrl, origin) {
    try {
      this.session.currentStep = '탐지 계획 수립 중: 메인 메뉴 및 사이트 구조 고속 분석...';
      this.session.planningProgress = '15%';
      console.log('[DetectEngine] 1단계: 사이트 사전 탐색 및 계획 수립 시작:', entryUrl);

      // 루트 페이지 HTML 경량 고속 수신 (포워딩 및 리다이렉트 최대 5회 자동 추적)
      let currentTargetUrl = entryUrl;
      let rootHtml = '';
      let hops = 0;
      const maxHops = 5;

      while (hops < maxHops) {
        hops++;
        let fetchResp = null;
        try {
          fetchResp = await fetch(currentTargetUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
              'Accept': 'text/html,application/xhtml+xml',
              'Cache-Control': 'no-cache'
            },
            signal: AbortSignal.timeout(6000)
          });
          if (fetchResp.ok) {
            rootHtml = await fetchResp.text();
            // HTTP 응답 URL이 리다이렉트되어 변경된 경우 타겟 갱신
            if (fetchResp.url && fetchResp.url !== currentTargetUrl && isSameDomain(fetchResp.url, entryUrl)) {
              currentTargetUrl = fetchResp.url;
            }
          }
        } catch (fetchErr) {
          console.warn(`[DetectEngine] 페이지 수신 경고 (${currentTargetUrl}):`, fetchErr.message);
          break;
        }

        if (!rootHtml) break;

        // 클라이언트 사이드 포워딩 (JS location.href / meta refresh) 감지
        const redirectUrl = extractClientRedirectUrl(rootHtml, currentTargetUrl);
        if (redirectUrl && redirectUrl !== currentTargetUrl && isSameDomain(redirectUrl, entryUrl)) {
          console.log(`[DetectEngine] 포워딩(이동) 감지: ${currentTargetUrl} -> ${redirectUrl} (추적 ${hops}/${maxHops})`);
          currentTargetUrl = redirectUrl;
          this.session.currentStep = `탐지 계획 수립 중: 포워딩 이동 추적 중 -> ${new URL(redirectUrl).pathname}`;
          continue;
        }

        // 더 이상 포워딩이 없으면 현재 페이지로 확정
        break;
      }

      if (!rootHtml) {
        console.warn('[DetectEngine] 메인 HTML을 가져오지 못하여 기본 탐색으로 초기화합니다.');
        return;
      }

      const rootDom = htmlparser2.parseDocument(rootHtml);
      const siteTitle = this.extractSiteTitle(rootDom, currentTargetUrl);
      this.session.masterTitle = siteTitle;
      const siteProfileSource = this.extractSiteProfile(rootDom, siteTitle);
      this.session.siteProfile = await llmPipelineService.summarizeSiteProfile(siteProfileSource);
      this.session.effectiveRootUrl = currentTargetUrl;
      if (this.session.excludedUrlKeys) {
        this.session.excludedUrlKeys.delete(normalizeUrl(currentTargetUrl));
      }

      // 시작 URL과 실제 도착한 메인 URL이 다른 경우(포워딩된 경우) contentQueue에 포워딩 대상도 추가
      if (currentTargetUrl !== entryUrl) {
        this.session.contentQueue.push({
          url: currentTargetUrl,
          depth: 1,
          parentUid: 'node_1',
          pathSegment: new URL(currentTargetUrl).pathname,
          isArticle: false,
          title: siteTitle
        });
      }

      this.session.planningProgress = '30%';
      this.session.currentStep = `탐지 계획 수립 중: [${siteTitle}] 메뉴 구조 및 게시판 식별 중...`;

      // frame 및 iframe 태그 추출 및 프레임 내부 메뉴 결합
      const frames = extractFrameUrls(rootDom, currentTargetUrl);
      const frameDoms = [];
      if (frames.length > 0) {
        console.log(`[DetectEngine] 메인 페이지에서 프레임 ${frames.length}개 발견, 프레임 내부 메뉴 조사...`);
        for (const fr of frames) {
          if (this.hasVisitedOrExcludedUrl(fr.url)) continue;
          try {
            const frResp = await fetch(fr.url, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml',
                'Cache-Control': 'no-cache'
              },
              signal: AbortSignal.timeout(4000)
            });
            if (frResp.ok) {
              const frHtml = await frResp.text();
              const frDom = htmlparser2.parseDocument(frHtml);
              frameDoms.push({ dom: frDom, url: fr.url });
              // 프레임 자체도 점검 대기열에 등록
              this.session.contentQueue.push({
                url: fr.url,
                depth: 1,
                parentUid: 'node_1',
                pathSegment: `[${fr.type}] ${new URL(fr.url).pathname}`,
                isArticle: false,
                title: `${fr.type} 콘텐츠`
              });
            }
          } catch (e) {}
        }
      }

      // [진입점 게이트웨이 / 스플래시 화면 구조적 자동 감지]
      // 메인 랜딩 페이지의 내부 유효 링크 수가 적고 텍스트 밀도가 낮은 경우(인트로 포털 화면),
      // 발견된 모든 내부 진입점 페이지들을 구조적 1차 관문으로 간주하여 일괄 수신 및 메뉴 통합 스캔
      const initialLinks = domutils.findAll(el => el.type === 'tag' && el.name === 'a' && el.attribs && (el.attribs.href || el.attribs['data-href']), rootDom.children);
      const splashCandidateUrls = [];
      const rootTextLength = (domutils.getText(rootDom.children) || '').replace(/\s+/g, ' ').trim().length;

      // 텍스트가 500자 미만이거나 내부 링크 수가 15개 이하인 경우 포털 게이트웨이 화면으로 판정
      if (initialLinks.length <= 15 || rootTextLength < 500) {
        for (const a of initialLinks) {
          let raw = a.attribs.href || a.attribs['data-href'];
          if (!raw) continue;
          const resolved = this.resolveUrl(origin, currentTargetUrl, raw);
          if (resolved && isSameDomain(resolved, entryUrl) && resolved !== currentTargetUrl && !this.hasVisitedOrExcludedUrl(resolved) && !isNonContentLink(resolved, a)) {
            if (!splashCandidateUrls.includes(resolved)) {
              splashCandidateUrls.push(resolved);
            }
          }
        }
      }

      const extraDoms = [];
      if (splashCandidateUrls.length > 0) {
        console.log(`[DetectEngine] 진입점 게이트웨이 화면 식별: 내부 주요 허브 ${splashCandidateUrls.length}개 일괄 통합 스캔`);
        // 주요 진입점을 병렬 수신
        const portalsToFetch = splashCandidateUrls.slice(0, 8);
        await Promise.allSettled(portalsToFetch.map(async (sUrl) => {
          try {
            const sResp = await fetch(sUrl, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml',
                'Cache-Control': 'no-cache'
              },
              signal: AbortSignal.timeout(4000)
            });
            if (sResp.ok) {
              const sHtml = await sResp.text();
              const sDom = htmlparser2.parseDocument(sHtml);
              extraDoms.push({ dom: sDom, baseUrl: sUrl });
              this.session.contentQueue.push({
                url: sUrl,
                depth: 1,
                parentUid: 'node_1',
                pathSegment: new URL(sUrl).pathname,
                isArticle: false,
                title: this.extractSiteTitle(sDom, new URL(sUrl).pathname)
              });
            }
          } catch (se) {}
        }));
      }

      // 메인 DOM, 스플래시 확장 DOM 및 프레임 DOM들 결합
      const allDomsToScan = [
        { dom: rootDom, baseUrl: currentTargetUrl },
        ...extraDoms,
        ...frameDoms.map(f => ({ dom: f.dom, baseUrl: f.url }))
      ];
      const candidateUrls = new Map(); // resolvedUrl -> { linkText }

      // 1. DOM 내부 링크 추출 (alt 및 title 속성 자동 보존)
      for (const target of allDomsToScan) {
        const foundLinks = domutils.findAll(el => {
          if (el.type !== 'tag') return false;
          if (el.name === 'a') return !!(el.attribs && (el.attribs.href || el.attribs['data-href'] || el.attribs.onclick));
          if (el.attribs) {
            if (el.attribs.href || el.attribs['data-href']) return true;
            if (el.attribs.onclick && /(?:location(?:\.href)?\s*=|window\.open)/i.test(el.attribs.onclick)) return true;
          }
          return false;
        }, target.dom.children);

        for (const a of foundLinks) {
          let rawHref = a.attribs ? (a.attribs.href || a.attribs['data-href']) : null;
          if (!rawHref && a.attribs && a.attribs.onclick) {
            const m = a.attribs.onclick.match(/(?:location(?:\.href)?\s*=\s*['"]|window\.open\(\s*['"])([^'"]+)/i);
            if (m) rawHref = m[1];
          }
          if (!rawHref) continue;

          // javascript: 링크 중 location.href 포함 구문 확인
          if (rawHref.startsWith('javascript:') && /(?:location(?:\.href)?\s*=|window\.open)/i.test(rawHref)) {
            const jm = rawHref.match(/(?:location(?:\.href)?\s*=\s*['"]|window\.open\(\s*['"])([^'"]+)/i);
            if (jm) rawHref = jm[1];
          }

          if (rawHref.startsWith('javascript:') || rawHref.startsWith('#')) continue;

          const resolved = this.resolveUrl(origin, target.baseUrl, rawHref);
          if (resolved && isSameDomain(resolved, entryUrl) && !resolved.includes('#')) {
            if (!isNonContentLink(resolved, a)) {
              const linkText = extractLinkTextAndAlt(a) || new URL(resolved).pathname;
              if (!candidateUrls.has(resolved)) {
                candidateUrls.set(resolved, { linkText });
              }
            }
          }
        }

        // 2. [자바스크립트 라우트 자동 추출기] <script> 태그 및 외부 JS 파일(/js/url.js 등)의 라우트 파싱
        try {
          const jsHarvested = await harvestJavaScriptUrls(target.dom, target.baseUrl, origin, entryUrl);
          for (const [jUrl, jMeta] of jsHarvested.entries()) {
            if (!candidateUrls.has(jUrl)) {
              candidateUrls.set(jUrl, jMeta);
            }
          }
        } catch (je) {
          console.warn('[DetectEngine] JS 라우트 수집 경고:', je.message);
        }
      }

      // 3. [표준 XML 사이트맵 및 robots.txt 자동 탐색]
      try {
        const sitemapUrls = await fetchSitemapUrls(origin, entryUrl);
        for (const smUrl of sitemapUrls) {
          if (!candidateUrls.has(smUrl)) {
            candidateUrls.set(smUrl, { linkText: '사이트맵(XML)' });
          }
        }
      } catch (sme) {}

      // 4. [HTML 사이트맵 자동 수확]
      let htmlSitemapUrl = null;
      for (const [u, meta] of candidateUrls.entries()) {
        const pLower = new URL(u).pathname.toLowerCase();
        if (/sitemap/i.test(pLower) || /사이트맵|sitemap/i.test(meta.linkText)) {
          htmlSitemapUrl = u;
          break;
        }
      }
      if (htmlSitemapUrl && !this.hasVisitedOrExcludedUrl(htmlSitemapUrl)) {
        try {
          console.log('[DetectEngine] HTML 사이트맵 감지 -> 전수 메뉴 일괄 수확:', htmlSitemapUrl);
          const smResp = await fetch(htmlSitemapUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            signal: AbortSignal.timeout(4000)
          });
          if (smResp.ok) {
            const smHtml = await smResp.text();
            const smDom = htmlparser2.parseDocument(smHtml);
            const smLinks = domutils.findAll(el => el.type === 'tag' && el.name === 'a' && el.attribs && el.attribs.href, smDom.children);
            for (const sla of smLinks) {
              const slRes = this.resolveUrl(origin, htmlSitemapUrl, sla.attribs.href);
              if (slRes && isSameDomain(slRes, entryUrl) && !isNonContentLink(slRes, sla)) {
                if (!candidateUrls.has(slRes)) {
                  candidateUrls.set(slRes, { linkText: extractLinkTextAndAlt(sla) || '사이트맵메뉴' });
                }
              }
            }
          }
        } catch (hme) {}
      }

      // === 지능형 URL 씨드 수집 (신규 추가 블록) ===
      const crawlerCfg = crawlerConfig.getConfig();
      const domain = new URL(entryUrl).hostname.replace(/^www\./, '');
      const dorkEpicenterUrls = new Set();

      // [신규 0] 알려진 검색내용 활용 (DuckDuckGo Dorking 색인 역조회)
      if (crawlerCfg.useSearchDork) {
        try {
          let dorkUrls;
          if (this.session.knownSearchCompleted) {
            dorkUrls = new Map(this.session.knownSearchUrls.map(url => [url, {
              linkText: '[노출된 색인] 검색엔진 색인 URL',
              isDorkTarget: true,
              riskScore: 90
            }]));
            console.log(`[DetectEngine] Electron 브라우저 알려진 검색 결과: ${dorkUrls.size}개 URL 전달받음`);
          } else {
            const rawKeywords = process.env.SEARCH_DORK_KEYWORDS || '카톡,텔레';
            const keywords = rawKeywords.split(',').map(s => s.trim()).filter(Boolean);
            dorkUrls = await urlSeedCollector.fetchDuckDuckGoDorkUrls(domain, entryUrl, keywords, this.session.speedDelayMs);
          }
          for (const [dUrl, dMeta] of dorkUrls.entries()) {
            if (!candidateUrls.has(dUrl)) {
              candidateUrls.set(dUrl, dMeta);
            }
            dorkEpicenterUrls.add(dUrl);
            this.session.exposedIndexUrls.add(normalizeUrl(dUrl));
          }
        } catch (dorkErr) {
          console.warn('[DetectEngine] DuckDuckGo 색인 수집 오류:', dorkErr.message);
        }
      }

      // [신규 A] RSS/Atom 피드 URL 씨드 수집
      if (crawlerCfg.useRssFeed) {
        try {
          const rssUrls = await urlSeedCollector.fetchRssFeedUrls(origin, entryUrl);
          for (const [rUrl, rMeta] of rssUrls.entries()) {
            if (!candidateUrls.has(rUrl)) {
              candidateUrls.set(rUrl, rMeta);
            }
          }
        } catch (rssErr) {
          console.warn('[DetectEngine] RSS/Atom 수집 오류:', rssErr.message);
        }
      }

      // CMS 유형은 설치 안내에도 사용합니다.
      try {
        const detectedCms = cmsFingerprint.detectCmsType(rootHtml, currentTargetUrl);
        if (detectedCms) {
          this.session.detectedCms = detectedCms;
          console.log(`[DetectEngine] CMS 탐지 완료: ${detectedCms}`);
          if (crawlerCfg.useCmsVulnDict) {
            const vulnUrls = await cmsFingerprint.fetchCmsVulnUrls(detectedCms, origin);
            for (const [vUrl, vMeta] of vulnUrls.entries()) {
              if (!candidateUrls.has(vUrl)) {
                candidateUrls.set(vUrl, vMeta);
              }
            }
          }
        }
      } catch (cmsErr) {
        console.warn('[DetectEngine] CMS 지문 탐지 오류:', cmsErr.message);
      }

      // [신규 C] Common Crawl 역조회 (과거에 존재했던 URL 발굴)
      if (crawlerCfg.useCommonCrawl) {
        try {
          const ccUrls = await urlSeedCollector.fetchCommonCrawlUrls(domain, entryUrl);
          for (const [ccUrl, ccMeta] of ccUrls.entries()) {
            if (!candidateUrls.has(ccUrl)) {
              candidateUrls.set(ccUrl, ccMeta);
            }
          }
        } catch (ccErr) {
          console.warn('[DetectEngine] Common Crawl 조회 오류:', ccErr.message);
        }
      }

      // [신규 D] urlscan.io 히스토리 역조회
      if (crawlerCfg.useUrlscan) {
        try {
          const scanUrls = await urlSeedCollector.fetchUrlscanUrls(domain, entryUrl);
          for (const [scUrl, scMeta] of scanUrls.entries()) {
            if (!candidateUrls.has(scUrl)) {
              candidateUrls.set(scUrl, scMeta);
            }
          }
        } catch (scanErr) {
          console.warn('[DetectEngine] urlscan.io 조회 오류:', scanErr.message);
        }
      }

      // [신규 E] URL 무한증식 방지 정규화 (전체 candidateUrls 일괄 처리)
      const beforeCount = candidateUrls.size;
      const normalizedUrls = normalizeAndFilter(candidateUrls, crawlerCfg);
      // candidateUrls를 정규화된 맵으로 교체
      candidateUrls.clear();
      for (const [nUrl, nMeta] of normalizedUrls.entries()) {
        if (this.hasVisitedOrExcludedUrl(nUrl)) continue;
        candidateUrls.set(nUrl, nMeta);
      }
      console.log(`[DetectEngine] 지능형 URL 수집 완료: ${beforeCount}개 -> 정규화 후 ${candidateUrls.size}개 (CMS: ${this.session.detectedCms || '미탐지'})`);
      // === 지능형 URL 씨드 수집 종료 ===

      // 5. [사이트 구조 기반 2-Depth 네비게이션(LNB/서브메뉴) 다단계 병렬 확장]
      // 인위적 키워드 필터링 없이, URL의 구조적 디렉토리(1차 경로 세그먼트)별로 대표 허브 페이지를 선별하여 하위 메뉴를 전수 수확
      const sectionMap = new Map(); // sectionKey -> Array of URLs
      for (const [u, meta] of candidateUrls.entries()) {
        try {
          const uObj = new URL(u);
          const parts = uObj.pathname.split('/').filter(Boolean);
          // 1차 디렉토리(예: /company, /products) 또는 쿼리 파라미터를 기준으로 섹션 군집화
          let sectionKey = parts.length > 0 ? `/${parts[0]}` : '/';
          if (uObj.search) {
            const firstParam = uObj.searchParams.keys().next().value;
            if (firstParam) sectionKey += `?${firstParam}`;
          }
          if (!sectionMap.has(sectionKey)) {
            sectionMap.set(sectionKey, []);
          }
          sectionMap.get(sectionKey).push(u);
        } catch (e) {}
      }

      // 각 섹션별로 1~2개의 대표 URL을 균등 추출하여 최대 12개 주요 허브 페이지 확장
      const gnbCandidates = [];
      for (const [secKey, urls] of sectionMap.entries()) {
        gnbCandidates.push(urls[0]);
        if (urls.length > 1 && gnbCandidates.length < 12) {
          gnbCandidates.push(urls[1]);
        }
        if (gnbCandidates.length >= 12) break;
      }

      if (gnbCandidates.length > 0) {
        console.log(`[DetectEngine] 구조 기반 2-Depth 다단계 확장: 주요 섹션 대표 페이지 ${gnbCandidates.length}개 병렬 스캔...`);
        await Promise.allSettled(gnbCandidates.map(async (gnbUrl) => {
          try {
            const gResp = await fetch(gnbUrl, {
              headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
              signal: AbortSignal.timeout(4000)
            });
            if (!gResp.ok) return;
            const gHtml = await gResp.text();
            const gDom = htmlparser2.parseDocument(gHtml);
            const subLinks = domutils.findAll(el => el.type === 'tag' && el.name === 'a' && el.attribs && el.attribs.href, gDom.children);
            for (const sa of subLinks) {
              const saRes = this.resolveUrl(origin, gnbUrl, sa.attribs.href);
              if (saRes && isSameDomain(saRes, entryUrl) && !isNonContentLink(saRes, sa)) {
                if (!candidateUrls.has(saRes)) {
                  candidateUrls.set(saRes, { linkText: extractLinkTextAndAlt(sa) || '하위메뉴' });
                }
              }
            }
            // 하위 페이지 내 자바스크립트 라우트도 수집
            const gJs = await harvestJavaScriptUrls(gDom, gnbUrl, origin, entryUrl);
            for (const [gju, gjm] of gJs.entries()) {
              if (!candidateUrls.has(gju)) {
                candidateUrls.set(gju, gjm);
              }
            }
          } catch (ge) {}
        }));
      }

      console.log(`[DetectEngine] 1단계: 모던 수집 완료 (후보 링크 총 ${candidateUrls.size}개 확보), 유형 분류 시작...`);

      // 후보 링크 분류: 정적 페이지 후보, 게시판 후보, 일반 기타 링크
      const staticCandidates = [];
      const boardCandidates = [];
      const otherCandidates = [];

      for (const [url, meta] of candidateUrls.entries()) {
        if (url === entryUrl) continue;
        const urlObj = new URL(url);
        const path = urlObj.pathname.toLowerCase();
        const search = urlObj.search.toLowerCase();
        const text = (meta.linkText || '').toLowerCase();

        const isBoardLike = /\/(?:board|bbs|notice|news|press|blog|gallery|qna|faq|event|media|archive|data|list)\b/i.test(path) ||
                            /(?:[&?]|^)(?:page|pageid|page_id|p|board_id|bbs_id|mid|bo_table)=/i.test(search);

        const isStaticLike = /\/(?:intro|about|info|guide|map|location|history|greet|vision|organization|policy|privacy|terms|sitemap|clean|sub\d+|product|service|solution|business|company)\b/i.test(path) ||
                             /소개|연혁|오시는길|안내|개인정보|이용약관|조직도|사업|클린|제품|솔루션|서비스|고객/i.test(text);

        if (isBoardLike) {
          boardCandidates.push({ url, text: meta.linkText });
        } else if (isStaticLike) {
          staticCandidates.push({ url, text: meta.linkText });
        } else {
          otherCandidates.push({ url, text: meta.linkText });
        }
      }

      this.session.planningProgress = '50%';
      this.session.currentStep = `탐지 계획 수립 중: 게시판 규격 및 전체 페이지 수 조사 중 (후보 ${boardCandidates.length}개)...`;

      // 확보한 게시판 후보를 버리지 않고 설정된 전체 탐색 한도 안에서 고속 검사
      const candidateList = boardCandidates.slice(0, this.session.maxPages);
      const confirmedBoardCandidateUrls = new Set();
      const batchSize = 8;
      for (let i = 0; i < candidateList.length; i += batchSize) {
        const batch = candidateList.slice(i, i + batchSize);
        await Promise.allSettled(batch.map(async (item) => {
          try {
            const resp = await fetch(item.url, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml',
                'Cache-Control': 'no-cache'
              },
              signal: AbortSignal.timeout(4000)
            });
            if (!resp.ok) return;
            const htmlText = await resp.text();
            const subDom = htmlparser2.parseDocument(htmlText);

            if (!isArticleDetailPageUrl(item.url) && isBoardListPage(subDom, item.url)) {
              const spec = extractBoardSpec(subDom, item.url);
              if (spec && !this.session.discoveredBoards.has(spec.baseKey)) {
                this.session.discoveredBoards.set(spec.baseKey, {
                  ...spec,
                  title: item.text || spec.baseKey,
                  sampleUrl: item.url,
                  hasAuthoringControl: hasBoardAuthoringControl(subDom)
                });
                console.log(`[DetectEngine] 신규 게시판 식별 성공: ${spec.baseKey} (전체 ${spec.totalPage}페이지)`);
              }
              confirmedBoardCandidateUrls.add(normalizeUrl(item.url));
            }
          } catch (e) {}
        }));
      }

      this.session.planningProgress = '80%';

      // 확보된 URL은 버리지 않고 경로 구간별로 순환 배치하여 사이트 전체 폭을 먼저 확보
      const totalBuffer = this.session.articleBufferCap;
      const allDiscoveryTargets = [
        ...staticCandidates.map(item => ({ ...item, kind: 'content' })),
        ...otherCandidates.map(item => ({ ...item, kind: 'content' })),
        ...boardCandidates.map(item => ({ ...item, kind: 'board' }))
      ];
      const existingQueueUrls = new Set(this.session.contentQueue.map(q => normalizeUrl(q.url)));

      // 0. 노출된 색인(DuckDuckGo 색인) URL 최우선 배치 (Index 0부터 크롤링 시작)
      for (const dUrl of dorkEpicenterUrls) {
        const dorkKey = normalizeUrl(dUrl);
        if (!existingQueueUrls.has(dorkKey) && !this.hasVisitedOrExcludedUrl(dorkKey)) {
          existingQueueUrls.add(dorkKey);
          try {
            const duObj = new URL(dUrl);
            this.session.contentQueue.unshift({
              url: dUrl,
              depth: 1,
              parentUid: 'node_1',
              pathSegment: `[노출된 색인] ${duObj.pathname}${duObj.search || ''}`,
              isArticle: false,
              isDorkEpicenter: true,
              title: '[노출된 색인] 검색엔진 색인 URL'
            });
            console.log(`[DetectEngine] 노출된 색인 URL 최우선 큐 배치: ${dUrl}`);
          } catch (e) {}
        }
      }

      const uniqueDiscoveryTargets = [];
      for (const target of allDiscoveryTargets) {
        const targetKey = normalizeUrl(target.url);
        if (existingQueueUrls.has(targetKey)) continue;
        try {
          const uObj = new URL(target.url);
          const parts = uObj.pathname.split('/').filter(Boolean);
          const sectionKey = parts.length > 0 ? parts[0] : 'root';
          uniqueDiscoveryTargets.push({ ...target, sectionKey });
          existingQueueUrls.add(targetKey);
        } catch (e) {}
      }

      const fairDiscoveryTargets = roundRobinByKey(uniqueDiscoveryTargets, item => item.sectionKey);
      const discoveryLimit = Math.min(this.session.maxPages, fairDiscoveryTargets.length);
      for (let i = 0; i < discoveryLimit; i++) {
        const target = fairDiscoveryTargets[i];
        try {
          const uObj = new URL(target.url);
          this.session.contentQueue.push({
            url: target.url,
            depth: 1,
            parentUid: 'node_1',
            pathSegment: uObj.pathname + (uObj.search ? uObj.search : ''),
            isArticle: false,
            isBoardList: target.kind === 'board' && confirmedBoardCandidateUrls.has(normalizeUrl(target.url)),
            title: target.text || uObj.pathname
          });
        } catch (e) {}
      }

      // 2. 전체 버퍼 중 정적 콘텐츠를 제외한 잔여 버퍼를 게시판에 배분
      const totalBoards = this.session.discoveredBoards.size;
      const boardBuffer = Math.max(50, totalBuffer - this.session.contentQueue.length);
      let totalBoardStratifiedPages = 0;
      let totalBoardPlannedVisits = 0;
      const plannedBoardItems = [];
      const reserveBoardItems = [];
      const plannedArticleItems = [];
      const plannedArticleKeys = new Set();
      const boardSampleLimitByUrl = new Map();

      if (totalBoards > 0) {
        const sumTotalPages = Array.from(this.session.discoveredBoards.values())
          .reduce((sum, s) => sum + Math.max(1, s.totalPage || 1), 0);

        console.log(`[DetectEngine] 1단계 배분 수립: 총 버퍼 ${totalBuffer}p (정적 ${this.session.contentQueue.length}p 배정, 잔여 게시판 버퍼 ${boardBuffer}p, 총 게시판 합산 ${sumTotalPages}p)`);

        for (const [baseKey, spec] of this.session.discoveredBoards.entries()) {
          const boardTotal = Math.max(1, spec.totalPage || 1);
          const ratio = boardTotal / Math.max(1, sumTotalPages);

          const isDorkBoard = isExposedIndexBoard(spec, dorkEpicenterUrls, origin);
          const hasAuthoring = Boolean(spec.hasAuthoringControl);
          const priorityWeight = getBoardPriorityWeight(isDorkBoard, hasAuthoring);
          const baseAllocatedBudget = Math.max(5, Math.floor(boardBuffer * ratio));
          const weightedBudget = applyBoardPriorityWeight(baseAllocatedBudget, priorityWeight);
          const maxBoardQuota = Math.max(10, Math.floor(boardBuffer * Math.min(1, 0.30 * priorityWeight)));
          const allocatedBudget = Math.min(maxBoardQuota, weightedBudget);
          const samplingPlan = planBoardSampling(boardTotal, allocatedBudget);
          const postsPerList = samplingPlan.postsPerList;
          const stratifiedPages = generateStratifiedPages(spec, samplingPlan.listPageCount);
          const remainingPages = generateRemainingBoardPages(
            spec,
            stratifiedPages.map(page => page.pageNum),
            this.session.maxPages
          );
          totalBoardStratifiedPages += stratifiedPages.length;
          totalBoardPlannedVisits += samplingPlan.plannedVisits;

          console.log(` -> [게시판 계획] ${baseKey}: 총 ${boardTotal}p, 기본 ${baseAllocatedBudget}건, 가중치 ${priorityWeight}, 배분 ${allocatedBudget}건, 목록 ${stratifiedPages.length}p, 목록당 게시물 최대 ${postsPerList}건`);
          logWrite(config.paths.logsDir, {
            event: 'board_page_sample',
            boardKey: baseKey,
            totalPages: boardTotal,
            sampledPages: stratifiedPages.map(item => item.pageNum)
          });

          // 표본 목록은 경량 요청으로 먼저 읽어 게시물 주소를 검사 시작 전에 확보
          for (let offset = 0; offset < stratifiedPages.length; offset += batchSize) {
            if (Date.now() >= this.session.planningDeadlineAtMs) break;
            const scoutBatch = stratifiedPages.slice(offset, offset + batchSize);
            await Promise.allSettled(scoutBatch.map(async pageInfo => {
              if (Date.now() >= this.session.planningDeadlineAtMs) return;
              try {
                const response = await fetch(pageInfo.url, {
                  headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml',
                    'Cache-Control': 'no-cache'
                  },
                  signal: AbortSignal.timeout(4000)
                });
                if (!response.ok) return;
                const pageDom = htmlparser2.parseDocument(await response.text());
                const anchors = domutils.findAll(
                  el => el.type === 'tag' && el.name === 'a' && el.attribs && el.attribs.href,
                  pageDom.children
                );
                for (const anchor of anchors) {
                  const articleUrl = this.resolveUrl(origin, pageInfo.url, anchor.attribs.href);
                  if (!articleUrl || !isSameDomain(articleUrl, entryUrl) ||
                      !isArticleDetailLink(anchor, pageDom, articleUrl) || isNonContentLink(articleUrl, anchor)) {
                    continue;
                  }
                  const articleKey = normalizeUrl(articleUrl);
                  if (plannedArticleKeys.has(articleKey)) continue;
                  plannedArticleKeys.add(articleKey);
                  const articleUrlObj = new URL(articleUrl);
                  plannedArticleItems.push({
                    url: articleUrl,
                    depth: 2,
                    parentUid: 'node_1',
                    pathSegment: articleUrlObj.pathname + articleUrlObj.search,
                    isArticle: true,
                    boardKey: baseKey
                  });
                }
              } catch (e) {}
            }));
          }

          for (const sp of stratifiedPages) {
            const queueItem = {
              url: sp.url,
              depth: 1,
              parentUid: 'node_1',
              pathSegment: `[P.${sp.pageNum}] ${new URL(sp.url).pathname}`,
              isBoardList: true,
              boardKey: baseKey,
              pageNum: sp.pageNum,
              samplePostsLimit: postsPerList,
              isDorkEpicenter: isDorkBoard,
              hasAuthoringControl: hasAuthoring,
              boardPriorityWeight: priorityWeight
            };
            plannedBoardItems.push(queueItem);
            boardSampleLimitByUrl.set(normalizeUrl(sp.url), postsPerList);
          }

          for (const rp of remainingPages) {
            reserveBoardItems.push({
              url: rp.url,
              depth: 1,
              parentUid: 'node_1',
              pathSegment: `[정밀 P.${rp.pageNum}] ${new URL(rp.url).pathname}`,
              isBoardList: true,
              isReserve: true,
              boardKey: baseKey,
              pageNum: rp.pageNum
            });
          }
        }
        this.session.boardPageQueue = roundRobinByKey(plannedBoardItems, item => item.boardKey);
        this.session.reserveBoardPageQueue = roundRobinByKey(reserveBoardItems, item => item.boardKey)
          .slice(0, this.session.maxPages);
        this.session.articleQueue = roundRobinByKey(plannedArticleItems, item => item.boardKey)
          .slice(0, this.session.articleBufferCap);

        // 같은 게시판 URL이 일반 대기열에서 먼저 실행되더라도 계산된 게시물 수를 동일하게 적용
        for (const item of this.session.contentQueue) {
          const plannedSampleLimit = boardSampleLimitByUrl.get(normalizeUrl(item.url));
          if (plannedSampleLimit) {
            item.isBoardList = true;
            item.samplePostsLimit = Math.max(item.samplePostsLimit || 0, plannedSampleLimit);
          }
        }
      }

      this.session.planningProgress = '100%';
      const expectedTotal = this.session.contentQueue.length + totalBoardPlannedVisits + this.session.articleQueue.length;
      this.session.targetPlanCount = Math.max(expectedTotal, 1);
      this.session.currentStep = `탐지 계획 수립 완료: URL ${this.session.contentQueue.length}개, 게시판 ${totalBoards}개, 게시물 ${this.session.articleQueue.length}개 사전 확보`;
      console.log(`[DetectEngine] 1단계 계획 수립 완료: URL ${this.session.contentQueue.length}개, 표본 목록 ${totalBoardStratifiedPages}쪽, 게시물 ${this.session.articleQueue.length}개 사전 확보`);
    } catch (err) {
      console.warn('[DetectEngine] 탐지 계획 수립 예외 (기본 크롤링으로 폴백):', err.message);
    }
  }

  // HTML DOM에서 사이트 메타 타이틀 추출 (og:title, title, og:site_name 등)
  extractSiteTitle(dom, fallback = '') {
    if (!dom || !dom.children) return fallback;
    try {
      // 1. og:title 메타태그 확인
      const ogTitleMeta = domutils.findOne(
        el => el.type === 'tag' && el.name === 'meta' && el.attribs && (
          el.attribs.property === 'og:title' || el.attribs.name === 'og:title' || el.attribs.name === 'twitter:title' || el.attribs.name === 'title'
        ) && el.attribs.content,
        dom.children
      );
      let candidate = ogTitleMeta ? ogTitleMeta.attribs.content.trim() : '';

      // 2. <title> 태그 확인
      if (!candidate) {
        const titleElem = domutils.findOne(el => el.type === 'tag' && el.name === 'title', dom.children);
        if (titleElem) {
          candidate = domutils.getText(titleElem).trim();
        }
      }

      // 3. og:site_name 메타태그 보조 확인
      if (!candidate) {
        const siteNameMeta = domutils.findOne(
          el => el.type === 'tag' && el.name === 'meta' && el.attribs && (
            el.attribs.property === 'og:site_name' || el.attribs.name === 'og:site_name'
          ) && el.attribs.content,
          dom.children
        );
        if (siteNameMeta) {
          candidate = siteNameMeta.attribs.content.trim();
        }
      }

      if (candidate) {
        // 제어문자 및 연속 공백 정리
        candidate = candidate.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
        return candidate || fallback;
      }
    } catch (e) {}
    return fallback;
  }

  // 시작 화면의 제목, 소개, 주요 메뉴만 모아 사이트 성격 판단 자료로 사용한다.
  extractSiteProfile(dom, siteTitle = '') {
    if (!dom || !dom.children) return String(siteTitle || '').trim();

    const clean = value => String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
    const parts = [];
    const append = (label, value) => {
      const text = clean(value);
      if (text) parts.push(label + ': ' + text);
    };

    append('사이트명', siteTitle);

    const descriptionMeta = domutils.findOne(
      el => el.type === 'tag' && el.name === 'meta' && el.attribs &&
        /^(?:description|og:description|twitter:description)$/i.test(String(el.attribs.name || el.attribs.property || '')) &&
        el.attribs.content,
      dom.children
    );
    if (descriptionMeta) append('소개', descriptionMeta.attribs.content);

    const navigationRoots = domutils.findAll(
      el => el.type === 'tag' && (el.name === 'header' || el.name === 'nav'),
      dom.children
    );
    const menuTexts = [];
    for (const navigationRoot of navigationRoots) {
      const links = domutils.findAll(el => el.type === 'tag' && el.name === 'a', navigationRoot.children || []);
      for (const link of links) {
        const text = clean(domutils.getText(link));
        if (text.length >= 2 && text.length <= 30 && !menuTexts.includes(text)) menuTexts.push(text);
        if (menuTexts.length >= 8) break;
      }
      if (menuTexts.length >= 8) break;
    }
    if (menuTexts.length) append('메뉴', menuTexts.join(', '));

    return parts.join(' | ').slice(0, 360);
  }

  getStatus() {
    const visited = this.session.visitedUrls ? this.session.visitedUrls.size : 0;
    const queued = (this.session.contentQueue ? this.session.contentQueue.length : 0) +
                   (this.session.articleQueue ? this.session.articleQueue.length : 0) +
                   (this.session.boardPageQueue ? this.session.boardPageQueue.length : 0) +
                   (this.session.reserveBoardPageQueue ? this.session.reserveBoardPageQueue.length : 0) +
                   (this.session.reserveArticleQueue ? this.session.reserveArticleQueue.length : 0);
    const bufferCap = this.session.articleBufferCap || 1800;
    const dynamicPlanCount = Math.min(bufferCap, Math.max(this.session.targetPlanCount || 0, visited + queued));

    return {
      masterId: this.session.masterId,
      masterTitle: this.session.masterTitle,
      siteProfile: this.session.siteProfile || '',
      detectedCms: this.session.detectedCms || null,
      entryUrl: this.session.entryUrl,
      status: this.session.status,
      phase: this.session.phase,
      planningProgress: this.session.planningProgress || '',
      targetPlanCount: dynamicPlanCount,
      remainingQueueCount: queued,
      startedAt: this.session.startedAt,
      finishedAt: this.session.finishedAt,
      elapsedSec: this.session.elapsedSec,
      currentUrl: this.session.currentUrl,
      currentStep: this.session.currentStep,
      speedDelayMs: this.session.speedDelayMs,
      maxPages: this.session.maxPages,
      maxTimeSec: this.session.maxTimeSec,
      resultReserveSec: this.session.resultReserveSec || 90,
      observedPageMs: this.session.observedPageMs || 0,
      adaptivePageLimit: this.session.adaptivePageLimit || this.session.estimatedTotalPages || 0,
      totalVisited: visited,
      excludedHistoryUrlCount: this.session.excludedUrlKeys ? this.session.excludedUrlKeys.size : 0,
      articleBufferCap: this.session.articleBufferCap || 1800,
      contentQueueCount: this.session.contentQueue ? this.session.contentQueue.length : 0,
      articleQueueCount: this.session.articleQueue ? this.session.articleQueue.length : 0,
      reserveBoardPageQueueCount: this.session.reserveBoardPageQueue ? this.session.reserveBoardPageQueue.length : 0,
      reserveArticleQueueCount: this.session.reserveArticleQueue ? this.session.reserveArticleQueue.length : 0,
      precisionMode: Boolean(this.session.precisionMode),
      discoveredBoardsCount: this.session.discoveredBoards ? this.session.discoveredBoards.size : 0,
      visitedContentCount: this.session.visitedContentCount || 0,
      visitedArticleCount: this.session.visitedArticleCount || 0,
      articleQuota: this.session.articleQuota || 0,
      contentQuota: this.session.contentQuota || 0,
      estimatedTotalPages: this.session.estimatedTotalPages || 0,
      violationCount: this.session.findings ? this.session.findings.length : 0,
      treeNodesCount: this.session.treeNodes ? this.session.treeNodes.length : 0,
      recentNodes: this.session.treeNodes ? this.session.treeNodes.slice(-10) : [],
      findings: this.session.findings || [],
      tempPollutedKeywords: (this.session && this.session.tempPollutedKeywords) || [],
      tempAllowedKeywords: (this.session && this.session.tempAllowedKeywords) || []
    };
  }

  hasVisitedOrExcludedUrl(url) {
    try {
      const key = normalizeUrl(String(url || ''));
      return Boolean(
        (this.session.visitedUrls && this.session.visitedUrls.has(key)) ||
        (this.session.excludedUrlKeys && this.session.excludedUrlKeys.has(key))
      );
    } catch (e) {
      return false;
    }
  }

  async pause() {
    if (this.session.status === 'RUNNING') {
      this.session.status = 'PAUSED';
      this.session.currentStep = '점검 일시 중지';
      if (this.session.masterId) {
        await commonDAO.execute_query('detectMapper.updateDetectMasterStatus', {
          id: this.session.masterId,
          status: 'PAUSED'
        });
      }
      return true;
    }
    return false;
  }

  async resume() {
    if (this.session.status === 'PAUSED') {
      this.session.status = 'RUNNING';
      this.session.currentStep = '점검 재개';
      if (this.session.masterId) {
        await commonDAO.execute_query('detectMapper.updateDetectMasterStatus', {
          id: this.session.masterId,
          status: 'RUNNING'
        });
      }
      return true;
    }
    return false;
  }

  async stop() {
    if (this.session && (this.session.status === 'RUNNING' || this.session.status === 'PAUSED' || this.session.status === 'PLANNING')) {
      this.session.status = 'STOPPED';
      this.session.currentStep = '점검 사용자에 의해 중단됨';
      if (this.session.timerId) clearInterval(this.session.timerId);
      await this.finalizeSession('STOPPED');
      return true;
    }
    return false;
  }

  async start(entryUrl, options = {}) {
    const trimmedUrl = String(entryUrl || '').trim();
    if (!trimmedUrl.startsWith('http://') && !trimmedUrl.startsWith('https://')) {
      throw new Error('올바른 웹사이트 URL을 입력해 주세요.');
    }

    const requiredAiModels = [
      ['AI_SIMILARITY_MODEL', aiModelConfig.similarity && aiModelConfig.similarity.modelId],
      ['AI_LLM_MODEL', aiModelConfig.llm && aiModelConfig.llm.modelId]
    ];
    const missingAiModels = requiredAiModels.filter(([, modelId]) => !String(modelId || '').trim()).map(([name]) => name);
    if (missingAiModels.length > 0) {
      throw new Error(`AI 모델이 지정되지 않았습니다: ${missingAiModels.join(', ')}`);
    }

    if (this.workflowPromise) {
      console.log('[DetectEngine] 이전 점검 작업 종료 대기 후 새 세션 시작');
      this.session.status = 'STOPPED';
      if (this.session.timerId) clearInterval(this.session.timerId);
      const previousWorkflow = this.workflowPromise;
      try {
        await previousWorkflow;
      } catch (e) {
        console.warn('[DetectEngine] 이전 점검 작업 종료 중 오류:', e.message);
      }
      if (this.workflowPromise === previousWorkflow) {
        this.workflowPromise = null;
      }
    }

    const sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.currentSessionId = sessionId;
    this.invalidateCleanroomPatternCache();

    const speedDelayMs = Number(options.speedDelayMs) || 500;
    const maxPages = Number(options.maxPages) || 5000;
    // 점검 시간 설정: 디폴트 30분(1800초), 최대 1시간(3600초) 지원
    let maxTimeSec = Number(options.maxTimeSec) || 1800;
    if (maxTimeSec > 3600) {
      maxTimeSec = 3600;
    }

    const resultReserveSec = 90;
    const scanTimeSec = Math.max(60, maxTimeSec - resultReserveSec);
    // 결과 정리 시간을 제외한 순수 탐지 시간으로 최초 계획을 세우고 실행 중 실측 속도로 계속 보정
    const { targetPageBudget: dynamicPageLimit, maxDepth: dynamicMaxDepth } = calculateDynamicBudget(scanTimeSec, speedDelayMs);
    const estimatedTotalPages = Math.min(maxPages, dynamicPageLimit);

    // 시간에 맞게 버퍼 한도 및 게시물/콘텐츠 쿼터 동적 산출
    const articleBufferCap = estimatedTotalPages;
    const contentQuota = Math.max(20, Math.floor(estimatedTotalPages * 0.25));
    const articleQuota = Math.max(20, estimatedTotalPages - contentQuota);

    const entryUrlKey = normalizeUrl(trimmedUrl);
    const excludedUrlKeys = new Set();
    for (const candidate of Array.isArray(options.excludedHistoryUrls) ? options.excludedHistoryUrls : []) {
      try {
        const resolved = resolveCrawlUrl(String(candidate), trimmedUrl);
        if (!isSameDomain(resolved, trimmedUrl)) continue;
        const key = normalizeUrl(resolved);
        if (key && key !== entryUrlKey) excludedUrlKeys.add(key);
      } catch (e) {}
    }

    const knownSearchUrls = [];
    const knownSearchKeys = new Set();
    for (const candidate of Array.isArray(options.knownSearchUrls) ? options.knownSearchUrls : []) {
      try {
        const resolved = resolveCrawlUrl(String(candidate), trimmedUrl);
        if (!isSameDomain(resolved, trimmedUrl)) continue;
        const key = normalizeUrl(resolved);
        if (knownSearchKeys.has(key) || excludedUrlKeys.has(key)) continue;
        knownSearchKeys.add(key);
        knownSearchUrls.push(resolved);
      } catch (e) {}
      if (knownSearchUrls.length >= 200) break;
    }

    console.log(`[DetectEngine] 점검 스케줄 계산: 전체=${maxTimeSec}초, 탐지=${scanTimeSec}초, 결과정리=${resultReserveSec}초, 최초 버퍼=${articleBufferCap}p (Depth한도=${dynamicMaxDepth})`);

    // 세션 초기화 (1단계: 탐지 계획 수립 상태로 시작, DB 저장은 2단계에서 개시)
    const startedAtMs = Date.now();
    const nowIso = new Date(startedAtMs).toISOString();
    this.session = {
      sessionId,
      masterId: null,
      masterTitle: null,
      siteProfile: '',
      entryUrl: trimmedUrl,
      status: 'PLANNING',  // 1단계 탐지 계획 수립 상태로 시작
      phase: 'PLANNING',
      startedAt: nowIso,
      startedAtMs,
      finishedAt: null,
      elapsedSec: 0,
      currentUrl: trimmedUrl,
      currentStep: '탐지 계획 수립 중: 사이트 전체 메뉴 및 게시판 구조 분석...',
      planningProgress: '사전 탐색 중',
      dynamicMaxDepth,
      targetPlanCount: articleBufferCap,
      speedDelayMs,
      maxPages,
      maxTimeSec,
      resultReserveSec,
      scanDeadlineAtMs: startedAtMs + Math.max(0, maxTimeSec - resultReserveSec) * 1000,
      planningDeadlineAtMs: startedAtMs + Math.max(15000, scanTimeSec * 100) ,
      pageDurationSamples: [],
      observedPageMs: 0,
      adaptivePageLimit: estimatedTotalPages,
      schedulerCursor: 0,
      visitedUrls: new Set(),
      excludedUrlKeys,
      exposedIndexUrls: new Set(),
      nonstandardPortFindingUrls: new Set(),
      reflectionProbeSignatures: new Set(),
      reflectionCheckedBoardKeys: new Set(),
      siteSearchProbeDone: false,
      excludeHistoryMasterId: options.excludeHistoryMasterId || null,
      contentQueue: [],  // 일반 콘텐츠 대기열
      articleQueue: [],  // 게시물 본문 대기열
      reserveBoardPageQueue: [],  // 기본 탐색에서 선택하지 않은 게시판 쪽
      reserveArticleQueue: [],    // 기본 탐색에서 선택하지 않은 게시물
      knownSearchUrls,
      knownSearchCompleted: options.knownSearchCompleted === true,
      precisionMode: false,
      urlQueue: [],      // 실시간 UI 연동 대기열
      discoveredBoards: new Map(), // 발견된 게시판 목록 (Base URL -> Spec)
      boardPageQueue: [],          // 전 구간 층화 샘플링된 게시판 목록 페이지 큐
      boardListVisitCountMap: new Map(), // 게시판 식별키별 목록 페이지 방문 누적 수
      articleBufferCap,
      estimatedTotalPages,
      contentQuota,
      articleQuota,
      visitedContentCount: 0,
      visitedArticleCount: 0,
      treeNodes: [],
      findings: [],
      tempPollutedKeywords: Array.isArray(options.tempPollutedKeywords)
        ? options.tempPollutedKeywords.map(k => String(k || '').trim()).filter(Boolean)
        : [],
      tempAllowedKeywords: Array.isArray(options.tempAllowedKeywords)
        ? options.tempAllowedKeywords.map(k => String(k || '').trim()).filter(Boolean)
        : [],
      timerId: null
    };

    // 소요시간 타이머 시작
    this.session.timerId = setInterval(() => {
      if (this.currentSessionId === sessionId && (this.session.status === 'RUNNING' || this.session.status === 'PLANNING')) {
        this.session.elapsedSec = Math.max(0, Math.floor((Date.now() - this.session.startedAtMs) / 1000));
      }
    }, 1000);

    // 백그라운드 크롤링 및 탐지 비동기 구동 (고유 sessionId 전달)
    const workflowPromise = this.runInspectionWorkflow(sessionId);
    this.workflowPromise = workflowPromise;
    workflowPromise.catch(err => {
      if (this.currentSessionId === sessionId) {
        console.error('[DetectEngine Workflow Error]', err);
        this.session.status = 'STOPPED';
        this.session.currentStep = '점검 중단: ' + err.message;
      }
    }).finally(() => {
      if (this.workflowPromise === workflowPromise) {
        this.workflowPromise = null;
      }
    });

    return this.getStatus();
  }

  async runInspectionWorkflow(sessionId) {
    const entryUrl = this.session.entryUrl;
    const urlObj = new URL(entryUrl);
    const origin = urlObj.origin;

    // 루트 URL 콘텐츠 큐 삽입
    this.session.contentQueue.push({
      url: entryUrl,
      depth: 0,
      parentUid: null,
      pathSegment: urlObj.pathname || '/',
      isArticle: false
    });

    // [1단계: 사전 탐색 및 계획 수립 단계 실행]
    // 브라우저를 띄우지 않고, DB 저장도 하지 않은 채로 사이트 구조와 메뉴를 고속 탐색하여 배분 계획 수립
    await this.scoutAndPlanSite(entryUrl, origin);

    // 탐지 계획 수립 도중 중단 요청이 있었으면 즉시 종료
    if (this.currentSessionId !== sessionId || this.session.sessionId !== sessionId || this.session.status === 'STOPPED') {
      return;
    }

    // [2단계: 본격 정밀 검출 및 DB 저장 시작 단계]
    // 계획 수립 완료 후 DB 마스터 레코드 생성 및 실시간 검출/저장 개시
    this.session.status = 'RUNNING';
    this.session.phase = 'RUNNING';
    this.session.currentStep = '정밀 검출 및 저장 시작...';

    try {
      const insertRes = await commonDAO.execute_query('detectMapper.insertDetectMaster', {
        entry_url: entryUrl,
        title: this.session.masterTitle || entryUrl,
        started_at: this.session.startedAt,
        tool_version: '1.0.0'
      });
      if (insertRes && insertRes.info && insertRes.info.insertId) {
        this.session.masterId = insertRes.info.insertId;
        if (this.session.detectedCms) {
          await commonDAO.execute_query('detectMapper.updateDetectMasterCms', {
            id: this.session.masterId,
            detected_cms: this.session.detectedCms
          });
        }
        console.log(`[DetectEngine] 2단계 진입: DB 마스터 레코드 생성 완료 (ID=${this.session.masterId})`);
      }
    } catch (dbErr) {
      console.error('[DetectEngine] Master Insert Error:', dbErr.message);
    }

    this.session.urlQueue = [
      ...this.session.boardPageQueue,
      ...this.session.contentQueue,
      ...this.session.articleQueue,
      ...this.session.reserveBoardPageQueue,
      ...this.session.reserveArticleQueue
    ];

    let nodeSequence = 1;

    while (
      this.session.contentQueue.length > 0 ||
      this.session.articleQueue.length > 0 ||
      this.session.boardPageQueue.length > 0 ||
      this.session.reserveBoardPageQueue.length > 0 ||
      this.session.reserveArticleQueue.length > 0
    ) {
      // 0. 고유 세션 유효성 검사 (새 점검 시작 또는 중단 시 이전 루프 즉시 소멸)
      if (this.currentSessionId !== sessionId || this.session.status === 'STOPPED') {
        console.log(`[DetectEngine] 세션 만료 또는 중단으로 크롤링 루프 즉각 종료 (${sessionId})`);
        break;
      }

      // 결과 정리 및 파일 저장을 위한 90초를 남기고 탐색 종료
      const fallbackPageMs = Math.max(2000, this.session.speedDelayMs + 1500);
      const expectedPageMs = conservativePageDurationMs(this.session.pageDurationSamples, fallbackPageMs);
      if (Date.now() + expectedPageMs >= this.session.scanDeadlineAtMs) {
        this.session.endedForResultReserve = true;
        console.log(`[DetectEngine] 결과 정리 시간 ${this.session.resultReserveSec}초 확보를 위해 탐색 종료: 탐색 ${this.session.visitedUrls.size}페이지 완료`);
        break;
      }
      // 2. 최대 페이지 수 상한 도달 시 종료
      if (this.session.visitedUrls.size >= this.session.maxPages) {
        console.log(`[DetectEngine] 최대 탐색 페이지 한도(${this.session.maxPages}건) 도달로 종료`);
        break;
      }

      // 일시 정지 상태 처리
      while (this.session.status === 'PAUSED') {
        await sleep(400);
      }
      if (this.session.status === 'STOPPED' || this.currentSessionId !== sessionId) {
        break;
      }

      const hasPrimaryWork = this.session.contentQueue.length > 0 ||
        this.session.boardPageQueue.length > 0 ||
        this.session.articleQueue.length > 0;
      if (!hasPrimaryWork && !this.session.precisionMode) {
        this.session.precisionMode = true;
        this.session.schedulerCursor = 0;
        console.log(`[DetectEngine] 기본 탐색 완료, 남은 시간 정밀 탐색 시작: 목록 ${this.session.reserveBoardPageQueue.length}p, 게시물 ${this.session.reserveArticleQueue.length}건`);
        logWrite(config.paths.logsDir, {
          event: 'precision_crawl_started',
          masterId: this.session.masterId,
          reserveBoardPages: this.session.reserveBoardPageQueue.length,
          reserveArticles: this.session.reserveArticleQueue.length,
          remainingScanSec: Math.max(0, Math.floor((this.session.scanDeadlineAtMs - Date.now()) / 1000))
        });
      }

      // 기본 탐색이 끝나면 보관한 게시판 쪽과 게시물을 순서대로 정밀 검사
      let currentItem = null;
      const queueNames = hasPrimaryWork
        ? ['contentQueue', 'boardPageQueue', 'articleQueue']
        : ['reserveBoardPageQueue', 'reserveArticleQueue'];
      for (let offset = 0; offset < queueNames.length; offset++) {
        const index = (this.session.schedulerCursor + offset) % queueNames.length;
        const queueName = queueNames[index];
        if (this.session[queueName].length > 0) {
          currentItem = this.session[queueName].shift();
          this.session.schedulerCursor = (index + 1) % queueNames.length;
          break;
        }
      }

      if (!currentItem) {
        break;
      }
      this.session.urlQueue = [
        ...this.session.boardPageQueue,
        ...this.session.contentQueue,
        ...this.session.articleQueue,
        ...this.session.reserveBoardPageQueue,
        ...this.session.reserveArticleQueue
      ];

      const currentUrl = resolveCrawlUrl(currentItem.url, entryUrl);
      const currentVisitKey = normalizeUrl(currentUrl);
      currentItem.url = currentUrl;

      // 타 도메인 격리 방어선: 시작 URL과 호스트가 다르면 절대 방문하지 않고 폐기
      if (!isSameDomain(currentUrl, entryUrl)) {
        continue;
      }

      // 이미 방문한 URL 스킵
      if (this.hasVisitedOrExcludedUrl(currentVisitKey)) {
        continue;
      }
      this.session.visitedUrls.add(currentVisitKey);
      const pageStartedAtMs = Date.now();
      if (currentItem.isArticle) {
        this.session.visitedArticleCount = (this.session.visitedArticleCount || 0) + 1;
      } else {
        this.session.visitedContentCount = (this.session.visitedContentCount || 0) + 1;
      }

      this.session.currentUrl = currentUrl;
      const remainSec = Math.max(0, Math.floor((this.session.scanDeadlineAtMs - Date.now()) / 1000));
      const remainMin = Math.floor(remainSec / 60);
      const remainSecPart = String(remainSec % 60).padStart(2, '0');
      const itemTypeLabel = currentItem.isArticle ? '게시물' : (currentItem.isBoardList ? '게시판목록' : '콘텐츠');
      const phaseLabel = this.session.precisionMode ? '정밀 탐색' : '기본 탐색';
      this.session.currentStep = `[${phaseLabel} | ${this.session.visitedUrls.size}p (게시물 ${this.session.visitedArticleCount} / 일반 ${this.session.visitedContentCount}) | 남은시간 ${remainMin}:${remainSecPart}] ${itemTypeLabel} 분석: ${currentItem.pathSegment}`;

      const nodeUid = `node_${nodeSequence++}`;
      let pageTitle = currentItem.pathSegment;
      let httpStatus = 200;
      let pageHtml = '';
      let pageFindings = [];
      const cleanroom = await this.loadCleanroomPatterns();
      const { pollutedPatterns, suspectPatterns, exceptionPatterns, memoMap, requiredTermsMap } = cleanroom;

      const currentUrlKey = normalizeUrl(currentUrl);
      const nonstandardPort = getNonstandardPort(currentUrl);
      if (nonstandardPort && this.session.exposedIndexUrls.has(currentUrlKey) &&
          !this.session.nonstandardPortFindingUrls.has(currentUrlKey)) {
        this.session.nonstandardPortFindingUrls.add(currentUrlKey);
        const reason = `노출된 색인에서 비표준 포트 ${nonstandardPort} 사용 URL 발견`;
        pageFindings.push({
          id: `f_${String(this.session.findings.length + pageFindings.length + 1).padStart(3, '0')}`,
          url: currentUrl,
          is_violation: true,
          location: '노출된 색인 URL',
          evidence_text: currentUrl,
          technique: 'NONSTANDARD_PORT',
          reason,
          matched_keyword: nonstandardPort,
          extra_finding: reason
        });
      }

      try {
        // 지연 시간 적용 (WAF 차단 및 먹통 방지)
        await sleep(this.session.speedDelayMs);

        // HTTP 요청 수행 (사람다운 랜덤 브라우저 헤더 및 Client Hints 적용)
        const response = await fetch(currentUrl, {
          headers: getRandomHumanHeaders(this.session.entryUrl),
          signal: AbortSignal.timeout(15000)
        });

        httpStatus = response.status;
        const contentType = response.headers.get('content-type') || '';

        // 서버 오류 화면은 콘텐츠 분석과 브라우저 정밀 검사의 대상에서 제외
        if (response.status < 500 && contentType.includes('text/html')) {
          // 바이너리 버퍼로 수신하여 문자 인코딩 자동 판별
          const arrayBuffer = await response.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          pageHtml = decodeHtmlBuffer(buffer, contentType);
        }
      } catch (reqErr) {
        httpStatus = 500;
        pageTitle = `오류: ${reqErr.message}`;
      }

      if (pageHtml) {
        // HTML 파싱 및 메타/제목 추출
        let dom = htmlparser2.parseDocument(pageHtml);
        const extractedTitle = this.extractSiteTitle(dom, currentItem.pathSegment);
        pageTitle = extractedTitle;

        // 최초 진입 URL (depth === 0)이거나 아직 마스터 타이틀이 없을 때 t_detect의 title 결정
        if (currentItem.depth === 0 || !this.session.masterTitle) {
          this.session.masterTitle = extractedTitle;
          if (!this.session.siteProfile) {
            const siteProfileSource = this.extractSiteProfile(dom, extractedTitle);
            this.session.siteProfile = await llmPipelineService.summarizeSiteProfile(siteProfileSource);
          }
          if (this.session.masterId && extractedTitle) {
            try {
              await commonDAO.execute_query('detectMapper.updateDetectMasterTitle', {
                id: this.session.masterId,
                title: extractedTitle
              });
              console.log(`[DetectEngine] 마스터 사이트 타이틀 결정: [${extractedTitle}] (ID: ${this.session.masterId})`);
            } catch (titleDbErr) {
              console.warn('[DetectEngine] Master Title Update Error:', titleDbErr.message);
            }
          }
        }

        // [클라이언트 사이드 포워딩 추적] JS location 이동 또는 meta refresh 발견 시 대기열 최우선 삽입하여 즉시 쫓아감
        const clientRedirectTarget = extractClientRedirectUrl(pageHtml, currentUrl);
        if (clientRedirectTarget && isSameDomain(clientRedirectTarget, entryUrl) && !this.hasVisitedOrExcludedUrl(clientRedirectTarget)) {
          const isQueued = this.session.contentQueue.some(q => q.url === clientRedirectTarget) ||
                           this.session.articleQueue.some(q => q.url === clientRedirectTarget) ||
                           this.session.boardPageQueue.some(q => q.url === clientRedirectTarget) ||
                           this.session.reserveBoardPageQueue.some(q => q.url === clientRedirectTarget) ||
                           this.session.reserveArticleQueue.some(q => q.url === clientRedirectTarget);
          if (!isQueued) {
            console.log(`[DetectEngine] 2단계 포워딩 추적 즉시 등록: ${currentUrl} -> ${clientRedirectTarget}`);
            this.session.contentQueue.unshift({
              url: clientRedirectTarget,
              depth: currentItem.depth + 1,
              parentUid: nodeUid,
              pathSegment: `[이동] ${new URL(clientRedirectTarget).pathname}`,
              isArticle: false,
              title: '포워딩 대상 페이지'
            });
          }
        }

        // [frame / iframe 내부 침투] 프레임셋 또는 아이프레임 내부 URL을 대기열 앞단에 등록하여 연계 검출
        const pageFrames = extractFrameUrls(dom, currentUrl);
        for (const fr of pageFrames) {
          if (isSameDomain(fr.url, entryUrl) && !this.hasVisitedOrExcludedUrl(fr.url)) {
            const isQueued = this.session.contentQueue.some(q => q.url === fr.url) ||
                             this.session.articleQueue.some(q => q.url === fr.url) ||
                             this.session.boardPageQueue.some(q => q.url === fr.url) ||
                             this.session.reserveBoardPageQueue.some(q => q.url === fr.url) ||
                             this.session.reserveArticleQueue.some(q => q.url === fr.url);
            if (!isQueued) {
              console.log(`[DetectEngine] 2단계 ${fr.type} 프레임 침투 대기열 등록: ${fr.url}`);
              this.session.contentQueue.unshift({
                url: fr.url,
                depth: currentItem.depth + 1,
                parentUid: nodeUid,
                pathSegment: `[${fr.type}] ${new URL(fr.url).pathname}`,
                isArticle: false,
                title: `${fr.type} 콘텐츠`
              });
            }
          }
        }

        // 브라우저 실행 후 생성되는 동적 HTML도 같은 규칙으로 분석
        let browserInspection = { findings: [], links: [], html: '' };
        let pageUsesRenderedDom = false;
        try {
          const useDynamicDiscovery = needsDynamicLinkDiscovery(dom, currentUrl);
          browserInspection = await browserInspector.inspectPageDetails(currentUrl, 15000, {
            waitForDynamicNetwork: useDynamicDiscovery,
            collectDynamicPagination: useDynamicDiscovery
          });
          if (browserInspection.html) {
            const renderedDom = htmlparser2.parseDocument(browserInspection.html);
            const renderedText = (domutils.getText(renderedDom.children) || '').replace(/\s+/g, ' ').trim();
            const sourceText = (domutils.getText(dom.children) || '').replace(/\s+/g, ' ').trim();
            if (renderedText.length > sourceText.length) {
              dom = renderedDom;
              pageUsesRenderedDom = true;
            }
          }
        } catch (browserErr) {
          console.warn('[DetectEngine] 브라우저 렌더링 검사 오류:', browserErr.message);
        }

        // 방문한 페이지가 게시판 목록 페이지인지 확인 및 신규 게시판 등록
        const articleMeta = domutils.findOne(el => el.type === 'tag' && el.name === 'meta' &&
          el.attribs && (el.attribs.property || '').toLowerCase() === 'og:type' &&
          (el.attribs.content || '').toLowerCase() === 'article', dom.children);
        const isCurrentArticle = currentItem.isArticle || isArticleDetailPageUrl(currentUrl) || Boolean(articleMeta);
        const isCurrentBoardList = !isCurrentArticle && (currentItem.isBoardList || isBoardListPage(dom, currentUrl));
        if (isCurrentBoardList) {
          const spec = extractBoardSpec(dom, currentUrl);
          if (spec && !this.session.discoveredBoards.has(spec.baseKey)) {
            spec.sampleUrl = currentUrl;
            spec.hasAuthoringControl = hasBoardAuthoringControl(dom);
            this.session.discoveredBoards.set(spec.baseKey, spec);
            const totalBuffer = this.session.adaptivePageLimit || this.session.articleBufferCap;
            const staticBuffer = Math.max(200, Math.floor(totalBuffer * 0.20));
            const boardBuffer = Math.max(100, totalBuffer - staticBuffer);

            const sumTotalPages = Array.from(this.session.discoveredBoards.values())
              .reduce((sum, s) => sum + Math.max(1, s.totalPage || 1), 0);

            const boardTotal = Math.max(1, spec.totalPage || 1);
            const ratio = boardTotal / Math.max(1, sumTotalPages);
            const isDorkBoard = isExposedIndexBoard(spec, this.session.exposedIndexUrls || [], origin);
            const priorityWeight = getBoardPriorityWeight(isDorkBoard, spec.hasAuthoringControl);
            const baseAllocatedBudget = Math.max(5, Math.floor(boardBuffer * ratio));
            const allocatedBudget = applyBoardPriorityWeight(baseAllocatedBudget, priorityWeight);
            const samplingPlan = planBoardSampling(boardTotal, allocatedBudget);
            const stratifiedPages = generateStratifiedPages(spec, samplingPlan.listPageCount);
            const remainingPages = generateRemainingBoardPages(
              spec,
              stratifiedPages.map(page => page.pageNum),
              this.session.maxPages
            );
            currentItem.samplePostsLimit = Math.max(
              currentItem.samplePostsLimit || 0,
              samplingPlan.postsPerList
            );
            console.log(`[DetectEngine] 탐색 중 신규 게시판 발견: ${spec.baseKey} (총 ${boardTotal}p, 가중치 ${priorityWeight}) -> 목록 ${samplingPlan.listPageCount}p, 목록당 게시물 최대 ${samplingPlan.postsPerList}건`);
            logWrite(config.paths.logsDir, {
              event: 'board_page_sample',
              boardKey: spec.baseKey,
              totalPages: boardTotal,
              sampledPages: stratifiedPages.map(item => item.pageNum)
            });
            const newBoardItems = [];
            for (const sp of stratifiedPages) {
              const sampleKey = normalizeUrl(sp.url);
              if (!this.hasVisitedOrExcludedUrl(sampleKey) && !this.session.boardPageQueue.some(b => normalizeUrl(b.url) === sampleKey)) {
                newBoardItems.push({
                  url: sp.url,
                  depth: currentItem.depth + 1,
                  parentUid: nodeUid,
                  pathSegment: `[P.${sp.pageNum}] ${new URL(sp.url).pathname}`,
                  isBoardList: true,
                  boardKey: spec.baseKey,
                  pageNum: sp.pageNum,
                  samplePostsLimit: samplingPlan.postsPerList,
                  isDorkEpicenter: isDorkBoard,
                  hasAuthoringControl: spec.hasAuthoringControl,
                  boardPriorityWeight: priorityWeight
                });
              }
            }
            this.session.boardPageQueue = roundRobinByKey(
              [...this.session.boardPageQueue, ...newBoardItems],
              item => item.boardKey || getBoardIdentityKey(item.url)
            );

            const newReserveBoardItems = [];
            for (const rp of remainingPages) {
              const reserveKey = normalizeUrl(rp.url);
              const isQueued = this.session.boardPageQueue.some(item => normalizeUrl(item.url) === reserveKey) ||
                this.session.reserveBoardPageQueue.some(item => normalizeUrl(item.url) === reserveKey);
              if (!this.hasVisitedOrExcludedUrl(reserveKey) && !isQueued) {
                newReserveBoardItems.push({
                  url: rp.url,
                  depth: currentItem.depth + 1,
                  parentUid: nodeUid,
                  pathSegment: `[정밀 P.${rp.pageNum}] ${new URL(rp.url).pathname}`,
                  isBoardList: true,
                  isReserve: true,
                  boardKey: spec.baseKey,
                  pageNum: rp.pageNum
                });
              }
            }
            this.session.reserveBoardPageQueue = roundRobinByKey(
              [...this.session.reserveBoardPageQueue, ...newReserveBoardItems],
              item => item.boardKey || getBoardIdentityKey(item.url)
            ).slice(0, this.session.maxPages);
          }
        }

        // [사후 텍스트 밀도 검사]
        // 텍스트가 없는 단순 미디어/이미지 팝업이나 빈 껍데기 페이지는 분석 단계 스킵 및 쿼터 보존
        const purePageText = (domutils.getText(dom.children) || '').replace(/\s+/g, ' ').trim();
        const isBlankOrMediaOnly = purePageText.length < 25 && !isCurrentBoardList;

        if (isBlankOrMediaOnly) {
          logWrite(config.paths.logsDir, { event: 'spam_similarity_page', masterId: this.session.masterId, url: currentUrl, status: 'skipped_blank_or_media', pageTextLength: purePageText.length });
          // 유효 텍스트가 없으므로 카운트 롤백하여 버퍼 쿼터 보존
          if (currentItem.isArticle && this.session.visitedArticleCount > 0) {
            this.session.visitedArticleCount--;
          } else if (this.session.visitedContentCount > 0) {
            this.session.visitedContentCount--;
          }
        } else {
          // [1차] htmlparser2 기반 JAMO/HOMOGLYPH 텍스트 패턴 분석
          try {
            pageFindings.push(...await this.analyzePageForViolations(dom, currentUrl));
          } catch (pageErr) {
            console.warn('[DetectEngine] analyzePageForViolations Error:', pageErr.message);
          }

          // [2차] Puppeteer 브라우저 기반 TRANSPARENT/OFFSCREEN 정밀 검사
          this.session.currentStep = `[${this.session.visitedUrls.size}/${this.session.maxPages}] CSS 시각 은닉 정밀 검사: ${currentItem.pathSegment}`;
          try {
            const browserFindings = browserInspection.findings || [];
            if (browserFindings && browserFindings.length > 0) {
              for (const bf of browserFindings) {
                // 이미 htmlparser2에서 같은 location으로 검출된 항목은 중복 제거
                const isDup = pageFindings.some(pf => pf.location === bf.location && pf.technique === bf.technique);
                if (isDup) continue;

                // 검출된 텍스트가 불법광고인지 LLM 및 정화소 교차 판정
                const evidenceText = (bf.evidence_text || '').trim();
                if (!evidenceText || evidenceText.length < 2) continue;

                if (isNormalWebContent(evidenceText, bf.location)) continue;

                const isPolluted = pollutedPatterns.some(p => evidenceText.includes(p));
                const suspectMatchInfo = findMatchedSuspectKeyword(evidenceText, suspectPatterns, memoMap, requiredTermsMap);
                const isSuspect = Boolean(suspectMatchInfo);
                const matchInfo = findMatchedKeyword(evidenceText, pollutedPatterns, memoMap) || suspectMatchInfo;
                const matchedKeyword = matchInfo ? matchInfo.keyword : '';
                const matchedMemo = matchInfo ? matchInfo.memo : '';

                // 불법 의심 징후 (오염DB 또는 의심DB 패턴) 감지 시 LLM에 판정 요청
                const hasSuspicion = isPolluted || isSuspect;

                let isIllegal = false;
                let aiReason = '';

                if (hasSuspicion) {
                  // [예외 단어 확인] 확정 오염이 아닌 의심 상태에서 예외 패턴이 있으면 통과
                  if (!isPolluted && exceptionPatterns.some(c => evidenceText.includes(c))) continue;

                  try {
                    const aiRes = await llmPipelineService.classifyText(evidenceText, {
                      masterId: this.session.masterId,
                      url: currentUrl,
                      siteProfile: this.session.siteProfile || '',
                      isPolluted,
                      matchedKeyword,
                      matchedMemo
                    });
                    if (aiRes) {
                      isIllegal = aiRes.isViolation;
                      aiReason = aiRes.reason;
                    }
                  } catch (e) {
                    // LLM 에러 발생 시 폴백: 오염 패턴 매칭 시 불법 인정
                    if (isPolluted) isIllegal = true;
                  }
                }

                if (isIllegal) {
                  const matchInfo = findMatchedKeyword(evidenceText, pollutedPatterns, memoMap);
                  const matchedKeyword = matchInfo ? matchInfo.keyword : '';
                  const snippet = extractEvidenceSnippet(evidenceText, matchedKeyword);
                  const reasonStr = bf.reason ? `[${bf.technique}] ${bf.reason}` : (matchInfo ? matchInfo.reason : `${bf.technique} 은닉 의심`);

                  const fIdx = this.session.findings.length + pageFindings.length + 1;
                  pageFindings.push({
                    id: `f_${String(fIdx).padStart(3, '0')}`,
                    url: currentUrl,
                    is_violation: true,
                    location: bf.location,
                    evidence_text: snippet,
                    technique: bf.technique,
                    reason: reasonStr,
                    matched_keyword: matchedKeyword,
                    extra_finding: reasonStr
                  });
                }
              }
            }
          } catch (browserErr) {
            console.warn('[DetectEngine] Puppeteer 검사 오류:', browserErr.message);
          }

          // [3차] 보이는 텍스트 LLM 추가 탐지 (ETC)
          const remainSecLlm = Math.max(0, Math.floor((this.session.scanDeadlineAtMs - Date.now()) / 1000));
          const remainMinLlm = Math.floor(remainSecLlm / 60);
          const remainSecPartLlm = String(remainSecLlm % 60).padStart(2, '0');
          this.session.currentStep = `[${this.session.visitedUrls.size}p / 남은시간 ${remainMinLlm}:${remainSecPartLlm}] LLM 판정 중: ${currentItem.pathSegment}`;
          try {
            const visibleFindings = await this.analyzeVisibleText(dom, currentUrl);
            pageFindings.push(...visibleFindings);
          } catch (visErr) {
            console.warn('[DetectEngine] 보이는 텍스트 분석 오류:', visErr.message);
            logWrite(config.paths.logsDir, { event: 'spam_similarity_page', masterId: this.session.masterId, url: currentUrl, status: 'visible_text_error', error: visErr.message });
          }
        }

        try {
          const reflectedFindings = await this.inspectReflectedSearchForms(
            dom,
            currentUrl,
            currentItem,
            isCurrentBoardList,
            isCurrentArticle,
            pollutedPatterns,
            pageUsesRenderedDom
          );
          for (const finding of reflectedFindings) {
            finding.id = `f_${String(this.session.findings.length + pageFindings.length + 1).padStart(3, '0')}`;
            pageFindings.push(finding);
          }
        } catch (reflectionErr) {
          console.warn('[DetectEngine] 반사형 검색 오염 검사 오류:', reflectionErr.message);
        }
      // 하위 링크 추출 및 외부 사행성 스팸 링크 정밀 검사
        // 하위 링크 추출 및 이중 대기열(일반 콘텐츠 vs 게시물 버퍼) 적재
        const totalQueued = this.session.contentQueue.length + this.session.articleQueue.length;
        if (!isCurrentArticle && this.session.visitedUrls.size + totalQueued < this.session.maxPages * 2) {
          const pageArticleCandidates = [];
          const pageArticleCandidateKeys = new Set();
          const pagePagingCandidates = [];

          // 버튼 방식으로 이동한 동적 게시판의 다른 쪽에서 확보한 상세 링크
          for (const renderedLink of browserInspection.links || []) {
            const resolvedRenderedUrl = this.resolveUrl(origin, currentUrl, renderedLink.href);
            if (!resolvedRenderedUrl || !isSameDomain(resolvedRenderedUrl, entryUrl) ||
                !isArticleDetailPageUrl(resolvedRenderedUrl) || isNonContentLink(resolvedRenderedUrl, null)) {
              continue;
            }
            const renderedKey = normalizeUrl(resolvedRenderedUrl);
            const isAlreadyKnown = this.hasVisitedOrExcludedUrl(renderedKey) ||
              this.session.articleQueue.some(item => normalizeUrl(item.url) === renderedKey) ||
              this.session.reserveArticleQueue.some(item => normalizeUrl(item.url) === renderedKey);
            if (!isAlreadyKnown && !pageArticleCandidateKeys.has(renderedKey)) {
              pageArticleCandidateKeys.add(renderedKey);
              const renderedUrl = new URL(resolvedRenderedUrl);
              pageArticleCandidates.push({
                url: resolvedRenderedUrl,
                depth: currentItem.depth + 1,
                parentUid: nodeUid,
                pathSegment: renderedUrl.pathname + renderedUrl.search,
                isArticle: true
              });
            }
          }

          // a, iframe, frame뿐만 아니라 tr[href], div[href], tr[onclick], div[data-href] 등 모든 클릭 가능 행/요소 추출
          const links = domutils.findAll(el => {
            if (!isNavigableLinkElement(el)) return false;
            // 구글 애드센스 등 공식 광고 컨테이너 및 광고 iframe 수집 사전 차단
            if (el.attribs) {
              if (el.attribs.class && /adsbygoogle|kakao_ad|adfit/i.test(el.attribs.class)) return false;
              if (el.attribs.src && adPlatforms.isAdPlatform(el.attribs.src)) return false;
            }
            return !(el.attribs && el.attribs.src && adPlatforms.isAdPlatform(el.attribs.src));
          }, dom.children);

          for (const link of links) {
            let rawHref = null;
            if (link.attribs) {
              rawHref = link.attribs.href || link.attribs['data-href'] || link.attribs['data-url'] || link.attribs.src;
              if (!rawHref && link.attribs.onclick) {
                const clickMatch = link.attribs.onclick.match(/(?:location(?:\.href)?\s*=\s*['"]|window\.open\(\s*['"])([^'"]+)/i);
                if (clickMatch) rawHref = clickMatch[1];
              }
            }
            if (!rawHref) continue;

            // [공식 광고 플랫폼 필터링] 구글 애드센스, 카카오 애드핏, 네이버 등 정상 광고 URL은 즉시 스킵 (부하 및 오탐 방지)
            if (adPlatforms.isAdPlatform(rawHref)) {
              continue;
            }

            // [외부 사행성/불법 링크 감지] 텍스트가 없어도 href 주소 자체가 불법 도메인/패턴인 경우 즉시 적발
            if (/^(?:https?:)?\/\//i.test(rawHref) || /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(rawHref)) {
              const hrefLower = rawHref.toLowerCase();
              const isIllegalLink = /(?:bmw\d+|bbw\d+|casino|baccarat|bet\d+|\bslot\b|toto|onca)/i.test(hrefLower) ||
                                    (Array.isArray(pollutedPatterns) && pollutedPatterns.some(p => hrefLower.includes(p))) ||
                                    (Array.isArray(suspectPatterns) && Boolean(findMatchedSuspectKeyword(hrefLower, suspectPatterns, memoMap, requiredTermsMap)));
              if (isIllegalLink) {
                const loc = this.buildCssLocation(link, dom);
                const isDup = pageFindings.some(pf => pf.location === loc);
                if (!isDup) {
                  const fIdx = this.session.findings.length + pageFindings.length + 1;
                  const reasonStr = `사행성/불법 스팸 외부 링크 삽입 검출 (${rawHref}) [즉시 차단]`;
                  pageFindings.push({
                    id: `f_${String(fIdx).padStart(3, '0')}`,
                    url: currentUrl,
                    is_violation: true,
                    location: loc,
                    evidence_text: `외부 연결 URL: ${rawHref}`,
                    technique: 'ETC',
                    reason: reasonStr,
                    matched_keyword: rawHref,
                    extra_finding: reasonStr
                  });
                }
              }
            }

            // 내부 도메인 링크 판별 및 이중 대기열 분류 적재 (동일 도메인 유연 판별 적용)
            const resolvedUrl = this.resolveUrl(origin, currentUrl, rawHref);
            if (resolvedUrl && isSameDomain(resolvedUrl, entryUrl)) {
              // 단순 이미지 뷰어(?fn=xxx.jpg 등), 파일 다운로드, 인쇄 등 텍스트 검출 취지에 맞지 않는 링크 제외 (DOM 문맥 + URL 파라미터 사전 검사)
              if (isNonContentLink(resolvedUrl, link)) {
                continue;
              }

              const isAlreadyVisited = this.hasVisitedOrExcludedUrl(resolvedUrl);
              const isAlreadyQueued = this.session.contentQueue.some(q => q.url === resolvedUrl) ||
                                      this.session.articleQueue.some(q => q.url === resolvedUrl) ||
                                      this.session.boardPageQueue.some(q => q.url === resolvedUrl) ||
                                      this.session.reserveBoardPageQueue.some(q => q.url === resolvedUrl) ||
                                      this.session.reserveArticleQueue.some(q => q.url === resolvedUrl);

              if (!isAlreadyVisited && !isAlreadyQueued) {
                try {
                  const subUrlObj = new URL(resolvedUrl);
                  const subSegment = subUrlObj.pathname + subUrlObj.search;

                  // DOM 구조 및 반복 행 패턴 분석을 통한 게시판 본문 상세 뷰 링크 판정
                  const isArticle = isArticleDetailLink(link, dom, resolvedUrl);

                  if (isArticle) {
                    // 같은 게시물이 여러 요소에 연결되어 있어도 한 번만 보관
                    const articleKey = normalizeUrl(resolvedUrl);
                    if (!pageArticleCandidateKeys.has(articleKey)) {
                      pageArticleCandidateKeys.add(articleKey);
                      pageArticleCandidates.push({
                        url: resolvedUrl,
                        depth: currentItem.depth + 1,
                        parentUid: nodeUid,
                        pathSegment: subSegment || '/',
                        isArticle: true
                      });
                    }
                  } else {
                    // 페이징 파라미터가 포함된 목록 링크 식별 (쿼리스트링 및 경로 기반 통합 지원)
                    const linkText = domutils.getText(link).trim();
                    const pagingInfo = parsePagingInfoFromHref(resolvedUrl, linkText);
                    const pageNum = pagingInfo ? pagingInfo.pageNum : null;

                    if (pageNum !== null) {
                      pagePagingCandidates.push({
                        url: resolvedUrl,
                        depth: currentItem.depth + 1,
                        parentUid: nodeUid,
                        pathSegment: `[P.${pageNum}] ${subSegment || '/'}`,
                        isBoardList: true,
                        pageNum,
                        samplePostsLimit: currentItem.samplePostsLimit || 2
                      });
                    } else if (currentItem.depth < 8) {
                      // 일반 단일 콘텐츠 링크 (전수 탐색 원칙에 따라 8단계까지 허용)
                      this.session.contentQueue.push({
                        url: resolvedUrl,
                        depth: currentItem.depth + 1,
                        parentUid: nodeUid,
                        pathSegment: subSegment || '/',
                        isArticle: false,
                        title: linkText || subSegment
                      });
                    }
                  }
                } catch (e) {}
              }
            }
          }

          // 크롤링 중 방문한 페이지 내 자바스크립트 라우트 실시간 추가 발굴
          try {
            const pageJsRoutes = await harvestJavaScriptUrls(dom, currentUrl, origin, entryUrl);
            for (const [pju, pjm] of pageJsRoutes.entries()) {
              if (!this.hasVisitedOrExcludedUrl(pju) &&
                  !this.session.contentQueue.some(q => q.url === pju) &&
                  !this.session.articleQueue.some(q => q.url === pju) &&
                  !this.session.boardPageQueue.some(q => q.url === pju) &&
                  !this.session.reserveBoardPageQueue.some(q => q.url === pju) &&
                  !this.session.reserveArticleQueue.some(q => q.url === pju)) {
                this.session.contentQueue.push({
                  url: pju,
                  depth: currentItem.depth + 1,
                  parentUid: nodeUid,
                  pathSegment: new URL(pju).pathname,
                  isArticle: false,
                  title: pjm.linkText || new URL(pju).pathname
                });
              }
            }
          } catch (pje) {}

          // 기본 탐색에서 선택하지 않은 게시물은 버리지 않고 정밀 탐색 대기열에 보관
          if (pageArticleCandidates.length > 0) {
            let selectedArticles = pageArticleCandidates;
            let reservedArticles = [];
            if (currentItem.isBoardList || isCurrentBoardList) {
              if (this.session.precisionMode || currentItem.isReserve) {
                selectedArticles = [];
                reservedArticles = pageArticleCandidates;
              } else {
                const sampleLimit = Math.max(1, currentItem.samplePostsLimit || 2);
                const partitioned = partitionInOrder(pageArticleCandidates, sampleLimit);
                selectedArticles = partitioned.primary;
                reservedArticles = partitioned.reserve;
              }
            }

            for (const art of selectedArticles) {
              if (this.session.articleQueue.length < this.session.articleBufferCap && currentItem.depth < 8) {
                this.session.articleQueue.push(art);
              } else {
                reservedArticles.push(art);
              }
            }

            for (const art of reservedArticles) {
              const reserveKey = normalizeUrl(art.url);
              const isQueued = this.session.reserveArticleQueue.some(item => normalizeUrl(item.url) === reserveKey) ||
                this.session.articleQueue.some(item => normalizeUrl(item.url) === reserveKey);
              if (!this.hasVisitedOrExcludedUrl(reserveKey) && !isQueued &&
                  this.session.reserveArticleQueue.length < this.session.maxPages && currentItem.depth < 8) {
                this.session.reserveArticleQueue.push({ ...art, isReserve: true });
              }
            }
          }

          // 현재 페이지가 목록 페이지인 경우 해당 게시판의 방문 누적 횟수 증가
          if (currentItem.isBoardList) {
            const curBKey = getBoardIdentityKey(currentUrl);
            const vCount = (this.session.boardListVisitCountMap.get(curBKey) || 0) + 1;
            this.session.boardListVisitCountMap.set(curBKey, vCount);
          }

          // 페이징 링크 적재 제어:
          // 1. 현재 목록 페이지에 게시물이 0건인 빈 페이지(Empty Board Page)라면 하단 페이징 바 링크는 모두 무시 (무한 증식 차단)
          // 2. 단일 게시판(동일 bo_table 등) 목록 방문 횟수가 6회를 초과하지 않도록 캡 적용 (특정 게시판 독점 방지)
          const isCurrentEmptyBoard = currentItem.isBoardList && pageArticleCandidates.length === 0;
          if (!isCurrentEmptyBoard && pagePagingCandidates.length > 0) {
            const newPagingItems = [];
            for (const pc of pagePagingCandidates) {
              const targetBKey = getBoardIdentityKey(pc.url);
              const targetVisits = this.session.boardListVisitCountMap.get(targetBKey) || 0;
              if (targetVisits < 6 && this.session.boardPageQueue.length < this.session.articleBufferCap && currentItem.depth < 8) {
                newPagingItems.push({ ...pc, boardKey: targetBKey });
              }
            }
            if (newPagingItems.length > 0) {
              this.session.boardPageQueue = roundRobinByKey(
                [...this.session.boardPageQueue, ...newPagingItems],
                item => item.boardKey || getBoardIdentityKey(item.url)
              );
            }
          }

          this.session.urlQueue = [
            ...this.session.boardPageQueue,
            ...this.session.contentQueue,
            ...this.session.articleQueue,
            ...this.session.reserveBoardPageQueue,
            ...this.session.reserveArticleQueue
          ];
        }
      }

      // 이번만 제외(허용) 키워드가 매칭된 위반 항목은 최종 스킵 처리
      if (this.session && Array.isArray(this.session.tempAllowedKeywords) && this.session.tempAllowedKeywords.length > 0) {
        pageFindings = pageFindings.filter(f => !this.isFindingAllowed(f));
      }

      // 오래 걸린 브라우저 검사나 AI 판정이 끝나는 사이 새 점검이 시작되었으면
      // 이전 페이지 결과를 새 세션과 DB에 섞지 않고 즉시 폐기합니다.
      if (this.currentSessionId !== sessionId || this.session.sessionId !== sessionId || this.session.status === 'STOPPED') {
        console.log(`[DetectEngine] 만료된 세션의 페이지 결과 폐기: ${currentUrl}`);
        return;
      }

      pageFindings.forEach((finding, index) => {
        finding.id = `f_${String(this.session.findings.length + index + 1).padStart(3, '0')}`;
      });

      // 트리 노드 구성
      const hasViolation = pageFindings.length > 0;
      const primaryTech = hasViolation ? pageFindings[0].technique : '-';
      const treeNode = {
        uid: nodeUid,
        parentUid: currentItem.parentUid,
        level: currentItem.depth,
        name: currentItem.pathSegment,
        fullUrl: currentUrl,
        title: pageTitle,
        status: httpStatus,
        hasViolation,
        technique: primaryTech
      };

      this.session.treeNodes.push(treeNode);

      // DB에 트리 노드 저장
      if (this.session.masterId) {
        try {
          await commonDAO.execute_query('detectMapper.insertDetectNode', {
            master_id: this.session.masterId,
            parent_id: currentItem.parentUid ? Number(currentItem.parentUid.replace('node_', '')) : null,
            depth: currentItem.depth,
            url: currentUrl,
            path_segment: currentItem.pathSegment,
            title: pageTitle,
            http_status: httpStatus,
            has_violation: hasViolation ? 1 : 0,
            violation_cnt: pageFindings.length
          });
        } catch (dbNodeErr) {
          // 중복 등으로 인한 에러 무시
        }
      }

      // 검출된 위반 항목 세션 및 DB 등록
      for (const f of pageFindings) {
        this.session.findings.push(f);
        if (this.session.masterId) {
          try {
            await commonDAO.execute_query('detectMapper.insertDetectFinding', {
              master_id: this.session.masterId,
              finding_id: f.id,
              url: f.url,
              is_violation: f.is_violation ? 1 : 0,
              location: f.location,
              evidence_text: f.evidence_text,
              technique: f.technique,
              extra_finding: f.extra_finding || null
            });
          } catch (dbFindErr) {
            console.error('[DetectEngine] Finding Insert Error:', dbFindErr.message);
          }
        }
      }

      const pageDurationMs = Math.max(1, Date.now() - pageStartedAtMs);
      this.session.pageDurationSamples.push(pageDurationMs);
      if (this.session.pageDurationSamples.length > 100) {
        this.session.pageDurationSamples.shift();
      }
      const remainingScanMs = Math.max(0, this.session.scanDeadlineAtMs - Date.now());
      const remainingHardLimit = Math.max(0, this.session.maxPages - this.session.visitedUrls.size);
      const observed = estimateRemainingCapacity(
        this.session.pageDurationSamples,
        remainingScanMs,
        Math.max(2000, this.session.speedDelayMs + 1500),
        remainingHardLimit
      );
      this.session.observedPageMs = observed.pageMs;
      this.session.adaptivePageLimit = Math.min(
        this.session.maxPages,
        this.session.visitedUrls.size + observed.capacity
      );
      this.session.estimatedTotalPages = this.session.adaptivePageLimit;
      this.session.articleBufferCap = Math.max(20, this.session.adaptivePageLimit);
      this.session.contentQuota = Math.max(10, Math.floor(this.session.adaptivePageLimit * 0.5));
      this.session.articleQuota = Math.max(10, this.session.adaptivePageLimit - this.session.contentQuota);
      this.session.targetPlanCount = Math.max(
        this.session.visitedUrls.size,
        Math.min(
          this.session.adaptivePageLimit,
          this.session.visitedUrls.size + this.session.contentQueue.length +
            this.session.boardPageQueue.length + this.session.articleQueue.length
        )
      );
      if (this.session.visitedUrls.size % 10 === 0) {
        logWrite(config.paths.logsDir, {
          event: 'crawl_speed_calibration',
          masterId: this.session.masterId,
          visitedPages: this.session.visitedUrls.size,
          observedPageMs: this.session.observedPageMs,
          remainingCapacity: observed.capacity,
          adaptivePageLimit: this.session.adaptivePageLimit,
          remainingScanSec: Math.floor(remainingScanMs / 1000)
        });
      }
    }

    if (this.currentSessionId !== sessionId) {
      console.log(`[DetectEngine] 이전 세션(${sessionId}) 루프 종료 감지 -> 현재 활성 세션(${this.currentSessionId}) 상태 보존`);
      return;
    }

    await this.finalizeSession();
  }

  // URL 절대경로 해석
  resolveUrl(origin, base, relative) {
    if (!relative) return null;
    const trimmed = relative.trim();
    if (trimmed.startsWith('#') || trimmed.startsWith('javascript:') || trimmed.startsWith('mailto:') || trimmed.startsWith('tel:')) {
      return null;
    }
    try {
      const resolved = new URL(resolveCrawlUrl(trimmed, base));
      resolved.hash = ''; // 해시 제거
      const pathname = resolved.pathname.toLowerCase();
      // 이미지, 동영상, 폰트, 압축파일 등 비HTML 정적 리소스 크롤링 제외
      if (/\.(png|jpe?g|gif|webp|svg|ico|pdf|zip|rar|tar|gz|exe|apk|mp3|mp4|avi|mov|wmv|css|js|woff2?|ttf|eot)$/i.test(pathname)) {
        return null;
      }
      return resolved.href;
    } catch (e) {
      return null;
    }
  }

  // CSS 선택자(location) 생성기 (가이드 규칙 엄격 준수)
  buildCssLocation(element, domRoot, iframeSrc = null) {
    const pathSegments = [];
    let curr = element;

    while (curr && curr.type === 'tag' && curr.name !== 'html' && curr.name !== 'body') {
      const tag = curr.name;
      const classAttr = curr.attribs && curr.attribs.class ? curr.attribs.class.trim() : '';

      if (classAttr) {
        // 첫 번째 유효한 클래스 사용
        const mainClass = classAttr.split(/\s+/)[0];
        pathSegments.unshift(`${tag}.${mainClass}`);
      } else {
        // 클래스가 없는 경우 :nth-of-type(N) 표기
        let index = 1;
        if (curr.parent && curr.parent.children) {
          const siblings = curr.parent.children.filter(c => c.type === 'tag' && c.name === tag);
          index = siblings.indexOf(curr) + 1;
        }
        pathSegments.unshift(`${tag}:nth-of-type(${Math.max(1, index)})`);
      }

      curr = curr.parent;
    }

    const localSelector = pathSegments.length > 0 ? pathSegments.join(' > ') : 'div';
    if (iframeSrc) {
      return `iframe[src="${iframeSrc}"] >>> ${localSelector}`;
    }
    return localSelector;
  }

  // 이번만 제외(허용) 키워드에 매칭되는 위반 항목인지 검증
  isFindingAllowed(finding) {
    if (!this.session || !Array.isArray(this.session.tempAllowedKeywords) || this.session.tempAllowedKeywords.length === 0) {
      return false;
    }
    const matched = String(finding.matched_keyword || '').toLowerCase();
    const evidence = String(finding.evidence_text || '').toLowerCase();
    const reason = String(finding.reason || finding.extra_finding || '').toLowerCase();

    for (const kw of this.session.tempAllowedKeywords) {
      if (!kw) continue;
      const target = kw.toLowerCase().trim();
      if (!target) continue;
      if (matched.includes(target) || evidence.includes(target) || reason.includes(target)) {
        return true;
      }
    }
    return false;
  }

  invalidateCleanroomPatternCache() {
    this.cleanroomPatternCacheVersion += 1;
    this.cleanroomPatternCache = null;
    this.cleanroomPatternLoadPromise = null;
  }

  // 데이터 정화소(t_cleanroom) 4단계(대기, 의심, 오염, 예외) 패턴 캐시 일괄 로드
  async loadCleanroomPatterns() {
    if (this.cleanroomPatternCache) return this.cleanroomPatternCache;

    const version = this.cleanroomPatternCacheVersion;
    const pending = this.cleanroomPatternLoadPromise || this.buildCleanroomPatterns();
    this.cleanroomPatternLoadPromise = pending;

    try {
      const patterns = await pending;
      if (version !== this.cleanroomPatternCacheVersion) {
        return this.loadCleanroomPatterns();
      }
      this.cleanroomPatternCache = patterns;
      return patterns;
    } finally {
      if (this.cleanroomPatternLoadPromise === pending) {
        this.cleanroomPatternLoadPromise = null;
      }
    }
  }

  async buildCleanroomPatterns() {
    const pollutedPatterns = [];
    const suspectPatterns = [];
    const exceptionPatterns = [];
    const waitPatterns = [];
    const memoMap = new Map();
    const requiredTermsMap = new Map();

    try {
      const res = await commonDAO.selectList('cleanroomMapper.selectCleanroomList', {});
      if (res && res.list) {
        for (const r of res.list) {
          const pt = (r.pattern_text || '').trim();
          if (!pt || pt.length < 2) continue;
          const type = String(r.pattern_type || '').toUpperCase();
          if (r.memo) memoMap.set(pt, r.memo);

          if (type === 'POLLUTED') {
            pollutedPatterns.push(pt);
          } else if (type === 'SUSPECT') {
            suspectPatterns.push(pt);
            const requiredTerms = parseRequiredTerms(r.required_terms);
            if (requiredTerms.length > 0) requiredTermsMap.set(pt, requiredTerms);
          } else if (type === 'EXCEPTION' || type === 'CLEAN') {
            exceptionPatterns.push(pt);
          } else if (type === 'WAIT') {
            waitPatterns.push(pt);
          }
        }
      }
    } catch (err) {
      console.warn('[DetectEngine] Cleanroom Cache Load Error:', err.message);
    }

    // 이번 탐지 세션의 임시 키워드(이번만 적용 / 이번만 제외) 동적 결합
    const tempPolluted = (this.session && Array.isArray(this.session.tempPollutedKeywords))
      ? this.session.tempPollutedKeywords
      : [];
    const tempAllowed = (this.session && Array.isArray(this.session.tempAllowedKeywords))
      ? this.session.tempAllowedKeywords
      : [];

    // 1. 이번만 제외(허용) 키워드 반영: exceptionPatterns에 최우선 추가 및 오염/의심 패턴 목록에서 제외
    if (tempAllowed.length > 0) {
      const allowedLowerSet = new Set(tempAllowed.map(k => k.toLowerCase()));
      for (const kw of tempAllowed) {
        if (!kw) continue;
        if (!exceptionPatterns.includes(kw)) {
          exceptionPatterns.unshift(kw);
        }
        memoMap.set(kw, '이번 탐지 세션 임시 허용 단어');
      }
      for (let i = pollutedPatterns.length - 1; i >= 0; i--) {
        if (allowedLowerSet.has(pollutedPatterns[i].toLowerCase())) {
          pollutedPatterns.splice(i, 1);
        }
      }
      for (let i = suspectPatterns.length - 1; i >= 0; i--) {
        if (allowedLowerSet.has(suspectPatterns[i].toLowerCase())) {
          suspectPatterns.splice(i, 1);
        }
      }
    }

    // 2. 이번만 적용 키워드 반영: pollutedPatterns 최우선 목록에 추가 (1단계 즉시 차단 보장)
    if (tempPolluted.length > 0) {
      const allowedLowerSet = new Set(tempAllowed.map(k => k.toLowerCase()));
      for (const kw of tempPolluted) {
        if (!kw) continue;
        if (allowedLowerSet.has(kw.toLowerCase())) continue; // 제외 목록과 겹칠 경우 제외 우선
        if (!pollutedPatterns.includes(kw)) {
          pollutedPatterns.unshift(kw);
        }
        memoMap.set(kw, '이번 탐지 세션 임시 지정 오염 단어');
      }
    }

    return {
      pollutedPatterns,
      suspectPatterns,
      exceptionPatterns,
      waitPatterns,
      memoMap,
      requiredTermsMap
    };
  }

  // 4대 은닉 기법 분석 및 정밀 판정 (4단계: 대기/의심/오염/예외 적용)
  async analyzePageForViolations(dom, pageUrl) {
    const findings = [];
    let findingIdx = this.session.findings.length + 1;

    // 데이터 정화소 4단계 캐시 구축
    const cleanroom = await this.loadCleanroomPatterns();
    const { pollutedPatterns, suspectPatterns, exceptionPatterns, memoMap, requiredTermsMap } = cleanroom;
    this.pollutedMemoMap = memoMap;

    // 문서 내 모든 태그 요소 순회
    const allElements = domutils.findAll(el => el.type === 'tag', dom.children);

    for (const el of allElements) {
      // 스크립트나 스타일 태그 및 화면 렌더링 목적이 아닌 태그 제외
      if (['script', 'style', 'meta', 'link', 'noscript', 'head', 'title', 'caption', 'base', 'template'].includes(el.name)) {
        continue;
      }

      // 접근성 클래스(sound_only 등) 처리
      const classAttr = el.attribs && el.attribs.class ? el.attribs.class.toLowerCase() : '';
      const isAccessibilityClass = classAttr.includes('sound_only') || classAttr.includes('sd_hidden') || classAttr.includes('blind');

      // 스크립트와 스타일 코드가 제거된 순수 텍스트만 추출
      const text = getPureElementText(el).trim();
      if (!text || text.length < 2) continue;

      // 순수 스크린리더 UI 단어(초기화, 축소, 확대, 열린, 검색 등)는 즉시 제외
      if (isAccessibilityContent(text, classAttr)) {
        continue;
      }

      if (isNormalWebContent(text, classAttr)) {
        continue;
      }

      // 접근성 클래스인데 불법/사행성 징후가 전혀 없으면 정상 건너뜀
      if (isAccessibilityClass) {
        const testCombined = combineJamo(text);
        const hasSuspicion = pollutedPatterns.some(p => text.includes(p) || testCombined.includes(p)) ||
                             Boolean(findMatchedSuspectKeyword([text, testCombined], suspectPatterns, memoMap, requiredTermsMap)) ||
                             hasRealJamoSequence(text);
        if (!hasSuspicion) {
          continue;
        }
      }

      const style = el.attribs && el.attribs.style ? el.attribs.style.toLowerCase() : '';

      // 내용 기법 검사에서 중단되더라도 동일 요소의 은닉 스타일 기법은 각각 별도로 기록한다.
      const hiddenTechniques = [];
      const hasTransparentStyle =
        /opacity\s*:\s*0(\.0+)?/i.test(style) ||
        /color\s*:\s*transparent/i.test(style) ||
        /color\s*:\s*rgba\([^)]*,\s*0\)/i.test(style) ||
        (style.includes('color: #fff') && style.includes('background: #fff')) ||
        (style.includes('color: #ffffff') && style.includes('background: #ffffff')) ||
        (style.includes('color: white') && style.includes('background: white')) ||
        classAttr.includes('visually-hidden') ||
        classAttr.includes('sr-only');
      const hasOffscreenStyle =
        (/position\s*:\s*(absolute|fixed)/i.test(style) && (/left\s*:\s*-\d{3,}/i.test(style) || /top\s*:\s*-\d{3,}/i.test(style))) ||
        /font-size\s*:\s*(0px|0|1px)/i.test(style) ||
        /display\s*:\s*none/i.test(style);
      if (hasTransparentStyle) hiddenTechniques.push('TRANSPARENT');
      if (hasOffscreenStyle) hiddenTechniques.push('OFFSCREEN');

      if (hiddenTechniques.length > 0 && !isAccessibilityContent(text, classAttr) && !isNormalWebContent(text, classAttr)) {
        const hiddenNormalizedText = normalizeFullwidth(text);
        const hiddenPollutedMatch = findMatchedKeyword(hiddenNormalizedText, pollutedPatterns, memoMap) ||
                                    findMatchedKeyword(text, pollutedPatterns, memoMap);
        const hiddenSuspectMatch = findMatchedSuspectKeyword([hiddenNormalizedText, text], suspectPatterns, memoMap, requiredTermsMap);
        const hiddenIsPolluted = Boolean(hiddenPollutedMatch);
        const hiddenMatch = hiddenPollutedMatch || hiddenSuspectMatch;

        if (hiddenMatch && (hiddenIsPolluted || !exceptionPatterns.some(c => text.includes(c)))) {
          const matchedKw = hiddenMatch.keyword || '';
          const matchedMemo = hiddenMatch.memo || '';
          let isIllegal = false;
          let aiReason = '';
          try {
            const aiRes = await llmPipelineService.classifyText(text, {
              masterId: this.session.masterId,
              url: pageUrl,
              siteProfile: this.session.siteProfile || '',
              isPolluted: hiddenIsPolluted,
              matchedKeyword: matchedKw,
              matchedMemo
            });
            if (aiRes) {
              isIllegal = aiRes.isViolation;
              aiReason = aiRes.reason;
            }
          } catch (e) {
            if (hiddenIsPolluted) isIllegal = true;
          }

          if (isIllegal) {
            const snippet = extractEvidenceSnippet(text, matchedKw);
            const loc = this.buildCssLocation(el, dom);
            const styleSummary = style ? style.slice(0, 50).replace(/[\r\n\t]+/g, '') : '은닉 스타일';
            const patternTypeLabel = hiddenIsPolluted ? '오염' : '의심';
            for (const hiddenTechnique of hiddenTechniques) {
              const techniqueLabel = hiddenTechnique === 'TRANSPARENT' ? '투명 텍스트 은닉' : '화면 밖 은닉';
              const reasonStr = `${techniqueLabel} (${styleSummary}) + ${patternTypeLabel} 패턴 검출 ('${matchedKw}') + AI 위반 판정${aiReason ? ` (${aiReason})` : ''}`;
              findings.push({
                id: `f_${String(findingIdx++).padStart(3, '0')}`,
                url: pageUrl,
                is_violation: true,
                location: loc,
                evidence_text: snippet,
                technique: hiddenTechnique,
                reason: reasonStr,
                matched_keyword: matchedKw,
                extra_finding: reasonStr
              });
            }
          }
        }
      }

      // [1단계: 원문 그대로 오염 패턴 매칭 (무조건 실행)]
      // DB t_cleanroom에 등록된 오염(POLLUTED) 단어(예: 'ㅅㅓㅇㅁㅐㅁㅐ', 'ㅋㅏㅈㅣㄴㅗ' 등 자모분리 은어 및 확정 오염어)와
      // 공백 분리 도메인 등 명백한 불법 은닉이 원문에 그대로 포함되어 있는지 무조건 먼저 매칭
      const spacedDom = extractSpacedDomain(text);
      const matchInfo = findMatchedKeyword(text, pollutedPatterns, memoMap);

      if (matchInfo || spacedDom) {
        const isCommentArea = isCommentAreaElement(el);
        const areaTag = isCommentArea ? '[댓글 영역] ' : '';
        let matchedKw = matchInfo ? matchInfo.keyword : spacedDom;
        const snippet = extractEvidenceSnippet(text, matchedKw);
        const technique = classifyPollutedPattern(matchedKw);
        const reasonStr = technique === 'JAMO'
          ? `${areaTag}자모 분해 은닉 패턴 검출 (오염 확정 단어: '${matchedKw}') [즉시 차단]`
          : technique === 'HOMOGLYPH'
          ? `${areaTag}닮은꼴 글자 위장 패턴 검출 (오염 확정 단어: '${matchedKw}') [즉시 차단]`
          : `${areaTag}오염 확정 패턴 검출 ('${matchedKw}') [즉시 차단]`;
        const loc = this.buildCssLocation(el, dom);

        try {
          if (llmPipelineService && typeof llmPipelineService.saveDetectLog === 'function') {
            llmPipelineService.saveDetectLog({
              masterId: this.session.masterId,
              url: pageUrl,
              inputKo: snippet || text,
              promptEn: `Direct blocked by cleanroom polluted database: "${matchedKw}"`,
              responseEn: `VIOLATION: Confirmed illegal spam in cleanroom polluted database.`,
              responseKo: `[오염 확정] 정화소 오염 패턴('${matchedKw}') 일치로 즉시 불법 스팸 차단`,
              similarityVal: 1.0,
              isIllegal: 1,
              confidence: 99,
              modelName: 'cleanroom-polluted-filter',
              deviceMode: 'AUTO'
            });
          }
        } catch (logErr) {}

        findings.push({
          id: `f_${String(findingIdx++).padStart(3, '0')}`,
          url: pageUrl,
          is_violation: true,
          location: loc,
          evidence_text: snippet,
          technique,
          reason: reasonStr,
          matched_keyword: matchedKw,
          extra_finding: reasonStr
        });
        continue;
      }

      // [2단계: 자모 분리 고의 은닉 검사 (분리 상태에서 정화소 단어와 직접 비교)]
      const hasRealJamo = hasRealJamoSequence(text);

      if (hasRealJamo) {
        // 본문 내 공백/특수기호/변칙자모가 정규화된 순수 분리 상태 스트림 추출
        const jamoStream = extractNormalizedJamoStream(text);

        // [분리 상태 비교 1] 정화소에 이미 등록된 자모 분리 오염 패턴과 분리 상태 직접 비교
        let matchedKw = null;
        let matchedDecomposed = null;

        for (const p of pollutedPatterns) {
          if (/[ㄱ-ㅎㅏ-ㅣ]{2,}/.test(p) && jamoStream.includes(p)) {
            matchedKw = p;
            matchedDecomposed = p;
            break;
          }
        }

        // [분리 상태 비교 2] 정화소 오염 키워드 및 불법 키워드의 '자모 분해 형태'와 분리 상태 직접 비교
        // 예: 정화소 키워드 '성매매' -> 자모 분해 'ㅅㅓㅇㅁㅐㅁㅐ', 본문의 'ㅅ ㅓ ㅇ ㅁ ㅐ ㅁ ㅐ' -> 분리 상태 100% 일치!
        // 반면 본문에 '성매매'(완성형)로 적혀있는 경우 jamoStream에는 완성형만 있으므로 분리 상태 불일치(오탐 원천 차단)!
        if (!matchedKw) {
          const targetKeywords = pollutedPatterns;
          for (const kw of targetKeywords) {
            if (!kw || kw.length < 2) continue;
            const decomposed = decomposeToJamo(kw);
            // 최소 2음절(자모 4자 이상) 분해 키워드가 본문의 자모 분리 스트림에 그대로 존재하는지 비교
            if (decomposed.length >= 4 && jamoStream.includes(decomposed)) {
              matchedKw = kw;
              matchedDecomposed = decomposed;
              break;
            }
          }
        }

        // 분리 상태에서 정화소 단어와 일치한 경우: 사람이 글자 그대로 자모를 쪼개어 은닉한 것이므로 JAMO 즉시 차단!
        if (matchedKw) {
          const snippet = extractEvidenceSnippet(text, matchedKw) || extractEvidenceSnippet(text, matchedDecomposed);
          const reasonStr = `자모 분해 은닉 패턴 검출 (분리 상태 일치: '${matchedKw}' [${matchedDecomposed}]) [즉시 차단]`;
          const loc = this.buildCssLocation(el, dom);

          try {
            if (llmPipelineService && typeof llmPipelineService.saveDetectLog === 'function') {
              llmPipelineService.saveDetectLog({
                masterId: this.session.masterId,
                url: pageUrl,
                inputKo: snippet || text,
                promptEn: `Direct blocked JAMO obfuscation: "${matchedKw}"`,
                responseEn: `VIOLATION: Confirmed JAMO obfuscation in decomposed state.`,
                responseKo: `[오염 확정] 자모 분해 은닉 단어('${matchedKw}') 분리 상태 일치로 즉시 불법 스팸 차단`,
                similarityVal: 1.0,
                isIllegal: 1,
                confidence: 99,
                modelName: 'cleanroom-polluted-filter',
                deviceMode: 'AUTO'
              });
            }
          } catch (logErr) {}

          findings.push({
            id: `f_${String(findingIdx++).padStart(3, '0')}`,
            url: pageUrl,
            is_violation: true,
            location: loc,
            evidence_text: snippet,
            technique: 'JAMO',
            reason: reasonStr,
            matched_keyword: matchedKw,
            extra_finding: reasonStr
          });
          continue;
        }

        // [분리 상태 비교 3] 정화소 '의심(SUSPECT)' 키워드의 자모 분해 형태와 분리 상태 비교
        // 의심 단어가 자모 분리되어 은닉된 경우 -> 결합 후 LLM에게 문맥 판정 요청!
        let suspectJamoKw = null;
        const combinedJamoText = combineJamo(text);
        for (const s of suspectPatterns) {
          if (!s || s.length < 2) continue;
          const decomposed = decomposeToJamo(s);
          if (decomposed.length >= 4 && jamoStream.includes(decomposed) &&
              findMatchedSuspectKeyword([combinedJamoText, text], [s], memoMap, requiredTermsMap)) {
            suspectJamoKw = s;
            break;
          }
        }

        if (suspectJamoKw) {
          // [예외 단어 확인] 의심 자모 단어 판정 시점에 예외 패턴(EXCEPTION)이 포함되어 있으면 즉시 정상 통과 (오탐 방지)
          if (exceptionPatterns.some(c => text.includes(c) || jamoStream.includes(c))) {
            continue;
          }

          const matchedMemo = memoMap.get(suspectJamoKw) || '불법 의심 은어';
          const snippet = extractEvidenceSnippet(text, suspectJamoKw);
          const combined = combinedJamoText;

          let isIllegal = false;
          let aiReason = '';
          try {
            const aiRes = await llmPipelineService.classifyText(combined, {
              masterId: this.session.masterId,
              url: pageUrl,
              siteProfile: this.session.siteProfile || '',
              isPolluted: false,
              matchedKeyword: suspectJamoKw,
              matchedMemo
            });
            if (aiRes) {
              isIllegal = aiRes.isViolation;
              aiReason = aiRes.reason;
            }
          } catch (e) {}

          if (isIllegal) {
            const loc = this.buildCssLocation(el, dom);
            findings.push({
              id: `f_${String(findingIdx++).padStart(3, '0')}`,
              url: pageUrl,
              is_violation: true,
              location: loc,
              evidence_text: snippet,
              technique: 'JAMO',
              reason: `자모 분해 은닉 패턴 (의심 검토: ${aiReason})`,
              matched_keyword: suspectJamoKw,
              extra_finding: `의심 패턴 LLM 검토: ${aiReason}`
            });
            continue;
          }
        }
      }

      // [기법 2] 닮은꼴 글자 위장 (HOMOGLYPH)
      const hasFullwidth = /[\uFF01-\uFF5E]/.test(text);
      if (hasFullwidth) {
        const normalized = normalizeFullwidth(text);

        if (isNormalWebContent(normalized, this.buildCssLocation(el, dom))) {
          continue;
        }

        // 실제 불법 키워드 매칭 여부 정밀 확인 (오염 패턴 매칭)
        const matchInfo = findMatchedKeyword(normalized, pollutedPatterns, memoMap) ||
                          findMatchedKeyword(text, pollutedPatterns, memoMap);

        // 매칭된 불법 키워드가 없으면 단순 전각 문자(예: 첨부파일명의 전각 숫자 등)이므로 스킵
        if (!matchInfo || !matchInfo.keyword) {
          continue;
        }

        // 전각 정규화를 거쳐 비로소 불법 키워드가 드러난 경우에만 HOMOGLYPH 은닉으로 확정 (원문에 이미 평문이 있던 경우는 평문 의심어로 처리)
        const isHomoglyphObfuscation = pollutedPatterns.some(p => !text.includes(p) && normalized.includes(p));

        if (isHomoglyphObfuscation) {
          const matchedKw = matchInfo.keyword;
          const snippet = extractEvidenceSnippet(text, matchedKw);
          const reasonStr = `닮은꼴 글자(전각) 위장 패턴 검출 (매칭 단어: '${matchedKw}') [즉시 차단]`;
          const loc = this.buildCssLocation(el, dom);

          try {
            if (llmPipelineService && typeof llmPipelineService.saveDetectLog === 'function') {
              llmPipelineService.saveDetectLog({
                masterId: this.session.masterId,
                url: pageUrl,
                inputKo: snippet || text,
                promptEn: `Direct blocked by cleanroom polluted database: "${matchedKw}"`,
                responseEn: `VIOLATION: Confirmed illegal spam in cleanroom polluted database.`,
                responseKo: `[오염 확정] 정화소 오염 패턴('${matchedKw}') 일치로 즉시 불법 스팸 차단`,
                similarityVal: 1.0,
                isIllegal: 1,
                confidence: 99,
                modelName: 'cleanroom-polluted-filter',
                deviceMode: 'AUTO'
              });
            }
          } catch (logErr) {
            console.warn('[Log Save Warn]', logErr.message);
          }

          findings.push({
            id: `f_${String(findingIdx++).padStart(3, '0')}`,
            url: pageUrl,
            is_violation: true,
            location: loc,
            evidence_text: snippet,
            technique: 'HOMOGLYPH',
            reason: reasonStr,
            matched_keyword: matchedKw,
            extra_finding: reasonStr
          });
          continue;
        }

        // [4단계 - 의심 (SUSPECT)]
        const suspectMatchInfo = findMatchedSuspectKeyword([normalized, text], suspectPatterns, memoMap, requiredTermsMap);
        if (suspectMatchInfo) {
          // [예외 단어 확인] 의심 패턴 판정 시점에 예외 패턴(EXCEPTION)이 포함되어 있으면 즉시 정상 통과
          if (exceptionPatterns.some(c => text.includes(c) || normalized.includes(c))) {
            continue;
          }

          const matchedKw = suspectMatchInfo.keyword;
          const matchedMemo = suspectMatchInfo.memo || (memoMap.get(matchedKw) || '의심 은어');
          const snippet = extractEvidenceSnippet(text, matchedKw);

          let isIllegal = false;
          let aiReason = '';
          try {
            const aiRes = await llmPipelineService.classifyText(normalized || text, {
              masterId: this.session.masterId,
              url: pageUrl,
              siteProfile: this.session.siteProfile || '',
              isPolluted: false,
              matchedKeyword: matchedKw,
              matchedMemo
            });
            if (aiRes) {
              isIllegal = aiRes.isViolation;
              aiReason = aiRes.reason;
            }
          } catch (e) {}

          if (isIllegal) {
            const loc = this.buildCssLocation(el, dom);
            findings.push({
              id: `f_${String(findingIdx++).padStart(3, '0')}`,
              url: pageUrl,
              is_violation: true,
              location: loc,
              evidence_text: snippet,
              technique: 'HOMOGLYPH',
              reason: `닮은꼴 글자 위장 (의심 검토: ${aiReason})`,
              matched_keyword: matchedKw,
              extra_finding: `의심 패턴 LLM 검토: ${aiReason}`
            });
            continue;
          }
        }
      }

    }

    return findings;
  }

  // 보이는 텍스트에서 불법광고 탐지 (ETC - 4단계 대기/의심/오염/예외 적용)
  async analyzeVisibleText(dom, pageUrl) {
    const findings = [];
    let findingIdx = this.session.findings.length + 1;
    const similarityCheck = { event: 'spam_similarity_page', masterId: this.session.masterId, url: pageUrl, status: 'completed', vectorCount: llmPipelineService.getSpamVectorCount(), eligibleChunks: 0, attempts: 0, successes: 0, errors: 0, maxScore: 0, firstError: null };

    // 데이터 정화소 4단계 패턴 로드
    const cleanroom = await this.loadCleanroomPatterns();
    const { pollutedPatterns, suspectPatterns, exceptionPatterns, memoMap, requiredTermsMap } = cleanroom;

    // 본문 영역의 텍스트 블록 추출 (h1~h6, p, span, a, td, li, div, article, section 등)
    const textTags = new Set(['h1','h2','h3','h4','h5','h6','p','span','a','td','th','li','strong','em','b','label','div','article','section','blockquote','dd','dt']);
    const contentElements = domutils.findAll(el => el.type === 'tag' && textTags.has(el.name), dom.children);

    // 분석할 텍스트 블록 수집 (중복 제거)
    const analyzedTexts = new Set();
    const llmCache = new Map();
    let pageLlmCount = 0;
    const maxPageLlmCount = 8; // 단일 페이지당 최대 AI 판정 횟수 제한 (과도한 지연 방지)

    for (const el of contentElements) {
      // 자식 요소가 실제 문장을 가지고 있고 현재 요소에 독립적인 직접 문장이 없으면
      // 상위 컨테이너의 합쳐진 문장을 생략하여 같은 내용을 여러 번 분석하지 않는다.
      const children = Array.isArray(el.children) ? el.children : [];
      const directText = children
        .filter(child => child.type === 'text')
        .map(child => child.data || '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      const hasTextBearingChild = children.some(child =>
        child.type === 'tag' && getPureElementText(child).replace(/\s+/g, ' ').trim().length >= 4
      );
      if (hasTextBearingChild && directText.length < 4) continue;

      // <br> 태그가 \n으로 변환된 순수 텍스트 추출
      const rawText = getVisibleCandidateText(el, getPureElementText);
      if (!rawText || rawText.length < 4) continue;

      const textChunks = splitTextForInference(rawText, aiModelConfig.inference.maxInputChars);

      for (const text of textChunks) {
        if (analyzedTexts.has(text)) continue;
        analyzedTexts.add(text);

        const hasRealJamo = hasRealJamoSequence(text);
        const combinedText = hasRealJamo ? combineJamo(text) : text;

        if (isNormalWebContent(text) && isNormalWebContent(combinedText)) continue;
        similarityCheck.eligibleChunks++;

        // [2단계: t_defense 인메모리 스팸 벡터 초고속 유사도 매칭 (1순위 선제 타격)]
        let spamSimScore = 0;
        let matchedSpamText = null;
        if (combinedText.length >= 6 && typeof llmPipelineService.getSpamVectorCount === 'function' && llmPipelineService.getSpamVectorCount() > 0) {
          similarityCheck.attempts++;
          try {
            // 연속 추론 중에도 서버가 화면 갱신과 상태 요청을 처리할 수 있게 합니다.
            await new Promise(resolve => setImmediate(resolve));
            const simRes = await llmPipelineService.calculateMaxSpamSimilarity(combinedText);
            similarityCheck.successes++;
            if (simRes) {
              spamSimScore = simRes.maxSim;
              matchedSpamText = simRes.matchedSpam;
              if (Number.isFinite(spamSimScore)) similarityCheck.maxScore = Math.max(similarityCheck.maxScore, spamSimScore);
            }
          } catch (simErr) {
            similarityCheck.errors++;
            if (!similarityCheck.firstError) similarityCheck.firstError = simErr.message;
          }
        }

        // 스팸 패턴과의 유사도가 설정된 차단 기준을 넘으면 즉시 확정한다.
        if (spamSimScore >= aiModelConfig.inference.similarityBlockThreshold) {
          const directPollutedMatch = findMatchedKeyword(text, pollutedPatterns, memoMap);
          const snippet = extractEvidenceSnippet(text, text.slice(0, 20));
          const reasonStr = `스팸 학습 패턴 고유사도 검출 (${(spamSimScore * 100).toFixed(1)}% 일치, 기준패턴: '${(matchedSpamText || '').slice(0, 25)}')`;
          const loc = this.buildCssLocation(el, dom);
          findings.push({
            id: `f_${String(findingIdx++).padStart(3, '0')}`,
            url: pageUrl,
            is_violation: true,
            location: loc,
            evidence_text: snippet,
            technique: directPollutedMatch ? classifyPollutedPattern(directPollutedMatch.keyword) : 'ETC',
            reason: reasonStr,
            matched_keyword: text.slice(0, 30),
            extra_finding: reasonStr
          });
          continue;
        }

        // [3단계: t_cleanroom 오염(POLLUTED) 패턴 원문 매칭 (무조건 실행)]
        const spacedDom = extractSpacedDomain(text);
        const matchInfo = findMatchedKeyword(text, pollutedPatterns, memoMap);

        if (matchInfo || spacedDom) {
          const isCommentArea = isCommentAreaElement(el);
          const areaTag = isCommentArea ? '[댓글 영역] ' : '';
          let matchedKw = matchInfo ? matchInfo.keyword : spacedDom;
          const snippet = extractEvidenceSnippet(text, matchedKw);
          const technique = classifyPollutedPattern(matchedKw);
          const reasonStr = technique === 'JAMO'
            ? `${areaTag}자모 분해 은닉 패턴 검출 (오염 확정 단어: '${matchedKw}') [즉시 차단]`
            : technique === 'HOMOGLYPH'
            ? `${areaTag}닮은꼴 글자 위장 패턴 검출 (오염 확정 단어: '${matchedKw}') [즉시 차단]`
            : `${areaTag}노출 텍스트 오염 패턴 검출 (식별: '${matchedKw}') [즉시 차단]`;
          const loc = this.buildCssLocation(el, dom);

          try {
            if (llmPipelineService && typeof llmPipelineService.saveDetectLog === 'function') {
              llmPipelineService.saveDetectLog({
                masterId: this.session.masterId,
                url: pageUrl,
                inputKo: snippet || text,
                promptEn: `Direct blocked visible spam: "${matchedKw}"`,
                responseEn: `VIOLATION: Confirmed illegal spam in cleanroom polluted database or domain obfuscation.`,
                responseKo: `[오염 확정] 노출 본문 오염 패턴('${matchedKw}') 일치로 즉시 불법 스팸 차단`,
                similarityVal: 1.0,
                isIllegal: 1,
                confidence: 99,
                modelName: 'cleanroom-polluted-filter',
                deviceMode: 'AUTO'
              });
            }
          } catch (logErr) {}

          findings.push({
            id: `f_${String(findingIdx++).padStart(3, '0')}`,
            url: pageUrl,
            is_violation: true,
            location: loc,
            evidence_text: snippet,
            technique,
            reason: reasonStr,
            matched_keyword: matchedKw,
            extra_finding: reasonStr
          });
          continue;
        }

        // [자모 분리 고의 은닉 검사 (분리 상태에서 정화소 단어와 직접 비교)]
        if (hasRealJamo) {
          const jamoStream = extractNormalizedJamoStream(text);

          // [분리 상태 비교 1] 정화소에 이미 등록된 자모 분리 오염 패턴과 분리 상태 직접 비교
          let matchedKw = null;
          let matchedDecomposed = null;

          for (const p of pollutedPatterns) {
            if (/[ㄱ-ㅎㅏ-ㅣ]{2,}/.test(p) && jamoStream.includes(p)) {
              matchedKw = p;
              matchedDecomposed = p;
              break;
            }
          }

          // [분리 상태 비교 2] 정화소 오염 키워드 및 불법 키워드의 '자모 분해 형태'와 분리 상태 직접 비교
          if (!matchedKw) {
            const targetKeywords = pollutedPatterns;
            for (const kw of targetKeywords) {
              if (!kw || kw.length < 2) continue;
              const decomposed = decomposeToJamo(kw);
              if (decomposed.length >= 4 && jamoStream.includes(decomposed)) {
                matchedKw = kw;
                matchedDecomposed = decomposed;
                break;
              }
            }
          }

          // 분리 상태에서 정화소 단어와 일치한 경우: 사람이 자모를 쪼개어 은닉한 것이므로 JAMO 즉시 차단!
          if (matchedKw) {
            const snippet = extractEvidenceSnippet(text, matchedKw) || extractEvidenceSnippet(text, matchedDecomposed);
            const reasonStr = `자모 분해 은닉 패턴 검출 (분리 상태 일치: '${matchedKw}' [${matchedDecomposed}]) [즉시 차단]`;
            const loc = this.buildCssLocation(el, dom);

            try {
              if (llmPipelineService && typeof llmPipelineService.saveDetectLog === 'function') {
                llmPipelineService.saveDetectLog({
                  masterId: this.session.masterId,
                  url: pageUrl,
                  inputKo: snippet || text,
                  promptEn: `Direct blocked visible JAMO obfuscation: "${matchedKw}"`,
                  responseEn: `VIOLATION: Confirmed JAMO obfuscation in decomposed state.`,
                  responseKo: `[오염 확정] 노출 본문 자모 분해 은닉('${matchedKw}') 분리 상태 일치로 즉시 불법 스팸 차단`,
                  similarityVal: 1.0,
                  isIllegal: 1,
                  confidence: 99,
                  modelName: 'cleanroom-polluted-filter',
                  deviceMode: 'AUTO'
                });
              }
            } catch (logErr) {}

            findings.push({
              id: `f_${String(findingIdx++).padStart(3, '0')}`,
              url: pageUrl,
              is_violation: true,
              location: loc,
              evidence_text: snippet,
              technique: 'JAMO',
              reason: reasonStr,
              matched_keyword: matchedKw,
              extra_finding: reasonStr
            });
            continue;
          }
        }

        // [3단계-A: 자모분리 상태에서는 통과했으나, 결합해 보니 정화소 '차단(POLLUTED)' 키워드가 나온 경우]
        // 결합 결과가 확정 오염이므로 검출 즉시 차단 (LLM 불필요)
        const matchPollutedAfterCombine = findMatchedKeyword(combinedText, pollutedPatterns, memoMap);
        if (matchPollutedAfterCombine) {
          const matchedKw = matchPollutedAfterCombine.keyword;
          const snippet = extractEvidenceSnippet(text, matchedKw) || extractEvidenceSnippet(combinedText, matchedKw);
          const reasonStr = `자모 결합 복원 결과 오염(차단) 패턴 검출 ('${matchedKw}') [즉시 차단]`;
          const loc = this.buildCssLocation(el, dom);

          try {
            if (llmPipelineService && typeof llmPipelineService.saveDetectLog === 'function') {
              llmPipelineService.saveDetectLog({
                masterId: this.session.masterId,
                url: pageUrl,
                inputKo: snippet || text,
                promptEn: `Direct blocked after combine: "${matchedKw}"`,
                responseEn: `VIOLATION: Confirmed polluted keyword revealed after JAMO combine.`,
                responseKo: `[오염 확정] 자모 결합 복원 결과 오염(차단) 패턴('${matchedKw}') 일치로 즉시 차단`,
                similarityVal: 1.0,
                isIllegal: 1,
                confidence: 99,
                modelName: 'cleanroom-polluted-filter',
                deviceMode: 'AUTO'
              });
            }
          } catch (logErr) {}

          findings.push({
            id: `f_${String(findingIdx++).padStart(3, '0')}`,
            url: pageUrl,
            is_violation: true,
            location: loc,
            evidence_text: snippet,
            technique: hasRealJamo ? 'JAMO' : 'ETC',
            reason: reasonStr,
            matched_keyword: matchedKw,
            extra_finding: reasonStr
          });
          continue;
        }

        // [5단계: t_cleanroom 의심(SUSPECT) 단어 및 검토 구간 유사도 AI 교차 판정]
        // 결합 평문(combinedText) 또는 원문 평문(text)에 의심 키워드가 있으면 -> 반드시 LLM에게 문맥 판정 요청!
        const suspectMatchInfo = findMatchedSuspectKeyword([combinedText, text], suspectPatterns, memoMap, requiredTermsMap);
        const isSuspectMatch = Boolean(suspectMatchInfo) ||
                               pollutedPatterns.some(p => text.includes(p) || combinedText.includes(p)) ||
                               (spamSimScore >= aiModelConfig.inference.similarityReviewThreshold);

      if (isSuspectMatch) {
        // [예외 단어 확인] 의심 단어나 중위험 유사도 판정 시점에 예외 패턴(EXCEPTION)이 포함되어 있으면 즉시 정상 통과 (오탐 차단 및 LLM 절약)
        if (exceptionPatterns.some(c => text.includes(c) || combinedText.includes(c))) {
          continue;
        }

        const matchInfo = suspectMatchInfo ||
                          findMatchedKeyword(combinedText, pollutedPatterns, memoMap) ||
                          findMatchedKeyword(text, pollutedPatterns, memoMap);
        // 중위험 유사도만으로 들어온 문장에는 실제로 일치한 의심 단어가 없다.
        // 가상의 단어와 뜻을 LLM에 넣으면 정상 문맥이 오염되므로 비워서 원문만 판정한다.
        const matchedKw = matchInfo ? matchInfo.keyword : '';
        const matchedMemo = matchInfo ? matchInfo.memo : '';

        try {
          const textForAi = combinedText || text;
          const llmCacheKey = JSON.stringify([
            textForAi,
            matchedKw || '',
            matchedMemo || '',
            this.session.siteProfile || ''
          ]);
          let aiRes = llmCache.get(llmCacheKey);
          if (!aiRes && pageLlmCount < maxPageLlmCount) {
            pageLlmCount++;
            const remainSecAi = Math.max(0, Math.floor((this.session.scanDeadlineAtMs - Date.now()) / 1000));
            const rMinAi = Math.floor(remainSecAi / 60);
            const rSecAi = String(remainSecAi % 60).padStart(2, '0');
            this.session.currentStep = `[${this.session.visitedUrls.size}p / 남은시간 ${rMinAi}:${rSecAi}] LLM 판정 중 (${pageLlmCount}/${maxPageLlmCount}): ${(matchedKw || '').slice(0, 15)}`;
            aiRes = await llmPipelineService.classifyText(textForAi, {
              masterId: this.session.masterId,
              url: pageUrl,
              siteProfile: this.session.siteProfile || '',
              isPolluted: false,
              matchedKeyword: matchedKw,
              matchedMemo,
              similarityScore: spamSimScore
            });
            if (aiRes) {
              llmCache.set(llmCacheKey, aiRes);
            }
          }

          if (aiRes && aiRes.isViolation && aiRes.confidence >= 65) {
            const snippet = extractEvidenceSnippet(text, matchedKw);
            const reasonStr = getRefinedCategoryReason(matchedKw, matchedMemo, aiRes);
            const loc = this.buildCssLocation(el, dom);
            findings.push({
              id: `f_${String(findingIdx++).padStart(3, '0')}`,
              url: pageUrl,
              is_violation: true,
              location: loc,
              evidence_text: snippet,
              technique: 'ETC',
              reason: reasonStr,
              matched_keyword: matchedKw,
              extra_finding: reasonStr
            });
          }
        } catch (llmErr) {
          console.warn('[LLM Visible Text Error]', llmErr.message);
          const matchInfo = findMatchedKeyword(text, pollutedPatterns, memoMap);
          if (matchInfo) {
            const matchedKw = matchInfo.keyword;
            const snippet = extractEvidenceSnippet(text, matchedKw);
            const reasonStr = getRefinedCategoryReason(matchedKw, matchInfo.memo, null);
            const loc = this.buildCssLocation(el, dom);

            findings.push({
              id: `f_${String(findingIdx++).padStart(3, '0')}`,
              url: pageUrl,
              is_violation: true,
              location: loc,
              evidence_text: snippet,
              technique: 'ETC',
              reason: reasonStr,
              matched_keyword: matchedKw,
              extra_finding: reasonStr
            });
          }
        }
      }
    }
  }

    similarityCheck.findings = findings.length;
    logWrite(config.paths.logsDir, similarityCheck);
    return findings;
  }

  // 세션 종료 및 표준 result.json 생성
  async finalizeSession(statusOverride = null) {
    if (this.session.timerId) {
      clearInterval(this.session.timerId);
      this.session.timerId = null;
    }

    // Puppeteer 브라우저 종료
    try {
      await browserInspector.closeBrowser();
    } catch (e) {}

    this.session.finishedAt = new Date().toISOString();
    if (this.session.startedAtMs) {
      this.session.elapsedSec = Math.max(0, Math.round((Date.now() - this.session.startedAtMs) / 1000));
    }
    if (statusOverride) {
      this.session.status = statusOverride;
      if (statusOverride === 'STOPPED') {
        this.session.currentStep = '점검 사용자에 의해 중단됨';
      }
    } else if (this.session.status !== 'STOPPED') {
      this.session.status = 'COMPLETED';
      this.session.currentStep = this.session.endedForResultReserve
        ? '탐지 종료 및 결과 파일 정리 완료'
        : '전체 하위 페이지 및 요소 점검 완료';
    }

    const reports = buildResultReports({
      entry_url: this.session.entryUrl,
      started_at: this.session.startedAt,
      finished_at: this.session.finishedAt,
      elapsed_sec: this.session.elapsedSec,
      tool_version: '1.0.0'
    }, this.session.findings);

    // 두 파일을 매번 새로 생성하여 이전 점검의 추가 탐지 결과가 남지 않도록 함
    try {
      const rootResultPath = path.join(config.paths.outputDir, 'result.json');
      fs.writeFileSync(rootResultPath, JSON.stringify(reports.main, null, 2), 'utf8');
      console.log(`[DetectEngine] result.json 표준 결과 파일 생성 완료: ${rootResultPath}`);
    } catch (fsErr) {
      console.error('[DetectEngine] result.json 저장 오류:', fsErr.message);
    }

    try {
      const extraPath = path.join(config.paths.outputDir, 'result_extra.json');
      fs.writeFileSync(extraPath, JSON.stringify(reports.extra, null, 2), 'utf8');
      console.log(`[DetectEngine] result_extra.json 추가 탐지 결과 파일 생성 완료: ${extraPath}`);
    } catch (fsErr) {
      console.error('[DetectEngine] result_extra.json 저장 오류:', fsErr.message);
    }

    // DB 마스터 레코드 갱신
    try {
      if (this.session.masterId) {
        await commonDAO.execute_query('detectMapper.updateDetectMasterComplete', {
          id: this.session.masterId,
          status: this.session.status || 'COMPLETED',
          finished_at: this.session.finishedAt,
          elapsed_sec: this.session.elapsedSec,
          total_pages: this.session.visitedUrls.size,
          violation_count: reports.counts.main + reports.counts.extra
        });
        console.log(`[DetectEngine] 마스터 레코드 완료 갱신: ID=${this.session.masterId}, status=${this.session.status}`);
      } else {
        // 혹시 masterId가 누락되었을 경우 즉시 신규 등록
        const insRes = await commonDAO.execute_query('detectMapper.insertDetectMaster', {
          entry_url: this.session.entryUrl,
          title: this.session.masterTitle || this.session.entryUrl,
          started_at: this.session.startedAt,
          tool_version: '1.0.0'
        });
        if (insRes && insRes.info && insRes.info.insertId) {
          this.session.masterId = insRes.info.insertId;
          await commonDAO.execute_query('detectMapper.updateDetectMasterComplete', {
            id: this.session.masterId,
            status: this.session.status || 'COMPLETED',
            finished_at: this.session.finishedAt,
            elapsed_sec: this.session.elapsedSec,
            total_pages: this.session.visitedUrls.size,
            violation_count: reports.counts.main + reports.counts.extra
          });
        }
      }

      // DB t_detect_list에 모든 findings가 누락 없이 저장되었는지 최종 보정 동기화
      if (this.session.masterId && this.session.findings.length > 0) {
        for (const f of this.session.findings) {
          try {
            await commonDAO.execute_query('detectMapper.insertDetectFinding', {
              master_id: this.session.masterId,
              finding_id: f.id,
              url: f.url,
              is_violation: f.is_violation ? 1 : 0,
              location: f.location,
              evidence_text: f.evidence_text,
              technique: f.technique,
              extra_finding: f.extra_finding || f.reason || null
            });
          } catch (ignoreDuplicateErr) {}
        }
      }
    } catch (dbFinErr) {
      console.error('[DetectEngine] Master Complete Update Error:', dbFinErr.message);
    }
  }
}

// 싱글톤 인스턴스
const detectEngine = new DetectEngine();
detectEngine._testing = {
  parsePagingInfoFromHref,
  extractBoardSpec,
  getBoardIdentityKey,
  needsDynamicLinkDiscovery,
  isArticleDetailPageUrl,
  parseRequiredTerms,
  findMatchedSuspectKeyword,
  getNonstandardPort,
  extractGetSearchForms,
  selectReflectionProbePattern,
  buildReflectionProbeUrl,
  inspectReflectedProbeHtml,
  isNavigableLinkElement,
  hasBoardAuthoringControl,
  isExposedIndexBoard
};

module.exports = detectEngine;
