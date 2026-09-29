/**
 * 공식 광고 플랫폼 관리 설정 파일 (White-list)
 * 구글 애드센스, 카카오 애드핏, 네이버 등 정상적인 상용 광고 네트워크를 등록하여
 * 불필요한 분석 부하 및 사행성 오탐(예: slotname 오탐)을 원천 차단합니다.
 * 
 * [관리 방법]
 * 추후 새로운 광고 플랫폼이 추가될 경우, 아래 'platforms' 객체에 도메인을 추가하거나,
 * .env 파일에 ADDITIONAL_AD_DOMAINS=도메인1,도메인2 형태로 지정할 수 있습니다.
 */

// 1. 공인 광고 플랫폼 기본 목록
const platforms = [
  {
    name: 'Google Ads / AdSense / DoubleClick',
    domains: [
      'googleads.g.doubleclick.net',
      'doubleclick.net',
      'googlesyndication.com',
      'adservice.google.com',
      'googleadservices.com',
      'pagead2.googlesyndication.com',
      'tpc.googlesyndication.com'
    ]
  },
  {
    name: 'Kakao AdFit / Daum Display Ads',
    domains: [
      'adfit.kakao.com',
      't1.daumcdn.net/kas',
      'display.ad.daum.net',
      'ad.daum.net'
    ]
  },
  {
    name: 'Naver AdPost / Veta Ads',
    domains: [
      'ad.naver.com',
      'siape.veta.naver.com',
      'ssl.pstatic.net/ad'
    ]
  },
  {
    name: 'Global Verified Ad Networks (Criteo, Taboola, Outbrain, etc.)',
    domains: [
      'criteo.com',
      'criteo.net',
      'taboola.com',
      'outbrain.com',
      'adnxs.com',
      'pubmatic.com',
      'rubiconproject.com',
      'adroll.com'
    ]
  }
];

// 2. .env 환경변수를 통한 추가 도메인 지원
const envAdditionalDomains = process.env.ADDITIONAL_AD_DOMAINS
  ? process.env.ADDITIONAL_AD_DOMAINS.split(',').map(d => d.trim().toLowerCase()).filter(Boolean)
  : [];

// 3. 전체 도메인 및 정규식 캐시 생성
const allAdDomains = [
  ...platforms.flatMap(p => p.domains.map(d => d.toLowerCase())),
  ...envAdditionalDomains
];

/**
 * 주어진 URL 또는 도메인 문자열이 공식 광고 플랫폼인지 판별합니다.
 * @param {string} rawUrlOrHref
 * @returns {boolean}
 */
function isAdPlatform(rawUrlOrHref) {
  if (!rawUrlOrHref || typeof rawUrlOrHref !== 'string') return false;
  const lower = rawUrlOrHref.toLowerCase();

  // 빠른 도메인 및 패턴 검색
  return allAdDomains.some(domain => {
    return lower.includes(domain);
  });
}

/**
 * 새로운 광고 플랫폼 도메인을 동적으로 런타임에 추가합니다.
 * @param {string} domain
 */
function addAdDomain(domain) {
  if (!domain || typeof domain !== 'string') return;
  const clean = domain.trim().toLowerCase();
  if (clean && !allAdDomains.includes(clean)) {
    allAdDomains.push(clean);
  }
}

module.exports = {
  platforms,
  allAdDomains,
  isAdPlatform,
  addAdDomain
};
