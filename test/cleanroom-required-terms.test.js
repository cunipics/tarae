const test = require('node:test');
const assert = require('node:assert/strict');
const detectEngine = require('../service/detectEngine');

const { parseRequiredTerms, findMatchedSuspectKeyword } = detectEngine._testing;

test('짝 단어 목록을 쉼표와 줄바꿈으로 정리한다', () => {
  assert.deepEqual(parseRequiredTerms('마약, 판매\n구매,마약'), ['마약', '판매', '구매']);
});

test('짝 단어가 없는 의심 패턴은 기존 방식으로 찾는다', () => {
  const result = findMatchedSuspectKeyword('불법 카지노 광고', ['카지노'], new Map(), new Map());
  assert.equal(result.keyword, '카지노');
});

test('짝 단어가 없는 케이는 인라인스케이트에서 무시한다', () => {
  const required = new Map([['케이', ['마약', '판매', '구매']]]);
  const result = findMatchedSuspectKeyword('인라인스케이트 강사 모집', ['케이'], new Map(), required);
  assert.equal(result, null);
  assert.equal(findMatchedSuspectKeyword('인라인스케이트 판매', ['케이'], new Map(), required), null);
});

test('짝 단어가 함께 나온 케이는 의심 패턴으로 찾는다', () => {
  const required = new Map([['케이', ['마약', '판매', '구매']]]);
  const result = findMatchedSuspectKeyword('케이 판매 문의', ['케이'], new Map(), required);
  assert.equal(result.keyword, '케이');
  assert.equal(findMatchedSuspectKeyword('케이판매 문의', ['케이'], new Map(), required).keyword, '케이');
});

test('아이스크림은 무시하고 마약 판매 문맥의 아이스는 찾는다', () => {
  const required = new Map([['아이스', ['마약', '판매', '필로폰']]]);
  assert.equal(findMatchedSuspectKeyword('아이스크림 행사', ['아이스'], new Map(), required), null);
  assert.equal(findMatchedSuspectKeyword('아이스크림 판매 행사', ['아이스'], new Map(), required), null);
  assert.equal(findMatchedSuspectKeyword('아이스 판매 텔레 문의', ['아이스'], new Map(), required).keyword, '아이스');
});

test('LSD와 MDMA는 마약 관련 짝 단어가 있을 때만 찾는다', () => {
  const required = new Map([
    ['LSD', ['마약', '환각', '판매', '구매']],
    ['MDMA', ['마약', '엑스터시', '판매', '구매']]
  ]);

  assert.equal(findMatchedSuspectKeyword('통계 분석은 LSD 검정을 사용했다', ['LSD'], new Map(), required), null);
  assert.equal(findMatchedSuspectKeyword('행사 코드 MDMA 안내', ['MDMA'], new Map(), required), null);
  assert.equal(findMatchedSuspectKeyword('LSD 판매 문의', ['LSD'], new Map(), required).keyword, 'LSD');
  assert.equal(findMatchedSuspectKeyword('MDMA 엑스터시 구매', ['MDMA'], new Map(), required).keyword, 'MDMA');
});
