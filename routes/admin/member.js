const path = require('path');
const fs = require('fs');
const express = require('express');
const router = express.Router();
const multer = require('multer');
const spamUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const commonDAO = require('../../service/commonDAO');
const util = require('../../utils/util');
const config = require('../../config/config');
const { buildResultReports, uniqueFindingRows } = require('../../service/resultReport');
const asyncReqHandler = require('../../service/asyncReqHandler');
const llmPipelineService = require('../../service/llmPipelineService');
const spamTrainService = require('../../service/spamTrainService');

function loadSession(req, res, next) {
  const authAdmin = req.session && req.session.authAdmin ? req.session.authAdmin : null;
  res.locals.admin = authAdmin;
  next();
}

function checkPermission(req, res, next) {
  next();
}

function normalizeRequiredTerms(value) {
  if (!value) return null;
  const terms = [...new Set(String(value)
    .split(/[,，\n\r]+/)
    .map(term => term.trim())
    .filter(Boolean))];
  return terms.length > 0 ? terms.join(',') : null;
}

router.get('/index', checkPermission, asyncReqHandler(async function(req, res) {
    let summary = { total_sites: 0, total_pages: 0, total_violations: 0, completed_sites: 0 };
    let masterList = [];
    let techStats = { JAMO: 0, HOMOGLYPH: 0, TRANSPARENT: 0, OFFSCREEN: 0, ETC: 0 };
    let categoryStats = { gambling_cnt: 0, adult_cnt: 0, loan_cnt: 0, total_cnt: 0 };
    let aiAccuracy = { total_cnt: 0, avg_sim_score: 0, avg_confidence: 0, illegal_cnt: 0 };

    // 검색 필터 파라미터
    const keyword = (req.query.keyword || '').trim();
    const statusFilter = (req.query.statusFilter || '').trim();

    // 실제 페이지 이동식 페이징 (Read Per Page 30건)
    const perPage = 30;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const offset = (page - 1) * perPage;
    let totalCount = 0;
    let totalPages = 1;

    try {
        const statsRes = await commonDAO.selectList('detectMapper.selectDetectSummaryStats');
        if (statsRes && statsRes.list && statsRes.list[0]) {
            const rawSummary = statsRes.list[0];
            summary = {
                total_sites: Number(rawSummary.total_sites) || 0,
                total_pages: Number(rawSummary.total_pages) || 0,
                total_violations: Number(rawSummary.total_violations) || 0,
                completed_sites: Number(rawSummary.completed_sites) || 0
            };
        }

        // 전체 건수 조회 (검색 조건 반영)
        const countRes = await commonDAO.selectList('detectMapper.selectDetectMasterCount', {
            keyword: keyword || null,
            statusFilter: statusFilter || null
        });
        if (countRes && countRes.list && countRes.list[0]) {
            totalCount = Number(countRes.list[0].total_count) || 0;
        }
        totalPages = Math.max(1, Math.ceil(totalCount / perPage));

        // 페이징된 30개 목록 조회 (검색 조건 반영)
        const listRes = await commonDAO.selectList('detectMapper.selectDetectMasterListPage', {
            limit: perPage,
            offset: offset,
            keyword: keyword || null,
            statusFilter: statusFilter || null
        });
        if (listRes && listRes.list) {
            masterList = listRes.list;
        }

        const techRes = await commonDAO.selectList('detectMapper.selectDetectTechniqueStats');
        if (techRes && techRes.list) {
            for (const item of techRes.list) {
                if (techStats.hasOwnProperty(item.technique)) {
                    techStats[item.technique] = Number(item.cnt) || 0;
                }
            }
        }

        const catRes = await commonDAO.selectList('detectMapper.selectDetectCategoryStats');
        if (catRes && catRes.list && catRes.list[0]) {
            const rawCat = catRes.list[0];
            categoryStats = {
                gambling_cnt: Number(rawCat.gambling_cnt) || 0,
                adult_cnt: Number(rawCat.adult_cnt) || 0,
                loan_cnt: Number(rawCat.loan_cnt) || 0,
                total_cnt: Number(rawCat.total_cnt) || 0
            };
        }

        // AI 평가 정확도 및 평균 유사도 통계 조회
        const aiRes = await commonDAO.selectList('detectMapper.selectDetectAiAccuracy');
        if (aiRes && aiRes.list && aiRes.list[0]) {
            const rawAi = aiRes.list[0];
            aiAccuracy = {
                total_cnt: Number(rawAi.total_cnt) || 0,
                avg_sim_score: Number(rawAi.avg_sim_score) || 0,
                avg_confidence: Number(rawAi.avg_confidence) || 0,
                illegal_cnt: Number(rawAi.illegal_cnt) || 0
            };
        }
    } catch (e) {
        console.error('[Dashboard Error]', e.message);
    }

    const pagination = {
        page,
        perPage,
        totalCount,
        totalPages,
        hasPrev: page > 1,
        hasNext: page < totalPages,
        prevPage: page - 1,
        nextPage: page + 1
    };

    res.render('admin/dashboard.html', {
        layout: "layout_admin.html",
        summary,
        masterList,
        techStats,
        categoryStats,
        aiAccuracy,
        keyword,
        statusFilter,
        pagination
    });
}));

