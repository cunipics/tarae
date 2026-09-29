const fs = require('fs');
const path = require('path');
const util = require('./util');

function walk(dir) {
  let result = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  entries.forEach((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result = result.concat(walk(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      result.push(full);
    }
  });

  return result;
}

function loadAllRouters(app, routesDir) {
  const files = walk(routesDir);

  files.forEach((file) => {
    const mod = require(file);
    if (mod && mod.basePath && mod.router) {

      if (mod.basePath === '/mgr' && !mod.skipSession) {
          app.use(mod.basePath, util.checkAdminSession, mod.router);
          return;
      }else if (mod.basePath === '/mypage' && !mod.skipSession) {
          app.use(mod.basePath, util.checkMemberSession, mod.router);
          return;
      }
      app.use(mod.basePath, mod.router);
    }
  });
}

module.exports = { loadAllRouters };
