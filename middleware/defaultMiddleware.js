const commonDAO = require('../service/commonDAO');
const util = require('../utils/util');
const asyncReqHandler = require('../service/asyncReqHandler');

module.exports = asyncReqHandler(async function defaultMiddleware(req, res, next) {
  
  try {
    const content = res.locals.content;
    return res.render('front/content/index.html', {
      content: content.content
    });
  } catch (err) { 
    next(err); 
  }
});