// 과거 점검 결과 상세 조회 및 복원 API (단건)
router.get('/api/detect/history/:id', checkPermission, asyncReqHandler(async function(req, res) {
    const masterId = req.params.id;
    try {
        const masterRes = await commonDAO.selectList('detectMapper.selectDetectMaster', { id: masterId });
        const master = (masterRes && masterRes.list) ? masterRes.list[0] : null;
        if (!master) {
            return res.status(404).json({ success: false, message: '해당 점검 이력을 찾을 수 없습니다.' });
        }

        const findingsRes = await commonDAO.selectList('detectMapper.selectDetectFindings', { master_id: masterId });
        let findings = (findingsRes && findingsRes.list) ? findingsRes.list : [];

        // 진행 중인 동일 회차의 메모리 결과만 DB에 보완 저장
        if (findings.length === 0) {
            const engineStatus = detectEngine.getStatus();
            if (engineStatus && Array.isArray(engineStatus.findings) && engineStatus.findings.length > 0 &&
                String(engineStatus.masterId) === String(masterId)) {
                findings = engineStatus.findings;
            }

            // 복구된 findings를 t_detect_list에 보정 저장 (중복 방지)
            if (findings.length > 0) {
                for (const f of findings) {
                    try {
                        await commonDAO.execute_query('detectMapper.insertDetectFinding', {
                            master_id: Number(masterId),
                            finding_id: f.id || f.finding_id,
                            url: f.url,
                            is_violation: (f.is_violation === true || f.is_violation === 1) ? 1 : 0,
                            location: f.location || 'div',
                            evidence_text: f.evidence_text || '',
                            technique: f.technique || 'ETC',
                            extra_finding: f.extra_finding || f.reason || null
                        });
                    } catch (insErr) {}
                }
            }
        }

        const nodesRes = await commonDAO.selectList('detectMapper.selectDetectNodes', { master_id: masterId });
        const nodes = (nodesRes && nodesRes.list) ? nodesRes.list : [];
        findings = uniqueFindingRows(findings);

        res.json({
            success: true,
            data: {
                master,
                findings,
                nodes
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
}));

function getSolutionKey(req) {
    const masterId = Number(req.params.masterId);
    const findingId = String(req.params.findingId || '');
    if (!Number.isSafeInteger(masterId) || masterId < 1 || !/^[A-Za-z0-9_.-]{1,80}$/.test(findingId)) return null;
    return { master_id: masterId, finding_id: findingId };
}

router.get('/api/detect/solution/:masterId/:findingId', checkPermission, asyncReqHandler(async function(req, res) {
    const key = getSolutionKey(req);
    if (!key) return res.status(400).json({ success: false, message: '잘못된 탐지 번호입니다.' });
    const masterRes = await commonDAO.selectList('detectMapper.selectDetectMaster', { id: key.master_id });
    if (!masterRes.ok) return res.status(500).json({ success: false, message: '점검 이력을 읽지 못했습니다.' });
    if (!masterRes.list || !masterRes.list.length) return res.status(404).json({ success: false, message: '점검 이력이 없습니다.' });
    const savedRes = await commonDAO.selectList('detectMapper.selectDetectSolution', key);
    if (!savedRes.ok) return res.status(500).json({ success: false, message: '저장된 설정을 읽지 못했습니다.' });
    res.json({ success: true, data: savedRes.list && savedRes.list[0] ? savedRes.list[0] : null });
}));

router.post('/api/detect/solution/:masterId/:findingId', checkPermission, asyncReqHandler(async function(req, res) {
    const key = getSolutionKey(req);
    if (!key) return res.status(400).json({ success: false, message: '잘못된 탐지 번호입니다.' });
    const values = ['target_text', 'clean_title', 'clean_body'].map(field => req.body && req.body[field]);
    if (values.some(value => typeof value !== 'string') || values[0].length > 1000 || values[1].length > 200 || values[2].length > 2000) {
        return res.status(400).json({ success: false, message: '입력값의 형식이나 길이를 확인해 주세요.' });
    }
    const masterRes = await commonDAO.selectList('detectMapper.selectDetectMaster', { id: key.master_id });
    if (!masterRes.ok) return res.status(500).json({ success: false, message: '점검 이력을 읽지 못했습니다.' });
    if (!masterRes.list || !masterRes.list.length) return res.status(404).json({ success: false, message: '점검 이력이 없습니다.' });
    const findingRes = await commonDAO.selectList('detectMapper.selectDetectFindingForSolution', key);
    if (!findingRes.ok) return res.status(500).json({ success: false, message: '탐지 결과를 읽지 못했습니다.' });
    const live = detectEngine.getStatus();
    const isLiveFinding = String(live.masterId) === String(key.master_id) &&
        Array.isArray(live.findings) && live.findings.some(item => item.id === key.finding_id);
    if ((!findingRes.list || !findingRes.list.length) && !isLiveFinding) {
        return res.status(404).json({ success: false, message: '탐지 결과가 없습니다.' });
    }
    const saveRes = await commonDAO.execute_query('detectMapper.upsertDetectSolution', {
        ...key,
        target_text: values[0].trim(),
        clean_title: values[1].trim(),
        clean_body: values[2].trim()
    });
    if (!saveRes.ok) return res.status(500).json({ success: false, message: '설정을 저장하지 못했습니다.' });
    res.json({ success: true });
}));

router.get('/member/list', checkPermission, asyncReqHandler(async function(req, res) {
    res.render('admin/member_list.html',{layout:"layout_admin.html"});
}));

router.get('/api/model-status', checkPermission, asyncReqHandler(async function(req, res) {
    res.json(llmPipelineService.getStatus());
}));

router.post('/api/model-init', checkPermission, asyncReqHandler(async function(req, res) {
    const status = await llmPipelineService.startLoading();
    res.json(status);
}));

// GPU 모드 상태 조회 API
router.get('/api/ai/gpu-mode', checkPermission, asyncReqHandler(async function(req, res) {
    const sessionGpu = (req.session.authAdmin && req.session.authAdmin.row && req.session.authAdmin.row.a_gpu !== undefined)
        ? req.session.authAdmin.row.a_gpu
        : llmPipelineService.getGpuMode();
    res.json({
        success: 'Y',
        a_gpu: sessionGpu,
        isGpu: sessionGpu === 1,
        deviceMode: llmPipelineService.getStatus().deviceMode
    });
}));

// GPU 모드 토글 및 PHP 서버 원격 동기화 API (/mgr/update, /mgr/api/ai/gpu-mode)
router.post(['/api/ai/gpu-mode', '/update'], checkPermission, asyncReqHandler(async function(req, res) {
    const rawGpu = req.body && req.body.a_gpu !== undefined ? req.body.a_gpu : (req.input && req.input.a_gpu);
    const a_gpu = Number(rawGpu) === 1 ? 1 : 0;
    const isGpu = a_gpu === 1;

    const userid = req.session.authAdmin && req.session.authAdmin.row ? req.session.authAdmin.row.u_id : '';
    if (!userid) {
        return res.json({ success: "N", msg: "로그인 세션이 만료되었습니다." });
    }

    let remoteGpuUrl = (config.auth && config.auth.remoteUpdateUrl) || process.env.REMOTE_GPU_API_URL || 'https://cms07.cafe24.com/_api/update/';
    if (!remoteGpuUrl) {
        return res.json({ success: "N", msg: "원격 서버 업데이트 설정이 올바르지 않습니다." });
    }

    if (!remoteGpuUrl.endsWith('/') && !remoteGpuUrl.includes('?') && !remoteGpuUrl.endsWith('.php')) {
        remoteGpuUrl += '/';
    }

    // 1. 원격 PHP 서버에 업데이트 요청
    const postBody = new URLSearchParams();
    postBody.append('mode', 'gup');
    postBody.append('userid', userid);
    postBody.append('user_id', userid);
    postBody.append('id', userid);
    postBody.append('u_id', userid);
    postBody.append('userId', userid);
    postBody.append('a_id', userid);
    postBody.append('a_gpu', String(a_gpu));

    let remoteRes = null;
    try {
        remoteRes = await fetch(remoteGpuUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
            },
            body: postBody.toString(),
            signal: AbortSignal.timeout(10000)
        });
    } catch (networkErr) {
        return res.json({ success: "N", msg: "원격 서버 연결 실패: " + networkErr.message });
    }

    if (!remoteRes.ok) {
        return res.json({ success: "N", msg: `원격 서버 응답 오류가 발생했습니다. (${remoteRes.status})` });
    }

    let rawText = '';
    let resData = null;
    try {
        rawText = await remoteRes.text();
        resData = JSON.parse(rawText);
    } catch (jsonErr) {
        return res.json({ success: "N", msg: "원격 서버가 올바른 JSON 응답을 반환하지 않았습니다. (" + rawText.slice(0, 100) + ")" });
    }

    // 2. PHP API 규격: error === 0 일 때만 성공으로 처리하고 1년짜리 쿠키 발급
    if (resData && (resData.error === 0 || resData.error === "0")) {
        const ONE_YEAR_MS = 1000 * 60 * 60 * 24 * 365; // 1년 (365일)

        // (1) 세션 쿠키 1년 연장 (로그인과 동일하게 처리)
        if (req.session) {
            req.session.cookie.maxAge = ONE_YEAR_MS;
            if (req.session.authAdmin && req.session.authAdmin.row) {
                req.session.authAdmin.row.a_gpu = a_gpu;
            }
            req.session.save();
        }

        // (2) 1년짜리 HTTP 쿠키 발급
        res.cookie('a_gpu', String(a_gpu), {
            maxAge: ONE_YEAR_MS,
            path: '/',
            httpOnly: false,
            sameSite: 'lax'
        });

        // (3) AI 파이프라인 실제 디바이스 모드 즉각 전환
        await llmPipelineService.setGpuMode(isGpu);

        return res.json({
            success: 'Y',
            a_gpu,
            isGpu,
            deviceMode: llmPipelineService.getStatus().deviceMode,
            msg: resData.msg || (isGpu ? 'GPU 하드웨어 가속 모드가 활성화되었습니다.' : 'CPU 모드로 전환되었습니다.')
        });
    } else {
        // error !== 0 실패 시에는 세션이나 쿠키를 변경하지 않고 실패 응답 반환
        return res.json({
            success: 'N',
            msg: (resData && resData.msg) ? resData.msg : "원격 서버 설정 저장에 실패했습니다."
        });
    }
}));

// 단일 문장 AI 판정 테스트 API
router.post('/api/test-ai-classify', checkPermission, asyncReqHandler(async function(req, res) {
    const text = (req.body && req.body.text) ? req.body.text : '';
    const result = await llmPipelineService.classifyText(text, { url: 'AI 단독 판정 테스트' });
    res.json({ success: true, result });
}));

// 대표 샘플 일괄 판정 테스트 API
router.get('/api/test-ai-classify', checkPermission, asyncReqHandler(async function(req, res) {
    const samples = [
        '카지노 보너스 코드 LUCKY7 첫충 30% 지급',
        '먹튀검증 안전놀이터 문의 텔레그램 @promo_777',
        '불법 사설 도박 근절 및 피해 예방 신고 안내',
        '2026년 공공기관 열린마당 우수 혁신사례 공모전 안내'
    ];
    const results = [];
    for (const sample of samples) {
        const resItem = await llmPipelineService.classifyText(sample, { url: 'AI 샘플 일괄 테스트' });
        results.push(resItem);
    }
    res.json({ success: true, count: results.length, results });
}));

// AI 추론 및 대화 로그 목록 조회 API
router.get('/api/detect/logs/:masterId', checkPermission, asyncReqHandler(async function(req, res) {
    const masterId = req.params.masterId;
    try {
        const logRes = await commonDAO.selectList('detectMapper.selectDetectLogs', { master_id: masterId });
        res.json({ success: true, list: (logRes && logRes.list) ? logRes.list : [] });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
}));

// 자모 분해('ㅂㅏㅋㅏㄹㅏ' 등) 및 4대 은닉 수법 실전 검증용 모의 테스트 페이지
router.get('/sample/jamo-test', function(req, res) {
    res.send(`<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <title>불법광고 및 자모 분해 실전 검증 테스트 페이지</title>
</head>
<body style="font-family: sans-serif; padding: 20px; line-height: 1.6;">
  <h1>실전 불법광고 탐지 테스트 페이지</h1>
  <p>이 페이지는 FCMS 엔진의 4대 은닉기법 및 LLM 문맥 검증을 테스트하기 위한 샘플입니다.</p>
  
  <hr>
  
  <!-- 1. 자모 분해 (JAMO) 테스트 샘플 -->
  <section style="margin-bottom: 20px;">
    <h2>1. 자모 분해 스팸 샘플</h2>
    <p>실시간 라이브 카지노 <strong>ㅂㅏㅋㅏㄹㅏ</strong> 게임 첫충 30% 보너스 지급!</p>
    <p>안전 놀이터 <strong>ㅋㅏㅈㅣㄴㅗ</strong> & <strong>ㅌㅗㅌㅗ</strong> 즉시 환전 보장</p>
    <p>잭팟 터지는 <strong>ㅅㅡㄹㄹㅗㅅ</strong> 머신 무료 쿠폰 지급</p>
  </section>
  
  <!-- 2. 닮은꼴 글자 (HOMOGLYPH) 테스트 샘플 -->
  <section style="margin-bottom: 20px;">
    <h2>2. 닮은꼴 글자 위장 샘플</h2>
    <p>해외 안전 스포츠 베팅 <strong>ｍｅｇａ－ＢＥＴ</strong> 주소 안내</p>
  </section>

  <!-- 3. 투명 텍스트 (TRANSPARENT) 테스트 샘플 -->
  <section style="margin-bottom: 20px;">
    <h2>3. 투명 텍스트 은닉 샘플</h2>
    <div style="opacity: 0; color: transparent; font-size: 1px;">
      비밀 사설 바카라 VIP 초대 코드 텔레그램 @secret_baccarat
    </div>
    <p>겉으로는 정상적인 안내문이지만 뒤에 투명 글자가 숨겨져 있습니다.</p>
  </section>

  <!-- 4. 화면 밖 은닉 (OFFSCREEN) 테스트 샘플 -->
  <section style="margin-bottom: 20px;">
    <h2>4. 화면 밖 은닉 샘플</h2>
    <div style="position: absolute; left: -9999px; top: -9999px;">
      먹튀 없는 메이저 안전 카지노 사이트 주소 모음
    </div>
    <p>화면 좌측 바깥(-9999px)에 검색엔진 노출용 스팸이 숨겨져 있습니다.</p>
  </section>

  <!-- 5. 정상 대조군 샘플 (오탐 방지 검증용) -->
  <section style="margin-bottom: 20px; background: #f8f9fa; padding: 15px; border-radius: 8px;">
    <h2>5. 정상 공공 및 학교 콘텐츠 (오탐 방지 대조군)</h2>
    <p>부산여자대학교 바리스타&카페창업과, 제9회 전포커피축제 참가 안내</p>
    <p>[시사포커스] 2026년 공공기관 디지털 혁신 사업 공모전 공지</p>
    <p>위 문장은 '포커'라는 글자가 들어가 있지만 도박이 아니므로 정상 통과되어야 합니다.</p>
  </section>
</body>
</html>`);
});

router.get('/search', checkPermission, asyncReqHandler(async function(req, res) {
    const webviewPreloadPath = path.resolve(__dirname, '../../static/js/webview-preload.js');
    res.render('admin/search.html', { layout: "layout_admin.html", webviewPreloadPath: webviewPreloadPath });
}));

router.get('/train', checkPermission, asyncReqHandler(async function(req, res) {
    res.render('admin/train.html', { layout: "layout_admin.html" });
}));

router.get('/settings', checkPermission, asyncReqHandler(async function(req, res) {
    res.render('admin/settings.html', { layout: "layout_admin.html" });
}));

// 크롤러 URL 수집 설정 조회 API
const crawlerConfigModule = require('../../config/crawler.config');
router.get('/api/crawler-config', checkPermission, asyncReqHandler(async function(req, res) {
    const cfg = crawlerConfigModule.getConfig();
    res.json({ success: true, data: cfg });
}));

// 크롤러 URL 수집 설정 저장 API
router.post('/api/crawler-config', checkPermission, asyncReqHandler(async function(req, res) {
    const settings = req.body || {};
    const saved = crawlerConfigModule.saveConfig(settings);
    res.json({ success: true, message: '크롤러 설정이 저장되었습니다.', data: saved });
}));

// 데이터 정화소 (t_cleanroom) 목록 조회 API
router.get('/api/cleanroom', checkPermission, asyncReqHandler(async function(req, res) {
    const pattern_type = req.query.type || '';
    const result = await commonDAO.selectList('cleanroomMapper.selectCleanroomList', { pattern_type });
    const list = (result && result.list) ? result.list : [];
    res.json({ success: true, count: list.length, list });
}));

// 데이터 정화소 4단계 상태별 건수 통계 API (대기, 의심, 오염, 예외)
router.get('/api/cleanroom/counts', checkPermission, asyncReqHandler(async function(req, res) {
    const result = await commonDAO.selectList('cleanroomMapper.countCleanroomByType', {});
    const counts = { WAIT: 0, SUSPECT: 0, POLLUTED: 0, EXCEPTION: 0 };
    if (result && result.list) {
        for (const row of result.list) {
            const type = String(row.pattern_type || '').toUpperCase();
            if (type === 'CLEAN' || type === 'EXCEPTION') {
                counts.EXCEPTION = (counts.EXCEPTION || 0) + Number(row.cnt || 0);
            } else if (counts[type] !== undefined) {
                counts[type] = Number(row.cnt || 0);
            }
        }
    }
    res.json({ success: true, counts });
}));

// 데이터 정화소 신규 패턴 등록 API
router.post('/api/cleanroom', checkPermission, asyncReqHandler(async function(req, res) {
    const { pattern_type, pattern_text, source_finding_id, source_url, required_terms, memo } = req.body || {};
    if (!pattern_text || !pattern_text.trim()) {
        return res.status(400).json({ success: false, message: '패턴 문구를 입력해 주세요.' });
    }
    const cleanPattern = pattern_text.trim();
    let type = (pattern_type || 'WAIT').toUpperCase();
    if (type === 'CLEAN') type = 'EXCEPTION';

    // 설명 필수 조건:
    // "대기(WAIT)", "예외(EXCEPTION)" 등록 시에는 설명이 없어도 됨
    // "의심(SUSPECT)", "오염(POLLUTED)" 등록 시에는 설명이 반드시 있어야 함
    const isMemoRequired = (type === 'SUSPECT' || type === 'POLLUTED');
    if (isMemoRequired && (!memo || !memo.trim())) {
        return res.status(400).json({ success: false, message: '의심 또는 오염 상태는 설명을 반드시 입력해야 합니다.' });
    }

    // 중복 키워드 사전 검사
    const dupCheck = await commonDAO.selectList('cleanroomMapper.selectCleanroomByText', { pattern_text: cleanPattern });
    if (dupCheck && dupCheck.list && dupCheck.list.length > 0) {
        return res.status(400).json({ success: false, message: '이미 등록 된 키워드 입니다.' });
    }

    try {
        await commonDAO.execute_query('cleanroomMapper.insertCleanroom', {
            pattern_type: type,
            pattern_text: cleanPattern,
            source_finding_id: source_finding_id || null,
            source_url: source_url || null,
            required_terms: type === 'SUSPECT' ? normalizeRequiredTerms(required_terms) : null,
            memo: memo ? memo.trim() : ''
        });
        res.json({ success: true, message: '패턴이 정상 등록되었습니다.' });
    } catch (err) {
        if (String(err).includes('UNIQUE') || String(err).includes('constraint')) {
            return res.status(400).json({ success: false, message: '이미 등록 된 키워드 입니다.' });
        }
        res.status(500).json({ success: false, message: '등록 중 오류가 발생했습니다: ' + err.message });
    }
}));

// 데이터 정화소 리스트 상태 이동 API (WAIT, SUSPECT, POLLUTED, EXCEPTION)
router.put('/api/cleanroom/status', checkPermission, asyncReqHandler(async function(req, res) {
    const { id, pattern_type, memo } = req.body || {};
    if (!id || !pattern_type) {
        return res.status(400).json({ success: false, message: '필수 항목이 누락되었습니다.' });
    }
    let targetType = String(pattern_type).toUpperCase();
    if (targetType === 'CLEAN') targetType = 'EXCEPTION';

    // 기존 항목 정보 조회
    const currentResult = await commonDAO.selectOne('cleanroomMapper.selectCleanroomById', { id: Number(id) });
    const current = currentResult && currentResult.row;
    if (!current) {
        return res.status(404).json({ success: false, message: '해당 패턴 항목을 찾을 수 없습니다.' });
    }

    // 설명 필수 조건:
    // "대기", "예외" 상태로 이동 시에는 설명이 없어도 됨
    // "의심", "오염" 상태로 이동 시에는 설명이 반드시 있어야 함
    const isMemoRequired = (targetType === 'SUSPECT' || targetType === 'POLLUTED');
    let finalMemo = (memo !== undefined && memo !== null) ? memo.trim() : (current.memo ? current.memo.trim() : '');

    if (isMemoRequired && !finalMemo) {
        return res.status(400).json({ success: false, message: '의심 또는 오염 상태로 이동 시에는 설명을 반드시 입력해야 합니다.' });
    }

    // 이동 시에도 중복 키워드 확인 (다른 ID에 동일 패턴이 이미 등록되어 있는지 검사)
    const dupCheck = await commonDAO.selectList('cleanroomMapper.selectCleanroomByTextExcludeId', {
        pattern_text: current.pattern_text.trim(),
        exclude_id: Number(id)
    });
    if (dupCheck && dupCheck.list && dupCheck.list.length > 0) {
        return res.status(400).json({ success: false, message: '이미 등록 된 키워드 입니다.' });
    }

    try {
        await commonDAO.execute_query('cleanroomMapper.updateCleanroomStatusAndMemo', {
            id: Number(id),
            pattern_type: targetType,
            memo: finalMemo
        });
        res.json({ success: true, message: '상태가 성공적으로 변경되었습니다.' });
    } catch (err) {
        if (String(err).includes('UNIQUE') || String(err).includes('constraint')) {
            return res.status(400).json({ success: false, message: '이미 등록 된 키워드 입니다.' });
        }
        res.status(500).json({ success: false, message: '상태 변경 중 오류가 발생했습니다: ' + err.message });
    }
}));

// 데이터 정화소 패턴 문구 수정 API
router.put('/api/cleanroom/text', checkPermission, asyncReqHandler(async function(req, res) {
    const { id, pattern_text, required_terms, memo } = req.body || {};
    if (!id || !pattern_text || !pattern_text.trim()) {
        return res.status(400).json({ success: false, message: '수정할 패턴 문구를 입력해 주세요.' });
    }
    const cleanPattern = pattern_text.trim();

    // 기존 항목 정보 조회
    const currentResult = await commonDAO.selectOne('cleanroomMapper.selectCleanroomById', { id: Number(id) });
    const current = currentResult && currentResult.row;
    const currentType = current ? current.pattern_type : 'WAIT';

    const isMemoRequired = (currentType === 'SUSPECT' || currentType === 'POLLUTED');
    if (isMemoRequired && (!memo || !memo.trim())) {
        return res.status(400).json({ success: false, message: '의심 또는 오염 상태는 설명을 반드시 입력해야 합니다.' });
    }

    // 수정 시 중복 키워드 확인 (본인 제외)
    const dupCheck = await commonDAO.selectList('cleanroomMapper.selectCleanroomByTextExcludeId', {
        pattern_text: cleanPattern,
        exclude_id: Number(id)
    });
    if (dupCheck && dupCheck.list && dupCheck.list.length > 0) {
        return res.status(400).json({ success: false, message: '이미 등록 된 키워드 입니다.' });
    }

    try {
        await commonDAO.execute_query('cleanroomMapper.updateCleanroomText', {
            id: Number(id),
            pattern_text: cleanPattern,
            required_terms: currentType === 'SUSPECT' ? (normalizeRequiredTerms(required_terms) || '') : null,
            memo: memo ? memo.trim() : ''
        });
        res.json({ success: true, message: '패턴 문구가 정상 수정되었습니다.' });
    } catch (err) {
        if (String(err).includes('UNIQUE') || String(err).includes('constraint')) {
            return res.status(400).json({ success: false, message: '이미 등록 된 키워드 입니다.' });
        }
        res.status(500).json({ success: false, message: '수정 중 오류가 발생했습니다: ' + err.message });
    }
}));

// 데이터 정화소 패턴 삭제 API
router.delete('/api/cleanroom/:id', checkPermission, asyncReqHandler(async function(req, res) {
    const id = req.params.id;
    if (!id) {
        return res.status(400).json({ success: false, message: '삭제할 식별자가 누락되었습니다.' });
    }
    await commonDAO.execute_query('cleanroomMapper.deleteCleanroom', { id: Number(id) });
    res.json({ success: true, message: '패턴이 정상 삭제되었습니다.' });
}));

const detectEngine = require('../../service/detectEngine');

router.get('/api/detect/search-keywords', checkPermission, asyncReqHandler(async function(req, res) {
    const keywords = String(process.env.SEARCH_DORK_KEYWORDS || '카톡,텔레')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean);
    res.json({ success: true, data: { keywords: [...new Set(keywords)] } });
}));

// 점검 시작 API (URL, 속도 딜레이, 점검 제한 시간, 최대 페이지 수, 이번만 적용/제외 키워드)
router.post('/api/detect/start', checkPermission, asyncReqHandler(async function(req, res) {
    const { url, speedDelayMs, maxPages, maxTimeSec, tempPollutedKeywords, tempAllowedKeywords, knownSearchUrls, knownSearchCompleted } = req.body || {};
    if (!url || !url.trim()) {
        return res.status(400).json({ success: false, message: '점검할 웹사이트 URL을 입력해 주세요.' });
    }
    try {
        const result = await detectEngine.start(url.trim(), {
            speedDelayMs: Number(speedDelayMs) || 500,
            maxPages: Number(maxPages) || 5000,
            maxTimeSec: Number(maxTimeSec) || 1800,
            tempPollutedKeywords: Array.isArray(tempPollutedKeywords) ? tempPollutedKeywords : [],
            tempAllowedKeywords: Array.isArray(tempAllowedKeywords) ? tempAllowedKeywords : [],
            knownSearchUrls: Array.isArray(knownSearchUrls) ? knownSearchUrls : [],
            knownSearchCompleted: knownSearchCompleted === true
        });
        res.json({ success: true, message: '점검이 시작되었습니다.', data: result });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message });
    }
}));

