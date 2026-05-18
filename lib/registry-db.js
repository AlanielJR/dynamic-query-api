/**
 * =============================================================
 *  lib/registry-db.js — Capa compartida de base de datos
 * =============================================================
 *
 *  Gestiona el pool de conexión a la BD de registro y crea
 *  las tablas necesarias al iniciar. Usado por:
 *    - lib/connections.js  (tabla api_connections)
 *    - lib/traces.js       (tabla api_traces)
 *
 *  Variables de entorno:
 *    REGISTRY_DB_TYPE     — mssql | postgresql
 *    REGISTRY_DB_HOST
 *    REGISTRY_DB_PORT
 *    REGISTRY_DB_NAME
 *    REGISTRY_DB_USER
 *    REGISTRY_DB_PASSWORD
 * =============================================================
 */

'use strict';

const sql = require('mssql');
let pg;
try { pg = require('pg'); } catch { pg = null; }

// ── Config desde .env ───────────────────────────────────────
const REGISTRY = {
  type:     (process.env.REGISTRY_DB_TYPE     || 'mssql').toLowerCase(),
  host:      process.env.REGISTRY_DB_HOST     || '',
  port:  parseInt(process.env.REGISTRY_DB_PORT ||
           (process.env.REGISTRY_DB_TYPE === 'postgresql' ? '5432' : '1433')),
  database:  process.env.REGISTRY_DB_NAME     || '',
  user:      process.env.REGISTRY_DB_USER     || '',
  password:  process.env.REGISTRY_DB_PASSWORD || '',
};

let _pool = null;

// ── DDL — tabla de conexiones ───────────────────────────────
//  NOTA: database_name es NULL — la BD se pasa en cada /api/query,
//  no se almacena en la conexión. Un servidor puede tener N bases.
const DDL_CONNECTIONS = {
  mssql: `
    IF NOT EXISTS (
      SELECT 1 FROM sys.objects
      WHERE object_id = OBJECT_ID(N'dbo.api_connections') AND type = N'U'
    )
    CREATE TABLE dbo.api_connections (
      connection_id NVARCHAR(100) NOT NULL PRIMARY KEY,
      label         NVARCHAR(200)     NULL,
      db_type       NVARCHAR(20)  NOT NULL,
      host          NVARCHAR(255) NOT NULL,
      port          INT           NOT NULL,
      database_name NVARCHAR(100)     NULL,
      username_enc  NVARCHAR(MAX) NOT NULL,
      password_enc  NVARCHAR(MAX) NOT NULL,
      created_at    NVARCHAR(30)  NOT NULL,
      updated_at    NVARCHAR(30)  NOT NULL
    )`,
  postgresql: `
    CREATE TABLE IF NOT EXISTS api_connections (
      connection_id VARCHAR(100) NOT NULL PRIMARY KEY,
      label         VARCHAR(200),
      db_type       VARCHAR(20)  NOT NULL,
      host          VARCHAR(255) NOT NULL,
      port          INTEGER      NOT NULL,
      database_name VARCHAR(100),
      username_enc  TEXT         NOT NULL,
      password_enc  TEXT         NOT NULL,
      created_at    VARCHAR(30)  NOT NULL,
      updated_at    VARCHAR(30)  NOT NULL
    )`
};

