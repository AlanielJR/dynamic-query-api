/**
 * =============================================================
 *  lib/query-executor.js — Ejecutor de queries multi-motor
 * =============================================================
 *
 *  Ejecuta queries SQL parametrizadas contra distintos motores
 *  de base de datos. Los parámetros se expresan siempre como
 *  $1, $2, $3... y se adaptan internamente al formato del motor.
 *
 *  Motores soportados:
 *    mssql      — SQL Server  (parámetros: @p1, @p2...)
 *    postgresql — PostgreSQL  (parámetros: $1, $2... — nativo)
 *    mysql      — MySQL/MariaDB (parámetros: ?)
 *
 *  Uso:
 *    const { executeQuery } = require('./query-executor');
 *    const result = await executeQuery({ db_type, host, port,
 *      database, username, password, mode, query, params });
 * =============================================================
 */

'use strict';

const sql = require('mssql');

let pg, mysql;
try { pg    = require('pg');             } catch { pg    = null; }
try { mysql = require('mysql2/promise'); } catch { mysql = null; }

// Comandos bloqueados — se leen desde el entorno para ser configurables
const BLOCKED_COMMANDS = (
  process.env.BLOCKED_SQL_COMMANDS || 'DROP,TRUNCATE,ALTER,CREATE,GRANT,REVOKE,DELETE'
).split(',').map(c => c.trim().toUpperCase());

// ── Helpers internos ─────────────────────────────────────────

/**
 * Detecta el tipo de query ignorando comentarios SQL.
 * @returns {string} SELECT | INSERT | UPDATE | DROP | etc.
 */
