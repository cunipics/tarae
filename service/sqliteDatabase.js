const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('../config/config');
const { GOV_ILLEGAL_KEYWORDS } = require('../utils/govKeywords');
const { decomposeHangul, hasHangul } = require('../utils/hangul');

let database = null;

function initCleanroomDefaults(db) {
  // 1. t_cleanroom 테이블 생성 보장
  db.exec(`
    CREATE TABLE IF NOT EXISTS t_cleanroom (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern_type TEXT NOT NULL,
      pattern_text TEXT NOT NULL,
      source_finding_id TEXT,
      source_url TEXT,
      required_terms TEXT,
      memo TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(pattern_text)
    );
    CREATE INDEX IF NOT EXISTS idx_cleanroom_type ON t_cleanroom (pattern_type);
  `);

  // 2. 가이드 4대 패턴 및 준비된 오염 패턴 등록 (없으면 INSERT, 기존 WAIT였으면 POLLUTED로 보정)
  const defaultPollutedPatterns = [
    { text: 'ㅋㅏㅈㅣㄴㅗ ㅂㅗㄴㅓㅅㅡ 코드 LUCKY7', memo: '가이드 예시 [JAMO] 자모 분해 불법광고' },
    { text: 'ｍｅｇａ－ＢＥＴ 첫충 30％ 지급', memo: '가이드 예시 [HOMOGLYPH] 닮은꼴 글자 위장 불법광고' },
    { text: '먹튀검증 안전놀이터 상담 텔레그램 @promo_777', memo: '가이드 예시 [TRANSPARENT] 투명 텍스트 은닉 불법광고' },
    { text: '무료 슬롯 체험 바로가기', memo: '가이드 예시 [OFFSCREEN] 화면 밖 은닉 불법광고' },
    { text: '첫충 30% 매충 10% 지급 안전 메이저', memo: '불법 도박 홍보' },
    { text: '무서류 비대면 당일 급전 소액 대출 문의 상담', memo: '불법 대출 스팸' },
    // 불법 유흥 [풀싸롱] 계열
    { text: '풀싸롱', memo: '불법 유흥 스팸 [풀싸롱]' },
    { text: '팔용동풀싸롱', memo: '불법 유흥 스팸 [풀싸롱]' },
    { text: '상남동풀싸롱', memo: '불법 유흥 스팸 [풀싸롱]' },
    // 불법 유흥 [호스트빠 / 호스트바] 계열
    { text: '호스트빠', memo: '불법 유흥 스팸 [호스트빠]' },
    { text: '호스트바', memo: '불법 유흥 스팸 [호스트바]' },
    { text: '창원호스트빠', memo: '불법 유흥 스팸 [호스트빠]' },
    { text: '창원호스트바', memo: '불법 유흥 스팸 [호스트바]' },
    // 불법 유흥 [호빠] 지역별 세부 오염 패턴
    { text: '호빠', memo: '불법 유흥 스팸 [호빠]' },
    { text: '김해호빠', memo: '불법 유흥 스팸 [호빠]' },
    { text: '창원호빠', memo: '불법 유흥 스팸 [호빠]' },
    { text: '울산호빠', memo: '불법 유흥 스팸 [호빠]' },
    { text: '거제도호빠', memo: '불법 유흥 스팸 [호빠]' },
    { text: '경주호빠', memo: '불법 유흥 스팸 [호빠]' },
    { text: '포항호빠', memo: '불법 유흥 스팸 [호빠]' },
    { text: '마산호빠', memo: '불법 유흥 스팸 [호빠]' },
    { text: '진해호빠', memo: '불법 유흥 스팸 [호빠]' },
    { text: '장유호빠', memo: '불법 유흥 스팸 [호빠]' },
    { text: '용원호빠', memo: '불법 유흥 스팸 [호빠]' },
    { text: '물금호빠', memo: '불법 유흥 스팸 [호빠]' },
    { text: '율하호빠', memo: '불법 유흥 스팸 [호빠]' },
    { text: '명지호빠', memo: '불법 유흥 스팸 [호빠]' },
    { text: '진영호빠', memo: '불법 유흥 스팸 [호빠]' },
    { text: '진주호빠', memo: '불법 유흥 스팸 [호빠]' },
    { text: '상남동호빠', memo: '불법 유흥 스팸 [호빠]' },
    { text: '고현호빠', memo: '불법 유흥 스팸 [호빠]' },
    { text: '창원상남동호빠', memo: '불법 유흥 스팸 [호빠]' },
    { text: '거제호빠', memo: '불법 유흥 스팸 [호빠]' },
    { text: '통영호빠', memo: '불법 유흥 스팸 [호빠]' },
    { text: '사천호빠', memo: '불법 유흥 스팸 [호빠]' },
    { text: '창원상남호빠', memo: '불법 유흥 스팸 [호빠]' },
    { text: '상남호빠', memo: '불법 유흥 스팸 [호빠]' },
    { text: '팔용동호빠', memo: '불법 유흥 스팸 [호빠]' },
    { text: '고성호빠', memo: '불법 유흥 스팸 [호빠]' },
    { text: '봉곡동호빠', memo: '불법 유흥 스팸 [호빠]' },
    { text: '함안호빠', memo: '불법 유흥 스팸 [호빠]' },
    { text: '밀양호빠', memo: '불법 유흥 스팸 [호빠]' },
    { text: '양산호빠', memo: '불법 유흥 스팸 [호빠]' },
    { text: '창녕호빠', memo: '불법 유흥 스팸 [호빠]' },
    { text: '남해호빠', memo: '불법 유흥 스팸 [호빠]' },
    { text: '여수호빠', memo: '불법 유흥 스팸 [호빠]' },
    { text: '울산삼산호빠', memo: '불법 유흥 스팸 [호빠]' },
    { text: '울산삼산동호빠', memo: '불법 유흥 스팸 [호빠]' },
  ];

  // 패턴 기본 등록용 쿼리 (기존에 등록된 패턴은 사용자의 상태를 보존하도록 DO NOTHING)
  const stmtUpsertPattern = db.prepare(`
    INSERT INTO t_cleanroom (pattern_type, pattern_text, memo, created_at, updated_at)
    VALUES (@pattern_type, @pattern_text, @memo, datetime('now', 'localtime'), datetime('now', 'localtime'))
    ON CONFLICT(pattern_text) DO NOTHING
  `);

  // 1. [기본 고의 은닉 예시] 심각한 오염(POLLUTED)으로 등록
  for (const item of defaultPollutedPatterns) {
    if (item.text === '무통') continue;
    stmtUpsertPattern.run({
      pattern_type: 'POLLUTED',
      pattern_text: item.text,
      memo: item.memo
    });
  }

  // 2. 정부 가이드 키워드 분류 등록:
  // - 평문 키워드는 'SUSPECT'(의심)으로 등록 -> LLM 심층 판정 대상!
  // - 자모 분해 은어 키워드는 고의적 은닉이므로 'POLLUTED'(오염)으로 등록 -> 즉시 스팸 차단!
  if (Array.isArray(GOV_ILLEGAL_KEYWORDS)) {
    for (const kw of GOV_ILLEGAL_KEYWORDS) {
      if (!kw || !kw.text) continue;
      const originalText = kw.text.trim();
      if (originalText === '무통') continue;

      const originalMemo = kw.meaning ? `[${kw.category}] ${kw.meaning}` : `[${kw.category}] 불법광고 은어`;

      // 1) 평문 패턴은 'SUSPECT(의심)'으로 등록
      stmtUpsertPattern.run({
        pattern_type: 'SUSPECT',
        pattern_text: originalText,
        memo: originalMemo
      });

      // 2) 한글 자모 분리 데이터는 고의 은닉이므로 'POLLUTED(오염)'으로 등록
      if (hasHangul(originalText)) {
        const jamoText = decomposeHangul(originalText);
        if (jamoText && jamoText !== originalText && jamoText !== 'ㅁㅜㅌㅗㅇ') {
          const jamoMemo = `[자모 분해 은어: ${originalText}] ${kw.meaning || '불법 광고 은어'}`;
          stmtUpsertPattern.run({
            pattern_type: 'POLLUTED',
            pattern_text: jamoText,
            memo: jamoMemo
          });
        }
      }
    }
  }

  // 3. '무통' 및 'ㅁㅜㅌㅗㅇ' 키워드 영구 삭제
  db.prepare(`DELETE FROM t_cleanroom WHERE pattern_text IN ('무통', 'ㅁㅜㅌㅗㅇ')`).run();

  // 4. 구버전 'CLEAN' 표기를 'EXCEPTION(예외)'으로 통일
  db.prepare(`UPDATE t_cleanroom SET pattern_type = 'EXCEPTION' WHERE pattern_type = 'CLEAN'`).run();

  const defaultExceptionPatterns = [
    { text: '불법 사설 도박 근절 및 피해 예방 신고 안내', memo: '정상 예방 공지' },
    { text: '내국인 카지노 출입 제한 일수 및 이용 수칙', memo: '정상 이용 수칙' },
    { text: '청소년 불법 도박 중독 예방 교육 및 상담 안내', memo: '정상 교육 홍보' },
    { text: '종이형 지역사랑상품권 판매·환전 지점 정보', memo: '공공 행정 [상품권 환전 지점]' },
    { text: '지역사랑상품권 판매 및 환전 안내', memo: '공공 행정 [지역상품권 환전]' },
    { text: '온누리상품권 가맹점 및 환전 대행점 안내', memo: '공공 행정 [온누리상품권]' },
    { text: '외화 환전 수수료 우대 및 지점 안내', memo: '정상 금융 [외화 환전]' },
    { text: '공공데이터 개방 데이터셋 목록', memo: '공공 행정 [데이터셋 목록]' },
    { text: '온라인 무통장입금 및 결제 안내', memo: '정상 수납 안내 [무통장입금]' }
  ];

  for (const item of defaultExceptionPatterns) {
    stmtUpsertPattern.run({
      pattern_type: 'EXCEPTION',
      pattern_text: item.text,
      memo: item.memo
    });
  }

  // 현재 t_cleanroom 데이터 카운트 로그
  const stats = db.prepare(`
    SELECT pattern_type, count(*) as cnt FROM t_cleanroom GROUP BY pattern_type
  `).all();
  console.log('[Cleanroom Init 4-Stage Stats]:', JSON.stringify(stats));
}

