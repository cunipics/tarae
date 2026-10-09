# Tarae(타래)

Tarae는 웹 콘텐츠를 수집하고 규칙과 AI 모델로 분석해 점검 결과를 정리하는 데스크톱 프로그램입니다.

화면은 Electron으로 구성되어 있고, 실제 수집과 분석은 로컬 Node.js 서버가 처리합니다. 설정과 점검 결과는 SQLite에 저장하며 로그인과 사용자 설정 변경은 별도의 원격 API를 사용합니다.

## 작동 방식

```text
Tarae 화면
  └─ 로컬 Node.js 서버
      ├─ 웹 콘텐츠 수집
      ├─ 규칙 기반 검사
      ├─ AI 분석
      └─ SQLite 저장

원격 서버
  ├─ 로그인 API
  └─ 사용자 설정 변경 API
```

AI 분석은 문장 유사도 확인, 번역, 텍스트 분류 순서로 진행됩니다. 모델은 설치 파일에 넣지 않으며, AI 기능을 처음 사용할 때 내려받아 사용자 폴더에 보관합니다.

## 설치와 환경 설정

```powershell
npm ci
Copy-Item .env.example .env
```

`.env`에서 서버 주소와 AI 모델을 실제 환경에 맞게 수정합니다.

```dotenv
REMOTE_LOGIN_API_URL=여기에 로그인 API URL 입력
REMOTE_UPDATE_API_URL=여기에 관리자 정보 업데이트 API URL 입력

# 값을 지정하지 않으면 config/aiModel.config.js의 기본값을 사용합니다.
AI_SIMILARITY_MODEL=exp-models/dragonkue-KoEn-E5-Tiny-ONNX
AI_TRANSLATION_MODEL=Xenova/nllb-200-distilled-600M
AI_LLM_MODEL=onnx-community/bert-tiny-finetuned-sms-spam-detection-ONNX
AI_DTYPE=q8
```

실제 `.env` 파일에는 운영 서버 주소나 비밀정보가 들어갈 수 있으므로 공개 저장소에 올리지 마십시오.

## AI 모델

### 문장 유사도

`exp-models/dragonkue-KoEn-E5-Tiny-ONNX`는 한국어와 영어 문장을 벡터로 변환하고 의미가 얼마나 비슷한지 비교합니다.

