const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const uploadConfig = require('../config/upload.config');

function asyncReqHandler(fn) {
  return function (req, res, next) {
    parseRequest(req, res)
      .then(function () {
        return Promise.resolve(fn(req, res, next));
      })
      .catch(next);
  };
}

function parseRequest(req, res) {
  if (!isMultipart(req)) {
    req.files = req.files || [];
    req.fileMap = {};
    req.input = mergeInput(req);
    res.locals.input = req.input;
    res.locals.files = req.files;
    res.locals.fileMap = req.fileMap;
    return Promise.resolve();
  }

  var rule = resolveRule(req);
  var uploader = createUploader(rule);

  return new Promise(function (resolve, reject) {
    uploader(req, res, function (err) {
      if (err) {
        cleanupUploadedFiles(req.files)
          .then(function () {
            reject(normalizeUploadError(err));
          })
          .catch(function () {
            reject(normalizeUploadError(err));
          });
        return;
      }

      try {
        normalizeUploadedFiles(req, rule);
        req.input = mergeInput(req);

        req.getFile = function (fieldname) {
          var list = req.fileMap[fieldname] || [];
          return list.length ? list[0] : null;
        };

        req.getFiles = function (fieldname) {
          return req.fileMap[fieldname] || [];
        };

        res.locals.input = req.input;
        res.locals.files = req.files;
        res.locals.fileMap = req.fileMap;

        resolve();
      } catch (e) {
        cleanupUploadedFiles(req.files)
          .then(function () {
            reject(e);
          })
          .catch(function () {
            reject(e);
          });
      }
    });
  });
}

function isMultipart(req) {
  var contentType = String(req.headers['content-type'] || '').toLowerCase();
  return contentType.indexOf('multipart/form-data') === 0;
}

function mergeInput(req) {
  return Object.assign(
    {},
    req.query || {},
    req.body || {},
    req.params || {}
  );
}

function resolveRule(req) {
  var requestPath = getRequestPath(req);
  var rules = uploadConfig.rules || [];
  var i;
  var rule = null;

  for (i = 0; i < rules.length; i += 1) {
    if (matchRule(rules[i], req, requestPath)) {
      rule = rules[i];
      break;
    }
  }

  return Object.assign({}, uploadConfig.defaultRule || {}, rule || {});
}

function getRequestPath(req) {
  if (req.baseUrl && req.path) {
    return req.baseUrl + req.path;
  }

  if (req.originalUrl) {
    return req.originalUrl.split('?')[0];
  }

  return req.url ? req.url.split('?')[0] : '';
}

function matchRule(rule, req, requestPath) {
  if (!rule || !rule.test) return false;

  if (typeof rule.test === 'function') {
    return rule.test(req);
  }

  if (rule.test instanceof RegExp) {
    return rule.test.test(requestPath);
  }

  if (typeof rule.test === 'string') {
    return requestPath.indexOf(rule.test) === 0;
  }

  return false;
}

function createUploader(rule) {
  var storage = multer.diskStorage({
    destination: function (req, file, cb) {
      try {
        var subDir = typeof rule.subDir === 'function'
          ? rule.subDir(req, file)
          : (rule.subDir || 'common');

        var safeSubDir = sanitizeSubDir(subDir);
        var fullDir = path.join(uploadConfig.rootDir, safeSubDir);

        ensureDir(fullDir);
        cb(null, fullDir);
      } catch (e) {
        cb(e);
      }
    },

    filename: function (req, file, cb) {
      try {
        var originalName = sanitizeFilename(file.originalname || 'file');
        var ext = uploadConfig.naming.keepExtension !== false
          ? path.extname(originalName).toLowerCase()
          : '';

        var baseName = path.basename(originalName, path.extname(originalName))
          .replace(/[^a-zA-Z0-9._-]/g, '_')
          .replace(/_+/g, '_')
          .replace(/^_+|_+$/g, '') || 'file';

        var uniqueId = Date.now() + '_' + crypto.randomBytes(8).toString('hex');

        var finalName;
        if (uploadConfig.naming.useOriginalBaseName) {
          finalName = baseName + '_' + uniqueId + ext;
        } else {
          finalName = uniqueId + ext;
        }

        cb(null, finalName);
      } catch (e) {
        cb(e);
      }
    }
  });

  return multer({
    storage: storage,
    limits: uploadConfig.limits,
    fileFilter: function (req, file, cb) {
      try {
        var ext = path.extname(file.originalname || '').toLowerCase();
        var allowedMimeTypes = rule.allowedMimeTypes || null;
        var allowedExtensions = rule.allowedExtensions || null;

        if (allowedMimeTypes && allowedMimeTypes.length) {
          if (allowedMimeTypes.indexOf(file.mimetype) === -1) {
            return cb(new Error('허용되지 않은 MIME TYPE 입니다: ' + file.mimetype));
          }
        }

        if (allowedExtensions && allowedExtensions.length) {
          if (allowedExtensions.indexOf(ext) === -1) {
            return cb(new Error('허용되지 않은 확장자입니다: ' + ext));
          }
        }

        cb(null, true);
      } catch (e) {
        cb(e);
      }
    }
  }).any();
}

