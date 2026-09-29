/**
 * CMS 지문 탐지 + 알려진 취약 경로 딕셔너리 (cmsFingerprint.js)
 * - HTML meta generator, URL 패턴, 특정 파일 존재로 CMS 식별
 * - 식별된 CMS의 알려진 취약/공개 경로에 HEAD 요청 → 존재 확인 → candidateUrls 추가
 * - 대상: 그누보드5, WordPress, XE/라이믹스, 전자정부프레임워크, 나모CrossEditor, Drupal, Joomla
 */

// CMS 지문 시그니처 정의
const CMS_SIGNATURES = {
  gnuboard5: {
    metaPattern:  /그누보드|gnuboard|gnboard/i,
    urlPatterns:  [/[?&]bo_table=/, /\/bbs\/board\.php/, /\/bbs\/write\.php/],
    cookieNames:  ['ck_rememberId', 'PHPSESSID'],
    probeFiles:   ['/bbs/board.php', '/bbs/write.php']
  },
  wordpress: {
    metaPattern:  /WordPress/i,
    urlPatterns:  [/\/wp-content\//, /\/wp-includes\//],
    cookieNames:  ['wordpress_logged_in', 'wp-settings'],
    probeFiles:   ['/wp-login.php', '/wp-admin/', '/wp-json/wp/v2/posts']
  },
  xpressengine: {
    metaPattern:  /XpressEngine|라이믹스|rhymix/i,
    urlPatterns:  [/[?&]module=/, /[?&]mid=/, /document_srl=/],
    cookieNames:  ['XESSID', 'rhymix_token'],
    probeFiles:   ['/?module=board', '/?module=page', '/index.php?mid=main']
  },
  egovframework: {
    metaPattern:  /전자정부|eGovFrame|eGov/i,
    urlPatterns:  [/\.do($|\?)/, /\/uat\/uia\//, /\/cmm\/fms\//],
    cookieNames:  ['JSESSIONID'],
    probeFiles:   [
      '/uat/uia/egovLoginUsr.do',
      '/cmm/fms/FileDown.do',
      '/cmm/fms/FileUploadAjax.do',
      '/EgovLeft.do',
      '/index.do',
      '/main.do'
    ]
  },
  namo_crosseditor: {
    metaPattern:  /CrossEditor|나모/i,
    urlPatterns:  [/\/crosseditor\//, /\/editor\/crosseditor\//],
    cookieNames:  [],
    probeFiles:   ['/crosseditor/', '/editor/crosseditor/', '/FileUpload.do']
  },
  drupal: {
    metaPattern:  /Drupal/i,
    urlPatterns:  [/\/sites\/default\/files\//, /\/node\/\d+/],
    cookieNames:  ['SSESS', 'Drupal'],
    probeFiles:   ['/user/login', '/admin/']
  },
  joomla: {
    metaPattern:  /Joomla/i,
    urlPatterns:  [/\/components\/com_/, /\/option=com_/],
    cookieNames:  [],
    probeFiles:   ['/administrator/', '/index.php?option=com_users']
  }
};

// CMS별 알려진 취약/공개 경로 딕셔너리
const CMS_VULN_PATHS = {
  gnuboard5: [
    { path: '/bbs/board.php?bo_table=free',    label: 'GNU자유게시판' },
    { path: '/bbs/board.php?bo_table=notice',  label: 'GNU공지게시판' },
    { path: '/bbs/board.php?bo_table=gallery', label: 'GNU갤러리' },
    { path: '/bbs/board.php?bo_table=qna',     label: 'GNUQNA' },
    { path: '/bbs/register_form.php',          label: 'GNU회원가입' },
    { path: '/bbs/poll.php',                   label: 'GNU투표' },
    { path: '/editor/cheditor5/plugins/',      label: 'GNU에디터플러그인' },
    { path: '/bbs/ajax.filter.php',            label: 'GNU필터AJAX' }
  ],
  wordpress: [
    { path: '/wp-login.php',                   label: 'WP로그인' },
    { path: '/wp-admin/',                      label: 'WP관리자' },
    { path: '/xmlrpc.php',                     label: 'WP-XMLRPC(스팸공격경로)' },
    { path: '/?author=1',                      label: 'WP사용자열거' },
    { path: '/?author=2',                      label: 'WP사용자열거2' },
    { path: '/wp-json/wp/v2/posts',            label: 'WP REST게시물' },
    { path: '/wp-json/wp/v2/users',            label: 'WP REST사용자' },
    { path: '/wp-json/wp/v2/pages',            label: 'WP REST페이지' },
    { path: '/wp-json/wp/v2/comments',         label: 'WP REST댓글' },
    { path: '/?p=1',                           label: 'WP첫번째게시물' }
  ],
  xpressengine: [
    { path: '/?module=board&act=index',        label: 'XE게시판목록' },
    { path: '/?module=page&act=index',         label: 'XE페이지목록' },
    { path: '/?module=poll&act=index',         label: 'XE투표' },
    { path: '/?module=member&act=dispMemberLoginForm', label: 'XE로그인' },
    { path: '/?module=member&act=dispMemberSignUpForm', label: 'XE회원가입' }
  ],
  egovframework: [
    { path: '/uat/uia/egovLoginUsr.do',        label: 'eGov로그인' },
    { path: '/cmm/fms/FileDown.do',            label: 'eGov파일다운로드(CVE)' },
    { path: '/cmm/fms/FileUploadAjax.do',      label: 'eGov파일업로드(CVE)' },
    { path: '/EgovLeft.do',                    label: 'eGov좌측메뉴' },
    { path: '/index.do',                       label: 'eGov인덱스' },
    { path: '/main.do',                        label: 'eGov메인' },
    { path: '/cop/bbs/selectBoardList.do',     label: 'eGov게시판목록' },
    { path: '/cop/bbs/selectBoardArticle.do',  label: 'eGov게시글' }
  ],
  namo_crosseditor: [
    { path: '/crosseditor/',                   label: 'CrossEditor기본경로' },
    { path: '/editor/crosseditor/',            label: 'CrossEditor에디터경로' },
    { path: '/FileUpload.do',                  label: 'CrossEditor업로드(KISA)' },
    { path: '/crosseditor/index.html',         label: 'CrossEditor인덱스' }
  ],
  drupal: [
    { path: '/user/login',                     label: 'Drupal로그인' },
    { path: '/admin/',                         label: 'Drupal관리자' },
    { path: '/node/1',                         label: 'Drupal첫번째노드' }
  ],
  joomla: [
    { path: '/administrator/',                 label: 'Joomla관리자' },
    { path: '/index.php?option=com_users',     label: 'Joomla사용자' },
    { path: '/index.php?option=com_content',   label: 'Joomla콘텐츠' }
  ]
};

/**
 * HTML 및 URL로부터 CMS 유형 탐지
 * @param {string} html - 메인 페이지 HTML
 * @param {string} entryUrl - 진입 URL
 * @param {object} dom - htmlparser2 DOM (선택)
 * @returns {string|null} CMS 유형 키 ('gnuboard5', 'wordpress', ...) 또는 null
 */
function detectCmsType(html, entryUrl) {
  if (!html) return null;

  // 1. meta generator 태그 확인
  const metaMatch = html.match(/<meta[^>]*name=["']generator["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']generator["']/i);
  if (metaMatch) {
    const generator = metaMatch[1];
    for (const [cmsKey, sig] of Object.entries(CMS_SIGNATURES)) {
      if (sig.metaPattern && sig.metaPattern.test(generator)) {
        console.log(`[CmsFingerprint] meta generator 탐지: ${cmsKey} (${generator})`);
        return cmsKey;
      }
    }
  }

  // 2. URL 패턴 확인
  for (const [cmsKey, sig] of Object.entries(CMS_SIGNATURES)) {
    if (sig.urlPatterns) {
      for (const pattern of sig.urlPatterns) {
        if (pattern.test(entryUrl) || pattern.test(html.slice(0, 20000))) {
          console.log(`[CmsFingerprint] URL/HTML 패턴 탐지: ${cmsKey}`);
          return cmsKey;
        }
      }
    }
  }

  // 3. 특징적 경로 존재 빠른 확인 (HTML 내 href 포함 여부)
  if (/\/bbs\/board\.php|bo_table=/i.test(html))        return 'gnuboard5';
  if (/\/wp-content\/|\/wp-includes\//i.test(html))     return 'wordpress';
  if (/document_srl=|XpressEngine|rhymix/i.test(html))  return 'xpressengine';
  if (/\.do["'?\s]|eGovFrame|전자정부/i.test(html))      return 'egovframework';
  if (/crosseditor|나모/i.test(html))                    return 'namo_crosseditor';

  return null;
}

/**
 * 탐지된 CMS의 알려진 취약 경로에 HEAD 요청하여 존재하는 URL만 반환
 * @param {string} cmsType - CMS 유형 키
 * @param {string} origin - https://example.go.kr
 * @returns {Map} url -> { linkText } 맵
 */
async function fetchCmsVulnUrls(cmsType, origin) {
  const result = new Map();
  if (!cmsType || !CMS_VULN_PATHS[cmsType]) return result;

  const paths = CMS_VULN_PATHS[cmsType];
  console.log(`[CmsFingerprint] CMS 탐지: ${cmsType}, 취약 경로 ${paths.length}개 HEAD 검사 시작`);

  await Promise.allSettled(paths.map(async ({ path: urlPath, label }) => {
    try {
      const fullUrl = origin + urlPath;
      const resp = await fetch(fullUrl, {
        method: 'HEAD',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(3000),
        redirect: 'manual'
      });
      // 200 OK, 301/302 리다이렉트 모두 존재하는 경로로 간주
      if (resp.status === 200 || resp.status === 301 || resp.status === 302 || resp.status === 403) {
        result.set(fullUrl, { linkText: `[취약경로:${cmsType}] ${label}`, riskScore: 20 });
      }
    } catch (e) {}
  }));

  if (result.size > 0) {
    console.log(`[CmsFingerprint] 취약 경로 확인 완료: ${cmsType} 경로 ${result.size}개 존재 확인`);
  }

  return result;
}

module.exports = { detectCmsType, fetchCmsVulnUrls, CMS_VULN_PATHS };
