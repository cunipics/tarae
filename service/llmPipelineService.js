/**
 * AI 불법광고 탐지 2단계 q8 모델 파이프라인 서비스
 * 1. 유사도: AI_SIMILARITY_MODEL 환경 변수로 지정된 ONNX 모델
 * 2. 스팸/LLM: AI_LLM_MODEL 환경 변수로 지정된 ONNX 판정 모델
 *
 * GPU 우선 가속 시도 및 미지원 시 CPU(WASM 멀티스레드) 자동 폴백
 */

const aiConfig = require('../config/aiModel.config');
const fs = require('fs');
const path = require('path');
const { stripLeadingTitleMarkers } = require('../utils/inferenceText');

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
    llm: false
  },
  error: null
};

const pipelines = {
  similarity: null,
  llm: null
};

function buildInferenceExcerpt(text, maxChars, focusTerm = '') {
  const source = String(text || '')
    .normalize('NFKC')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const limit = Math.max(40, Number(maxChars) || 180);
  if (source.length <= limit) return source;

  const focus = String(focusTerm || '').normalize('NFKC').trim();
  const focusIndex = focus ? source.toLowerCase().indexOf(focus.toLowerCase()) : -1;
  if (focusIndex < 0) return source.slice(0, limit).trim();

  const beforeLength = Math.floor((limit - Math.min(focus.length, limit)) / 2);
  let start = Math.max(0, focusIndex - beforeLength);
  if (start + limit > source.length) start = Math.max(0, source.length - limit);
  return source.slice(start, start + limit).trim();
}

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

const modelWeightManifestCache = new Map();

