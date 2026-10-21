const path = require('path');

module.exports = {
  app: {
    port: process.env.PORT || 3333,
    staticDir: path.join(__dirname, '..', 'static'),
    viewsDir: path.join(__dirname, '..', 'templates')
  },
  db: {
    sqlite: {
      filename: path.resolve(__dirname, '..', process.env.SQLITE_FILENAME || 'cms.db')
    }
  },
  i18n: {
    locales: ['ko', 'en'],
    defaultLocale: 'ko',
    directory: path.join(__dirname, '..', 'locales')
  },
  security: {
    sessionSecret: process.env.SESSION_SECRET || 'change_this_secret_now',
    sanitize: {
      allowedTags: ['b', 'i', 'em', 'strong', 'a', 'p', 'ul', 'ol', 'li', 'br'],
      allowedAttributes: {
        a: ['href', 'title', 'target']
      },
      allowedSchemes: ['http', 'https', 'mailto']
    }
  },
  auth: {
    remoteLoginUrl: process.env.REMOTE_LOGIN_API_URL,
    remoteUpdateUrl: process.env.REMOTE_UPDATE_API_URL
  },
  paths: {
    resDir: path.join(__dirname, '..', 'res'),
    logsDir: process.env.TARAE_LOGS_DIR || path.join(__dirname, '..', 'logs'),
    outputDir: process.env.TARAE_OUTPUT_DIR || path.join(__dirname, '..'),
    routesDir: path.join(__dirname, '..', 'routes')
  },
  ai: require('./aiModel.config'),
  adPlatforms: require('./adPlatforms.config')
};
