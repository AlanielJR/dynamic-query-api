/**
 * =============================================================
 *  lib/traces.js - Trazabilidad de consumo en base de datos
 * =============================================================
 *
 *  Guarda cada request en la tabla api_traces de la BD de registro.
 *  Expone funciones para insertar, consultar con filtros y limpiar.
 *
 *  La tabla se crea automaticamente via lib/registry-db.js init().
 *
 *  Estrategia de enmascaramiento de IP:
 *    - BD de registro : IP en texto plano (para filtros y auditoria)
 *    - Respuesta API  : IP codificada en Base64 (enmascarada)
 *    - Archivo de log : IP codificada en Base64 (enmascarada)
 * =============================================================
 */

'use strict';

const { runQuery, extractRows, extractRowsAffected, dbType } = require('./registry-db');
const { writeLog } = require('./logger');

/**
 * Enmascara una IP en Base64.
 * Ejemplo: '192.168.1.100' -> 'MTkyLjE2OC4xLjEwMA=='
 */
function maskIp(ip) {
  if (!ip) return null;
  return Buffer.from(ip).toString('base64');
}

/**
 * Insertar una traza.
 * BD: IP en texto plano. Respuesta y log: IP en Base64.
 */
async function insert(entry) {
  const rawIp       = entry.ip       || null;
  const rawHostname = entry.hostname || null;

  // Persistir en BD - IP en texto plano
  try {
    await runQuery(
      'INSERT INTO api_traces' +
      ' (request_id, timestamp, ip, hostname, method, path, exec_time_ms, api,' +
      '  query_type, connection_id, db_host, database_name, is_mock,' +
      '  success, row_count, error_code, error_message)' +
      ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)',
      [
        entry.requestId     || null,
        entry.timestamp     || new Date().toISOString(),
        rawIp,
        rawHostname,
        entry.method        || null,
        entry.path          || null,
        entry.execTimeMs    != null ? entry.execTimeMs : null,
        entry.api           || 'json',
        entry.queryType     || null,
        entry.connection_id || null,
        entry.dbHost        || null,
        entry.database      || null,
        entry.isMock        ? true : false,
        entry.success       ? true : false,
        entry.rowCount      != null ? entry.rowCount : null,
        entry.errorCode     || null,
        entry.errorMessage  || null,
      ]
    );
  } catch (err) {
    console.error('[Trace] Error guardando traza en BD:', err.message);
  }

  // Persistir en archivo de log - IP enmascarada en Base64
  writeLog({
    requestId:     entry.requestId     || null,
    timestamp:     entry.timestamp     || new Date().toISOString(),
    ip:            maskIp(rawIp),
    hostname:      rawHostname ? maskIp(rawHostname) : null,
    method:        entry.method        || null,
    path:          entry.path          || null,
    execTimeMs:    entry.execTimeMs    != null ? entry.execTimeMs : null,
    api:           entry.api           || 'json',
    queryType:     entry.queryType     || null,
    connection_id: entry.connection_id || null,
    dbHost:        entry.dbHost        || null,
    database:      entry.database      || null,
    isMock:        entry.isMock        ? true : false,
    success:       entry.success       ? true : false,
    rowCount:      entry.rowCount      != null ? entry.rowCount : null,
    errorCode:     entry.errorCode     || null,
    errorMessage:  entry.errorMessage  || null,
  });
}

/**
 * Consultar trazas con filtros opcionales.
 * La IP se filtra por valor real pero se devuelve enmascarada en Base64.
 */
async function query(filters) {
  filters = filters || {};
  var ip            = filters.ip;
  var success       = filters.success;
  var queryType     = filters.queryType;
  var api           = filters.api;
  var connection_id = filters.connection_id;
  var from          = filters.from;
  var to            = filters.to;
  var limit         = filters.limit;

  var conditions = [];
  var params     = [];
  var idx        = 1;

  if (ip)                                    { conditions.push('ip = $' + idx++);            params.push(ip); }
  if (success !== undefined && success !== '') { conditions.push('success = $' + idx++);      params.push(success === 'true' || success === true); }
  if (queryType)                             { conditions.push('query_type = $' + idx++);    params.push(queryType.toUpperCase()); }
  if (api)                                   { conditions.push('api = $' + idx++);           params.push(api.toLowerCase()); }
  if (connection_id)                         { conditions.push('connection_id = $' + idx++); params.push(connection_id); }
  if (from)                                  { conditions.push('timestamp >= $' + idx++);    params.push(from); }
  if (to)                                    { conditions.push('timestamp <= $' + idx++);    params.push(to); }

  var where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  var countResult = await runQuery('SELECT COUNT(*) AS total FROM api_traces ' + where, params);
  var totalRow    = extractRows(countResult)[0];
  var total       = parseInt(totalRow && (totalRow.total || totalRow.Total) || 0);

  var maxRows    = Math.min(parseInt(limit) || 100, 1000);
  var orderLimit = dbType() === 'mssql'
    ? 'ORDER BY id DESC OFFSET 0 ROWS FETCH NEXT ' + maxRows + ' ROWS ONLY'
    : 'ORDER BY id DESC LIMIT ' + maxRows;

  var rowsResult = await runQuery('SELECT * FROM api_traces ' + where + ' ' + orderLimit, params);

  // Enmascarar IP en Base64 en la respuesta (la BD conserva el valor real)
  var traces = extractRows(rowsResult).map(function(row) {
    if (row.ip)       row.ip       = maskIp(row.ip);
    if (row.hostname) row.hostname = maskIp(row.hostname);
    return row;
  });

  return { total: total, traces: traces };
}

/**
 * Limpiar todas las trazas de la BD.
 */
async function clear() {
  var result = await runQuery('DELETE FROM api_traces');
  return extractRowsAffected(result);
}

module.exports = { insert, query, clear };
