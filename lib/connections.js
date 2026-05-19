/**
 * =============================================================
 *  lib/connections.js - Registro de conexiones en BD
 * =============================================================
 *
 *  CRUD sobre la tabla api_connections.
 *  La tabla se crea via lib/registry-db.js init().
 *  Las credenciales siempre se cifran antes de guardarse.
 *
 *  NOTA: La conexion almacena el servidor (host, port, credenciales)
 *  pero NO la base de datos. La base de datos se pasa en cada
 *  request a /api/query, permitiendo usar un mismo servidor
 *  para multiples bases de datos.
 * =============================================================
 */

'use strict';

const { runQuery, extractRows, extractRowsAffected, dbInfo } = require('./registry-db');
const { encrypt, decrypt } = require('./crypto');

const VALID_TYPES = ['mssql', 'postgresql', 'mysql'];

/**
 * Decodifica un string Base64 a texto plano.
 * Lanza un error claro si el valor no es Base64 valido.
 */
function decodeBase64(value, fieldName) {
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64') !== value &&
        Buffer.from(decoded, 'utf8').toString('base64').replace(/=/g, '') !== value.replace(/=/g, '')) {
      throw new Error();
    }
    return decoded;
  } catch {
    throw new Error('El campo "' + fieldName + '" no es un valor Base64 valido.');
  }
}

/**
 * Registrar o actualizar una conexion de servidor.
 * Las credenciales se cifran con AES-256-GCM antes de guardarse.
 * La base de datos NO se almacena - se pasa en cada query.
 *
 * @param {boolean} [encoded=false] - si true, host/username/password vienen en Base64
 *   y se decodifican antes de guardar. Util para enmascarar los datos
 *   durante el transporte sin exponerlos en texto plano en el request.
 */
async function upsert({ connection_id, label, db_type, host, port, username, password, encoded = false }) {
  if (!connection_id || !db_type || !host || !port || !username || !password) {
    throw new Error('Campos requeridos: connection_id, db_type, host, port, username, password');
  }
  if (!VALID_TYPES.includes(db_type.toLowerCase())) {
    throw new Error('db_type invalido: "' + db_type + '". Valores aceptados: ' + VALID_TYPES.join(', '));
  }

  // Si los campos sensibles vienen en Base64, decodificar antes de guardar/cifrar
  const rawHost     = encoded ? decodeBase64(host,     'host')     : host;
  const rawUsername = encoded ? decodeBase64(username, 'username') : username;
  const rawPassword = encoded ? decodeBase64(password, 'password') : password;

  const now          = new Date().toISOString();
  const username_enc = encrypt(rawUsername);
  const password_enc = encrypt(rawPassword);
  const existing     = await getById(connection_id, false);

  if (existing) {
    await runQuery(
      'UPDATE api_connections SET' +
      '  label = $1, db_type = $2, host = $3, port = $4,' +
      '  username_enc = $5, password_enc = $6, updated_at = $7' +
      ' WHERE connection_id = $8',
      [label || connection_id, db_type.toLowerCase(), rawHost, parseInt(port),
       username_enc, password_enc, now, connection_id]
    );
  } else {
    await runQuery(
      'INSERT INTO api_connections' +
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
 * @param {string}  id
 * @param {boolean} withCredentials - si true, descifra y devuelve username/password
 */
async function getById(id, withCredentials) {
  if (withCredentials === undefined) withCredentials = false;
  const result = await runQuery(
    'SELECT * FROM api_connections WHERE connection_id = $1', [id]
  );
  const rows = extractRows(result);
  if (!rows.length) return null;
  return formatRow(rows[0], withCredentials);
}

/**
 * Listar todas las conexiones (sin credenciales).
 */
async function list() {
  const result = await runQuery(
    'SELECT * FROM api_connections ORDER BY created_at DESC'
  );
  return extractRows(result).map(function(r) { return formatRow(r, false); });
}

/**
 * Eliminar una conexion por ID.
 * @returns {boolean} true si existia y se elimino
 */
async function remove(id) {
  const result = await runQuery(
    'DELETE FROM api_connections WHERE connection_id = $1', [id]
  );
  return extractRowsAffected(result) > 0;
}

/**
 * Obtener credenciales descifradas para uso interno.
 * NUNCA exponer esto en respuestas de la API.
 */
async function getCredentials(id) {
  const conn = await getById(id, true);
  if (!conn) throw new Error('Conexion "' + id + '" no encontrada');
  return conn;
}

// Formato de salida
function formatRow(row, withCredentials) {
  const base = {
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

module.exports = { upsert, getById, list, remove, getCredentials };
