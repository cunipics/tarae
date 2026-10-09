const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const puppeteer = require('puppeteer');
const { createSnippet, defaultEditValues } = require('../static/js/detect-solution');

test('생성 코드가 해당 URL의 단일 오염 문구와 메타 정보만 바꾼다', async () => {
  const server = http.createServer((req, res) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const repeated = req.url.startsWith('/repeat');
    const scoped = req.url.startsWith('/scope');
    const link = req.url.startsWith('/link');
    const spaced = req.url.startsWith('/space');
    const targetUrl = scoped ? `${origin}/other` : repeated ? `${origin}/repeat` :
      link ? `${origin}/link` : spaced ? `${origin}/space` : `${origin}/page?a=1&b=2`;
    const snippet = createSnippet({ url: targetUrl, location: 'div.site', evidence_text: link ? '외부 연결 URL: https://bad.example/' : '오염 문구' }, {
      target_text: link ? 'https://bad.example/' : '오염 문구', clean_title: link ? '' : '정상 제목', clean_body: link ? '' : '정상 본문'
    });
    assert.equal(snippet.error, '');
    const body = link ? '<div class="site"><a href="https://bad.example/">도박 광고</a></div>' :
      spaced ? '<div class="site">오염   문구</div>' : repeated
      ? '<div class="site"><span>오염 문구</span><span>오염 문구</span></div>'
      : '<div class="site"><a href="https://bad.example/">오염 문구</a><span> 보존 문구</span></div>';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html><head><title>오염 문구 제목</title><meta name="description" content="오염 문구 설명"><meta property="og:title" content="오염 문구 제목">${snippet.code}</head><body>${body}</body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(`${origin}/page?b=2&a=1`);
    await page.waitForFunction(() => document.querySelector('.site').textContent.includes('정상 본문'));
    const applied = await page.evaluate(() => ({
      text: document.querySelector('.site').textContent,
      href: document.querySelector('.site a').getAttribute('href'),
      title: document.title,
      description: document.querySelector('meta[name="description"]').content,
      og: document.querySelector('meta[property="og:title"]').content
    }));
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(applied, {
      text: '정상 본문 보존 문구', href: null, title: '정상 제목',
      description: '정상 본문', og: '정상 제목'
    });
    await page.goto(`${origin}/scope`);
    assert.equal(await page.title(), '오염 문구 제목');
    assert.equal(await page.$eval('.site', el => el.textContent), '오염 문구 보존 문구');
    await page.goto(`${origin}/repeat`);
    assert.equal(await page.title(), '오염 문구 제목');
    assert.equal(await page.$eval('.site', el => el.textContent), '오염 문구오염 문구');
    await page.goto(`${origin}/space`);
    assert.equal(await page.$eval('.site', el => el.textContent), '정상 본문');
    await page.goto(`${origin}/link`);
    assert.equal(await page.$eval('.site', el => el.textContent), '');
    assert.equal(await page.$('.site a'), null);
    assert.equal(await page.title(), '오염 문구 제목');
    assert.equal(await page.$eval('meta[name="description"]', el => el.content), '오염 문구 설명');
    await page.close();
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('코드에 들어가는 값이 script 태그를 종료하지 않는다', () => {
  const result = createSnippet({ url: 'https://example.org/a', location: 'div.site' }, {
    target_text: '</script>오염', clean_title: defaultEditValues.title, clean_body: defaultEditValues.body
  });
  assert.equal(result.error, '');
  assert.equal(result.code.match(/<\/script>/g).length, 1);
  const lines = result.code.split('\n');
  assert.equal(lines.length, 5);
  assert.equal(lines[0], '<script>');
  assert.equal(lines[1], 'var fcmstitle="여기에 수정할 타이틀을 입력하세요";');
  assert.equal(lines[2], 'var fcmsdesc="여기에 수정할 내용을 입력하세요";');
  assert.match(lines[3], /^\(function\(\)\{var u=new URL\(/);
  assert.equal(lines[4], '</script>');
  assert.equal(lines[3].includes('fcmstitle==='), false);
  assert.equal(lines[3].includes('fcmsdesc==='), false);
});

test('탐지 건별 설정을 저장하고 다시 읽을 수 있다', async () => {
  const config = require('../config/config');
  config.db.sqlite.filename = ':memory:';
  const dao = require('../service/commonDAO');
  const master = await dao.execute_query('detectMapper.insertDetectMaster', {
    entry_url: 'https://example.org/', title: '테스트', tool_version: 'test'
  });
  assert.equal(master.ok, true);
  const key = { master_id: master.info.insertId, finding_id: 'f_001' };
  const saved = await dao.execute_query('detectMapper.upsertDetectSolution', {
    ...key, target_text: '오염 문구', clean_title: '정상 제목', clean_body: '정상 본문'
  });
  assert.equal(saved.ok, true);
  const loaded = await dao.selectList('detectMapper.selectDetectSolution', key);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.list[0].clean_title, '정상 제목');
  assert.equal(loaded.list[0].target_text, '오염 문구');
});
