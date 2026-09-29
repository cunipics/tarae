/**
 * URL 정규화 및 무한증식 방지 유틸리티 (urlNormalizer.js)
 * - 추적/세션 파라미터 제거
 * - 파라미터 키 알파벳순 정렬 (동일 페이지 중복 방지)
 * - 후행 슬래시 통일, 프래그먼트 제거
 * - 파라미터 수 초과 URL 차단
 * - 경로 깊이 초과 URL 차단
 */

const REMOVE_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'fbclid', 'gclid', '_ga', '_gl', '_gid', 'ref', 'referral', 'source',
  'PHPSESSID', 'jsessionid', 'sessionid', 'SESSID', 'sid',
  '_hsenc', '_hsmi', 'mc_eid', 'mc_cid', 'mkt_tok'
]);

function decodeUrlQuerySeparators(value) {
  let decoded = String(value);
  for (let i = 0; i < 3; i++) {
    const next = decoded.replace(/&(?:amp;|#(?:0*38|x0*26);)/gi, '&');
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

function resolveCrawlUrl(rawUrl, baseUrl) {
  const url = new URL(decodeUrlQuerySeparators(rawUrl), baseUrl);
  if (url.searchParams.get('mod')?.toLowerCase() === 'list') {
    url.searchParams.delete('uid');
  }
  url.hash = '';
  return url.href;
}

function normalizeUrl(rawUrl, baseUrl) {
  try {
    const u = new URL(resolveCrawlUrl(rawUrl, baseUrl));

    // 1. 추적/세션 파라미터 제거
    for (const p of REMOVE_PARAMS) {
      u.searchParams.delete(p);
    }

    // 2. 파라미터 키 알파벳순 정렬 (같은 URL이 다른 순서로 오는 중복 방지)
    const sortedEntries = [...u.searchParams.entries()].sort((a, b) =>
      a[0].localeCompare(b[0])
    );
    u.search = '';
    for (const [k, v] of sortedEntries) {
      u.searchParams.append(k, v);
    }

    // 3. 후행 슬래시 제거 (루트 경로 / 는 유지)
    if (u.pathname !== '/' && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }

    // 4. 프래그먼트(#) 제거
    u.hash = '';

    return u.href;
  } catch (e) {
    return rawUrl;
  }
}

// 파라미터 수가 maxParams 초과하면 true (무한증식 URL)
// URL 파싱 실패 시 false 반환 (상대경로 등 파싱 불가 URL은 필터하지 않음)
function isUrlExplosion(url, maxParams = 5) {
  try {
    const count = [...new URL(url).searchParams.keys()].length;
    return count > maxParams;
  } catch (e) {
    return false;
  }
}

// 경로 깊이가 maxDepth 초과하면 true
// URL 파싱 실패 시 false 반환 (상대경로 등 파싱 불가 URL은 필터하지 않음)
function isPathTooDeep(url, maxDepth = 6) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    return parts.length > maxDepth;
  } catch (e) {
    return false;
  }
}

/**
 * candidateUrls Map 전체를 정규화하고 무한증식 URL 제거
 * @param {Map} candidateUrls - url -> { linkText } 맵
 * @param {object} config - { useUrlNormalize, maxParamCount, maxPathDepth }
 * @returns {Map} 정규화된 맵
 */
function normalizeAndFilter(candidateUrls, config) {
  if (!config || !config.useUrlNormalize) return candidateUrls;
  // 입력이 비어 있으면 그대로 반환
  if (candidateUrls.size === 0) return candidateUrls;

  const maxParams = config.maxParamCount || 5;
  const maxDepth  = config.maxPathDepth  || 6;
  const result    = new Map();
  let removedCount = 0;

  for (const [url, meta] of candidateUrls.entries()) {
    const normUrl = normalizeUrl(url);
    if (isUrlExplosion(normUrl, maxParams)) {
      removedCount++;
      continue;
    }
    if (isPathTooDeep(normUrl, maxDepth)) {
      removedCount++;
      continue;
    }
    if (!result.has(normUrl)) {
      result.set(normUrl, meta);
    }
  }

  // 안전장치: 정규화 결과가 비어 있으면 원본 반환 (전수 필터링 방지)
  if (result.size === 0 && candidateUrls.size > 0) {
    console.warn(`[UrlNormalizer] 정규화 결과가 0개로 비어 원본 ${candidateUrls.size}개를 그대로 사용합니다.`);
    return candidateUrls;
  }

  if (removedCount > 0) {
    console.log(`[UrlNormalizer] 무한증식/과다 파라미터 URL ${removedCount}개 제거, 중복 정규화 후 ${result.size}개 확보`);
  }

  return result;
}

module.exports = { resolveCrawlUrl, normalizeUrl, isUrlExplosion, isPathTooDeep, normalizeAndFilter };
