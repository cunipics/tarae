const test = require('node:test');
const assert = require('node:assert/strict');
const htmlparser2 = require('htmlparser2');
const domutils = require('domutils');
const detectEngine = require('../service/detectEngine');

const { isNavigableLinkElement } = detectEngine._testing;

function firstTag(html, tagName) {
  const dom = htmlparser2.parseDocument(html);
  return domutils.findOne(el => el.type === 'tag' && el.name === tagName, dom.children);
}

test('stylesheet link is not treated as a navigable external link', () => {
  const element = firstTag(
    '<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard/dist/web/static/pretendard.css">',
    'link'
  );
  assert.equal(isNavigableLinkElement(element), false);
});

test('user navigation elements remain detectable', () => {
  assert.equal(isNavigableLinkElement(firstTag('<a href="https://bad.example/">이동</a>', 'a')), true);
  assert.equal(isNavigableLinkElement(firstTag('<iframe src="https://bad.example/"></iframe>', 'iframe')), true);
  assert.equal(isNavigableLinkElement(firstTag('<tr data-href="/board/view/1"><td>제목</td></tr>', 'tr')), true);
});
