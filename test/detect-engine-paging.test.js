const test = require('node:test');
const assert = require('node:assert/strict');
const htmlparser2 = require('htmlparser2');
const detectEngine = require('../service/detectEngine');

const {
  parsePagingInfoFromHref,
  extractBoardSpec,
  getBoardIdentityKey,
  needsDynamicLinkDiscovery,
  isArticleDetailPageUrl,
  isBoardListPage,
  hasBoardAuthoringControl,
  isExposedIndexBoard
} = detectEngine._testing;

test('pageid 쪽 번호와 page_id 게시판 식별자를 구분한다', () => {
  const html = `
    <table><tbody>
      <tr><td><a href="/?page_id=778&mod=document&uid=10&pageid=1">첫 글</a></td></tr>
      <tr><td><a href="/?page_id=778&mod=document&uid=9&pageid=1">둘째 글</a></td></tr>
      <tr><td><a href="/?page_id=778&mod=document&uid=8&pageid=1">셋째 글</a></td></tr>
      <tr><td><a href="/?page_id=778&mod=document&uid=7&pageid=1">넷째 글</a></td></tr>
    </tbody></table>
    <nav>
      <a href="/?page_id=778&mod=list&pageid=1">1</a>
      <a href="/?page_id=778&mod=list&pageid=2">2</a>
      <a href="/?page_id=778&mod=list&pageid=786">마지막</a>
    </nav>`;
  const dom = htmlparser2.parseDocument(html);
  const paging = parsePagingInfoFromHref('/?page_id=778&mod=list&pageid=786', '마지막');
  const spec = extractBoardSpec(dom, 'http://example.test/?page_id=778');

  assert.deepEqual(paging, { type: 'query', paramKey: 'pageid', pageNum: 786 });
  assert.equal(spec.baseKey, 'http://example.test/?page_id=778');
  assert.equal(spec.pageParam.toLowerCase(), 'pageid');
  assert.equal(spec.totalPage, 786);
  assert.equal(getBoardIdentityKey('http://example.test/?page_id=778&pageid=4'), '/?page_id=778');
  assert.equal(getBoardIdentityKey('http://example.test/?page_id=999&pageid=4'), '/?page_id=999');
});

test('반복 항목과 a onclick 쪽 이동이 있는 동적 목록을 목록으로 판정한다', () => {
  const html = `
    <meta property="og:type" content="article">
    <ul>${[1, 2, 3, 4].map(index => `<li class="item"><div onclick="location.href='/detail?seq=${index}'">제품 ${index}</div></li>`).join('')}</ul>
    <div class="paging">
      <a href="javascript:void(0)" class="on">1</a>
      <a href="javascript:void(0)" onclick="movePage(2)">2</a>
      <a href="javascript:void(0)" onclick="movePage(3)">3</a>
    </div>`;
  const dom = htmlparser2.parseDocument(html);

  assert.equal(isBoardListPage(dom, 'https://example.test/products'), true);
});

test('게시물 읽기 주소는 목록 쪽 번호가 있어도 게시물로 유지한다', () => {
  assert.equal(
    isArticleDetailPageUrl('http://example.test/?page_id=778&mod=document&uid=10&pageid=4'),
    true
  );
});

test('내용과 링크가 있는 일반 게시판에는 동적 쪽 이동을 사용하지 않는다', () => {
  const normalDom = htmlparser2.parseDocument(
    '<html><body><script src="/common.js"></script><ul><li><a href="/view/1">글1</a></li><li><a href="/view/2">글2</a></li><li><a href="/view/3">글3</a></li><li><a href="/view/4">글4</a></li></ul><nav><a href="?page=1">1</a><a href="?page=2">2</a></nav></body></html>'
  );
  const shellDom = htmlparser2.parseDocument(
    '<html><body><div></div><script>document.body.dataset.ready = "1";</script></body></html>'
  );
  const routedShellDom = htmlparser2.parseDocument(
    '<html><body><nav><a href="/a">메뉴1</a><a href="/b">메뉴2</a><a href="/c">메뉴3</a><a href="/d">메뉴4</a></nav><div></div><script src="/app.js"></script></body></html>'
  );

  assert.equal(needsDynamicLinkDiscovery(normalDom, 'http://example.test/board/list'), false);
  assert.equal(needsDynamicLinkDiscovery(shellDom), true);
  assert.equal(needsDynamicLinkDiscovery(routedShellDom, 'http://example.test/board/list'), true);
});

test('게시판 작성 기능은 실제 조작 요소에서만 판정한다', () => {
  const writableDom = htmlparser2.parseDocument('<div class="board"><a href="/bbs/write.php?bo_table=notice">글쓰기</a></div>');
  const registerButtonDom = htmlparser2.parseDocument('<div class="board"><button type="button">등록</button></div>');
  const readOnlyDom = htmlparser2.parseDocument('<div class="board"><a href="/member/register">회원가입</a><button type="button">검색</button></div>');

  assert.equal(hasBoardAuthoringControl(writableDom), true);
  assert.equal(hasBoardAuthoringControl(registerButtonDom), true);
  assert.equal(hasBoardAuthoringControl(readOnlyDom), false);
});

test('노출된 게시물 주소와 같은 게시판 식별자를 연결한다', () => {
  const spec = {
    baseKey: 'https://example.test/bbs/board.php?bo_table=notice',
    sampleUrl: 'https://example.test/bbs/board.php?bo_table=notice&page=2'
  };
  const exposedUrls = new Set(['https://example.test/bbs/board.php?bo_table=notice&wr_id=33']);
  const otherUrls = new Set(['https://example.test/bbs/board.php?bo_table=free&wr_id=33']);

  assert.equal(isExposedIndexBoard(spec, exposedUrls, 'https://example.test'), true);
  assert.equal(isExposedIndexBoard(spec, otherUrls, 'https://example.test'), false);
});
