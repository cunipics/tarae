/**
 * AI 불법광고 탐지 3단계 q8 모델 파이프라인 서비스
 * 1. 유사도: exp-models/dragonkue-KoEn-E5-Tiny-ONNX (q8)
 * 2. 번역: Xenova/opus-mt-ko-en (q8)
 * 3. 스팸/LLM: onnx-community/bert-tiny-finetuned-sms-spam-detection-ONNX 또는 Qwen2.5
 *
 * GPU 우선 가속 시도 및 미지원 시 CPU(WASM 멀티스레드) 자동 폴백
 */

const aiConfig = require('../config/aiModel.config');
const { splitTextForTranslation } = require('../utils/translationText');

let transformersModule = null;

const state = {
  status: 'idle', // 'idle' | 'loading' | 'ready' | 'error'
  progress: 0,
  currentModel: aiConfig.similarity.modelId,
  detail: 'AI 탐지 모델 초기화 대기 중',
  deviceMode: '초기화 대기',
  gpuEnabled: false, // 디폴트 값: 꺼져 있음 (0: CPU 모드, 1: GPU 모드)
  loadedModels: {
    similarity: false,
    translation: false,
    llm: false
  },
  error: null
};

const pipelines = {
  similarity: null,
  translation: null,
  llm: null
};

// 불법도박 및 불법스팸 앵커 기준 임베딩 벡터 캐시
let cachedGamblingEmbeddings = null;

// t_defense 테이블 기반 인메모리 스팸 벡터 캐시 ([{ id, text, vector: Float32Array }])
let inMemorySpamVectors = [];

// 같은 문장을 여러 페이지와 중첩 HTML에서 다시 벡터화하지 않도록 제한된 크기로 보관한다.
const spamSimilarityCache = new Map();
const MAX_SPAM_SIMILARITY_CACHE_SIZE = 4000;

function getCachedValue(cache, key) {
  if (!cache.has(key)) return null;
  const value = cache.get(key);
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function setCachedValue(cache, key, value, maxSize) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > maxSize) {
    cache.delete(cache.keys().next().value);
  }
}

const GAMBLING_ANCHOR_SENTENCES = [
  '카지노 첫충전 보너스 코드 지급 바카라 슬롯',
  '먹튀검증 안전놀이터 문의 텔레그램 메이저 사이트',
  '무료 슬롯 체험 머니 즉시 지급 가입 혜택',
  '사설 토토 배팅 환전 첫충 매충 이벤트',
  '사설 포커 온라인 홀덤 사이공포커 환전 베팅',
  '무서류 당일 비대면 소액 대출 급전 비상금',
  '풀싸롱 호빠 룸싸롱 예약 문의 주점 전화번호',
  '강남 가라오케 셔츠룸 하이퍼블릭 유흥 예약 문의',
  '출장안마 조건만남 출장마사지 성매매 예약 문의'
];

async function getTransformers() {
  if (!transformersModule) {
    transformersModule = await import('@huggingface/transformers');
    // CPU 멀티스레드 최적화 (4스레드)
    if (transformersModule.env && transformersModule.env.backends && transformersModule.env.backends.onnx) {
      transformersModule.env.backends.onnx.wasm = transformersModule.env.backends.onnx.wasm || {};
      transformersModule.env.backends.onnx.wasm.numThreads = 4;
    }
  }
  return transformersModule;
}

function getStatus() {
  return {
    ...state,
    modelsConfig: {
      similarity: aiConfig.similarity.modelId,
      translation: aiConfig.translation.modelId,
      llm: aiConfig.llm.modelId,
      dtypes: {
        similarity: aiConfig.similarity.dtype,
        translation: aiConfig.translation.dtype,
        llm: aiConfig.llm.dtype
      }
    }
  };
}

/**
 * GPU(WebGPU) / CPU 디바이스 모드 제어
 * - state.gpuEnabled 가 true 이면 WebGPU 우선 시도 후 실패 시 CPU 폴백
 * - state.gpuEnabled 가 false (디폴트) 이면 순수 CPU (WASM 멀티스레드) 즉시 구동
 */
