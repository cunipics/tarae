const test = require('node:test');
const assert = require('node:assert/strict');
const htmlparser2 = require('htmlparser2');
const domutils = require('domutils');
const { getVisibleCandidateText, splitTextForTranslation } = require('../utils/translationText');

test('바깥 영역의 합쳐진 글 대신 게시물 본문과 목록 제목을 각각 가져온다', () => {
  const dom = htmlparser2.parseDocument('<div class="content"><p>방사선 비상 발령 방법입니다.</p><ul><li><a href="/post/1">안전계통 제어케이블 시험성적서 관련 입장</a></li></ul></div>');
  const wrapper = domutils.findOne(el => el.type === 'tag' && el.name === 'div', dom.children);
  const paragraph = domutils.findOne(el => el.type === 'tag' && el.name === 'p', dom.children);
  const title = domutils.findOne(el => el.type === 'tag' && el.name === 'a', dom.children);
  const getText = el => domutils.getText(el);

  assert.equal(getVisibleCandidateText(wrapper, getText), '');
  assert.equal(getVisibleCandidateText(paragraph, getText), '방사선 비상 발령 방법입니다.');
  assert.equal(getVisibleCandidateText(title, getText), '안전계통 제어케이블 시험성적서 관련 입장');
});

test('번역할 글을 문장과 단어 경계에서 중복 없이 나눈다', () => {
  const original = '첫 번째 안내 문장입니다. 두 번째 안내 문장은 방송 시스템과 전화 안내를 설명합니다.';
  const chunks = splitTextForTranslation(original, 40);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every(chunk => chunk.length <= 40));
  assert.equal(chunks.join(' ').replace(/\s+/g, ' '), original);
});
