const digitLookalikes = { O: '0', o: '0', I: '1', l: '1', S: '5', s: '5', B: '8' };

function classifyPollutedPattern(pattern) {
  const text = String(pattern || '');
  if (/[ㄱ-ㅎㅏ-ㅣ]{2,}/u.test(text)) return 'JAMO';
  if (/[\uFF01-\uFF5E]/u.test(text)) return 'HOMOGLYPH';

  if (/^[A-Za-z0-9]{3,}$/u.test(text) && /\d/u.test(text)) {
    const normalized = text.replace(/[OoIlSsB]/gu, character => digitLookalikes[character]);
    if (normalized !== text && /^\d{3,}$/u.test(normalized)) return 'HOMOGLYPH';
  }

  return 'ETC';
}

module.exports = { classifyPollutedPattern };
