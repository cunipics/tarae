const test = require('node:test');
const assert = require('node:assert/strict');
const {
  generateRandomStratifiedPageNumbers,
  roundRobinByKey,
  conservativePageDurationMs,
  estimateRemainingCapacity,
  planBoardSampling,
  getBoardPriorityWeight,
  applyBoardPriorityWeight,
  partitionInOrder
} = require('../service/crawlScheduler');

test('페이징 표본은 최신 페이지와 근거리 및 원거리 페이지를 중복 없이 포함한다', () => {
  const pages = generateRandomStratifiedPageNumbers(300, 20);
  assert.equal(pages.length, 20);
  assert.equal(pages[0], 1);
  assert.equal(new Set(pages).size, pages.length);
  assert.equal(pages.some(page => page >= 2 && page <= 60), true);
  assert.equal(pages.some(page => page >= 61 && page <= 300), true);
  assert.equal(pages.every(page => page >= 1 && page <= 300), true);
  const repeated = new Set(Array.from({ length: 6 }, () =>
    generateRandomStratifiedPageNumbers(300, 20).join(',')));
  assert.equal(repeated.size > 1, true);
});

test('게시판 목록은 게시판별로 한 페이지씩 순환한다', () => {
  const items = [
    { board: 'a', page: 1 }, { board: 'a', page: 2 }, { board: 'a', page: 3 },
    { board: 'b', page: 1 }, { board: 'b', page: 2 }, { board: 'b', page: 3 },
    { board: 'c', page: 1 }, { board: 'c', page: 2 }, { board: 'c', page: 3 }
  ];
  const result = roundRobinByKey(items, item => item.board);
  for (let i = 1; i < result.length; i++) {
    assert.notEqual(result[i].board, result[i - 1].board);
  }
  assert.deepEqual(new Set(result.map(item => `${item.board}:${item.page}`)).size, 9);
});

test('실측 처리 시간의 느린 쪽을 기준으로 남은 처리량을 계산한다', () => {
  assert.equal(conservativePageDurationMs([1000, 2000, 3000, 9000], 1500), 3000);
  assert.deepEqual(
    estimateRemainingCapacity([1000, 2000, 3000, 9000], 30000, 1500, 5000),
    { pageMs: 3000, capacity: 10 }
  );
  assert.equal(estimateRemainingCapacity([1000], 30000, 1500, 0).capacity, 0);
});

test('게시판 처리 예산을 목록과 게시물에 남김없이 배분한다', () => {
  assert.deepEqual(planBoardSampling(1, 50), {
    listPageCount: 1,
    postsPerList: 49,
    plannedVisits: 50
  });

  const largeBoard = planBoardSampling(300, 100);
  assert.equal(largeBoard.listPageCount, 10);
  assert.equal(largeBoard.postsPerList, 9);
  assert.equal(largeBoard.plannedVisits, 100);
});

test('게시판 특성에 따라 기존 배분량에 정확한 가중치를 적용한다', () => {
  assert.equal(getBoardPriorityWeight(false, false), 1);
  assert.equal(getBoardPriorityWeight(true, false), 2);
  assert.equal(getBoardPriorityWeight(false, true), 2);
  assert.equal(getBoardPriorityWeight(true, true), 2.5);
  assert.equal(applyBoardPriorityWeight(20, 1), 20);
  assert.equal(applyBoardPriorityWeight(20, 2), 40);
  assert.equal(applyBoardPriorityWeight(20, 2.5), 50);
});

test('기본 탐색에서 선택하지 않은 게시물을 순서대로 모두 보관한다', () => {
  const posts = ['p1', 'p2', 'p3', 'p4', 'p5'];
  const result = partitionInOrder(posts, 2);
  assert.deepEqual(result.primary, ['p1', 'p2']);
  assert.deepEqual(result.reserve, ['p3', 'p4', 'p5']);
  assert.deepEqual([...result.primary, ...result.reserve], posts);
});
