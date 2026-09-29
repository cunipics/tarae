const fs = require('fs');
const path = require('path');

function pad(n) {
  return String(n).padStart(2, '0');
}

function nowParts() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return { yyyy, mm, dd, hh, mi, ss, ms };
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function getLogFile(baseDir) {
  const t = nowParts();
  const ym = `${t.yyyy}${t.mm}`;
  const ymd = `${t.yyyy}${t.mm}${t.dd}`;
  const dir = path.join(baseDir, ym);
  ensureDir(dir);
  return path.join(dir, `${ymd}.log`);
}

function timestamp() {
  const t = nowParts();
  return `${t.yyyy}-${t.mm}-${t.dd} ${t.hh}:${t.mi}:${t.ss}.${t.ms}`;
}

function isQueryLog(obj) {
  return obj
    && typeof obj === 'object'
    && Object.prototype.hasOwnProperty.call(obj, 'namespace')
    && Object.prototype.hasOwnProperty.call(obj, 'id')
    && Object.prototype.hasOwnProperty.call(obj, 'final_query');
}

function stringifyValue(value) {
  if (value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch (e) {
    return String(value);
  }
}

function compactSql(sql) {
  if (!sql) return '';

  return String(sql)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b(from|where|group by|having|order by|limit|offset|values|set)\b/gi, '\n$1')
    .replace(/ *\n */g, '\n')
    .replace(/\n+/g, '\n')
    .trim();
}

function formatQueryLog(obj) {
  const lines = [];
  const level = obj.level || 'INFO';
  const queryId = `${obj.namespace || ''}.${obj.id || ''}`;

  lines.push(`${timestamp()} | ${level} | ${obj.dbType || ''} | ${queryId}`);
  lines.push(`rowCount=${obj.rowCount === null || obj.rowCount === undefined ? '' : obj.rowCount} rowsAffected=${obj.rowsAffected === null || obj.rowsAffected === undefined ? '' : obj.rowsAffected}`);
  lines.push(`params=${stringifyValue(obj.params || [])}`);

  if (obj.error) {
    lines.push('');
    lines.push('ERROR:');
    lines.push(String(obj.error));
  }

  lines.push('');
  lines.push(compactSql(obj.final_query));
  lines.push('');
  lines.push('------------------------------------------------------------');

  return `${lines.join('\n')}\n`;
}

function formatDefaultLog(obj) {
  if (typeof obj === 'string') {
    return `${timestamp()} | ${obj}\n`;
  }

  return `${timestamp()} | ${JSON.stringify(obj, null, 2)}\n`;
}

function write(baseDir, obj) {
  try {
    const line = isQueryLog(obj) ? formatQueryLog(obj) : formatDefaultLog(obj);
    fs.appendFileSync(getLogFile(baseDir), line, { encoding: 'utf8' });
  } catch (e) {
    console.error('LOG_WRITE_ERROR:', e.message);
  }
}

module.exports = { write };