// 점검 일시 정지 API
router.post('/api/detect/pause', checkPermission, asyncReqHandler(async function(req, res) {
    const ok = await detectEngine.pause();
    res.json({ success: ok, message: ok ? '점검이 일시 정지되었습니다.' : '일시 정지할 수 없는 상태입니다.' });
}));

// 점검 재개 API
router.post('/api/detect/resume', checkPermission, asyncReqHandler(async function(req, res) {
    const ok = await detectEngine.resume();
    res.json({ success: ok, message: ok ? '점검이 재개되었습니다.' : '재개할 수 없는 상태입니다.' });
}));

// 점검 중지 API
router.post('/api/detect/stop', checkPermission, asyncReqHandler(async function(req, res) {
    const ok = await detectEngine.stop();
    res.json({ success: ok, message: ok ? '점검이 중지되었습니다.' : '중지할 수 없는 상태입니다.' });
}));

// 점검 상태 실시간 폴링 API
router.get('/api/detect/status', checkPermission, asyncReqHandler(async function(req, res) {
    const status = detectEngine.getStatus();
    res.json({ success: true, data: status });
}));

// 점검 회차별 표준 결과 파일 조회 및 다운로드 API
router.get('/api/detect/result-json', checkPermission, asyncReqHandler(async function(req, res) {
    const masterId = Number(req.query.masterId);
    if (!Number.isSafeInteger(masterId) || masterId < 1) {
        return res.status(400).json({ success: false, message: '점검 회차 번호가 필요합니다.' });
    }
    const masterRes = await commonDAO.selectList('detectMapper.selectDetectMaster', { id: masterId });
    if (!masterRes || !masterRes.ok) throw new Error('점검 회차를 읽지 못했습니다.');
    const master = masterRes && masterRes.list && masterRes.list[0];
    if (!master) return res.status(404).json({ success: false, message: '점검 이력을 찾을 수 없습니다.' });

    const findingsRes = await commonDAO.selectList('detectMapper.selectDetectFindings', { master_id: masterId });
    if (!findingsRes || !findingsRes.ok) throw new Error('점검 결과를 읽지 못했습니다.');
    const findings = findingsRes && findingsRes.list ? findingsRes.list : [];
    const reports = buildResultReports(master, findings);
    const requestedType = req.query.type;
    if (requestedType && !['auto', 'main', 'extra'].includes(requestedType)) {
        return res.status(400).json({ success: false, message: '결과 파일 종류가 올바르지 않습니다.' });
    }
    const type = requestedType === 'main' || requestedType === 'extra'
        ? requestedType : (reports.counts.main === 0 && reports.counts.extra > 0 ? 'extra' : 'main');
    const filename = type === 'extra' ? 'result_extra.json' : 'result.json';
    const data = reports[type];
    const content = JSON.stringify(data, null, 2);

    if (req.query.view === '1') {
        return res.json({
            success: true,
            masterId,
            type,
            filename,
            source: '점검 이력 DB',
            size: Buffer.byteLength(content, 'utf8'),
            counts: reports.counts,
            data
        });
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(content);
}));

// result.json 저장 위치 탐색기 폴더 열기 API (Electron 및 데스크톱 환경 지원)
router.post('/api/detect/open-result-folder', checkPermission, asyncReqHandler(async function(req, res) {
    const resultJsonPath = path.join(__dirname, '..', '..', 'result.json');
    if (!fs.existsSync(resultJsonPath)) {
        return res.status(404).json({ success: false, message: '생성된 result.json 파일이 없습니다.' });
    }
    const cp = require('child_process');
    cp.exec(`explorer.exe /select,"${resultJsonPath}"`, (err) => {
        if (err) {
            console.warn('[Open Folder Error]', err.message);
        }
    });
    res.json({ success: true, message: '탐색기로 result.json 파일 위치를 열었습니다.', path: resultJsonPath });
}));

// 간편 점검 실행 테스트 API (브라우저 주소창 및 간편 점검용)
router.get('/api/detect/test-trigger', checkPermission, asyncReqHandler(async function(req, res) {
    const targetUrl = req.query.url || 'https://www.data.go.kr/data/15119100/fileData.do';
    const speedDelayMs = Number(req.query.speedDelayMs) || 500;
    const maxPages = Number(req.query.maxPages) || 10;
    try {
        const result = await detectEngine.start(targetUrl, { speedDelayMs, maxPages });
        res.json({ success: true, message: '점검이 시작되었습니다.', data: result });
    } catch (err) {
        res.status(400).json({ success: false, message: err.message, status: detectEngine.getStatus() });
    }
}));

// ==========================================
// [스팸 학습 및 AI 벡터 캐싱 관리 API]
// ==========================================

// 1. 스팸 학습 화면 렌더링
router.get('/spam-train', checkPermission, asyncReqHandler(async function(req, res) {
    res.render('admin/spam_train.html', { layout: "layout_admin.html" });
}));

// 2. 스팸 패턴 목록 페이징 및 검색 API
router.get('/api/spam', checkPermission, asyncReqHandler(async function(req, res) {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = Math.min(100, Math.max(10, parseInt(req.query.perPage, 10) || 20));
    const offset = (page - 1) * perPage;
    const keyword = (req.query.keyword || '').trim();

    const countRes = await commonDAO.selectList('spamMapper.selectSpamCount', { keyword });
    const totalCount = (countRes && countRes.list && countRes.list[0]) ? Number(countRes.list[0].total_count) : 0;
    const totalPages = Math.ceil(totalCount / perPage) || 1;

    const listRes = await commonDAO.selectList('spamMapper.selectSpamList', {
        keyword,
        limit: perPage,
        offset
    });
    const list = (listRes && listRes.list) ? listRes.list : [];

    const memoryCount = llmPipelineService.getSpamVectorCount();

    res.json({
        success: true,
        list,
        pagination: {
            page,
            perPage,
            totalCount,
            totalPages
        },
        memoryCount
    });
}));

// 따옴표 내부의 줄바꿈 및 쉼표를 온전히 처리하는 정밀 CSV 파서
function parseCsvRows(text) {
    const rows = [];
    let currentRow = [];
    let currentField = '';
    let insideQuotes = false;

    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        const nextChar = text[i + 1];

        if (char === '"') {
            if (insideQuotes && nextChar === '"') {
                currentField += '"';
                i++;
            } else {
                insideQuotes = !insideQuotes;
            }
        } else if (char === ',' && !insideQuotes) {
            currentRow.push(currentField.trim());
            currentField = '';
        } else if ((char === '\r' || char === '\n') && !insideQuotes) {
            if (char === '\r' && nextChar === '\n') i++;
            currentRow.push(currentField.trim());
            if (currentRow.some(c => c.length > 0)) {
                rows.push(currentRow);
            }
            currentRow = [];
            currentField = '';
        } else {
            currentField += char;
        }
    }
    if (currentField.length > 0 || currentRow.length > 0) {
        currentRow.push(currentField.trim());
        if (currentRow.some(c => c.length > 0)) {
            rows.push(currentRow);
        }
    }
    return rows;
}

