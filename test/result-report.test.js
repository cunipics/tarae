const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { buildResultReports } = require('../service/resultReport');
const { saveResultJson } = require('../service/resultJsonSaver');

test('점검 회차별 결과는 표준 기법과 추가 탐지를 분리하고 중복을 제외한다', () => {
  const master = {
    entry_url: 'https://example.org/',
    started_at: '2026-09-27T09:00:00.000Z',
    finished_at: '2026-09-27T09:03:04.000Z',
    elapsed_sec: 1819
  };
  const rows = [
    { url: 'https://example.org/a?b=2&a=1', location: 'h1', technique: 'ETC', is_violation: 1, evidence_text: '광고', extra_finding: '스팸' },
    { url: 'http://example.org/a?a=1&b=2', location: 'h1', technique: 'ETC', is_violation: 1, evidence_text: '중복 광고', extra_finding: '스팸' },
    { url: 'https://example.org/a?a=1&b=2', location: 'h1', technique: 'JAMO', is_violation: 1, evidence_text: '자모 분해' }
  ];
  const reports = buildResultReports(master, rows);
  assert.deepEqual(reports.counts, { main: 1, extra: 1, raw: 3, duplicate: 1 });
  assert.equal(reports.main.meta.elapsed_sec, 184);
  assert.equal(reports.extra.meta.elapsed_sec, 184);
  assert.deepEqual(Object.keys(reports.main), ['meta', 'findings']);
  assert.deepEqual(Object.keys(reports.extra), ['meta', 'findings']);
  assert.equal(reports.main.findings[0].technique, 'JAMO');
  assert.equal(reports.extra.findings[0].technique, 'ETC');
  assert.equal(reports.extra.findings[0].extra_finding, '스팸');
  assert.equal(reports.extra.findings[0].id, 'f_001');
});

test('Electron 저장은 실행 파일 폴더에 정확한 제출 파일명을 쓴다', async t => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fcms-result-test-'));
  t.after(async () => {
    if (path.dirname(tempDir) === os.tmpdir() && path.basename(tempDir).startsWith('fcms-result-test-')) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
  const content = JSON.stringify({ meta: {}, findings: [] });
  const saved = await saveResultJson({ content, suggestedName: 'result_extra.json' }, { outputDir: tempDir });
  assert.equal(saved.status, 'saved');
  assert.equal(path.basename(saved.path), 'result_extra.json');
  assert.equal(path.dirname(saved.path), tempDir);
  assert.equal(await fs.readFile(saved.path, 'utf8'), content);
});

test('검색 오염 탐지는 추가 결과에서 세부 기법을 유지한다', () => {
  const master = {
    entry_url: 'https://example.org/',
    started_at: '2026-10-01T00:00:00.000Z',
    finished_at: '2026-10-01T00:01:00.000Z'
  };
  const rows = [
    { url: 'https://example.org:46028/', location: '노출된 색인 URL', technique: 'NONSTANDARD_PORT', is_violation: 1, evidence_text: '비표준 포트', extra_finding: '색인 오염' },
    { url: 'https://example.org/search?q=test', location: '사이트 GET 검색 결과', technique: 'REFLECTED_SEARCH', is_violation: 1, evidence_text: '입력값 반사', extra_finding: '반사형 검색 오염' }
  ];

  const reports = buildResultReports(master, rows);
  assert.equal(reports.main.findings.length, 0);
  assert.deepEqual(reports.extra.findings.map(item => item.technique), ['ETC', 'ETC']);
  assert.deepEqual(reports.extra.findings.map(item => item.extra_finding), ['색인 오염', '반사형 검색 오염']);
});