function getDatabase() {
  if (database) return database;

  const filename = config.db.sqlite.filename;
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  database = new DatabaseSync(filename);
  database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');

  // 기존 정화소 DB에 의심 단어 짝 단어 컬럼을 먼저 추가한다.
  try {
    database.exec('ALTER TABLE t_cleanroom ADD COLUMN required_terms TEXT;');
  } catch (err) {
    // 새 DB이거나 이미 컬럼이 있는 경우 정상 무시
  }

  try {
    const schemaPath = path.join(__dirname, '..', 'sql', 'schema.sql');
    if (fs.existsSync(schemaPath)) {
      database.exec(fs.readFileSync(schemaPath, 'utf8'));
    }
  } catch (err) {
    console.error('schema.sql 실행 경고:', err.message);
  }

  // 이전 실행에서 중복 저장된 동일 적발을 정리하고, 종료 처리가 여러 번 호출되어도 재등록되지 않도록 보장
  try {
    const before = database.prepare('SELECT COUNT(*) AS count FROM t_detect_list').get().count;
    database.exec(`
      BEGIN IMMEDIATE;
      DELETE FROM t_detect_list
      WHERE id NOT IN (
        SELECT MIN(id)
        FROM t_detect_list
        GROUP BY master_id, finding_id, url, is_violation, location, evidence_text, technique, IFNULL(extra_finding, '')
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_detect_finding_identity
      ON t_detect_list (master_id, finding_id, url, is_violation, location, evidence_text, technique, IFNULL(extra_finding, ''));
      COMMIT;
    `);
    const after = database.prepare('SELECT COUNT(*) AS count FROM t_detect_list').get().count;
    if (before !== after) console.log(`[Detect DB] 중복 적발 ${before - after}건 정리`);
  } catch (err) {
    try { database.exec('ROLLBACK;'); } catch (rollbackErr) {}
    console.error('적발 항목 중복 정리 오류:', err.message);
  }

  // t_detect 테이블에 title 및 임시 키워드 컬럼 누락 방지 안전 마이그레이션
  try {
    database.exec('ALTER TABLE t_detect ADD COLUMN title TEXT;');
  } catch (err) {
    // 이미 컬럼이 존재하는 경우 정상 무시
  }
  try {
    database.exec('ALTER TABLE t_detect ADD COLUMN apply_keywords TEXT;');
  } catch (err) {
    // 이미 컬럼이 존재하는 경우 정상 무시
  }
  try {
    database.exec('ALTER TABLE t_detect ADD COLUMN exclude_keywords TEXT;');
  } catch (err) {
    // 이미 컬럼이 존재하는 경우 정상 무시
  }
  try {
    database.exec('ALTER TABLE t_detect ADD COLUMN detected_cms TEXT;');
  } catch (err) {
    // 이미 컬럼이 존재하는 경우 정상 무시
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS t_detect_solution (
      master_id INTEGER NOT NULL,
      finding_id TEXT NOT NULL,
      target_text TEXT NOT NULL DEFAULT '',
      clean_title TEXT NOT NULL DEFAULT '',
      clean_body TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      PRIMARY KEY (master_id, finding_id),
      FOREIGN KEY (master_id) REFERENCES t_detect (id) ON DELETE CASCADE
    );
  `);

  // AI 추론 대화 내역 저장용 t_detect_log 테이블 생성 보장
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS t_detect_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        master_id INTEGER,
        url TEXT,
        input_ko TEXT NOT NULL,
        prompt_en TEXT,
        response_en TEXT,
        response_ko TEXT,
        similarity_val REAL DEFAULT 0,
        is_illegal INTEGER DEFAULT 0,
        confidence INTEGER DEFAULT 0,
        model_name TEXT,
        device_mode TEXT,
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        FOREIGN KEY (master_id) REFERENCES t_detect (id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_detect_log_master ON t_detect_log (master_id);
    `);
  } catch (err) {
    console.error('t_detect_log 생성 경고:', err.message);
  }

  // t_defense 테이블 생성 및 마이그레이션 (스팸 방어 학습 및 벡터 저장소)
  try {
    // 기존 t_spam 테이블이 있으면 t_defense로 자동 이름 변경 (데이터 보존)
    const hasSpamTable = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='t_spam'").get();
    const hasDefenseTable = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='t_defense'").get();
    if (hasSpamTable && !hasDefenseTable) {
      database.exec(`ALTER TABLE t_spam RENAME TO t_defense;`);
      console.log('[DB Migration] t_spam 테이블을 t_defense로 성공적으로 이름 변경(마이그레이션)했습니다.');
    }

    database.exec(`
      CREATE TABLE IF NOT EXISTS t_defense (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        spam_text TEXT NOT NULL,
        category TEXT DEFAULT 'SPAM',
        vector_json TEXT,
        memo TEXT,
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT DEFAULT (datetime('now', 'localtime')),
        UNIQUE(spam_text)
      );
      CREATE INDEX IF NOT EXISTS idx_defense_spam_text ON t_defense (spam_text);
    `);
  } catch (err) {
    console.error('t_defense 생성/마이그레이션 경고:', err.message);
  }

  // 기존 컬럼 누락 방지 안전 마이그레이션
  const logColumns = [
    { name: 'input_ko', type: 'TEXT' },
    { name: 'prompt_en', type: 'TEXT' },
    { name: 'response_en', type: 'TEXT' },
    { name: 'response_ko', type: 'TEXT' },
    { name: 'similarity_val', type: 'REAL DEFAULT 0' },
    { name: 'is_illegal', type: 'INTEGER DEFAULT 0' },
    { name: 'confidence', type: 'INTEGER DEFAULT 0' },
    { name: 'model_name', type: 'TEXT' },
    { name: 'device_mode', type: 'TEXT' }
  ];
  for (const col of logColumns) {
    try {
      database.exec(`ALTER TABLE t_detect_log ADD COLUMN ${col.name} ${col.type};`);
    } catch (e) {}
  }

  // 재시작 시 기본 문구 오염(POLLUTED) 강제 동기화 실행
  try {
    initCleanroomDefaults(database);
  } catch (err) {
    console.error('initCleanroomDefaults 오류:', err.message);
  }

  // 앱 새로 시작 시 이전 비정상 종료로 남아있던 진행 중(RUNNING) 점검을 자동으로 중단(STOPPED) 처리
  try {
    const cleanupResult = database.prepare(`
      UPDATE t_detect
      SET status = 'STOPPED',
          finished_at = COALESCE(finished_at, datetime('now', 'localtime'))
      WHERE status = 'RUNNING'
    `).run();
    if (cleanupResult.changes > 0) {
      console.log(`[Detect Cleanup] 비정상 종료되었던 점검 ${cleanupResult.changes}건을 자동으로 중단(STOPPED) 처리하였습니다.`);
    }
  } catch (err) {
    console.error('RUNNING 점검 상태 정리 오류:', err.message);
  }

  return database;
}

module.exports = { getDatabase, initCleanroomDefaults };
