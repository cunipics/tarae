const commonDAO = require('../service/commonDAO');
const util = require('../utils/util');
const asyncReqHandler = require('../service/asyncReqHandler');

module.exports = asyncReqHandler(async function moduleMiddleware(req, res, next) {
  try {
    const content = res.locals.content;

    const moduleMap = {
      banner: function(req, res, content) {
        return res.render('modules/banner', { content: content });
      },
      gallery: function(req, res, content) {
        return res.render('modules/gallery', { content: content });
      }
    };

    const mod = moduleMap[content.module_code];
    if (!mod) {
      const err = new Error('모듈이 없습니다.');
      err.status = 500;
      throw err;
    }

    return mod(req, res, content);
  } catch (err) {
    next(err);
  }
});
