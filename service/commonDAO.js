const fs = require('fs');
const path = require('path');
const mybatisMapper = require('mybatis-mapper');
const config = require('../config/config');
const { getDatabase } = require('./sqliteDatabase');
const { write: logWrite } = require('../utils/logger');

let mapperLoaded = false;
let transactionActive = false;

function loadMappers() {
  if (mapperLoaded) return;

  const xmlFiles = fs.readdirSync(config.paths.resDir)
    .filter((file) => file.endsWith('.xml'))
    .map((file) => path.join(config.paths.resDir, file));

  mybatisMapper.createMapper(xmlFiles);
  mapperLoaded = true;
}

function makeBoundSql(namespace, id, paramObj) {
  const originalSql = mybatisMapper.getStatement(namespace, id, paramObj || {});
  const values = [];
  const sql = originalSql.replace(/#\{(\w+)\}/g, (_, key) => {
    const val = paramObj ? paramObj[key] : null;
    values.push(val !== undefined ? val : null);
    return '?';
  });

  return { originalSql, sql, values };
}

function toLogValue(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function makeFinalQuery(sql, values) {
  let index = 0;
  return sql.replace(/\?/g, () => toLogValue(values[index++]));
}

function isSelectSql(sql) {
  return /^\s*(select|with|pragma|explain)\b/i.test(sql);
}

function getRowsAffected(info) {
  return Number((info && info.changes) || 0);
}

function getTransaction(options) {
  const trx = options && options.trx;
  if (!trx) return null;
  if (trx.completed) {
    throw new Error('Transaction is already completed.');
  }
  return trx;
}

async function execute_query(queryId, paramObj, options) {
  loadMappers();
  const parts = String(queryId).split('.');
  if (parts.length !== 2) {
    throw new Error('queryId must be in namespace.id format.');
  }

  const [namespace, id] = parts;
  let bound = null;
  let finalQuery = null;
  let isSelect = false;
  const trx = getTransaction(options);

  try {
    bound = makeBoundSql(namespace, id, paramObj || {});
    finalQuery = makeFinalQuery(bound.sql, bound.values);
    isSelect = isSelectSql(bound.sql);
    const statement = getDatabase().prepare(bound.sql);
    const result = isSelect
      ? statement.all(...bound.values)
      : statement.run(...bound.values);
    const rows = isSelect ? result : [];
    const info = isSelect ? null : {
      changes: Number(result.changes || 0),
      insertId: Number(result.lastInsertRowid || 0)
    };

    logWrite(config.paths.logsDir, {
      level: 'INFO', namespace, id, dbType: 'sqlite', sql: bound.sql,
      params: bound.values, final_query: finalQuery,
      rowCount: isSelect ? rows.length : null,
      rowsAffected: isSelect ? null : getRowsAffected(info), error: null
    });

    return {
      ok: true,
      rows,
      info,
      rowCount: isSelect ? rows.length : 0,
      rowsAffected: isSelect ? 0 : getRowsAffected(info)
    };
  } catch (error) {
    logWrite(config.paths.logsDir, {
      level: 'ERROR', namespace, id, dbType: 'sqlite',
      sql: bound ? bound.sql : null,
      params: bound ? bound.values : (paramObj || {}),
      final_query: finalQuery, rowCount: null, rowsAffected: null,
      error: `Error: ${error.message}`
    });

    // 트랜잭션 중에는 에러 발생 시 즉시 throw하여 rollback이 수행되도록 함
    if (trx) {
      throw error;
    }

    return { ok: false, error };
  }
}

async function selectList(queryId, paramObj, options) {
  const result = await execute_query(queryId, paramObj, options);
  return { ok: result.ok, list: result.rows || [], count: result.rowCount || 0, error: result.error || null };
}

async function selectOne(queryId, paramObj, options) {
  const result = await execute_query(queryId, paramObj, options);
  const row = result.rows && result.rows.length ? result.rows[0] : null;
  return { ok: result.ok, row, count: row ? 1 : 0, error: result.error || null };
}

async function change(queryId, paramObj, options) {
  const result = await execute_query(queryId, paramObj, options);
  return {
    ok: result.ok,
    affected: result.rowsAffected || 0,
    rows: result.rows || [],
    info: result.info || null,
    error: result.error || null
  };
}

async function beginTransaction() {
  const database = getDatabase();
  if (transactionActive) {
    throw new Error('A SQLite transaction is already active.');
  }
  database.exec('BEGIN IMMEDIATE');
  transactionActive = true;
  return { dbType: 'sqlite', completed: false };
}

async function commit(trx) {
  if (!trx || trx.completed) return;
  try {
    getDatabase().exec('COMMIT');
  } finally {
    transactionActive = false;
    trx.completed = true;
  }
}

async function rollback(trx) {
  if (!trx || trx.completed) return;
  try {
    getDatabase().exec('ROLLBACK');
  } finally {
    transactionActive = false;
    trx.completed = true;
  }
}

module.exports = {
  loadMappers,
  execute: execute_query,
  execute_query,
  selectList,
  selectOne,
  insert: change,
  update: change,
  delete: change,
  beginTransaction,
  commit,
  rollback
};