function normalizeUploadedFiles(req, rule) {
  var files = Array.isArray(req.files) ? req.files : [];
  var fileMap = {};
  var counts = {};
  var fields = rule.fields || null;
  var i;
  var file;
  var relativePath;
  var urlPath;

  for (i = 0; i < files.length; i += 1) {
    file = files[i];

    if (!fileMap[file.fieldname]) {
      fileMap[file.fieldname] = [];
    }
    fileMap[file.fieldname].push(file);

    counts[file.fieldname] = (counts[file.fieldname] || 0) + 1;

    if (fields) {
      if (!fields[file.fieldname]) {
        throw new Error('허용되지 않은 파일 필드입니다: ' + file.fieldname);
      }

      if (counts[file.fieldname] > fields[file.fieldname]) {
        throw new Error(file.fieldname + ' 파일 개수가 허용 수를 초과했습니다.');
      }
    } else if (rule.maxFilesPerField && counts[file.fieldname] > rule.maxFilesPerField) {
      throw new Error(file.fieldname + ' 파일 개수가 허용 수를 초과했습니다.');
    }

    relativePath = path.relative(uploadConfig.rootDir, file.path).split(path.sep).join('/');
    urlPath = joinUrl(uploadConfig.publicBasePath, relativePath);

    file.relativePath = relativePath;
    file.urlPath = urlPath;
    file.extension = path.extname(file.originalname || '').toLowerCase();
  }

  req.files = files;
  req.fileMap = fileMap;
}

function cleanupUploadedFiles(files) {
  var list = Array.isArray(files) ? files : [];

  return Promise.all(
    list.map(function (file) {
      return new Promise(function (resolve) {
        if (!file || !file.path) return resolve();

        fs.unlink(file.path, function () {
          resolve();
        });
      });
    })
  );
}

function normalizeUploadError(err) {
  if (!err) return new Error('업로드 중 알 수 없는 오류가 발생했습니다.');

  if (err.code === 'LIMIT_FILE_SIZE') {
    return new Error('업로드 파일 크기가 제한을 초과했습니다.');
  }

  if (err.code === 'LIMIT_FILE_COUNT') {
    return new Error('업로드 파일 개수가 제한을 초과했습니다.');
  }

  if (err.code === 'LIMIT_FIELD_COUNT') {
    return new Error('전송 필드 개수가 제한을 초과했습니다.');
  }

  if (err.code === 'LIMIT_PART_COUNT') {
    return new Error('multipart 데이터 개수가 제한을 초과했습니다.');
  }

  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    return new Error('허용되지 않은 파일 필드가 업로드되었습니다.');
  }

  return err;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function sanitizeFilename(name) {
  return path.basename(String(name || 'file')).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
}

function sanitizeSubDir(subDir) {
  return String(subDir || 'common')
    .split(/[\\/]+/)
    .filter(Boolean)
    .map(function (part) {
      return part.replace(/[^a-zA-Z0-9._-]/g, '_');
    })
    .filter(function (part) {
      return part !== '.' && part !== '..';
    })
    .join(path.sep);
}

function joinUrl(base, rel) {
  var a = '/' + String(base || '').replace(/^\/+|\/+$/g, '');
  var b = String(rel || '').replace(/^\/+/, '');
  return a + '/' + b;
}

module.exports = asyncReqHandler;