function formatFileSize(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function getWeightFileMatcher(dtype) {
  const normalized = String(dtype || '').toLowerCase();
  if (normalized === 'q8') return /(?:_quantized|_q8)\.onnx(?:_data)?$/i;
  if (normalized === 'int8') return /_int8\.onnx(?:_data)?$/i;
  if (normalized === 'uint8') return /_uint8\.onnx(?:_data)?$/i;
  if (normalized === 'q4f16') return /_q4f16\.onnx(?:_data)?$/i;
  if (normalized === 'q4') return /_q4\.onnx(?:_data)?$/i;
  if (normalized === 'fp16') return /_fp16\.onnx(?:_data)?$/i;
  return /(?:^|\/)(?:model|encoder_model|decoder_model|decoder_with_past_model)\.onnx(?:_data)?$/i;
}

async function getModelWeightManifest(modelId, dtype) {
  const cacheKey = `${modelId}|${dtype || ''}`;
  if (modelWeightManifestCache.has(cacheKey)) return modelWeightManifestCache.get(cacheKey);

  let files = [];
  try {
    if (typeof fetch !== 'function') return files;
    const encodedModelId = String(modelId).split('/').map(encodeURIComponent).join('/');
    const url = `https://huggingface.co/api/models/${encodedModelId}/tree/main/onnx?recursive=true&expand=true`;
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const rows = await response.json();
    const matcher = getWeightFileMatcher(dtype);
    files = (Array.isArray(rows) ? rows : [])
      .filter(item => item && item.type === 'file' && matcher.test(String(item.path || '')) && Number(item.size) > 0)
      .map(item => ({ path: String(item.path).replace(/\\/g, '/'), size: Number(item.size) }));

    if (files.length > 0) {
      const totalBytes = files.reduce((sum, item) => sum + item.size, 0);
      console.log(`[AI Pipeline] ${modelId} ${dtype || ''} 가중치 용량 확인: ${formatFileSize(totalBytes)}`);
    }
  } catch (error) {
    console.warn(`[AI Pipeline] ${modelId} 가중치 용량 사전 확인 실패, 다운로드 콜백 기준으로 계산합니다: ${error.message}`);
  }

  modelWeightManifestCache.set(cacheKey, files);
  return files;
}

async function createModelProgressCallback(modelId, dtype, stageStart, stageEnd, label) {
  const expectedFiles = await getModelWeightManifest(modelId, dtype);
  const observedFiles = new Map();
  let displayedRatio = 0;
  let useExpectedManifest = expectedFiles.length > 0;

  return (info) => {
    if (!info) return;
    const fileName = String(info.file || info.name || '').replace(/\\/g, '/');
    if (!/\.onnx(?:_data)?$/i.test(fileName)) return;

    const expected = expectedFiles.find(item =>
      fileName.endsWith(item.path) || fileName.endsWith(`/${item.path.split('/').pop()}`) || item.path.endsWith(`/${fileName}`)
    );
    if (!expected && expectedFiles.length > 0) useExpectedManifest = false;
    const callbackTotal = Number(info.total);
    const total = expected ? expected.size : (Number.isFinite(callbackTotal) && callbackTotal > 0 ? callbackTotal : 0);
    if (total <= 0) return;

    let loaded = Number(info.loaded);
    if (!Number.isFinite(loaded) && typeof info.progress === 'number') {
      loaded = total * Math.max(0, Math.min(100, info.progress)) / 100;
    }
    if (info.status === 'done') loaded = total;
    if (!Number.isFinite(loaded)) return;

    const key = expected ? expected.path : fileName;
    observedFiles.set(key, { loaded: Math.max(0, Math.min(total, loaded)), total });

    let totalBytes = 0;
    let loadedBytes = 0;
    if (useExpectedManifest) {
      totalBytes = expectedFiles.reduce((sum, item) => sum + item.size, 0);
      loadedBytes = expectedFiles.reduce((sum, item) => {
        const current = observedFiles.get(item.path);
        return sum + (current ? Math.min(item.size, current.loaded) : 0);
      }, 0);
    } else {
      for (const current of observedFiles.values()) {
        totalBytes += current.total;
        loadedBytes += current.loaded;
      }
    }
    if (totalBytes <= 0) return;

    displayedRatio = Math.max(displayedRatio, Math.min(1, loadedBytes / totalBytes));
    const stageProgress = stageStart + displayedRatio * (stageEnd - stageStart);
    state.progress = Math.max(state.progress, Math.round(stageProgress));
    state.detail = `${label} (${formatFileSize(loadedBytes)} / ${formatFileSize(totalBytes)}, ${Math.round(displayedRatio * 100)}%)`;
  };
}

async function getTransformers() {
  if (!transformersModule) {
    transformersModule = await import('@huggingface/transformers');
    const configuredCacheDir = String(process.env.TARAE_MODEL_CACHE_DIR || '').trim();
    if (configuredCacheDir) {
      const resolvedCacheDir = path.resolve(configuredCacheDir);
      fs.mkdirSync(resolvedCacheDir, { recursive: true });
      transformersModule.env.cacheDir = resolvedCacheDir;
      transformersModule.env.useFSCache = true;
    }
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
      llm: aiConfig.llm.modelId,
      dtypes: {
        similarity: aiConfig.similarity.dtype,
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
    pipelines.llm = null;
    state.loadedModels = { similarity: false, llm: false };
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

  const requiredModels = [
    ['AI_SIMILARITY_MODEL', aiConfig.similarity.modelId],
    ['AI_LLM_MODEL', aiConfig.llm.modelId]
  ];
  const missingModels = requiredModels.filter(([, modelId]) => !String(modelId || '').trim()).map(([name]) => name);
  if (missingModels.length > 0) {
    const message = `AI 모델이 지정되지 않았습니다: ${missingModels.join(', ')}`;
    state.status = 'error';
    state.progress = 0;
    state.currentModel = '';
    state.error = message;
    state.detail = message;
    return state;
  }

  state.status = 'loading';
  state.progress = 5;
  state.error = null;
  state.currentModel = aiConfig.similarity.modelId;
  state.detail = `1/2단계: ${aiConfig.similarity.name} 로딩 중 (${aiConfig.similarity.dtype})...`;

  // 백그라운드 비동기 로딩 시작
  (async () => {
    try {
      const { pipeline } = await getTransformers();

      // [1단계] 유사도/임베딩 모델
      state.currentModel = aiConfig.similarity.modelId;
      state.detail = `1/2단계: ${aiConfig.similarity.name} 로딩 중 (${aiConfig.similarity.dtype})...`;
      const similarityProgressCallback = await createModelProgressCallback(
        aiConfig.similarity.modelId, aiConfig.similarity.dtype, 5, 40, '1/2단계: 유사도 모델 파일 적재 중'
      );
      pipelines.similarity = await loadPipelineWithFallback(
        pipeline,
        aiConfig.similarity.task,
        aiConfig.similarity.modelId,
        {
          dtype: aiConfig.similarity.dtype,
          progress_callback: similarityProgressCallback
        }
      );
      state.loadedModels.similarity = true;
      state.progress = 40;

      // [2단계] 핵심 판정 모델 (스팸 분류 / LLM 추론)
      state.currentModel = aiConfig.llm.modelId;
      state.detail = `2/2단계: ${aiConfig.llm.name} 로딩 중...`;
      const llmProgressCallback = await createModelProgressCallback(
        aiConfig.llm.modelId, aiConfig.llm.dtype, 40, 98, `2/2단계: ${aiConfig.llm.modelId} 적재 중`
      );
      const llmLoadOpts = {
        progress_callback: llmProgressCallback
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
      console.log(`[AI Pipeline] 2단계 q8 탐지 모델 로딩 완료 (100%, ${state.deviceMode})`);

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
  const judgmentText = stripLeadingTitleMarkers(inputText);
  if (!judgmentText || inMemorySpamVectors.length === 0) {
    return { maxSim: 0, matchedSpam: null };
  }

  const cacheKey = judgmentText.replace(/\s+/g, ' ').trim().toLowerCase();
  const cachedResult = getCachedValue(spamSimilarityCache, cacheKey);
  if (cachedResult) return cachedResult;

  // 1회 벡터화
  const inputVec = await generateEmbedding(judgmentText);
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

  if (maxSim >= aiConfig.inference.similarityReviewThreshold) {
    console.log(`[dragonkue 유사도 매칭] t_defense ${inMemorySpamVectors.length}건 비교 | 최고유사도: ${(maxSim * 100).toFixed(1)}% | 매칭패턴: '${(matchedSpam || '').slice(0, 25)}' | 텍스트: '${judgmentText.slice(0, 25)}'`);
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
 * 2단계 파이프라인을 통한 한국어 문장 판정
 * 1단계: multilingual-e5 벡터 유사도
 * 2단계: 설정된 판정 모델의 최종 의도 분류
 */
// 동일 문장 AI 판정 결과 고속 메모리 캐시 (문장 정규화 키 -> 판정 결과 객체)
const sentenceResultCache = new Map();
const MAX_SENTENCE_RESULT_CACHE_SIZE = 2000;
const CLASSIFICATION_POLICY_VERSION = 'site-external-ad-single-stage-v6';
const SIMILARITY_AUTO_BLOCK_THRESHOLD = aiConfig.inference.similarityBlockThreshold;

function clearSentenceCache() {
  sentenceResultCache.clear();
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

// 판정 이유는 특정 단어 목록에 의존하지 않고 LLM의 공통 정책으로 표시한다.
function getCleanCategoryLabel() {
  return '사이트와 무관한 광고 또는 검색 오염 판정';
}

async function summarizeSiteProfile(sourceText) {
  const source = String(sourceText || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 360);
  if (!source || state.status !== 'ready' || !pipelines.llm || aiConfig.llm.task === 'text-classification') return source;

  try {
    const messages = [
      { role: 'system', content: '입력에 나온 운영 주체와 제공 내용을 "운영 주체 | 제공 내용" 형식의 짧은 명사구로 답하라. 입력에 없는 내용은 만들지 마라.' },
      { role: 'user', content: '사이트 정보: ' + source + '\n사이트 성격:' }
    ];
    const result = await pipelines.llm(messages, {
      max_new_tokens: 32,
      do_sample: false,
      return_full_text: false
    });
    const generated = result && result[0] ? result[0].generated_text : '';
    const answer = Array.isArray(generated)
      ? String((([...generated].reverse().find(item => item && item.role === 'assistant')) || {}).content || '')
      : String(generated || '');
    const cleaned = answer.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
    const copiedInstruction = /운영\s*주체|제공\s*내용|사이트\s*정보|사이트\s*성격/.test(cleaned);
    return !cleaned || copiedInstruction || isDegenerateRepetition(cleaned) ? source : cleaned;
  } catch (error) {
    console.warn('[Site Profile Summary Error]', error.message);
    return source;
  }
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

  const judgmentText = stripLeadingTitleMarkers(raw);
  const llmInputText = buildInferenceExcerpt(
    judgmentText,
    aiConfig.inference.maxInputChars,
    context.matchedKeyword
  );

  // [캐시 확인] 이미 분석한 이력이 있는 동일 문장은 AI 추론 없이 0초 만에 즉시 반환
  const matchedMemo = String(context.matchedMemo || '').trim();
  const siteProfile = String(context.siteProfile || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
  const cacheKey = JSON.stringify([
    CLASSIFICATION_POLICY_VERSION,
    llmInputText.replace(/\s+/g, ' ').toLowerCase(),
    String(context.matchedKeyword || ''),
    matchedMemo,
    siteProfile,
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

  // [1단계] DetectEngine에서 계산한 점수를 재사용하고, 직접 호출일 때만 벡터를 계산한다.
  const suppliedSimilarity = Number(context.similarityScore);
  let maxSimilarity = Number.isFinite(suppliedSimilarity)
    ? Math.max(0, Math.min(1, suppliedSimilarity))
    : 0;
  if (pipelines.similarity && !Number.isFinite(suppliedSimilarity)) {
    try {
      const out = await pipelines.similarity(llmInputText, { pooling: 'mean', normalize: true });
      const inputVec = Array.from(out.data);

      // t_defense 학습된 스팸 벡터 전체 비교
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
  const isHighSimSpam = maxSimilarity >= SIMILARITY_AUTO_BLOCK_THRESHOLD;

  const englishText = llmInputText;

  // [2단계] 분류/생성 모델 판정 (text-classification 또는 생성형 LLM)
  let isViolation = false;
  let reason = '정상적인 콘텐츠입니다.';
  let confidence = Math.round(maxSimilarity * 100);
  let promptText = '';
  let responseText = '';

  if (pipelines.llm) {
    try {
      // 원문과 일치한 단어의 뜻을 함께 판정
      const keywordContext = '';

      if (aiConfig.llm.task === 'text-classification') {
        // 텍스트 분류 모델 판정
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
        const generationOptions = {
          max_new_tokens: 4,
          do_sample: false,
          return_full_text: false
        };
        const readGeneratedText = (result, sentPrompt) => {
          const generated = result && result[0] ? result[0].generated_text : '';
          if (Array.isArray(generated)) {
            const assistantMessage = [...generated].reverse().find(item => item && item.role === 'assistant');
            return String((assistantMessage && assistantMessage.content) || '').trim();
          }
          return String(generated || '').replace(sentPrompt, '').trim();
        };
        const normalizeDecision = (value) => {
          const rawDecision = String(value || '').trim();
          if (/^0(?:\b|$)/.test(rawDecision) || /^NORMAL\b/i.test(rawDecision)) return 'NORMAL';
          if (/^1(?:\b|$)/.test(rawDecision) || /^VIOLATION\b/i.test(rawDecision)) return 'VIOLATION';
          return rawDecision;
        };
        const runDecisionOnce = async (systemText, userText) => {
          const sentPrompt = systemText + '\n\n' + userText;
          console.log(`[AI Inference Start] type=classification inputChars=${llmInputText.length}`);
          const output = await pipelines.llm([
            { role: 'system', content: systemText },
            { role: 'user', content: userText }
          ], generationOptions);
          const decision = normalizeDecision(readGeneratedText(output, sentPrompt));
          console.log('[AI Inference End] type=classification');
          if (isDegenerateRepetition(decision)) return '';
          return /^(?:NORMAL|VIOLATION)\b/i.test(decision) ? decision : '';
        };

        const runDecision = async (systemText, userText) => {
          const first = await runDecisionOnce(systemText, userText);
          if (first) return first;
          return runDecisionOnce(systemText, userText);
        };

        const decisionSystem = '먼저 정보 전달 글인지 판단하라. 기관의 발표, 조치, 단속, 통계, 보도, 공지, 주의, 경고, 예방, 교육이면 0. 그 외에 상품·서비스·사이트·연락처의 판매, 홍보, 접속 유도가 명확하거나 검색용 단어 나열이면 1. 불법 관련 단어만으로 1을 고르지 마라. 모호하면 0. 숫자만 답하라.';
        const decisionUser = '사이트: ' + (siteProfile || '확인 불가') + '\n글: ' + llmInputText + '\n답:';
        const decision = await runDecision(decisionSystem, decisionUser);

        promptText = decisionSystem + '\n\n' + decisionUser;
        responseText = decision === 'VIOLATION' ? '1' : decision === 'NORMAL' ? '0' : '?';
        isViolation = decision === 'VIOLATION';

        if (isViolation) {
          reason = getCleanCategoryLabel(context.matchedKeyword, context.matchedMemo);
          confidence = Math.max(confidence, 90);
        } else {
          reason = decision === 'NORMAL'
            ? '사이트와 무관한 외부 광고가 아닌 정상 콘텐츠'
            : '판정 모델이 유효한 답을 반환하지 않아 위반 확정 보류';
          confidence = Math.max(0, Math.min(confidence, 84));
        }
      }
    } catch (llmErr) {
      console.warn('[LLM Inference Error]', llmErr.message);
      isViolation = false;
      reason = '판정 모델 오류로 위반 확정 보류';
    }
  } else {
    if (maxSimilarity >= SIMILARITY_AUTO_BLOCK_THRESHOLD) {
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
    modelName: aiConfig.llm.modelId,
    deviceMode: state.deviceMode
  });

  setCachedValue(sentenceResultCache, cacheKey, resultItem, MAX_SENTENCE_RESULT_CACHE_SIZE);
  return resultItem;
}

module.exports = {
  getStatus,
  startLoading,
  summarizeSiteProfile,
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
