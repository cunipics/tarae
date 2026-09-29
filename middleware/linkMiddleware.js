const commonDAO = require('../service/commonDAO');
const util = require('../utils/util');
const asyncReqHandler = require('../service/asyncReqHandler');

module.exports = asyncReqHandler(async function linkMiddleware(req, res, next) {
  try {
    const content = res.locals.content;

    if (!content.link_url) {
      const err = new Error('link_url 이 없습니다.');
      err.status = 500;
      throw err;
    }

    return res.redirect(content.link_url);
  } catch (err) {
    next(err);
  }
});
