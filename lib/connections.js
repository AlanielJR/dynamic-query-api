/**
 * =============================================================
 *  lib/connections.js - Registro de conexiones en BD
 * =============================================================
 *
 *  CRUD de lectura sobre la tabla de conexiones.
 *  El nombre de la tabla se toma de TABLE_CONNECTIONS (env) via registry-db.
 *  Las credenciales siempre se cifran antes de guardarse.
 * =============================================================
 */

'use strict';

const { runQuery, extractRows, extractRowsAffected, dbInfo, tableConnections } = require('./registry-db');
const { encrypt, decrypt } = require('./crypto');

const VALID_TYPES = ['mssql', 'postgresql', 'mysql'];

/**
 * Decodifica un string Base64 a texto plano.
 */
function decodeBase64(value, fieldName) {
  try {
    var decoded = Buffer.from(value, 'base64').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64') !== value &&
        Buffer.from(decoded, 'utf8').toString('base64').replace(/=/g, '') !== value.replace(/=/g, '')) {
      throw new Error();
    }
    return decoded;
  } catch (e) {
    throw new Error('El campo "' + fieldName + '" no es un valor Base64 valido.');
  }
}

/**
 * Registrar o actualizar una conexion de servidor.
 * Las credenciales se cifran con AES-256-GCM antes de guardarse.
 * Si encoded=true, host/username/password vienen en Base64 y se decodifican.
 */
async function upsert({ connection_id, label, db_type, host, port, username, password, encoded }) {
  encoded = encoded || false;
  if (!connection_id || !db_type || !host || !port || !username || !password) {
    throw new Error('Campos requeridos: connection_id, db_type, host, port, username, password');
  }
  if (!VALID_TYPES.includes(db_type.toLowerCase())) {
    throw new Error('db_type invalido: "' + db_type + '". Valores aceptados: ' + VALID_TYPES.join(', '));
  }

  var rawHost     = encoded ? decodeBase64(host,     'host')     : host;
  var rawUsername = encoded ? decodeBase64(username, 'username') : username;
  var rawPassword = encoded ? decodeBase64(password, 'password') : password;

  var now          = new Date().toISOString();
  var username_enc = encrypt(rawUsername);
  var password_enc = encrypt(rawPassword);
  var T            = tableConnections();
  var existing     = await getById(connection_id, false);

  if (existing) {
    await runQuery(
      'UPDATE ' + T + ' SET' +
      '  label = $1, db_type = $2, host = $3, port = $4,' +
      '  username_enc = $5, password_enc = $6, updated_at = $7' +
      ' WHERE connection_id = $8',
      [label || connection_id, db_type.toLowerCase(), rawHost, parseInt(port),
       username_enc, password_enc, now, connection_id]
    );
  } else {
    await runQuery(
      'INSERT INTO ' + T +
      '  (connection_id, label, db_type, host, port,' +
      '   username_enc, password_enc, created_at, updated_at)' +
      ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [connection_id, label || connection_id, db_type.toLowerCase(),
       rawHost, parseInt(port), username_enc, password_enc, now, now]
    );
  }

  return getById(connection_id, false);
}

/**
 * Obtener una conexion por ID.
 */
async function getById(id, withCredentials) {
  if (withCredentials === undefined) withCredentials = false;
  var result = await runQuery(
    'SELECT * FROM ' + tableConnections() + ' WHERE connection_id = $1', [id]
  );
  var rows = extractRows(result);
  if (!rows.length) return null;
  return formatRow(rows[0], withCredentials);
}

/**
 * Listar todas las conexiones (sin credenciales).
 */
async function list() {
  var result = await runQuery(
    'SELECT * FROM ' + tableConnections() + ' ORDER BY created_at DESC'
  );
  return extractRows(result).map(function(r) { return formatRow(r, false); });
}

/**
 * Eliminar una conexion por ID.
 */
async function remove(id) {
  var result = await runQuery(
    'DELETE FROM ' + tableConnections() + ' WHERE connection_id = $1', [id]
  );
  return extractRowsAffected(result) > 0;
}

/**
 * Obtener credenciales descifradas para uso interno.
 * NUNCA exponer esto en respuestas de la API.
 */
async function getCredentials(id) {
  var conn = await getById(id, true);
  if (!conn) throw new Error('Conexion "' + id + '" no encontrada');
  return conn;
}

function formatRow(row, withCredentials) {
  var base = {
    connection_id: row.connection_id,
    label:         row.label,
    db_type:       row.db_type,
    host:          row.host,
    port:          row.port,
    created_at:    row.created_at,
    updated_at:    row.updated_at,
    registry:      dbInfo()
  };
  if (withCredentials) {
    base.username = decrypt(row.username_enc);
    base.password = decrypt(row.password_enc);
  }
  return base;
}

module.exports = { upsert, getById, list, remove, getCredentials, decodeBase64 };
