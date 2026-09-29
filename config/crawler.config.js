/**
 * 크롤러 URL 수집 설정 (crawler.config.js)
 * - 설정값은 config/crawler-settings.json 에 저장됩니다.
 * - 파일이 없으면 아래 기본값이 사용됩니다.
 */
const path = require('path');
const fs   = require('fs');

const SETTINGS_FILE = path.join(__dirname, 'crawler-settings.json');

function getDefaults() {
  return {
    useSearchDork:   true,   // 알려진 검색내용 활용 (DuckDuckGo Dorking)
    useCommonCrawl:  false,  // Common Crawl 역조회 사용 (기본 OFF)
    useUrlscan:      false,  // urlscan.io 히스토리 사용 (기본 OFF)
    useCmsVulnDict:  true,   // 알려진 취약점 공략 (CMS 딕셔너리)
    useRssFeed:      true,   // RSS/Atom 피드 URL 씨드 수집
    useUrlNormalize: true,   // URL 무한증식 방지 정규화
    maxPathDepth:    6       // 최대 경로 깊이 (초과 시 URL 버퍼 제외)
  };
}

function getConfig() {
  const defaults = getDefaults();
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      return { ...defaults, ...saved };
    }
  } catch (e) {}
  return { ...defaults };
}

function saveConfig(settings) {
  const defaults = getDefaults();
  const result = {};
  for (const [key, defVal] of Object.entries(defaults)) {
    if (settings[key] !== undefined) {
      if (typeof defVal === 'boolean') {
        result[key] = (settings[key] === true || settings[key] === 'true' || settings[key] === 1 || settings[key] === '1');
      } else {
        const parsed = parseInt(settings[key], 10);
        result[key] = (isNaN(parsed) || parsed < 1) ? defVal : parsed;
      }
    } else {
      result[key] = defVal;
    }
  }
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(result, null, 2), 'utf8');
  return result;
}

module.exports = { getConfig, saveConfig, getDefaults };
