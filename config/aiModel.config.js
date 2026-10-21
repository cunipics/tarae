/**
 * AI 파이프라인 모델 설정 관리 파일
 * 벡터링(Embedding/Similarity) -> 추론(LLM) 2단계 모델 중앙 제어
 * 
 * [주의사항]
 * 이 앱은 transformers.js(WebGPU / ONNX 런타임)를 기반으로 구동됩니다.
 * 따라서 지정하는 Hugging Face 모델 저장소 내에 ONNX 가중치 파일(예: onnx/model_q8.onnx 또는 onnx/model.onnx)이
 * 반드시 존재해야 브라우저/Node 환경에서 정상 다운로드 및 실행이 가능합니다.
 * PyTorch 전용(.safetensors / .bin만 있는) 모델은 ONNX 변환본 저장소 또는 로컬 ONNX 경로를 지정해야 합니다.
 */

const similarityModelId = String(process.env.AI_SIMILARITY_MODEL || '').trim();

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

const llmModelId = String(process.env.AI_LLM_MODEL || '').trim();
const llmTask = resolveLlmTask(llmModelId);

function readRatio(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

const similarityReviewThreshold = readRatio('AI_SIMILARITY_REVIEW_THRESHOLD', 0.70);
const similarityBlockThreshold = Math.max(
  similarityReviewThreshold,
  readRatio('AI_SIMILARITY_BLOCK_THRESHOLD', 0.85)
);

module.exports = {
  // [1단계: 벡터링 / 문맥 유사도 모델]
  similarity: {
    name: '문맥 유사도 및 벡터 임베딩',
    task: 'feature-extraction',
    // .env의 AI_SIMILARITY_MODEL 필수
    modelId: similarityModelId,
    dtype: process.env.AI_DTYPE || 'q8',
    pooling: 'mean',
    normalize: true,
    description: '스팸 문맥 유사도 측정 및 텍스트 벡터화 담당 모델'
  },

  inference: {
    maxInputChars: Number(process.env.AI_TEXT_MAX_INPUT_CHARS) || 180,
    similarityReviewThreshold,
    similarityBlockThreshold
  },

  // [2단계: 핵심 판정 모델 (설정 또는 모델명에 따라 text-classification / text-generation 자동 분기)]
  llm: {
    name: llmTask === 'text-classification' ? '스팸 분류 판정 엔진' : '핵심 LLM 추론 엔진',
    task: llmTask,
    modelId: llmModelId,
    dtype: process.env.AI_DTYPE || 'q8',
    description: llmTask === 'text-classification'
      ? '초경량 고속 텍스트 분류 기반 불법 광고 판정 모델'
      : '환경 변수로 지정된 생성형 불법 광고 문맥 판정 모델'
  }
};
