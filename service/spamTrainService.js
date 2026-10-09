/**
 * 스팸 학습 백그라운드 비동기 처리 서비스
 * 대용량 CSV 데이터의 AI 벡터화 및 DB/메모리 적재를 백그라운드에서 안전하게 실행합니다.
 */

const commonDAO = require('./commonDAO');
const llmPipelineService = require('./llmPipelineService');

const trainState = {
  status: 'idle', // 'idle' | 'running' | 'completed' | 'error'
  total: 0,
  current: 0,
  percent: 0,
  newCount: 0,
  duplicateCount: 0,
  skippedCount: 0,
  message: '대기 중',
  startedAt: null,
  finishedAt: null,
  error: null
};

function getSpamTrainStatus() {
  return { ...trainState };
}

/**
 * 스팸 패턴 한 건을 현재 유사도 모델로 벡터화하여 DB와 메모리에 즉시 등록합니다.
 */
async function registerSingleSpamPattern(inputText) {
  const spamText = String(inputText || '').trim();

  if (spamText.length < 2) {
    return { success: false, code: 'INVALID_TEXT', message: '두 글자 이상의 패턴을 입력해 주세요.' };
  }
  if (spamText.length > 2000) {
    return { success: false, code: 'TEXT_TOO_LONG', message: '패턴은 2,000자 이내로 입력해 주세요.' };
  }

  const existCheck = await commonDAO.selectList('spamMapper.selectSpamByText', { spam_text: spamText });
  if (!existCheck || !existCheck.ok) {
    throw new Error((existCheck && existCheck.error && existCheck.error.message) || '중복 패턴 확인에 실패했습니다.');
  }
  if (existCheck.list.length > 0) {
    return { success: false, code: 'DUPLICATE', message: '이미 등록된 스팸 패턴입니다.' };
  }

  const modelStatus = llmPipelineService.getStatus();
  if (!modelStatus.loadedModels || !modelStatus.loadedModels.similarity) {
    return {
      success: false,
      code: 'MODEL_NOT_READY',
      message: 'AI 유사도 모델이 아직 준비되지 않았습니다. 모델 준비 완료 후 다시 등록해 주세요.'
    };
  }

  const vector = await llmPipelineService.generateEmbedding(spamText);
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error('패턴 벡터 생성에 실패했습니다.');
  }

  const insertResult = await commonDAO.execute_query('spamMapper.insertSpam', {
    spam_text: spamText,
    category: 'SPAM',
    vector_json: JSON.stringify(vector),
    memo: '개별 등록'
  });

  if (!insertResult || !insertResult.ok) {
    throw new Error((insertResult && insertResult.error && insertResult.error.message) || '스팸 패턴 저장에 실패했습니다.');
  }
  if (!insertResult.info || Number(insertResult.info.changes) !== 1) {
    return { success: false, code: 'DUPLICATE', message: '이미 등록된 스팸 패턴입니다.' };
  }

  const newId = Number(insertResult.info.insertId);
  llmPipelineService.addSpamVectorsToMemory({
    id: newId,
    text: spamText,
    vector
  });

  return {
    success: true,
    id: newId,
    vectorSize: vector.length,
    modelName: modelStatus.modelsConfig.similarity,
    memoryCount: llmPipelineService.getSpamVectorCount()
  };
}

/**
 * 백그라운드 스팸 학습 작업 시작
 */
