// 한글 자모 분해 및 처리 유틸리티

const CHOSUNG = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
const JUNGSUNG = ['ㅏ','ㅐ','ㅑ','ㅒ','ㅓ','ㅔ','ㅕ','ㅖ','ㅗ','ㅘ','ㅙ','ㅚ','ㅛ','ㅜ','ㅝ','ㅞ','ㅟ','ㅠ','ㅡ','ㅢ','ㅣ'];
const JONGSUNG = ['', 'ㄱ','ㄲ','ㄳ','ㄴ','ㄵ','ㄶ','ㄷ','ㄹ','ㄺ','ㄻ','ㄼ','ㄽ','ㄾ','ㄿ','ㅀ','ㅁ','ㅂ','ㅄ','ㅅ','ㅆ','ㅇ','ㅈ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];

/**
 * 한글 문자열을 자모(초성, 중성, 종성)로 분해합니다.
 * 예: '카지노' -> 'ㅋㅏㅈㅣㄴㅗ'
 *     '성매매' -> 'ㅅㅓㅇㅁㅐㅁㅐ'
 *     'LSD' -> 'LSD'
 * @param {string} str
 * @returns {string}
 */
function decomposeHangul(str) {
  if (!str) return '';
  let result = '';
  for (const ch of str) {
    const code = ch.charCodeAt(0);
    if (code >= 0xAC00 && code <= 0xD7A3) {
      const sIndex = code - 0xAC00;
      const choIdx = Math.floor(sIndex / (21 * 28));
      const jungIdx = Math.floor((sIndex % (21 * 28)) / 28);
      const jongIdx = sIndex % 28;
      result += CHOSUNG[choIdx] + JUNGSUNG[jungIdx];
      if (jongIdx > 0) {
        result += JONGSUNG[jongIdx];
      }
    } else {
      result += ch;
    }
  }
  return result;
}

/**
 * 문자열 내에 완성형 한글이 1자 이상 포함되어 있는지 확인합니다.
 * @param {string} str
 * @returns {boolean}
 */
function hasHangul(str) {
  if (!str) return false;
  for (const ch of str) {
    const code = ch.charCodeAt(0);
    if (code >= 0xAC00 && code <= 0xD7A3) return true;
  }
  return false;
}

module.exports = {
  CHOSUNG,
  JUNGSUNG,
  JONGSUNG,
  decomposeHangul,
  hasHangul
};