[모델 정보](https://huggingface.co/exp-models/dragonkue-KoEn-E5-Tiny-ONNX)

### 번역

`Xenova/nllb-200-distilled-600M`은 여러 언어로 작성된 문장을 분석에 사용할 언어로 번역합니다. 처음 내려받을 때에는 모델 크기만큼 시간이 걸릴 수 있습니다.

[모델 정보](https://huggingface.co/Xenova/nllb-200-distilled-600M)

이 모델은 `CC BY-NC 4.0` 조건으로 공개되어 있습니다. 상업적인 용도로 사용하려면 모델의 라이선스 조건을 먼저 확인해야 합니다.

### 텍스트 분류

`onnx-community/bert-tiny-finetuned-sms-spam-detection-ONNX`는 문장을 분류해 의심 콘텐츠 판정에 참고합니다. SMS 스팸 데이터로 학습된 작은 모델이므로 실제 자료로 결과를 확인한 뒤 사용하십시오.

[모델 정보](https://huggingface.co/onnx-community/bert-tiny-finetuned-sms-spam-detection-ONNX)

`AI_DTYPE=q8`은 8비트 양자화 모델을 사용한다는 뜻입니다. 메모리 사용량과 실행 속도의 균형을 맞추기 위한 기본 설정입니다.

모델을 바꿀 때에는 현재 작업과 맞는 모델인지, ONNX 또는 Transformers.js에서 실행할 수 있는지, 라이선스상 사용 목적에 문제가 없는지 확인하십시오.

## 판정 데이터

Tarae의 기본 판정 자료는 `sql/schema.sql`의 `t_cleanroom`과 `t_defense`에 들어 있습니다. 두 테이블은 역할이 다릅니다.

### t_cleanroom

`t_cleanroom`은 단어나 문구를 직접 확인하는 규칙 저장소입니다. 일반 문자열뿐 아니라 자모 분해, 닮은꼴 문자, 띄어쓰기 변형처럼 필터를 피하려는 표현도 함께 관리합니다.

- `WAIT`: 아직 분류가 끝나지 않은 대기 항목입니다.
- `SUSPECT`: 문맥을 더 확인해야 하는 의심 항목입니다. 흔히 쓰이는 단어는 `required_terms`에 지정된 관련 단어가 함께 나올 때 추가 검사를 진행합니다.
- `POLLUTED`: 불법·유해 표현으로 확정된 오염 항목입니다. 원문에서 확인되면 바로 위반 판정에 반영합니다.
- `EXCEPTION`: 예방 안내나 정상적인 설명처럼 검사에서 제외할 예외 항목입니다.

`pattern_text`에는 검사할 표현, `required_terms`에는 함께 확인할 단어, `memo`에는 표현의 의미와 등록 이유가 들어갑니다. 프로그램은 이 자료를 검사 세션의 캐시에 올려 반복적인 데이터베이스 조회를 줄입니다.

### t_defense

`t_defense`는 이미 확인된 스팸 문장과 해당 문장의 임베딩 벡터를 저장합니다. `spam_text`에는 원문, `category`에는 분류, `vector_json`에는 384차원 벡터, `memo`에는 출처나 설명이 들어갑니다.

AI 파이프라인이 준비되면 `t_defense`의 벡터를 `Float32Array` 형태로 메모리에 올립니다. 새 항목을 학습하거나 기존 항목을 삭제하면 메모리 자료도 바로 갱신됩니다.

검사할 문장이 들어오면 같은 모델로 문장 벡터를 한 번 만든 뒤 메모리에 있는 전체 스팸 벡터와 비교합니다. 벡터를 정규화한 상태에서 내적을 계산하므로 결과적으로 코사인 유사도 검사와 같습니다. 가장 높은 점수와 일치한 스팸 문장을 판정에 사용합니다.

- 유사도 `0.85` 이상: 고위험 항목으로 판정합니다.
- 유사도 `0.70` 이상 `0.85` 미만: 의심 구간으로 보고 다른 규칙과 AI 결과를 함께 확인합니다.

`t_cleanroom`이 표현 자체를 빠르게 확인하는 규칙이라면, `t_defense`는 문장이 정확히 같지 않아도 전체 의미가 비슷한 스팸을 찾기 위한 자료입니다.

## 로그인 API

`REMOTE_LOGIN_API_URL`에는 로그인 요청을 처리할 주소를 입력합니다.

```json
{
  "userid": "사용자 아이디",
  "passwd": "사용자 비밀번호"
}
```

로그인에 성공하면 서버는 다음 형식으로 사용자 정보를 반환합니다.

```json
{
  "error": 0,
  "msg": "로그인 하였습니다.",
  "uAuth": "관리자 권한",
  "user": {
    "a_id": "사용자 아이디",
    "a_name": "사용자 이름",
    "a_auth": "관리자 권한",
    "a_status": "사용자 상태",
    "a_email": "이메일",
    "a_mobile": "연락처",
    "a_dept": "부서",
    "a_gpu": "GPU 설정"
  }
}
```

서버에서는 사용자를 조회한 뒤 로그인 실패 횟수와 상태를 확인합니다. 실패 횟수가 5회 이상이거나 상태가 `B`이면 로그인을 막고, 상태가 `R`이면 승인 대기 메시지를 반환합니다. 비밀번호가 맞으면 사용자 정보와 권한을 반환하고 마지막 로그인 시간을 갱신합니다.

백엔드는 사용하는 언어나 프레임워크와 관계없이 위 JSON 형식에 맞게 구성하면 됩니다. 요청은 POST로 받고, 성공과 실패 모두 `Content-Type: application/json`으로 응답하십시오. `error`는 성공일 때 `0`, 실패할 때 `1`을 사용합니다.

## 사용자 설정 변경 API

`REMOTE_UPDATE_API_URL`에는 사용자 GPU 설정을 저장할 주소를 입력합니다.

```json
{
  "userid": "사용자 아이디",
  "a_gpu": "GPU 설정값",
  "mode": "gup"
}
```

성공 응답:

```json
{
  "error": 0,
  "msg": "GPU 설정이 성공적으로 저장되었습니다.",
  "a_gpu": "저장된 GPU 설정값"
}
```

백엔드는 위 JSON에서 `mode`가 `gup`인지 확인한 뒤 `userid`에 해당하는 사용자의 GPU 설정을 `a_gpu` 값으로 저장하면 됩니다. 처리 결과는 `error`, `msg`, `a_gpu`를 포함한 JSON으로 반환하십시오.

운영 서버에서는 HTTPS를 사용하고, 허용할 요청 출처를 실제 서비스 주소로 제한하십시오. 비밀번호와 인증정보는 로그에 남기지 않는 것이 좋습니다.

## Windows 빌드

```powershell
npm run build:win
```

빌드할 때 `sql/schema.sql`을 기준으로 초기 데이터베이스를 만듭니다. 개발 중 생성된 `cms.db`, `node_modules`, `dist`, `build`, `scratch`, `logs`, `output`은 소스 배포 대상에서 제외합니다.

## 저작권과 라이선스

Tarae(타래)는 대한민국 프로그램 저작권으로 등록되어 있습니다.

- 접수번호: `2026-061499`
- 등록번호: `C-2026-049841`

Tarae의 원본 소스 코드는 [MIT License](LICENSE)에 따라 사용, 수정 및 배포할 수 있습니다. 외부 라이브러리와 AI 모델에는 각 제작자가 정한 별도 라이선스가 적용됩니다.
