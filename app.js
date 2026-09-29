require('dotenv').config();
const helmet = require('helmet');
const express = require('express');
const ejs = require('ejs');
const path = require('path');
const session = require('express-session');
const i18n = require('i18n');
const sanitizeHtml = require('sanitize-html');
const config = require('./config/config');
const commonDAO = require('./service/commonDAO');
const { getDatabase } = require('./service/sqliteDatabase');
const { loadAllRouters } = require('./utils/loadRouters');
const expressLayouts = require('express-ejs-layouts');
const app = express();
/*
todo 
1. 공공기관 관리자가 탐지 결과를 보고 바로 조치할 수 있도록 화면(UI)에서 "조치/해결 가이드"(예: 은닉 CSS 속성 제거법, 해당 게시글 즉시 삭제 및 차단 권고 등)를 함께 안내해 주면 실무 활용성 평가에서 매우 유리한 가산점 요인이 됩니다.
2. 적발 항목 카드마다 유형별 [조치 가이드] 펼침 영역

npm start
npx electron main.js
pm2 start --watch .\ecosystem.config.js
pm2 log
pm2 kill
*/
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));
class SqliteSessionStore extends session.Store {
  constructor() {
    super();
    getDatabase();
    commonDAO.loadMappers();
  }

  get(sid, callback) {
    commonDAO.selectOne('session.selectSession', { sid, now: Date.now() })
      .then((res) => {
        if (!res.ok || !res.row || !res.row.sess) return callback(null, null);
        try {
          let sessData = res.row.sess;
          if (typeof sessData === 'string' && sessData.startsWith('"') && sessData.endsWith('"')) {
            sessData = JSON.parse(sessData);
          }
          callback(null, typeof sessData === 'string' ? JSON.parse(sessData) : sessData);
        } catch (parseErr) {
          // 손상된 세션 데이터일 경우 안전하게 세션 리셋
          callback(null, null);
        }
      })
      .catch(callback);
  }

  set(sid, sess, callback) {
    const expiresAt = getSessionExpiry(sess);
    commonDAO.insert('session.insertSession', {
      sid,
      sess: sess,
      expiresAt
    })
      .then(() => {
        commonDAO.delete('session.deleteExpiredSessions', { now: Date.now() }).catch(() => { });
        callback && callback(null);
      })
      .catch((err) => {
        callback && callback(err);
      });
  }

  destroy(sid, callback) {
    commonDAO.delete('session.deleteSession', { sid })
      .then(() => {
        callback && callback(null);
      })
      .catch((err) => {
        callback && callback(err);
      });
  }

  touch(sid, sess, callback) {
    this.set(sid, sess, callback);
  }
}

function getSessionExpiry(sess) {
  const expires = sess && sess.cookie && sess.cookie.expires;
  const timestamp = expires ? new Date(expires).getTime() : NaN;
  return Number.isFinite(timestamp) ? timestamp : Date.now() + (1000 * 60 * 60 * 24 * 365);
}

const ONE_YEAR_MS = 1000 * 60 * 60 * 24 * 365; // 1년 (365일)

app.use(session({
  store: new SqliteSessionStore(),
  secret: config.security.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: ONE_YEAR_MS,
    secure: process.env.NODE_ENV === 'production' ? 'auto' : false,
  }
}));

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: true,
  crossOriginResourcePolicy: true,
  dnsPrefetchControl: true,
  frameguard: true,
  hidePoweredBy: true,
  xssFilter: true,
  hsts: true,
  ieNoOpen: true,
  noSniff: true,
  originAgentCluster: true,
  permittedCrossDomainPolicies: true,
}));

i18n.configure({
  locales: config.i18n.locales,
  directory: config.i18n.directory,
  defaultLocale: config.i18n.defaultLocale,
  queryParameter: 'lang',
  register: global,
  objectNotation: true
});

app.use(i18n.init);

app.set('views', config.app.viewsDir);
app.engine('html', ejs.renderFile);
app.set('view engine', 'html');
app.use(expressLayouts);
app.set('layout', 'layout.html');
app.use('/', express.static(path.join(__dirname, "/static")));

app.use((req, res, next) => {
  const lang = req.query.lang || req.session.lang || config.i18n.defaultLocale;
  req.setLocale(lang);
  req.session.lang = lang;
  res.locals.session = req.session;
  res.locals.menus = [];//홈페이지 대메뉴
  res.locals.submenus = [];//홈페이지 서브메뉴  
  res.locals.cate = "";//홈페이지 카테고리  
  res.locals.locale = req.getLocale();
  res.locals.safeHtml = function (text) {
    return sanitizeHtml(String(text || ''), config.security.sanitize);
  };
  next();
});

commonDAO.loadMappers();
getDatabase();
loadAllRouters(app, config.paths.routesDir);

app.get('/', (req, res) => {
  res.redirect('/mgr/index');
});

app.use(function (req, res, next) {
  next({ status: 404, message: '요청한 페이지를 찾을 수 없습니다.' });
});

app.use(function (err, req, res, next) {
  const status = err.status || 500;
  const message = err.message || '서버 오류가 발생했습니다.';
  const layout = req.originalUrl.startsWith('/mgr/')
    || req.originalUrl === '/mgr'
    ? 'layout_admin.html'
    : 'layout.html';
  res.status(status);
  return res.render('common/message.html', { layout, message: message, status: status });
});

const server = app.listen(config.app.port, () => {
  console.log('Server running on http://localhost:' + config.app.port);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Port ${config.app.port} already in use. Reusing running server.`);
  } else {
    console.error('Server error:', err);
  }
});