// ── DDL — tabla de trazas ───────────────────────────────────
const DDL_TRACES = {
  mssql: `
    IF NOT EXISTS (
      SELECT 1 FROM sys.objects
      WHERE object_id = OBJECT_ID(N'dbo.api_traces') AND type = N'U'
    )
    CREATE TABLE dbo.api_traces (
      id            INT IDENTITY(1,1) PRIMARY KEY,
      request_id    NVARCHAR(20)   NOT NULL,
      timestamp     NVARCHAR(30)   NOT NULL,
      ip            NVARCHAR(50)       NULL,
      hostname      NVARCHAR(255)      NULL,
      method        NVARCHAR(10)       NULL,
      path          NVARCHAR(255)      NULL,
      exec_time_ms  INT                NULL,
      api           NVARCHAR(10)       NULL,
      query_type    NVARCHAR(20)       NULL,
      connection_id NVARCHAR(100)      NULL,
      db_host       NVARCHAR(255)      NULL,
      database_name NVARCHAR(100)      NULL,
      is_mock       BIT            DEFAULT 0,
      success       BIT                NULL,
      row_count     INT                NULL,
      error_code    NVARCHAR(50)       NULL,
      error_message NVARCHAR(MAX)      NULL
    )`,
  postgresql: `
    CREATE TABLE IF NOT EXISTS api_traces (
      id            SERIAL PRIMARY KEY,
      request_id    VARCHAR(20)   NOT NULL,
      timestamp     VARCHAR(30)   NOT NULL,
      ip            VARCHAR(50),
      hostname      VARCHAR(255),
      method        VARCHAR(10),
      path          VARCHAR(255),
      exec_time_ms  INTEGER,
      api           VARCHAR(10),
      query_type    VARCHAR(20),
      connection_id VARCHAR(100),
      db_host       VARCHAR(255),
      database_name VARCHAR(100),
      is_mock       BOOLEAN DEFAULT FALSE,
      success       BOOLEAN,
      row_count     INTEGER,
      error_code    VARCHAR(50),
      error_message TEXT
    )`
};

// ── Init ────────────────────────────────────────────────────
async function init() {
  const missing = [];
  if (!REGISTRY.host)     missing.push('REGISTRY_DB_HOST');
  if (!REGISTRY.database) missing.push('REGISTRY_DB_NAME');
  if (!REGISTRY.user)     missing.push('REGISTRY_DB_USER');
  if (!REGISTRY.password) missing.push('REGISTRY_DB_PASSWORD');
  if (missing.length) {
    throw new Error(`Faltan variables de entorno: ${missing.join(', ')}`);
  }

  if (REGISTRY.type === 'mssql') {
    _pool = await sql.connect({
      user: REGISTRY.user, password: REGISTRY.password,
      server: REGISTRY.host, port: REGISTRY.port,
      database: REGISTRY.database,
      options: { encrypt: false, trustServerCertificate: true },
      connectionTimeout: 10000,
      pool: { min: 1, max: 5, idleTimeoutMillis: 30000 }
    });
    await _pool.request().query(DDL_CONNECTIONS.mssql);
    await _pool.request().query(DDL_TRACES.mssql);

  } else if (REGISTRY.type === 'postgresql') {
    if (!pg) throw new Error('Driver "pg" no instalado. Ejecutá: npm install pg');
    _pool = new pg.Pool({
      host: REGISTRY.host, port: REGISTRY.port,
      database: REGISTRY.database,
      user: REGISTRY.user, password: REGISTRY.password,
      max: 5, connectionTimeoutMillis: 10000
    });
    await _pool.query(DDL_CONNECTIONS.postgresql);
    await _pool.query(DDL_TRACES.postgresql);

  } else {
    throw new Error(`REGISTRY_DB_TYPE inválido: "${REGISTRY.type}". Use: mssql | postgresql`);
  }

  console.log(`[Registry] Conectado → ${REGISTRY.type}://${REGISTRY.host}:${REGISTRY.port}/${REGISTRY.database}`);
  console.log('[Registry] Tablas api_connections y api_traces listas');
}

// ── Helpers compartidos ─────────────────────────────────────
async function runQuery(queryStr, params = []) {
  if (!_pool) throw new Error('Registry DB no inicializada. Llamá a init() primero.');

  if (REGISTRY.type === 'mssql') {
    const req = _pool.request();
    params.forEach((val, i) => req.input(`p${i + 1}`, val == null ? null : val));
    const mssqlQuery = queryStr.replace(/\$(\d+)/g, '@p$1');
    return await req.query(mssqlQuery);
  } else {
    return await _pool.query(queryStr, params);
  }
}

function extractRows(result) {
  return REGISTRY.type === 'mssql' ? (result.recordset || []) : (result.rows || []);
}

function extractRowsAffected(result) {
  if (REGISTRY.type === 'mssql') {
    return Array.isArray(result.rowsAffected) ? result.rowsAffected[0] : 0;
  }
  return result.rowCount || 0;
}

function dbType() { return REGISTRY.type; }
function dbInfo() { return `${REGISTRY.type}://${REGISTRY.host}:${REGISTRY.port}/${REGISTRY.database}`; }

module.exports = { init, runQuery, extractRows, extractRowsAffected, dbType, dbInfo };