async function startBackgroundSpamTrain(dataRows, colInfo) {
  if (trainState.status === 'running') {
    return {
      started: false,
      message: '이미 다른 백그라운드 스팸 학습 작업이 실행 중입니다.'
    };
  }

  const { contentColIdx, classColIdx, memoColIdx } = colInfo;

  trainState.status = 'running';
  trainState.total = dataRows.length;
  trainState.current = 0;
  trainState.percent = 0;
  trainState.newCount = 0;
  trainState.duplicateCount = 0;
  trainState.skippedCount = 0;
  trainState.message = `스팸 학습 시작 (총 ${dataRows.length}건)`;
  trainState.startedAt = new Date().toISOString();
  trainState.finishedAt = null;
  trainState.error = null;

  // 비동기 백그라운드 루프 실행
  setImmediate(async () => {
    try {
      // 유사도 모델 준비 확인
      const modelStatus = llmPipelineService.getStatus();
      if (modelStatus.status !== 'ready' && (!modelStatus.loadedModels || !modelStatus.loadedModels.similarity)) {
        trainState.message = 'AI 임베딩 모델 초기화 대기 중...';
        await llmPipelineService.startLoading();
      }

      console.log(`[Background Spam Train] 총 ${dataRows.length}건 백그라운드 학습 시작`);

      for (let i = 0; i < dataRows.length; i++) {
        // 중도 중단 신호가 있다면 탈출 가능하도록 대비
        if (trainState.status !== 'running') break;

        const row = dataRows[i];
        trainState.current = i + 1;
        trainState.percent = Math.round((trainState.current / trainState.total) * 100);

        // class 컬럼 검사 (허깅페이스: 1=정상, 2=피싱/스팸)
        if (classColIdx !== -1 && row[classColIdx] !== undefined) {
          const classVal = String(row[classColIdx]).trim();
          if (classVal === '1' || classVal.toLowerCase() === 'ham' || classVal === '정상') {
            trainState.skippedCount++;
            continue;
          }
        }

        let spamText = row[contentColIdx] ? String(row[contentColIdx]).trim() : '';
        spamText = spamText.replace(/^["']|["']$/g, '').trim();

        let memo = '허깅페이스 스팸 데이터셋';
        if (memoColIdx !== -1 && row[memoColIdx]) {
          memo = String(row[memoColIdx]).trim();
        }

        if (!spamText || spamText.length < 2) {
          trainState.skippedCount++;
          continue;
        }

        // 중복 확인
        try {
          const existCheck = await commonDAO.selectList('spamMapper.selectSpamByText', { spam_text: spamText });
          if (existCheck && existCheck.list && existCheck.list.length > 0) {
            trainState.duplicateCount++;
            continue;
          }
        } catch (dbErr) {
          console.warn('[Spam Train DB Warn]', dbErr.message);
        }

        // AI 벡터화 수행 및 DB 저장
        try {
          const vector = await llmPipelineService.generateEmbedding(spamText);
          const vectorJson = vector ? JSON.stringify(vector) : null;

          const insRes = await commonDAO.execute_query('spamMapper.insertSpam', {
            spam_text: spamText,
            category: 'SPAM',
            vector_json: vectorJson,
            memo: memo
          });

          const newId = (insRes && insRes.info) ? insRes.info.insertId : 0;
          if (vector && typeof llmPipelineService.addSpamVectorsToMemory === 'function') {
            llmPipelineService.addSpamVectorsToMemory([{
              id: newId,
              text: spamText,
              vector
            }]);
          }
          trainState.newCount++;
        } catch (embErr) {
          console.warn(`[Spam Train Embedding Warn at row ${i + 1}]`, embErr.message);
          trainState.skippedCount++;
        }

        trainState.message = `적재 중: ${trainState.current}/${trainState.total}건 (신규 ${trainState.newCount}건, 중복 ${trainState.duplicateCount}건)`;

        // CPU 부하 분산 및 이벤트 루프 블로킹 방지를 위한 미세 틱 양보
        if (i % 5 === 0) {
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      }

      trainState.status = 'completed';
      trainState.percent = 100;
      trainState.finishedAt = new Date().toISOString();
      trainState.message = `스팸 학습 완료 (신규 적재: ${trainState.newCount}건, 중복 제외: ${trainState.duplicateCount}건)`;
      console.log(`[Background Spam Train] 완료: 신규 ${trainState.newCount}건, 중복 ${trainState.duplicateCount}건, 제외 ${trainState.skippedCount}건`);

      // 완료 후 1분 뒤 idle로 자연 전환
      setTimeout(() => {
        if (trainState.status === 'completed') {
          trainState.status = 'idle';
          trainState.message = '대기 중';
        }
      }, 60000);

    } catch (err) {
      console.error('[Background Spam Train Fatal Error]', err);
      trainState.status = 'error';
      trainState.error = err.message || '백그라운드 학습 오류';
      trainState.message = '오류 발생: ' + trainState.error;
    }
  });

  return {
    started: true,
    message: '백그라운드 스팸 학습 작업이 시작되었습니다.',
    totalCount: dataRows.length
  };
}

module.exports = {
  getSpamTrainStatus,
  startBackgroundSpamTrain,
  registerSingleSpamPattern
};