async function loadPipelineWithFallback(pipelineFn, task, modelName, baseOptions) {
  if (state.gpuEnabled) {
    // 1차: GPU (WebGPU) 우선 시도
    try {
      const gpuPipeline = await pipelineFn(task, modelName, {
        ...baseOptions,
        device: 'webgpu'
      });
      console.log(`[AI Pipeline] ${modelName} 모델 로딩 성공 (디바이스: GPU WebGPU)`);
      state.deviceMode = 'GPU (WebGPU 하드웨어 가속)';
      return gpuPipeline;
    } catch (gpuErr) {
      console.log(`[AI Pipeline] GPU 가속 미지원 또는 자원 부재로 CPU 모드로 자동 전환합니다 (${modelName})`);
    }
  }

  // 2차: CPU 모드 (디폴트 또는 GPU 미지원 시)
  try {
    const cpuPipeline = await pipelineFn(task, modelName, {
      ...baseOptions,
      device: 'cpu'
    });
    console.log(`[AI Pipeline] ${modelName} 모델 로딩 성공 (디바이스: CPU WASM)`);
    if (!state.deviceMode.includes('GPU')) {
      state.deviceMode = 'CPU (WASM 멀티스레드 4코어)';
    }
    return cpuPipeline;
  } catch (cpuErr) {
    // 3차: 양자화(q8 등) 전용 파일이 없는 저장소일 경우 dtype 제거 후 기본 ONNX로 안전 재시도
    if (baseOptions && baseOptions.dtype) {
      console.log(`[AI Pipeline] ${modelName} 양자화(${baseOptions.dtype}) 파일 부재, 기본 ONNX 모델로 재시도합니다.`);
      const { dtype, ...fallbackOptions } = baseOptions;
      const defaultPipeline = await pipelineFn(task, modelName, {
        ...fallbackOptions,
        device: 'cpu'
      });
      console.log(`[AI Pipeline] ${modelName} 기본 ONNX 모델 로딩 성공 (디바이스: CPU WASM)`);
      if (!state.deviceMode.includes('GPU')) {
        state.deviceMode = 'CPU (WASM 멀티스레드 4코어)';
      }
      return defaultPipeline;
    }
    throw cpuErr;
  }
}

/**
 * GPU 모드 켜기/끄기 설정 (1: GPU 모드, 0: CPU 모드)
 * 사용자가 토글 스위치를 변경했을 때 즉시 적용
 */
async function setGpuMode(enabled) {
  const nextMode = Boolean(enabled);
  if (state.gpuEnabled === nextMode) {
    return state.gpuEnabled ? 1 : 0;
  }
  state.gpuEnabled = nextMode;
  state.deviceMode = state.gpuEnabled ? 'GPU (WebGPU 하드웨어 가속)' : 'CPU (WASM 멀티스레드 4코어)';
  console.log(`[AI Pipeline] 디바이스 모드 전환 완료: ${state.gpuEnabled ? 'GPU 모드(1)' : 'CPU 모드(0)'}`);

  // 이미 모델들이 준비된 상태라면 새 디바이스 환경으로 비동기 재적재
  if (state.status === 'ready') {
    state.status = 'idle';
    pipelines.similarity = null;
    pipelines.translation = null;
    pipelines.llm = null;
    cachedGamblingEmbeddings = null;
    state.loadedModels = { similarity: false, translation: false, llm: false };
    startLoading();
  }
  return state.gpuEnabled ? 1 : 0;
}

function getGpuMode() {
  return state.gpuEnabled ? 1 : 0;
}

