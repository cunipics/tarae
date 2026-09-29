const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const commonDAO = require('../../service/commonDAO');
const asyncReqHandler = require('../../service/asyncReqHandler');

router.get('/login', asyncReqHandler(async (req, res) => {
  const recent = await commonDAO.selectList('user.selectRecentUsers', {});

  res.render('front/user/login', {
    pageTitle: 'User Login',
    recentUsers: recent.ok ? recent.list : [],
    debugEcho: req.input.echo || ''
  });
}));

router.post('/login_act', asyncReqHandler(async (req, res) => {
  const username = req.input.username || '';
  const password = req.input.password || '';

  const result = await commonDAO.selectOne('user.selectUserByLogin', { username });

  const messages = [];
  let loginUser = null;

  if (!result.ok || !result.row) {
    messages.push('사용자를 찾을 수 없습니다.');
  } else {
    const inputHash = crypto.createHash('sha256').update(password, 'utf8').digest('hex');

    if (inputHash === result.row.password_sha256) {
      req.session.user = {
        id: result.row.id,
        username: result.row.username,
        display_name: result.row.display_name,
        role: result.row.role,
        lang: result.row.lang || 'ko'
      };

      req.session.lang = req.session.user.lang;
      req.setLocale(req.session.lang);
      loginUser = req.session.user;
      messages.push('로그인에 성공했습니다.');
    } else {
      messages.push('비밀번호가 일치하지 않습니다.');
    }
  }

  res.render('front/user/login_result', {
    pageTitle: 'User Login Result',
    messages,
    user: loginUser
  });
}));

module.exports = {
  basePath: '/user',
  router
};
