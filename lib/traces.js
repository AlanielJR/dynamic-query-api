/**
 * =============================================================
 *  lib/traces.js — Trazabilidad de consumo en base de datos
 * =============================================================
 *
 *  Guarda cada request en la tabla api_traces de la BD de registro.
 *  Expone funciones para insertar, consultar con filtros y limpiar.
 *
 *  La tabla se crea automáticamente via lib/registry-db.js init().
 * =============================================================
 */

'use strict';

const { runQuery, extractRows, extractRowsAffected, dbType } = require('./registry-db');

/**
 * Insertar una traza en la BD.
 * Se llama de forma asíncrona sin bloquear la respuesta al cliente.
 *
 * @param {Object} entry
 * @param {string}  entry.requestId
 * @param {string}  entry.timestamp    — ISO string
 * @param {string}  entry.ip
 * @param {string}  [entry.hostname]
 * @param {string}  entry.method
 * @param {string}  entry.path
 * @param {number}  entry.execTimeMs
 * @param {string}  [entry.api]        — 'json'
 * @param {string}  [entry.queryType]
 * @param {string}  [entry.connection_id]
 * @param {string}  [entry.dbHost]
 * @param {string}  [entry.database]
 * @param {boolean} [entry.isMock]
 * @param {boolean} entry.success
 * @param {number}  [entry.rowCount]
 * @param {string}  [entry.errorCode]
 * @param {string}  [entry.errorMessage]
 */
async function insert(entry) {
  try {
    await runQuery(
      `INSERT INTO api_traces
        (request_id, timestamp, ip, hostname, method, path, exec_time_ms, api,
         query_type, connection_id, db_host, database_name, is_mock,
         success, row_count, error_code, error_message)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        entry.requestId        || null,
        entry.timestamp        || new Date().toISOString(),
        entry.ip               || null,
        entry.hostname         || null,
        entry.method           || null,
        entry.path             || null,
        entry.execTimeMs       ?? null,
        entry.api              || 'json',
        entry.queryType        || null,
        entry.connection_id    || null,
        entry.dbHost           || null,
        entry.database         || null,
        entry.isMock           ? true : false,
        entry.success          ? true : false,
        entry.rowCount         ?? null,
        entry.errorCode        || null,
        entry.errorMessage     || null,
      ]
    );
  } catch (err) {
    // No interrumpir el flujo del request si la traza falla
    console.error('[Trace] Error guardando traza en BD:', err.message);
  }
}

/**
 * Consultar trazas con filtros opcionales.
 *
 * @param {Object} filters
 * @param {string}  [filters.ip]
 * @param {string}  [filters.success]      — 'true' | 'false'
 * @param {string}  [filters.queryType]
 * @param {string}  [filters.api]          — 'json'
 * @param {string}  [filters.connection_id]
 * @param {string}  [filters.from]         — ISO date
 * @param {string}  [filters.to]           — ISO date
 * @param {number}  [filters.limit]        — default 100, max 1000
 *
 * @returns {{ total: number, traces: Array }}
 */
async function query(filters = {}) {
  const { ip, success, queryType, api, connection_id, from, to, limit } = filters;

  // Construir WHERE dinámico
  const conditions = [];
  const params     = [];
  let   idx        = 1;

  if (ip) {
    conditions.push(`ip = $${idx++}`);
    params.push(ip);
  }
  if (success !== undefined && success !== '') {
    conditions.push(`success = $${idx++}`);
    params.push(success === 'true' || success === true);
  }
  if (queryType) {
    conditions.push(`query_type = $${idx++}`);
    params.push(queryType.toUpperCase());
  }
  if (api) {
    conditions.push(`api = $${idx++}`);
    params.push(api.toLowerCase());
  }
  if (connection_id) {
    conditions.push(`connection_id = $${idx++}`);
    params.push(connection_id);
  }
  if (from) {
    conditions.push(`timestamp >= $${idx++}`);
    params.push(from);
  }
  if (to) {
    conditions.push(`timestamp <= $${idx++}`);
    params.push(to);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  // Total sin limit
  const countResult = await runQuery(
    `SELECT COUNT(*) AS total FROM api_traces ${where}`, params
  );
  const totalRow = extractRows(countResult)[0];
  const total = parseInt(totalRow?.total ?? totalRow?.Total ?? 0);

  // Filas con limit — más recientes primero
  const maxRows  = Math.min(parseInt(limit) || 100, 1000);
  const orderLimit = dbType() === 'mssql'
    ? `ORDER BY id DESC OFFSET 0 ROWS FETCH NEXT ${maxRows} ROWS ONLY`
    : `ORDER BY id DESC LIMIT ${maxRows}`;

  const rowsResult = await runQuery(
    `SELECT * FROM api_traces ${where} ${orderLimit}`, params
  );

  return { total, traces: extractRows(rowsResult) };
}

/**
 * Limpiar todas las trazas de la BD.
 * @returns {number} cantidad de filas eliminadas
 */
async function clear() {
  const result = await runQuery('DELETE FROM api_traces');
  return extractRowsAffected(result);
}

module.exports = { insert, query, clear };
