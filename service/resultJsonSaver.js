const fs = require('fs/promises');
const path = require('path');

async function saveResultJson(payload, { app, outputDir } = {}) {
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
  const targetDir = outputDir || (app && app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..'));

  try {
    await fs.mkdir(targetDir, { recursive: true });
    const filePath = path.join(targetDir, suggestedName);
    await fs.writeFile(filePath, content, 'utf8');
    return { status: 'saved', path: filePath };
  } catch (error) {
    return { status: 'error', message: error.message };
  }
}

module.exports = { saveResultJson };
