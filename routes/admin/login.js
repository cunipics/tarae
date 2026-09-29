const express = require('express');
const router = express.Router();
const config = require('../../config/config');
const util = require('../../utils/util');
const { write: logWrite } = require('../../utils/logger');
const asyncReqHandler = require('../../service/asyncReqHandler');

router.get('/', asyncReqHandler(async (req, res) => {//mean authAdmin
  if (req.session.authAdmin) {
    return res.redirect("/mgr/index");//dashboard
  }else {
    return res.redirect("/mgr/login");//login
  }
}));

router.all('/logout', asyncReqHandler(async (req, res) => {
  if (req.session) {
    req.session.destroy((err) => {
      res.clearCookie('connect.sid');
      return res.redirect('/mgr/index');
    });
  } else {
    return res.redirect('/mgr/index');
  }
}));

router.get("/login", asyncReqHandler(async (req, res, next) => {
    //관리자 로그인 화면
    res.render("admin/user/login.html",{
        layout: false,
    });
}));

router.post('/login', asyncReqHandler(async (req, res, next) => {
  //관리자 원격 로그인 처리
  try {
    const userid = (req.input && req.input.userid ? req.input.userid : '').trim();
    const passwd = (req.input && req.input.passwd ? req.input.passwd : '').trim();

    if (!userid || !passwd) {
      return res.json({ success: "N", msg: "아이디와 비밀번호를 입력해주세요." });
    }

    let remoteUrl = config.auth && config.auth.remoteLoginUrl;
    if (!remoteUrl) {
      return res.json({ success: "N", msg: "로그인 설정이 올바르지 않습니다." });
    }

    if (!remoteUrl.endsWith('/') && !remoteUrl.includes('?') && !remoteUrl.endsWith('.php')) {
      remoteUrl += '/';
    }

    //원격 PHP API 호출
    const postBody = new URLSearchParams();
    postBody.append('userid', userid);
    postBody.append('passwd', passwd);

    let remoteRes = null;
    try {
      remoteRes = await fetch(remoteUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
        },
        body: postBody.toString(),
        signal: AbortSignal.timeout(10000)
      });
    } catch (networkErr) {
      return res.json({ success: "N", msg: "원격 로그인 서버 연결에 실패했습니다." });
    }

    if (!remoteRes.ok) {
      return res.json({ success: "N", msg: "원격 서버 응답 오류가 발생했습니다. (" + remoteRes.status + ")" });
    }

    let resData = null;
    try {
      resData = await remoteRes.json();
    } catch (jsonErr) {
      return res.json({ success: "N", msg: "원격 서버가 올바른 JSON 응답을 반환하지 않았습니다. (PHP 소스 오류 가능성)" });
    }

    //PHP API 규격: error === 0 일 때 성공
    if (resData && (resData.error === 0 || resData.error === "0")) {
      // PHP 서버 DB에 저장된 a_gpu 값 추출 (1이면 GPU모드, 0이면 CPU모드, 디폴트 0)
      const userGpu = resData.a_gpu !== undefined ? Number(resData.a_gpu) : ((resData.user && resData.user.a_gpu !== undefined) ? Number(resData.user.a_gpu) : 0);

      req.session.authAdmin = {
        ok: true,
        row: {
          u_id: (resData.user && resData.user.u_id) || userid,
          u_name: (resData.user && resData.user.u_name) || (resData.u_name || '관리자'),
          u_auth: resData.uAuth || (resData.user && resData.user.u_auth) || '0001',
          u_status: (resData.user && resData.user.u_status) || 'A',
          u_dept: (resData.user && resData.user.u_dept) || null,
          u_email: (resData.user && resData.user.u_email) || null,
          u_mobile: (resData.user && resData.user.u_mobile) || null,
          a_gpu: userGpu
        },
        count: 1,
        error: null
      };

      // 사용자 설정(a_gpu)에 따라 AI 파이프라인 디바이스 모드 초기화
      const llmPipelineService = require('../../service/llmPipelineService');
      llmPipelineService.setGpuMode(userGpu === 1);

      // 최초 로그인 성공 시 AI 탐지 모델 3종(q8) 백그라운드 로딩 시작
      llmPipelineService.startLoading();

      return res.json({ success: "Y", msg: resData.msg || "로그인 하였습니다." });
    } else {
      return res.json({ success: "N", msg: (resData && resData.msg) ? resData.msg : "로그인에 실패했습니다." });
    }
  } catch (e) {
    return res.json({ success: "N", msg: "로그인 처리 중 시스템 오류가 발생했습니다." });
  }
}));

// 공공데이터포털 등 대상 사이트 점검 테스트 실행 API
router.get('/api/detect-test', asyncReqHandler(async (req, res) => {
  const targetUrl = req.query.url || 'https://www.data.go.kr/data/15119100/fileData.do';
  const speedDelayMs = Number(req.query.speedDelayMs) || 500;
  const maxPages = Number(req.query.maxPages) || 10;
  const detectEngine = require('../../service/detectEngine');
  try {
    const result = await detectEngine.start(targetUrl, { speedDelayMs, maxPages });
    res.json({ success: true, message: '점검이 시작되었습니다.', data: result });
  } catch (err) {
    res.json({ success: false, message: err.message, status: detectEngine.getStatus() });
  }
}));

// 점검 상태 실시간 폴링 조회 API
router.get('/api/detect-poll', asyncReqHandler(async (req, res) => {
  const detectEngine = require('../../service/detectEngine');
  res.json({ success: true, status: detectEngine.getStatus() });
}));

module.exports = {
  basePath : "/mgr",
  skipSession : true,
  router
};