function detectQueryType(query) {
  const clean = query
    .replace(/\/\*[\s\S]*?\*\//g, '') // quita comentarios bloque
    .replace(/--[^\n]*/g, '')          // quita comentarios línea
    .trim();
  return (clean.split(/\s+/)[0] || 'UNKNOWN').toUpperCase();
}

/**
 * Valida que el mode sea compatible con el tipo de query.
 *   "read"  → solo SELECT permitido
 *   "write" → INSERT / UPDATE permitidos (SELECT bloqueado)
 */
function validateMode(mode, queryType) {
  if (mode === 'read' && queryType !== 'SELECT') {
    throw Object.assign(
      new Error(`El modo "read" solo permite SELECT. Se detectó: ${queryType}`),
      { code: 'MODE_MISMATCH', httpStatus: 403 }
    );
  }
  if (mode === 'write' && queryType === 'SELECT') {
    throw Object.assign(
      new Error('El modo "write" es para INSERT/UPDATE. Para consultas usá mode: "read".'),
      { code: 'MODE_MISMATCH', httpStatus: 403 }
    );
  }
}

// ── API pública ──────────────────────────────────────────────

/**
 * Ejecuta una query SQL contra la base de datos indicada.
 *
 * @param {Object} opts
 * @param {string}  opts.db_type   — mssql | postgresql | mysql
 * @param {string}  opts.host
 * @param {number}  opts.port
 * @param {string}  opts.database
 * @param {string}  opts.username
 * @param {string}  opts.password
 * @param {string}  opts.query     — SQL con placeholders $1, $2...
 * @param {Array}   opts.params    — Valores para los placeholders (opcional)
 * @param {string}  [opts.mode]    — "read" | "write" (opcional, valida el tipo)
 * @param {number}  [opts.timeout]    — Timeout en ms (default: 30000)
 * @param {number}  [opts.fetchSize]  — Máx filas a retornar (default: 500)
 *
 * @returns {{ queryType, rows, rowsAffected, truncated, fetchSize }}
 */
async function executeQuery({ db_type, host, port, database, username, password,
                              mode, query, params = [], timeout = 30000, fetchSize = 500 }) {
  const queryType = detectQueryType(query);

  // Verificar blacklist
  if (BLOCKED_COMMANDS.includes(queryType)) {
    throw Object.assign(
      new Error(`Operación "${queryType}" bloqueada por política del servidor.`),
      { code: 'FORBIDDEN_OPERATION', httpStatus: 403 }
    );
  }

  // Verificar mode si fue enviado
  if (mode) validateMode(mode, queryType);

  const type = (db_type || 'mssql').toLowerCase();

  switch (type) {
    case 'mssql':
      return runMssql({ host, port, database, username, password, query, params, timeout, fetchSize, queryType });
    case 'postgresql':
      return runPostgres({ host, port, database, username, password, query, params, timeout, fetchSize, queryType });
    case 'mysql':
      return runMysql({ host, port, database, username, password, query, params, timeout, fetchSize, queryType });
    default:
      throw Object.assign(
        new Error(`Motor no soportado: "${db_type}". Valores válidos: mssql, postgresql, mysql`),
        { code: 'INVALID_REQUEST', httpStatus: 400 }
      );
  }
}

// ── SQL Server ───────────────────────────────────────────────

async function runMssql({ host, port, database, username, password, query, params, timeout, fetchSize, queryType }) {
  const config = {
    user: username, password, server: host, port, database,
    requestTimeout: timeout, connectionTimeout: 10000,
    options: { encrypt: false, trustServerCertificate: true }
  };

  // mssql usa @p1, @p2 — convertimos desde $1, $2
  const mssqlQuery = query.replace(/\$(\d+)/g, '@p$1');

  // Usamos ConnectionPool independiente para no interferir con el pool
  // global que usa registry-db.js para las tablas de registro.
  let pool;
  try {
    pool = await new sql.ConnectionPool(config).connect();
    const request = pool.request();

    params.forEach((val, i) => {
      request.input(`p${i + 1}`, inferMssqlType(val), val);
    });

    const result  = await request.query(mssqlQuery);
    let rows      = result.recordset || [];
    let truncated = false;

    if (queryType === 'SELECT' && rows.length > fetchSize) {
      rows      = rows.slice(0, fetchSize);
      truncated = true;
    }

    return {
      queryType,
      rows,
      rowsAffected: Array.isArray(result.rowsAffected) ? result.rowsAffected[0] : (result.rowsAffected || 0),
      truncated,
      fetchSize: truncated ? fetchSize : undefined,
    };
  } finally {
    if (pool) { try { await pool.close(); } catch (_) {} }
  }
}

/** Infiere el tipo mssql según el valor JS. */
function inferMssqlType(val) {
  if (val === null || val === undefined)             return sql.NVarChar;
  if (typeof val === 'number' && Number.isInteger(val)) return sql.Int;
  if (typeof val === 'number')                       return sql.Float;
  if (typeof val === 'boolean')                      return sql.Bit;
  if (val instanceof Date)                           return sql.DateTime;
  return sql.NVarChar;
}

// ── PostgreSQL ───────────────────────────────────────────────

async function runPostgres({ host, port, database, username, password, query, params, timeout, fetchSize, queryType }) {
  if (!pg) throw new Error('Driver "pg" no instalado. Ejecutá: npm install pg');

  const pool = new pg.Pool({
    host, port, database, user: username, password,
    connectionTimeoutMillis: 10000,
    statement_timeout: timeout,
    max: 1,
  });

  try {
    // PostgreSQL usa $1, $2 nativamente — no se transforma la query
    const result  = await pool.query(query, params);
    let rows      = result.rows || [];
    let truncated = false;

    if (queryType === 'SELECT' && rows.length > fetchSize) {
      rows      = rows.slice(0, fetchSize);
      truncated = true;
    }

    return {
      queryType,
      rows,
      rowsAffected: result.rowCount || 0,
      truncated,
      fetchSize: truncated ? fetchSize : undefined,
    };
  } finally {
    await pool.end().catch(() => {});
  }
}

// ── MySQL / MariaDB ──────────────────────────────────────────

async function runMysql({ host, port, database, username, password, query, params, timeout, fetchSize, queryType }) {
  if (!mysql) throw new Error('Driver "mysql2" no instalado. Ejecutá: npm install mysql2');

  // MySQL usa ? como placeholder — convertimos desde $N
  const mysqlQuery = query.replace(/\$\d+/g, '?');

  const conn = await mysql.createConnection({
    host, port, database, user: username, password,
    connectTimeout: 10000,
    queryTimeout:   timeout,
  });

  try {
    const [rows] = await conn.execute(mysqlQuery, params);
    let resultRows = Array.isArray(rows) ? rows : [];
    let truncated  = false;

    if (queryType === 'SELECT' && resultRows.length > fetchSize) {
      resultRows = resultRows.slice(0, fetchSize);
      truncated  = true;
    }

    return {
      queryType,
      rows:         resultRows,
      rowsAffected: rows.affectedRows ?? resultRows.length,
      truncated,
      fetchSize: truncated ? fetchSize : undefined,
    };
  } finally {
    await conn.end().catch(() => {});
  }
}

module.exports = { executeQuery, detectQueryType };