async function startLoading() {
  if (state.status === 'loading' || state.status === 'ready') {
    return state;
  }

  state.status = 'loading';
  state.progress = 5;
  state.error = null;
  state.currentModel = aiConfig.similarity.modelId;
  state.detail = `1/3단계: ${aiConfig.similarity.name} 로딩 중 (${aiConfig.similarity.dtype})...`;

  // 백그라운드 비동기 로딩 시작
  (async () => {
    try {
      const { pipeline } = await getTransformers();

      // [1단계] 유사도/임베딩 모델
      state.currentModel = aiConfig.similarity.modelId;
      state.detail = `1/3단계: ${aiConfig.similarity.name} 로딩 중 (${aiConfig.similarity.dtype})...`;
      pipelines.similarity = await loadPipelineWithFallback(
        pipeline,
        aiConfig.similarity.task,
        aiConfig.similarity.modelId,
        {
          dtype: aiConfig.similarity.dtype,
          progress_callback: (info) => {
            if (info.status === 'progress' && typeof info.progress === 'number') {
              state.progress = Math.round(5 + (info.progress * 0.20));
              state.detail = `1/3단계: 유사도 모델 파일 적재 중 (${Math.round(info.progress)}%)`;
            }
          }
        }
      );
      state.loadedModels.similarity = true;
      state.progress = 25;

      // [2단계] 한국어 -> 영어 초경량 번역 모델
      state.currentModel = aiConfig.translation.modelId;
      state.detail = `2/3단계: ${aiConfig.translation.name} 로딩 중 (${aiConfig.translation.dtype})...`;
      pipelines.translation = await loadPipelineWithFallback(
        pipeline,
        aiConfig.translation.task,
        aiConfig.translation.modelId,
        {
          dtype: aiConfig.translation.dtype,
          progress_callback: (info) => {
            if (info.status === 'progress' && typeof info.progress === 'number') {
              state.progress = Math.round(25 + (info.progress * 0.25));
              state.detail = `2/3단계: 한-영 번역 모델 파일 적재 중 (${Math.round(info.progress)}%)`;
            }
          }
        }
      );
      state.loadedModels.translation = true;
      state.progress = 50;

      // [3단계] 핵심 판정 모델 (스팸 분류 / LLM 추론)
      state.currentModel = aiConfig.llm.modelId;
      state.detail = `3/3단계: ${aiConfig.llm.name} 로딩 중...`;
      const llmLoadOpts = {
        progress_callback: (info) => {
          if (info.status === 'progress' && typeof info.progress === 'number') {
            state.progress = Math.round(50 + (info.progress * 0.48));
            state.detail = `3/3단계: ${aiConfig.llm.modelId} 적재 중 (${Math.round(info.progress)}%)`;
          }
        }
      };
      if (aiConfig.llm.dtype) {
        llmLoadOpts.dtype = aiConfig.llm.dtype;
      }
      pipelines.llm = await loadPipelineWithFallback(
        pipeline,
        aiConfig.llm.task,
        aiConfig.llm.modelId,
        llmLoadOpts
      );
      state.loadedModels.llm = true;
      state.progress = 100;
      state.status = 'ready';
      state.currentModel = '전체 준비 완료';
      state.detail = `AI 모델 준비 완료 (${state.deviceMode})`;
      console.log(`[AI Pipeline] 3단계 q8 탐지 모델 로딩 완료 (100%, ${state.deviceMode})`);

      // 앵커 문장 임베딩 사전 캐싱
      try {
        const anchorEmbeddings = [];
        for (const s of GAMBLING_ANCHOR_SENTENCES) {
          const out = await pipelines.similarity(s, { pooling: 'mean', normalize: true });
          anchorEmbeddings.push(Array.from(out.data));
        }
        cachedGamblingEmbeddings = anchorEmbeddings;
        console.log('[AI Pipeline] 불법광고 앵커 벡터 사전 캐싱 완료');
      } catch (cacheErr) {
        console.warn('[AI Pipeline] 앵커 벡터 캐싱 실패:', cacheErr.message);
      }

      // t_defense 학습된 패턴 인메모리 캐시 자동 적재
      try {
        await loadSpamVectorsFromDb();
      } catch (spamLoadErr) {
        console.warn('[AI Pipeline] t_defense 인메모리 캐시 적재 경고:', spamLoadErr.message);
      }

    } catch (err) {
      console.error('[AI Pipeline Error]', err);
      let errMsg = err.message || '모델 로딩 실패';
      if (errMsg.includes('locate file') || errMsg.includes('404') || errMsg.includes('Could not find')) {
        errMsg += ' (해당 모델 저장소에 transformers.js용 ONNX 파일이 존재하지 않을 수 있습니다. config/aiModel.config.js의 모델 설정을 확인해주세요)';
      }
      state.status = 'error';
      state.error = errMsg;
      state.detail = 'AI 모델 로딩 중 오류 발생: ' + errMsg;
    }
  })();

  return state;
}

