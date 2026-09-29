window.saveDisplayedResultJson = async function (content, sourcePath, button, statusEl) {
  if (!content) {
    statusEl.textContent = '저장할 JSON 내용이 없습니다.';
    return;
  }

  button.disabled = true;
  statusEl.textContent = '저장 중입니다...';
  try {
    const suggestedName = String(sourcePath || '').split(/[\\/]/).pop() === 'result_extra.json'
      ? 'result_extra.json' : 'result.json';

    const url = URL.createObjectURL(new Blob([content], { type: 'application/json;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = suggestedName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    statusEl.textContent = '다운로드를 시작했습니다.';
  } catch (error) {
    statusEl.textContent = '저장 실패: ' + error.message;
  } finally {
    button.disabled = false;
  }
};