// 3. 샘플 CSV 양식 다운로드 API (허깅페이스 버전 및 표준형 지원, UTF-8 BOM)
router.get('/api/spam/sample-csv', checkPermission, (req, res) => {
    const bom = '\uFEFF';
    const type = String(req.query.type || 'huggingface').toLowerCase();

    if (type === 'standard') {
        const csvContent = bom + `spam_text,memo
카지노 첫충전 보너스 코드 지급 바카라 슬롯,불법 도박 홍보
먹튀검증 안전놀이터 문의 텔레그램 메이저 사이트,도박 검증 사칭
무료 슬롯 체험 머니 즉시 지급 가입 혜택,사행성 슬롯 유인
사설 토토 배팅 환전 첫충 매충 이벤트,사설 스포츠 베팅
사설 포커 온라인 홀덤 사이공포커 환전 베팅,불법 카드 베팅
무서류 당일 비대면 소액 대출 급전 비상금,불법 고금리 대출
풀싸롱 호빠 룸싸롱 예약 문의 주점 전화번호,불법 유흥업소 홍보
강남 가라오케 셔츠룸 하이퍼블릭 유흥 예약 문의,변종 유흥주점 스팸
출장안마 조건만남 출장마사지 성매매 예약 문의,성매매 알선 스팸`;

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="spam_sample_standard.csv"');
        return res.send(csvContent);
    }

    // 기본: 허깅페이스(Hugging Face) index,content,class 규격 버전
    const hfCsvContent = bom + `index,content,class
1,엄마 나 폰 액정 깨져서 수리 맡겼어 이 번호로 문자 줘,2
2,"[국외발신] [코인원] 고객님계정이 해외IP에서 로그인되였습니다. 해외IP차단해주세요. www.coinonve.com",2
3,"[Web발신] [KB국민] 정부지원 대환대출 안내. 연 2.8%~ 최저금리 당일 입금 가능. 문의: 02-1234-5678",2
4,"(광고) [메이저 카지노] 신규가입 3만 즉시지급! 첫충 30% 보너스 코드 LUCKY7 바로가기 slot777.com",2
5,"[Web발신] 해외결제 승인 890,000원 본인 요청 아닐 시 소비자보호센터 02-987-6543 문의",2
6,"[안내] 회원님 꽁머니 50,000P 소멸 예정. 즉시 환전 신청 바로가기 www.toto-safe.com",2
7,"[단독] 텔레그램 비밀방 입장 코드 안내 @vip_secret_room 강남 풀싸롱 예약 문의",2
8,"사설 토토 파워볼 실시간 베팅 환전 첫충 매충 무한 보너스 이벤트 먹튀검증 완료",2
9,"무서류 비대면 당일 급전 소액대출 대학생 직장인 누구나 승인 개인돈 상담",2
10,"출장안마 24시 조건만남 마사지 예약 실시간 상담 텔레그램 @massage_24",2`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="huggingface_korean_message_sample.csv"');
    res.send(hfCsvContent);
});

