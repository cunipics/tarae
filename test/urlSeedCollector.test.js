const test = require('node:test');
const assert = require('node:assert/strict');
const logger = require('../utils/logger');
const originalWrite = logger.write;
logger.write = function () {};
const { fetchDuckDuckGoDorkUrls } = require('../service/urlSeedCollector');
logger.write = originalWrite;

test('DuckDuckGo HTTP 202는 결과 0건으로 기록하지 않는다', async () => {
  const originalFetch = global.fetch;
  const originalLog = console.log;
  const originalWarn = console.warn;
  const lines = [];
  const requests = [];
  const requestTimes = [];
  global.fetch = async function (url, options) {
    requests.push({ url, options });
    requestTimes.push(Date.now());
    return { status: 202, url: 'https://lite.duckduckgo.com/lite/', text: async () => '<title> DuckDuckGo </title>' };
  };
  console.log = (...args) => lines.push(args.join(' '));
  console.warn = (...args) => lines.push(args.join(' '));
  try {
    const urls = await fetchDuckDuckGoDorkUrls('example.org', 'https://example.org/', ['바카라', '카지노'], 40);
    assert.equal(urls.size, 0);
    assert.equal(requests.length, 2);
    assert.equal(new URLSearchParams(requests[0].options.body).get('q'), 'site:example.org 바카라');
    assert.equal(new URLSearchParams(requests[1].options.body).get('q'), 'site:example.org 카지노');
    assert.match(requests[0].url, /lite\.duckduckgo\.com/);
    assert.match(requests[1].url, /lite\.duckduckgo\.com/);
    assert.ok(requestTimes[1] - requestTimes[0] >= 30);
    assert.equal(lines.some(line => line.includes('결과 링크: 0개')), false);
    assert.equal(lines.some(line => line.includes('색인 여부를 확인하지 못했습니다')), true);
  } finally {
    global.fetch = originalFetch;
    console.log = originalLog;
    console.warn = originalWarn;
  }
});

test('정상 검색 응답의 대상 도메인 링크는 계속 수집한다', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async function () {
    calls++;
    return {
      status: 200,
      url: 'https://lite.duckduckgo.com/lite/',
      text: async () => '<title>site:example.org 바카라 at DuckDuckGo</title><a href="https://example.org/post/1">결과</a>'
    };
  };
  try {
    const urls = await fetchDuckDuckGoDorkUrls('example.org', 'https://example.org/', ['바카라'], 0);
    assert.equal(urls.has('https://example.org/post/1'), true);
    assert.equal(calls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Lite 결과가 없을 때만 지연 후 HTML을 조회한다', async () => {
  const originalFetch = global.fetch;
  const requestTimes = [];
  global.fetch = async function (url) {
    requestTimes.push(Date.now());
    return {
      status: 200,
      url,
      text: async () => requestTimes.length === 1
        ? '<title>DuckDuckGo Lite</title>'
        : '<title>DuckDuckGo HTML</title><a href="https://example.org/post/2">결과</a>'
    };
  };
  try {
    const urls = await fetchDuckDuckGoDorkUrls('example.org', 'https://example.org/', ['바카라', '카지노'], 40);
    assert.equal(requestTimes.length, 2);
    assert.ok(requestTimes[1] - requestTimes[0] >= 30);
    assert.equal(urls.has('https://example.org/post/2'), true);
  } finally {
    global.fetch = originalFetch;
  }
});
