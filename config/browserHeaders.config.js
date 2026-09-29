/**
 * 사람다운 브라우저 랜덤 헤더 생성 모듈 (browserHeaders.config.js)
 * - User-Agent 목록은 .env 의 BROWSER_USER_AGENTS 환경변수로부터 읽어옵니다.
 * - Client Hints(sec-ch-ua), Accept, Accept-Language, Sec-Fetch-* 등 실제 사람 브라우저 헤더를 동적 생성합니다.
 */

function getUserAgentsFromEnv() {
  const raw = process.env.BROWSER_USER_AGENTS || '';
  const list = raw.split('|').map(s => s.trim()).filter(Boolean);
  if (list.length > 0) return list;
  return [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  ];
}

/**
 * .env 설정 기반 랜덤 User-Agent 및 실제 사람 브라우저 헤더 세트 반환
 * @param {string} referer - Referer URL (선택)
 * @param {string} origin - Origin URL (선택)
 * @returns {object} HTTP Headers 객체
 */
function getRandomHumanHeaders(referer, origin) {
  const uas = getUserAgentsFromEnv();
  const chosenUa = uas[Math.floor(Math.random() * uas.length)];

  const isMac = chosenUa.includes('Macintosh') || chosenUa.includes('Mac OS');
  const isFirefox = chosenUa.includes('Firefox');
  const isEdge = chosenUa.includes('Edg/');

  const headers = {
    'User-Agent': chosenUa,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Upgrade-Insecure-Requests': '1',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache'
  };

  // Chromium 기반인 경우 Client Hints(sec-ch-ua) 주입
  if (!isFirefox) {
    if (isEdge) {
      headers['sec-ch-ua'] = '"Chromium";v="123", "Microsoft Edge";v="123", "Not:A-Brand";v="8"';
    } else {
      headers['sec-ch-ua'] = '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"';
    }
    headers['sec-ch-ua-mobile'] = '?0';
    headers['sec-ch-ua-platform'] = isMac ? '"macOS"' : '"Windows"';
    headers['Sec-Fetch-Dest'] = 'document';
    headers['Sec-Fetch-Mode'] = 'navigate';
    headers['Sec-Fetch-Site'] = referer ? 'same-origin' : 'none';
    headers['Sec-Fetch-User'] = '?1';
  }

  if (referer) headers['Referer'] = referer;
  if (origin) headers['Origin'] = origin;

  return headers;
}

module.exports = { getRandomHumanHeaders, getUserAgentsFromEnv };