// 코사인 유사도 연산 함수
function cosineSimilarity(vecA, vecB) {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

let commonDAO = null;
function getCommonDAO() {
  if (!commonDAO) {
    try {
      commonDAO = require('./commonDAO');
    } catch (e) {}
  }
  return commonDAO;
}

/**
 * 단일 텍스트에 대한 임베딩 벡터 생성 (정규화된 float 배열)
 */
async function generateEmbedding(text) {
  if (!text || !String(text).trim()) return null;
  if (!pipelines.similarity) {
    throw new Error('유사도 모델이 아직 준비되지 않았습니다. 모델 초기화를 기다려주세요.');
  }
  const out = await pipelines.similarity(String(text).trim(), { 
    pooling: aiConfig.similarity.pooling || 'mean', 
    normalize: aiConfig.similarity.normalize !== false 
  });
  return Array.from(out.data);
}

/**
 * DB(t_defense)에서 모든 스팸 패턴 및 벡터를 읽어와 RAM 메모리 캐시에 적재
 */
async function loadSpamVectorsFromDb() {
  try {
    const dao = getCommonDAO();
    if (!dao) return 0;
    const res = await dao.selectList('spamMapper.selectAllSpamVectors', {});
    const list = (res && res.list) ? res.list : [];
    const loaded = [];
    for (const row of list) {
      if (!row.vector_json) continue;
      try {
        const arr = JSON.parse(row.vector_json);
        if (Array.isArray(arr) && arr.length > 0) {
          loaded.push({
            id: row.id,
            text: row.spam_text,
            vector: new Float32Array(arr)
          });
        }
      } catch (e) {}
    }
    inMemorySpamVectors = loaded;
    spamSimilarityCache.clear();
    console.log(`[AI Pipeline] t_defense 인메모리 스팸 벡터 캐시 적재 완료 (총 ${inMemorySpamVectors.length}건)`);
    return inMemorySpamVectors.length;
  } catch (err) {
    console.warn('[AI Pipeline] loadSpamVectorsFromDb 경고:', err.message);
    return 0;
  }
}

/**
 * 신규 등록된 스팸 벡터들을 메모리 캐시에 즉시 추가 (실시간 업데이트)
 */
function addSpamVectorsToMemory(items) {
  if (!items) return;
  const arr = Array.isArray(items) ? items : [items];
  for (const it of arr) {
    if (it && it.vector && it.text) {
      inMemorySpamVectors.push({
        id: it.id || 0,
        text: it.text,
        vector: it.vector instanceof Float32Array ? it.vector : new Float32Array(it.vector)
      });
    }
  }
  spamSimilarityCache.clear();
  console.log(`[AI Pipeline] 인메모리 스팸 벡터 실시간 갱신 완료 (현재 총 ${inMemorySpamVectors.length}건)`);
}

/**
 * 스팸 패턴 삭제 시 메모리 캐시에서도 즉시 제거
 */
function removeSpamVectorFromMemory(id) {
  const numId = Number(id);
  const before = inMemorySpamVectors.length;
  inMemorySpamVectors = inMemorySpamVectors.filter(v => v.id !== numId);
  spamSimilarityCache.clear();
  console.log(`[AI Pipeline] 인메모리 스팸 벡터 삭제 완료 (ID: ${numId}, 잔여: ${inMemorySpamVectors.length}건)`);
  return before - inMemorySpamVectors.length;
}

/**
 * 인메모리 스팸 벡터 캐시 개수 반환
 */
function getSpamVectorCount() {
  return inMemorySpamVectors.length;
}

/**
 * 입력된 텍스트와 메모리에 적재된 스팸 벡터들 간의 최대 코사인 유사도 연산
 * - 초고속 수학 내적(Dot Product) 연산 (0.001초 미만)
 */
async function calculateMaxSpamSimilarity(inputText) {
  if (!inputText || !String(inputText).trim() || inMemorySpamVectors.length === 0) {
    return { maxSim: 0, matchedSpam: null };
  }

  const cacheKey = String(inputText).replace(/\s+/g, ' ').trim().toLowerCase();
  const cachedResult = getCachedValue(spamSimilarityCache, cacheKey);
  if (cachedResult) return cachedResult;

  // 1회 벡터화
  const inputVec = await generateEmbedding(inputText);
  if (!inputVec) return { maxSim: 0, matchedSpam: null };

  let maxSim = 0;
  let matchedSpam = null;

  for (let idx = 0; idx < inMemorySpamVectors.length; idx++) {
    const item = inMemorySpamVectors[idx];
    const v = item.vector;
    let dot = 0;
    const len = Math.min(inputVec.length, v.length);
    for (let i = 0; i < len; i++) {
      dot += inputVec[i] * v[i];
    }
    if (dot > maxSim) {
      maxSim = dot;
      matchedSpam = item.text;
    }
  }

  if (maxSim >= 0.70) {
    console.log(`[dragonkue 유사도 매칭] t_defense ${inMemorySpamVectors.length}건 비교 | 최고유사도: ${(maxSim * 100).toFixed(1)}% | 매칭패턴: '${(matchedSpam || '').slice(0, 25)}' | 텍스트: '${inputText.slice(0, 25)}'`);
  }

  const result = {
    maxSim: Number(maxSim.toFixed(3)),
    matchedSpam
  };
  setCachedValue(spamSimilarityCache, cacheKey, result, MAX_SPAM_SIMILARITY_CACHE_SIZE);
  return result;
}

async function saveDetectLog(logData) {
  try {
    const dao = getCommonDAO();
    if (dao) {
      await dao.execute_query('detectMapper.insertDetectLog', {
        master_id: logData.masterId || null,
        url: logData.url || '',
        input_ko: logData.inputKo || logData.inputText || '',
        prompt_en: logData.promptEn || logData.promptText || '',
        response_en: logData.responseEn || logData.responseText || '',
        response_ko: logData.responseKo || logData.reason || '',
        similarity_val: typeof logData.similarityVal === 'number' ? logData.similarityVal : (logData.similarityScore || 0),
        is_illegal: logData.isIllegal !== undefined ? (logData.isIllegal ? 1 : 0) : (logData.isViolation ? 1 : 0),
        confidence: logData.confidence || 0,
        model_name: logData.modelName || aiConfig.llm.modelId,
        device_mode: logData.deviceMode || state.deviceMode
      });
      console.log(`[AI Detect Log] t_detect_log 저장 완료: 원문="${(logData.inputKo || '').substring(0, 18)}", 유사도=${logData.similarityVal}, 불법여부=${logData.isIllegal ? 1 : 0}`);
    }
  } catch (err) {
    console.error('[AI Detect Log Save Error]', err.message);
  }
}

/**
 * 3단계 파이프라인을 통한 한국어 문장 판정
 * 1단계: multilingual-e5 벡터 유사도
 * 2단계: opus-mt-ko-en 영문 번역
 * 3단계: Qwen2.5-0.5B 최종 의도 분류
 */
// 동일 문장 AI 판정 결과 고속 메모리 캐시 (문장 정규화 키 -> 판정 결과 객체)
const sentenceResultCache = new Map();
const memoTranslationCache = new Map();
const MAX_SENTENCE_RESULT_CACHE_SIZE = 2000;
const MAX_MEMO_TRANSLATION_CACHE_SIZE = 500;

function clearSentenceCache() {
  sentenceResultCache.clear();
  memoTranslationCache.clear();
  console.log('[AI Pipeline] 문장 분석 결과 캐시 초기화 완료');
}

// 소형 생성 모델의 횡설수설/반복 퇴행(Degenerative Hallucination) 패턴 감지 함수
function isDegenerateRepetition(text) {
  if (!text) return false;
  const str = String(text).trim();
  // 1. 동일 단어 3회 이상 연속 반복 (예: "text text text", "jail jail jail")
  if (/(\b[a-zA-Z가-힣0-9_]{2,}\b)(?:\s+\1){2,}/i.test(str)) return true;
  // 2. 파편화된 기호/토큰 나열 (예: "[v] [i] [p]", "[sic] [v]", "{\"c\"}")
  if (/\[(?:v|i|p|sic|a|u|\.|\?|m)\](?:\s*\[(?:v|i|p|sic|a|u|\.|\?|m)\]){2,}/i.test(str)) return true;
  // 3. 문법 템플릿 무한 반복 ("\"This\" is a", "\"I\" am \"a\"", "or imprisonment")
  if (/\\"[a-zA-Z0-9_]+\\"\s*(?:is a|am|being a|command)/i.test(str) && str.length > 40) return true;
  if (/([a-zA-Z\s]{6,25}?)\1{2,}/i.test(str)) return true;
  return false;
}

// 위반 항목을 깔끔한 카테고리 판정 문구로 통일 반환하는 함수 (영어 횡설수설 노출 방지)
function getCleanCategoryLabel(kw, memo) {
  const k = String(kw || '').toLowerCase();
  const m = String(memo || '').toLowerCase();
  if (/(?:도박|카지노|바카라|슬롯|토토|홀덤|포커|베팅|꽁머니|환전|머니상|먹튀|놀이터)/i.test(k) || /(?:도박|카지노|사행)/i.test(m)) {
    return '불법 사행성/도박 광고 판정';
  }
  if (/(?:성매매|조건만남|호빠|풀싸롱|룸싸롱|출장안마|출장마사지|오피|유흥|셔츠룸|가라오케)/i.test(k) || /(?:성매매|유흥)/i.test(m)) {
    return '불법 유흥/성매매 광고 판정';
  }
  if (/(?:대출|급전|대포통장|대포폰|개인돈|카드현금화|소액결제|통장팝니다|선불유심)/i.test(k) || /(?:대출|금융|통장)/i.test(m)) {
    return '불법 대출/금융사기 광고 판정';
  }
  if (/(?:비아그라|시알리스|발기부전|정력제|최음제)/i.test(k) || /(?:의약품)/i.test(m)) {
    return '불법 의약품 광고 판정';
  }
  if (/(?:찌라시|백링크|도배|프로그램|텔레|상위노출)/i.test(kw) || /(?:스팸)/i.test(m)) {
    return '불법 홍보/스팸 광고 판정';
  }
  return '노출 텍스트 의심 패턴 판정';
}

async function classifyText(koreanText, context = {}) {
  if (state.status !== 'ready') {
    throw new Error('AI 모델이 아직 로딩 중입니다. 잠시 후 다시 시도해 주세요.');
  }

  const masterId = context.masterId || null;
  const targetUrl = context.url || '';

  const raw = String(koreanText || '').trim();
  if (!raw) {
    return {
      isViolation: false,
      category: 'EMPTY',
      confidence: 0,
      englishText: '',
      similarityScore: 0,
      reason: '입력된 문장이 없습니다.',
      deviceMode: state.deviceMode
    };
  }

  // [캐시 확인] 이미 분석한 이력이 있는 동일 문장은 AI 추론 없이 0초 만에 즉시 반환
  const matchedMemo = String(context.matchedMemo || '').trim();
  const cacheKey = JSON.stringify([
    raw.replace(/\s+/g, ' ').toLowerCase(),
    String(context.matchedKeyword || ''),
    matchedMemo,
    Boolean(context.isPolluted)
  ]);
  const cachedSentenceResult = getCachedValue(sentenceResultCache, cacheKey);
  if (cachedSentenceResult) {
    const cached = cachedSentenceResult;
    // 불법 위반 문장인 경우 현재 방문 URL 기준으로도 로그 저장 보장
    if (cached.isViolation && masterId) {
      saveDetectLog({
        masterId,
        url: targetUrl,
        inputKo: raw,
        promptEn: `[Cached result] Reused analysis for identical sentence`,
        responseEn: 'VIOLATION (Cached)',
        responseKo: `[캐시 재사용] ${cached.reason}`,
        similarityVal: cached.similarityScore || 1.0,
        isIllegal: 1,
        confidence: cached.confidence || 95,
        modelName: 'SentenceResultCache',
        deviceMode: state.deviceMode
      });
    }
    return { ...cached, koreanText: raw };
  }

  // [1단계] 유사도 모델 연산 (기본 앵커 + t_defense 인메모리 스팸 벡터 전체 교차 비교)
  let maxSimilarity = 0;
  if (pipelines.similarity) {
    try {
      const out = await pipelines.similarity(raw, { pooling: 'mean', normalize: true });
      const inputVec = Array.from(out.data);

      // 1. 기본 앵커 문장 비교
      if (cachedGamblingEmbeddings) {
        for (const anchorVec of cachedGamblingEmbeddings) {
          const sim = cosineSimilarity(inputVec, anchorVec);
          if (sim > maxSimilarity) maxSimilarity = sim;
        }
      }

      // 2. t_defense 학습된 스팸 벡터 전체 비교 (초고속 내적 연산)
      if (inMemorySpamVectors && inMemorySpamVectors.length > 0) {
        for (let idx = 0; idx < inMemorySpamVectors.length; idx++) {
          const v = inMemorySpamVectors[idx].vector;
          let dot = 0;
          const len = Math.min(inputVec.length, v.length);
          for (let i = 0; i < len; i++) {
            dot += inputVec[i] * v[i];
          }
          if (dot > maxSimilarity) {
            maxSimilarity = dot;
          }
        }
      }
    } catch (simErr) {
      console.warn('[Similarity Error]', simErr.message);
    }
  }

  // [1단계: dragonkue 유사도 모델 연산]
  // 앵커 벡터와의 코사인 유사도를 측정하며, 저유사도(<0.55)라고 해서 절대 독단적으로 정상 처리하지 않음 (스팸은 난수표식 키워드 나열이 많으므로)
  const isHighSimSpam = maxSimilarity >= 0.75;

  // [2단계] 한국어 -> 영어 번역
  let englishText = raw;
  const requiresTranslation = /[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(raw);
  let translationSucceeded = !requiresTranslation;
  if (requiresTranslation && pipelines.translation) {
    try {
      const transOpts = { ...(aiConfig.translation.options || {}) };
      const chunks = splitTextForTranslation(raw, aiConfig.translation.maxInputChars);
      const translated = [];
      for (const chunk of chunks) {
        const transRes = await pipelines.translation(chunk, transOpts);
        const value = transRes && transRes[0] && transRes[0].translation_text;
        if (!value) throw new Error('번역 결과가 비어 있습니다.');
        translated.push(value.trim());
      }
      englishText = translated.join(' ');
      translationSucceeded = translated.length === chunks.length;
    } catch (transErr) {
      console.warn('[Translation Error]', transErr.message);
    }
  }

  if (translationSucceeded && matchedMemo && pipelines.translation) {
    try {
      let translatedMemo = memoTranslationCache.get(matchedMemo);
      if (!translatedMemo) {
        const englishMeaning = matchedMemo.match(/(?:^|\|)\s*English:\s*([^|]+)\s*$/i);
        if (englishMeaning) {
          translatedMemo = englishMeaning[1].trim();
        } else if (/[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(matchedMemo)) {
          const transOpts = { ...(aiConfig.translation.options || {}) };
          const memoChunks = splitTextForTranslation(matchedMemo, aiConfig.translation.maxInputChars);
          const translated = [];
          for (const chunk of memoChunks) {
            const transRes = await pipelines.translation(chunk, transOpts);
            const value = transRes && transRes[0] && transRes[0].translation_text;
            if (!value) throw new Error('메모 번역 결과가 비어 있습니다.');
            translated.push(value.trim());
          }
          translatedMemo = translated.join(' ');
        } else {
          translatedMemo = matchedMemo;
        }
        setCachedValue(memoTranslationCache, matchedMemo, translatedMemo, MAX_MEMO_TRANSLATION_CACHE_SIZE);
      }
      englishText = `${englishText}\nMatched term meaning: ${translatedMemo}`;
    } catch (memoError) {
      console.warn('[Memo Translation Error]', memoError.message);
    }
  }

  // [3단계] 분류/생성 모델 판정 (text-classification 또는 생성형 LLM)
  let isViolation = false;
  let reason = '정상적인 콘텐츠입니다.';
  let confidence = Math.round(maxSimilarity * 100);
  let promptText = '';
  let responseText = '';

  if (pipelines.llm && !(aiConfig.llm.task === 'text-classification' && !translationSucceeded)) {
    try {
      // 번역된 원문과 일치한 단어의 뜻을 함께 판정
      const keywordContext = '';

      if (aiConfig.llm.task === 'text-classification') {
        // [RoBERTa-Spam-ONNX 초고속 스팸 분류 추론 (0.02초, 99% 정밀도)]
        promptText = `[Spam Classification] "${englishText}"`;
        const rawOutput = await pipelines.llm(englishText);
        const items = Array.isArray(rawOutput) ? (Array.isArray(rawOutput[0]) ? rawOutput[0] : rawOutput) : [rawOutput];

        let spamScore = 0;
        let topLabel = '';
        for (const item of items) {
          const lbl = String(item.label || '').toUpperCase();
          if (lbl === 'LABEL_1' || lbl === 'SPAM' || lbl.includes('SPAM')) {
            spamScore = Math.max(spamScore, item.score);
            topLabel = item.label;
          } else if (lbl === 'LABEL_0' || lbl === 'HAM' || lbl === 'NOT_SPAM') {
            spamScore = Math.max(spamScore, 1 - item.score);
            topLabel = item.label;
          }
        }

        // 단일 결과 반환 시 역산 보정
        if (items.length === 1) {
          const first = items[0];
          const lbl = String(first.label || '').toUpperCase();
          if (lbl === 'LABEL_1' || lbl === 'SPAM' || lbl.includes('SPAM')) {
            spamScore = first.score;
          } else {
            spamScore = 1 - first.score;
          }
          topLabel = `${first.label} (${(first.score * 100).toFixed(1)}%)`;
        }

        responseText = `SPAM_SCORE: ${(spamScore * 100).toFixed(1)}% (${topLabel})`;

        // detectEngine이 이미 키워드/패턴 필터링을 완료한 상태 - 여기서는 오염 여부와 유사도만 판단
        const hasObviousIllegalKeyword = context.isPolluted || isHighSimSpam;

        // 스팸 확률 75% 이상이거나, 오염 키워드가 포함되어 있고 스팸 확률이 50% 이상인 경우 불법 판정
        if (spamScore >= 0.75 || (hasObviousIllegalKeyword && spamScore >= 0.50)) {
          isViolation = true;
          reason = getCleanCategoryLabel(context.matchedKeyword, context.matchedMemo);
          confidence = Math.max(confidence, Math.round(spamScore * 100));
        } else if (hasObviousIllegalKeyword) {
          isViolation = true;
          reason = getCleanCategoryLabel(context.matchedKeyword, context.matchedMemo);
          confidence = Math.max(confidence, 88);
        } else {
          isViolation = false;
          reason = '정상 웹 콘텐츠 판정';
          confidence = Math.round((1 - spamScore) * 100);
        }
      } else {
        // [기존 Qwen2.5-0.5B 생성형 모델 추론 로직 (보존 및 토큰 최적화)]
        promptText = `You are a strict web safety content filter.${keywordContext}
Determine if the following text is an ILLEGAL advertisement (such as illegal casino, gambling bonuses, slot machines, illegal prostitution/escort, loan shark scams).
NOTE: Official announcements, public unions, schools, donation accounts, membership fees, and public notices are NORMAL and NOT violations.

Text: "${englishText}"

Respond ONLY in this format:
VIOLATION: [brief reason]
or
NORMAL: [brief reason]`;

        // 기존 설정: max_new_tokens: 35, do_sample: false
        // 횡설수설 억제를 위해 토큰 제한 및 반복 방지 페널티 적용 (기존 설정 주석 보존)
        const output = await pipelines.llm(promptText, {
          max_new_tokens: 10,
          /* max_new_tokens: 35, // 기존 백업 */
          temperature: 0.1,
          repetition_penalty: 1.2,
          do_sample: false
        });

        const generatedText = (output && output[0] && output[0].generated_text) ? output[0].generated_text : '';
        responseText = generatedText.replace(promptText, '').trim();

        // 횡설수설/반복 퇴행 감지 (단어 반복, 파편 기호 반복 등)
        const isDegenerate = isDegenerateRepetition(responseText);

        // AI 판정 결과 정밀 파싱
        // 1. 정상 판정 여부 확인 (NORMAL로 시작하거나 명시적으로 not violation인 경우)
        const isExplicitNormal = !isDegenerate && (/^NORMAL\b/i.test(responseText) || /not a violation/i.test(responseText) || /no violation/i.test(responseText) || /is not illegal/i.test(responseText) || /is normal/i.test(responseText));

        // 2. 불법 판정 여부 확인 (VIOLATION으로 시작하고, 횡설수설 반복이 아닐 때만 인정)
        const isExplicitViolation = !isDegenerate && (/^VIOLATION\b/i.test(responseText) || (!isExplicitNormal && /\b(?:illegal\s+(?:casino|gambling|prostitution|escort|betting|scam))\b/i.test(responseText)));

        // 3. detectEngine이 이미 키워드/패턴 필터링을 완료한 상태 - 여기서는 오염 여부와 유사도만 판단
        const hasObviousIllegalKeyword = context.isPolluted || isHighSimSpam;

        if (isExplicitViolation || (hasObviousIllegalKeyword && !isExplicitNormal)) {
          isViolation = true;
          reason = getCleanCategoryLabel(context.matchedKeyword, context.matchedMemo);
          confidence = Math.max(confidence, 90);
        } else if (isExplicitNormal) {
          if (hasObviousIllegalKeyword) {
            isViolation = true;
            reason = getCleanCategoryLabel(context.matchedKeyword, context.matchedMemo);
            confidence = Math.max(confidence, 88);
          } else {
            isViolation = false;
            reason = '정상 웹 콘텐츠 판정';
          }
        } else {
          // 불명확한 응답이거나 LLM 횡설수설 퇴행인 경우: 명백한 오염 키워드가 있을 때만 불법, 없으면 정상!
          if (hasObviousIllegalKeyword) {
            isViolation = true;
            reason = getCleanCategoryLabel(context.matchedKeyword, context.matchedMemo);
            confidence = Math.max(confidence, 85);
          } else {
            isViolation = false;
            reason = '정상 안내문 또는 일반 콘텐츠 판정';
          }
        }
      }
    } catch (llmErr) {
      console.warn('[LLM Inference Error]', llmErr.message);
      if (maxSimilarity >= 0.80) {
        isViolation = true;
        reason = '문맥 벡터 유사도 고위험 임계치(0.80) 초과로 위반 감지';
      }
    }
  } else {
    if (maxSimilarity >= 0.80) {
      isViolation = true;
      reason = '문맥 벡터 유사도 임계치 초과';
    }
  }

  const resultItem = {
    koreanText: raw,
    englishText,
    isViolation,
    category: isViolation ? '불법 사행성/도박 광고' : '정상 안내문',
    confidence,
    similarityScore: Number(maxSimilarity.toFixed(3)),
    reason,
    deviceMode: state.deviceMode
  };

  // AI 한국어 대답 구성
  let responseKo = '';
  if (isViolation) {
    responseKo = `[불법 사행성/도박 광고 판정] ${reason}`;
  } else {
    responseKo = `[정상 안내문/일반 콘텐츠 판정] ${reason}`;
  }

  // AI 대화 로그 테이블에 기록 (영어로 물어본 값, 한국어로 대답한 값, 불법 판단 여부, 유사도 검색 값)
  saveDetectLog({
    masterId,
    url: targetUrl,
    inputKo: raw,
    promptEn: promptText || `Text: "${englishText}" -> Does this text promote illegal gambling/betting?`,
    responseEn: responseText || (isViolation ? 'VIOLATION' : 'NORMAL'),
    responseKo,
    similarityVal: Number(maxSimilarity.toFixed(3)),
    isIllegal: isViolation ? 1 : 0,
    confidence,
    modelName: aiConfig.llm.modelId || 'RoBERTa-Spam-ONNX',
    deviceMode: state.deviceMode
  });

  setCachedValue(sentenceResultCache, cacheKey, resultItem, MAX_SENTENCE_RESULT_CACHE_SIZE);
  return resultItem;
}

module.exports = {
  getStatus,
  startLoading,
  classifyText,
  saveDetectLog,
  clearSentenceCache,
  sentenceResultCache,
  pipelines,
  generateEmbedding,
  loadSpamVectorsFromDb,
  addSpamVectorsToMemory,
  removeSpamVectorFromMemory,
  getSpamVectorCount,
  calculateMaxSpamSimilarity,
  setGpuMode,
  getGpuMode
};
