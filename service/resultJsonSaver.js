const fs = require('fs/promises');
const path = require('path');

async function saveResultJson(payload, { app }) {
  const content = payload && payload.content;
  if (typeof content !== 'string' || !content.trim()) {
    return { status: 'error', message: '저장할 JSON 내용이 없습니다.' };
  }

  try {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.findings)) {
      return { status: 'error', message: '점검 결과 JSON 형식이 올바르지 않습니다.' };
    }
  } catch (error) {
    return { status: 'error', message: 'JSON 내용을 읽을 수 없습니다: ' + error.message };
  }

  const suggestedName = payload.suggestedName === 'result_extra.json' ? 'result_extra.json' : 'result.json';
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const downloadsPath = app.getPath('downloads');

  try {
    for (let number = 0; number < 1000; number++) {
      const suffix = number ? `_${number}` : '';
      const folderPath = path.join(downloadsPath, `FCMS_${stamp}${suffix}`);
      try {
        await fs.mkdir(folderPath);
      } catch (error) {
        if (error.code === 'EEXIST') continue;
        throw error;
      }
      const filePath = path.join(folderPath, suggestedName);
      await fs.writeFile(filePath, content, 'utf8');
      return { status: 'saved', path: filePath };
    }
    return { status: 'error', message: '같은 이름의 저장 파일이 너무 많습니다.' };
  } catch (error) {
    return { status: 'error', message: error.message };
  }
}

module.exports = { saveResultJson };
