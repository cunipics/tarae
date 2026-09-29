/**
 * AI 파이프라인 모델 설정 관리 파일
 * 번역(Translation) -> 추론(LLM) -> 벡터링(Embedding/Similarity) 3단계 모델 중앙 제어
 * 
 * [주의사항]
 * 이 앱은 transformers.js(WebGPU / ONNX 런타임)를 기반으로 구동됩니다.
 * 따라서 지정하는 Hugging Face 모델 저장소 내에 ONNX 가중치 파일(예: onnx/model_q8.onnx 또는 onnx/model.onnx)이
 * 반드시 존재해야 브라우저/Node 환경에서 정상 다운로드 및 실행이 가능합니다.
 * PyTorch 전용(.safetensors / .bin만 있는) 모델은 ONNX 변환본 저장소 또는 로컬 ONNX 경로를 지정해야 합니다.
 */

// 다국어 번역 모델별 기본 언어 코드 프로필 레지스트리
const TRANSLATION_PROFILES = {
  // NLLB 계열 (200개 언어 다국어 번역)
  nllb: { src_lang: 'kor_Hang', tgt_lang: 'eng_Latn' },
  // m2m100 계열 (100개 언어 다국어 번역)
  m2m100: { src_lang: 'ko', tgt_lang: 'en' },
  // mbart 계열
  mbart: { src_lang: 'ko_KR', tgt_lang: 'en_XX' },
  // opus-mt 등 전용 단일 언어쌍 모델 (추가 옵션 불필요)
  'opus-mt': {}
};

function resolveTranslationOptions(modelId) {
  const mid = String(modelId || '').toLowerCase();
  let matchedOptions = {};

  for (const [key, opts] of Object.entries(TRANSLATION_PROFILES)) {
    if (mid.includes(key)) {
      matchedOptions = { ...opts };
      break;
    }
  }

  // .env 환경변수에 명시된 언어 코드가 있으면 최우선 적용
  if (process.env.AI_TRANSLATION_SRC_LANG) {
    matchedOptions.src_lang = process.env.AI_TRANSLATION_SRC_LANG;
  }
  if (process.env.AI_TRANSLATION_TGT_LANG) {
    matchedOptions.tgt_lang = process.env.AI_TRANSLATION_TGT_LANG;
  }

  return matchedOptions;
}

const translationModelId = process.env.AI_TRANSLATION_MODEL || 'Xenova/opus-mt-ko-en';

function resolveLlmTask(modelId) {
  if (process.env.AI_LLM_TASK) {
    return process.env.AI_LLM_TASK;
  }
  const mid = String(modelId || '').toLowerCase();
  if (mid.includes('bert') || mid.includes('roberta') || mid.includes('spam') || mid.includes('classifier') || mid.includes('classification')) {
    return 'text-classification';
  }
  return 'text-generation';
}

const llmModelId = process.env.AI_LLM_MODEL || 'onnx-community/Qwen2.5-0.5B-Instruct';
const llmTask = resolveLlmTask(llmModelId);

module.exports = {
  // [1단계: 벡터링 / 문맥 유사도 모델]
  similarity: {
    name: '문맥 유사도 및 벡터 임베딩',
    task: 'feature-extraction',
    // .env의 AI_SIMILARITY_MODEL 우선 적용 (기본값: exp-models/dragonkue-KoEn-E5-Tiny-ONNX)
    modelId: process.env.AI_SIMILARITY_MODEL || 'exp-models/dragonkue-KoEn-E5-Tiny-ONNX',
    dtype: process.env.AI_DTYPE || 'q8',
    pooling: 'mean',
    normalize: true,
    description: '스팸 문맥 유사도 측정 및 텍스트 벡터화 담당 모델'
  },

  // [2단계: 번역 모델 (opus-mt, nllb-200, m2m100 등 다중 모델 자동 대응)]
  translation: {
    name: '한-영 문맥 번역',
    task: 'translation',
    modelId: translationModelId,
    dtype: process.env.AI_DTYPE || 'q8',
    options: {
      ...resolveTranslationOptions(translationModelId),
      do_sample: false,
      num_beams: 1,
      max_new_tokens: 160
    },
    maxInputChars: Number(process.env.AI_TRANSLATION_MAX_INPUT_CHARS) || 180,
    description: '한국어 문맥을 영어로 변환하여 LLM에 전달하는 번역 모델'
  },

  // [3단계: 핵심 판정 모델 (설정 또는 모델명에 따라 text-classification / text-generation 자동 분기)]
  llm: {
    name: llmTask === 'text-classification' ? '스팸 분류 판정 엔진' : '핵심 LLM 추론 엔진',
    task: llmTask,
    modelId: llmModelId,
    dtype: process.env.AI_DTYPE || 'q8',
    description: llmTask === 'text-classification'
      ? '초경량 고속 텍스트 분류 기반 불법 광고 판정 모델'
      : '0.5B 초경량 고성능 파라미터 기반의 불법 광고 심층 문맥 판정 모델'
  }
};