// 4. CSV 일괄 업로드 및 실시간 AI 벡터화 API (허깅페이스 index,content,class 및 표준형 완벽 자동 판별)
router.post('/api/spam/upload', checkPermission, (req, res, next) => {
    spamUpload.single('csvFile')(req, res, (err) => {
        if (err) {
            return res.status(400).json({ success: false, message: '파일 업로드 오류: ' + err.message });
        }
        next();
    });
}, async function(req, res) {
    try {
        if (!req.file || !req.file.buffer) {
            return res.status(400).json({ success: false, message: '업로드할 CSV 파일을 선택해 주세요.' });
        }

        let fileContent = '';
        const buf = req.file.buffer;

        fileContent = buf.toString('utf8');
        if (fileContent.charCodeAt(0) === 0xFEFF) {
            fileContent = fileContent.slice(1);
        }

        const rows = parseCsvRows(fileContent);
        if (rows.length === 0) {
            return res.status(400).json({ success: false, message: 'CSV 파일에 유효한 데이터가 없습니다.' });
        }

        // 헤더 감지
        const header = rows[0].map(c => String(c || '').toLowerCase().trim());
        let contentColIdx = -1;
        let classColIdx = -1;
        let memoColIdx = -1;
        let hasHeader = false;

        const contentKeywords = ['content', 'text', 'spam_text', 'spam', '문구', '내용', '본문', 'message'];
        const classKeywords = ['class', 'label', '라벨', '분류'];
        const memoKeywords = ['memo', '메모', '비고', '출처', 'category', '카테고리'];

        contentKeywords.forEach(kw => {
            if (contentColIdx === -1) {
                const idx = header.indexOf(kw);
                if (idx !== -1) contentColIdx = idx;
            }
        });

        classKeywords.forEach(kw => {
            if (classColIdx === -1) {
                const idx = header.indexOf(kw);
                if (idx !== -1) classColIdx = idx;
            }
        });

        memoKeywords.forEach(kw => {
            if (memoColIdx === -1) {
                const idx = header.indexOf(kw);
                if (idx !== -1) memoColIdx = idx;
            }
        });

        if (contentColIdx !== -1) {
            hasHeader = true;
        } else {
            // 헤더가 감지되지 않은 경우: 3열 이상이고 1열이 숫자면 2열을 content로 배정 (허깅페이스 무헤더 대응)
            if (rows[0].length >= 3 && /^\d+$/.test(rows[0][0])) {
                contentColIdx = 1;
                classColIdx = 2;
            } else {
                contentColIdx = 0;
                memoColIdx = 1;
            }
        }

        const dataRows = hasHeader ? rows.slice(1) : rows;

        // 백그라운드 비동기 스팸 학습 시작 (화면 프리징 및 대기 시간 원천 차단)
        const trainResult = await spamTrainService.startBackgroundSpamTrain(dataRows, {
            contentColIdx,
            classColIdx,
            memoColIdx
        });

        if (!trainResult.started) {
            return res.status(409).json({
                success: false,
                message: trainResult.message
            });
        }

        return res.json({
            success: true,
            message: `스팸 학습이 백그라운드에서 시작되었습니다. (총 ${dataRows.length.toLocaleString()}건)`,
            totalCount: dataRows.length,
            background: true
        });
    } catch (handlerErr) {
        console.error('[Spam Upload Handler Error]', handlerErr);
        res.status(500).json({ success: false, message: '스팸 학습 처리 중 오류가 발생했습니다: ' + handlerErr.message });
    }
});

/**
 * 백그라운드 스팸 학습 진행 상태 조회 API
 */
router.get('/api/spam/train-status', checkPermission, (req, res) => {
    res.json({
        success: true,
        data: spamTrainService.getSpamTrainStatus()
    });
});

// 5. 스팸 패턴 단건 삭제 API
router.delete('/api/spam/:id', checkPermission, asyncReqHandler(async function(req, res) {
    const id = Number(req.params.id);
    if (!id) {
        return res.status(400).json({ success: false, message: '유효하지 않은 식별자입니다.' });
    }

    await commonDAO.execute_query('spamMapper.deleteSpam', { id });
    llmPipelineService.removeSpamVectorFromMemory(id);

    res.json({
        success: true,
        message: '스팸 패턴이 삭제되고 메모리 캐시에서 즉시 제거되었습니다.',
        memoryCount: llmPipelineService.getSpamVectorCount()
    });
}));

module.exports = {
  basePath : "/mgr",
  router
};
