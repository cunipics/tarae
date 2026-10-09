const crypto = require('crypto');

function randomIntInclusive(min, max) {
  if (max <= min) return min;
  return crypto.randomInt(min, max + 1);
}

function shuffleSecure(values) {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomIntInclusive(0, i);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function pickRandomPages(min, max, count, excluded = new Set()) {
  if (count <= 0 || max < min) return [];
  const candidates = [];
  for (let page = min; page <= max; page++) {
    if (!excluded.has(page)) candidates.push(page);
  }
  return shuffleSecure(candidates).slice(0, Math.min(count, candidates.length));
}

function generateRandomStratifiedPageNumbers(totalPages, pagesToSample) {
  const total = Math.max(1, Math.floor(Number(totalPages) || 1));
  const sampleCount = Math.min(total, Math.max(1, Math.floor(Number(pagesToSample) || 1)));
  if (sampleCount === 1) return [1];

  const selected = new Set([1]);
  let remaining = sampleCount - 1;

  if (total <= 60) {
    for (const page of pickRandomPages(2, total, remaining, selected)) selected.add(page);
  } else {
    let nearSlots;
    let farSlots;
    if (remaining === 1) {
      nearSlots = randomIntInclusive(0, 1);
      farSlots = 1 - nearSlots;
    } else {
      nearSlots = Math.max(1, Math.round(remaining * 0.45));
      farSlots = Math.max(1, remaining - nearSlots);
      if (nearSlots + farSlots > remaining) nearSlots--;
    }

    for (const page of pickRandomPages(2, 60, nearSlots, selected)) selected.add(page);
    for (const page of pickRandomPages(61, total, farSlots, selected)) selected.add(page);

    remaining = sampleCount - selected.size;
    if (remaining > 0) {
      for (const page of pickRandomPages(2, total, remaining, selected)) selected.add(page);
    }
  }

  const randomPages = shuffleSecure([...selected].filter(page => page !== 1));
  return [1, ...randomPages];
}

function roundRobinByKey(items, keySelector) {
  const groups = new Map();
  for (const item of items) {
    const key = String(keySelector(item) || 'unknown');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const activeGroups = shuffleSecure([...groups.values()]);
  const result = [];
  let remaining = items.length;
  while (remaining > 0) {
    for (const group of activeGroups) {
      if (group.length === 0) continue;
      result.push(group.shift());
      remaining--;
    }
  }
  return result;
}

function conservativePageDurationMs(samples, fallbackMs) {
  const valid = samples.filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (valid.length === 0) return Math.max(1000, Number(fallbackMs) || 2000);
  const index = Math.min(valid.length - 1, Math.ceil(valid.length * 0.75) - 1);
  return Math.max(500, valid[index]);
}

function estimateRemainingCapacity(samples, remainingMs, fallbackMs, hardLimit) {
  const pageMs = conservativePageDurationMs(samples, fallbackMs);
  const capacity = Math.max(0, Math.floor(Math.max(0, remainingMs) / pageMs));
  const parsedLimit = Number(hardLimit);
  const limit = Number.isFinite(parsedLimit) ? Math.max(0, parsedLimit) : capacity;
  return {
    pageMs,
    capacity: Math.min(limit, capacity)
  };
}

function planBoardSampling(totalPages, visitBudget) {
  const total = Math.max(1, Math.floor(Number(totalPages) || 1));
  const budget = Math.max(1, Math.floor(Number(visitBudget) || 1));
  const listPageCount = Math.min(total, budget, Math.max(1, Math.round(Math.sqrt(budget))));
  const remainingForArticles = Math.max(0, budget - listPageCount);
  const postsPerList = Math.max(1, Math.floor(remainingForArticles / listPageCount));

  return {
    listPageCount,
    postsPerList,
    plannedVisits: listPageCount * (1 + postsPerList)
  };
}

function getBoardPriorityWeight(isExposedIndex, hasAuthoringControl) {
  if (isExposedIndex && hasAuthoringControl) return 2.5;
  if (isExposedIndex || hasAuthoringControl) return 2;
  return 1;
}

function applyBoardPriorityWeight(baseBudget, weight) {
  const base = Math.max(1, Math.floor(Number(baseBudget) || 1));
  const safeWeight = Math.min(2.5, Math.max(1, Number(weight) || 1));
  return Math.max(base, Math.floor(base * safeWeight));
}

function partitionInOrder(items, primaryLimit) {
  const values = Array.isArray(items) ? items : [];
  const limit = Math.max(0, Math.min(values.length, Math.floor(Number(primaryLimit) || 0)));
  return {
    primary: values.slice(0, limit),
    reserve: values.slice(limit)
  };
}

module.exports = {
  generateRandomStratifiedPageNumbers,
  roundRobinByKey,
  shuffleSecure,
  conservativePageDurationMs,
  estimateRemainingCapacity,
  planBoardSampling,
  getBoardPriorityWeight,
  applyBoardPriorityWeight,
  partitionInOrder
};
