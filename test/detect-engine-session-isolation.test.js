const test = require('node:test');
const assert = require('node:assert/strict');

const detectEngine = require('../service/detectEngine');

test('이전 점검 작업이 끝난 뒤에만 새 세션을 시작한다', async () => {
  const originalWorkflow = detectEngine.runInspectionWorkflow;
  let releasePrevious;
  let newWorkflowStarted = false;

  detectEngine.session.status = 'RUNNING';
  detectEngine.workflowPromise = new Promise(resolve => {
    releasePrevious = resolve;
  });
  detectEngine.runInspectionWorkflow = async () => {
    newWorkflowStarted = true;
  };

  try {
    const startPromise = detectEngine.start('https://example.org', {
      maxTimeSec: 1800,
      maxPages: 20,
      speedDelayMs: 500
    });

    await new Promise(resolve => setImmediate(resolve));
    assert.equal(newWorkflowStarted, false);

    releasePrevious();
    await startPromise;
    assert.equal(newWorkflowStarted, true);
  } finally {
    if (detectEngine.session.timerId) clearInterval(detectEngine.session.timerId);
    detectEngine.session.status = 'IDLE';
    detectEngine.workflowPromise = null;
    detectEngine.runInspectionWorkflow = originalWorkflow;
  }
});
