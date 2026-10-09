const test = require('node:test');
const assert = require('node:assert/strict');
const htmlparser2 = require('htmlparser2');
const detectEngine = require('../service/detectEngine');

const {
  getNonstandardPort,
  extractGetSearchForms,
  buildReflectionProbeUrl,
  inspectReflectedProbeHtml
} = detectEngine._testing;

test('노출된 색인 URL에서 비표준 포트만 구분한다', () => {
  assert.equal(getNonstandardPort('https://example.org/path'), null);
  assert.equal(getNonstandardPort('https://example.org:443/path'), null);
  assert.equal(getNonstandardPort('http://example.org:80/path'), null);
  assert.equal(getNonstandardPort('https://example.org:46028/path'), '46028');
});

test('GET 검색 폼의 실제 주소와 검색어 매개변수를 추출한다', () => {
  const dom = htmlparser2.parseDocument(`
    <form method="get" action="/bbs/search.php">
      <input type="hidden" name="bo_table" value="free">
      <select name="sfl"><option value="wr_subject" selected>제목</option></select>
      <input type="text" name="stx" placeholder="검색어">
      <button type="submit">검색</button>
    </form>
    <form method="post" action="/login"><input name="id"><input type="password" name="pw"></form>
  `);
  const forms = extractGetSearchForms(dom, 'https://example.org/bbs/board.php?bo_table=free');

  assert.equal(forms.length, 1);
  assert.equal(forms[0].actionUrl, 'https://example.org/bbs/search.php');
  assert.equal(forms[0].searchParam, 'stx');
  const probeUrl = new URL(buildReflectionProbeUrl(forms[0], 'TARAE_ㅂㅏㅋㅏㄹㅏ'));
  assert.equal(probeUrl.searchParams.get('bo_table'), 'free');
  assert.equal(probeUrl.searchParams.get('sfl'), 'wr_subject');
  assert.equal(probeUrl.searchParams.get('stx'), 'TARAE_ㅂㅏㅋㅏㄹㅏ');
});

test('검색 결과 없음 문장에 고유 시험값이 보이면 반사로 판정한다', () => {
  const payload = 'TARAE_a1b2_ㅂㅏㅋㅏㄹㅏ_a1b2';
  const reflected = inspectReflectedProbeHtml(
    `<html><head><meta name="robots" content="noindex"></head><body>검색하신 '${payload}'에 해당하는 게시물을 찾지 못했습니다.</body></html>`,
    payload,
    null,
    'https://example.org/search?q=test'
  );
  assert.equal(reflected.reflected, true);
  assert.equal(reflected.indexLimited, true);
  assert.equal(reflected.limitReason, 'noindex');

  const normal = inspectReflectedProbeHtml('<p>검색 결과가 없습니다.</p>', payload);
  assert.equal(normal.reflected, false);
});
