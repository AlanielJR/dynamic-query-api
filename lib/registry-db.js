/**
 * =============================================================
 *  lib/registry-db.js - Capa compartida de base de datos
 * =============================================================
 *
 *  Gestiona el pool de conexion a la BD de registro y crea
 *  la tabla de conexiones al iniciar.
 *
 *  Variables de entorno:
 *    REGISTRY_DB_TYPE     -- mssql | postgresql
 *    REGISTRY_DB_HOST
 *    REGISTRY_DB_PORT
 *    REGISTRY_DB_NAME
 *    REGISTRY_DB_USER
 *    REGISTRY_DB_PASSWORD
 *    TABLE_CONNECTIONS    -- nombre de la tabla de conexiones (default: api_connections)
 * =============================================================
 */

'use strict';

const sql = require('mssql');
let pg;
try { pg = require('pg'); } catch { pg = null; }

// -- Nombre de tabla configurable via entorno ------------------
const TABLE_CONNECTIONS = process.env.TABLE_CONNECTIONS || 'api_connections';

// -- Config desde .env -----------------------------------------
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

// -- DDL: tabla de conexiones ----------------------------------
function getDdlConnections(type) {
  var t = TABLE_CONNECTIONS;
  if (type === 'mssql') {
    return (
      'IF NOT EXISTS (' +
      '  SELECT 1 FROM sys.objects' +
      '  WHERE object_id = OBJECT_ID(N' + "'" + 'dbo.' + t + "'" + ') AND type = N' + "'U'" +
      ')' +
      ' CREATE TABLE dbo.' + t + ' (' +
      '  connection_id NVARCHAR(100) NOT NULL PRIMARY KEY,' +
      '  label         NVARCHAR(200)     NULL,' +
      '  db_type       NVARCHAR(20)  NOT NULL,' +
      '  host          NVARCHAR(255) NOT NULL,' +
      '  port          INT           NOT NULL,' +
      '  username_enc  NVARCHAR(MAX) NOT NULL,' +
      '  password_enc  NVARCHAR(MAX) NOT NULL,' +
      '  created_at    NVARCHAR(30)  NOT NULL,' +
      '  updated_at    NVARCHAR(30)  NOT NULL' +
      ')'
    );
  }
  return (
    'CREATE TABLE IF NOT EXISTS ' + t + ' (' +
    '  connection_id VARCHAR(100) NOT NULL PRIMARY KEY,' +
    '  label         VARCHAR(200),' +
    '  db_type       VARCHAR(20)  NOT NULL,' +
    '  host          VARCHAR(255) NOT NULL,' +
    '  port          INTEGER      NOT NULL,' +
    '  username_enc  TEXT         NOT NULL,' +
    '  password_enc  TEXT         NOT NULL,' +
    '  created_at    VARCHAR(30)  NOT NULL,' +
    '  updated_at    VARCHAR(30)  NOT NULL' +
    ')'
  );
}

// -- Init -----------------------------------------------------
async function init() {
  var missing = [];
  if (!REGISTRY.host)     missing.push('REGISTRY_DB_HOST');
  if (!REGISTRY.database) missing.push('REGISTRY_DB_NAME');
  if (!REGISTRY.user)     missing.push('REGISTRY_DB_USER');
  if (!REGISTRY.password) missing.push('REGISTRY_DB_PASSWORD');
  if (missing.length) {
    throw new Error('Faltan variables de entorno: ' + missing.join(', '));
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
    await _pool.request().query(getDdlConnections('mssql'));

  } else if (REGISTRY.type === 'postgresql') {
    if (!pg) throw new Error('Driver "pg" no instalado. Ejecuta: npm install pg');
    _pool = new pg.Pool({
      host: REGISTRY.host, port: REGISTRY.port,
      database: REGISTRY.database,
      user: REGISTRY.user, password: REGISTRY.password,
      max: 5, connectionTimeoutMillis: 10000
    });
    await _pool.query(getDdlConnections('postgresql'));

  } else {
    throw new Error('REGISTRY_DB_TYPE invalido: "' + REGISTRY.type + '". Use: mssql | postgresql');
  }

  console.log('[Registry] Conectado -> ' + REGISTRY.type + '://' + REGISTRY.host + ':' + REGISTRY.port + '/' + REGISTRY.database);
  console.log('[Registry] Tabla ' + TABLE_CONNECTIONS + ' lista');
}

// -- Helpers compartidos --------------------------------------
async function runQuery(queryStr, params) {
  params = params || [];
  if (!_pool) throw new Error('Registry DB no inicializada. Llama a init() primero.');

  if (REGISTRY.type === 'mssql') {
    var req = _pool.request();
    params.forEach(function(val, i) { req.input('p' + (i + 1), val == null ? null : val); });
    var mssqlQuery = queryStr.replace(/\$(\d+)/g, '@p$1');
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
function dbInfo() { return REGISTRY.type + '://' + REGISTRY.host + ':' + REGISTRY.port + '/' + REGISTRY.database; }
function tableConnections() { return TABLE_CONNECTIONS; }

module.exports = { init, runQuery, extractRows, extractRowsAffected, dbType, dbInfo, tableConnections };
