const COMPOSITE_TAGS = new Set(['div', 'article', 'section']);
const CONTENT_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'a', 'li', 'td', 'th', 'blockquote', 'dd', 'dt']);
const contentDescendantCache = new WeakMap();

function getVisibleCandidateText(element, getPureElementText) {
  if (!COMPOSITE_TAGS.has(element.name)) return getPureElementText(element).trim();

  const descendants = element.children || [];
  const hasNestedContent = descendants.some(child => {
    if (child.type !== 'tag') return false;
    if (CONTENT_TAGS.has(child.name)) return true;
    return hasContentDescendant(child);
  });
  if (!hasNestedContent) return getPureElementText(element).trim();

  return descendants
    .filter(child => child.type === 'text')
    .map(child => child.data || '')
    .join(' ')
    .trim();
}

function hasContentDescendant(element) {
  if (contentDescendantCache.has(element)) return contentDescendantCache.get(element);
  const found = (element.children || []).some(child => child.type === 'tag' &&
    (CONTENT_TAGS.has(child.name) || hasContentDescendant(child)));
  contentDescendantCache.set(element, found);
  return found;
}

function splitTextForTranslation(text, maxChars = 180) {
  const limit = Math.max(40, Number(maxChars) || 180);
  const segmenter = new Intl.Segmenter('ko', { granularity: 'sentence' });
  const parts = [];

  for (const line of String(text || '').split(/\r?\n+/)) {
    let pending = '';
    for (const item of segmenter.segment(line.trim())) {
      let remaining = item.segment.trim();
      if (!remaining) continue;
      if (remaining.length <= limit) {
        if (pending && pending.length + 1 + remaining.length > limit) {
          parts.push(pending);
          pending = '';
        }
        pending = pending ? `${pending} ${remaining}` : remaining;
        continue;
      }
      if (pending) {
        parts.push(pending);
        pending = '';
      }
      while (remaining.length > limit) {
        const wordBreak = remaining.lastIndexOf(' ', limit + 1);
        const cut = wordBreak >= Math.floor(limit / 2) ? wordBreak : limit;
        parts.push(remaining.slice(0, cut).trim());
        remaining = remaining.slice(cut).trim();
      }
      if (remaining) parts.push(remaining);
    }
    if (pending) parts.push(pending);
  }

  return parts;
}

module.exports = { getVisibleCandidateText, splitTextForTranslation };
