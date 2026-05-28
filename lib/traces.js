/**
 * =============================================================
 *  lib/traces.js - Trazabilidad de consumo en archivo de log
 * =============================================================
 *
 *  Escribe cada request en el archivo de log diario.
 *  No escribe en BD (el usuario de registro es solo lectura).
 *
 *  Estrategia de enmascaramiento de IP:
 *    - Archivo de log : IP codificada en Base64 (enmascarada)
 * =============================================================
 */

'use strict';

const { writeLog } = require('./logger');

function maskIp(ip) {
  if (!ip) return null;
  return Buffer.from(ip).toString('base64');
}

/**
 * Registrar una traza en el archivo de log.
 * La IP se enmascara en Base64 antes de escribir.
 */
function insert(entry) {
  var rawIp       = entry.ip       || null;
  var rawHostname = entry.hostname || null;

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

module.exports = { insert };
