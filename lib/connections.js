/**
 * =============================================================
 *  lib/connections.js — Registro de conexiones en BD
 * =============================================================
 *
 *  CRUD sobre la tabla api_connections.
 *  La tabla se crea via lib/registry-db.js init().
 *  Las credenciales siempre se cifran antes de guardarse.
 *
 *  NOTA: La conexión almacena el servidor (host, port, credenciales)
 *  pero NO la base de datos. La base de datos se pasa en cada
 *  request a /api/query, permitiendo usar un mismo servidor
 *  para múltiples bases de datos.
 * =============================================================
 */

'use strict';

const { runQuery, extractRows, extractRowsAffected, dbInfo } = require('./registry-db');
const { encrypt, decrypt } = require('./crypto');

const VALID_TYPES = ['mssql', 'postgresql', 'mysql'];

/**
 * Registrar o actualizar una conexión de servidor.
 * Las credenciales se cifran antes de guardar.
 * La base de datos NO se almacena — se pasa en cada query.
 */
async function upsert({ connection_id, label, db_type, host, port, username, password }) {
  if (!connection_id || !db_type || !host || !port || !username || !password) {
    throw new Error('Campos requeridos: connection_id, db_type, host, port, username, password');
  }
  if (!VALID_TYPES.includes(db_type.toLowerCase())) {
    throw new Error(`db_type inválido: "${db_type}". Valores aceptados: ${VALID_TYPES.join(', ')}`);
  }

  const now          = new Date().toISOString();
  const username_enc = encrypt(username);
  const password_enc = encrypt(password);
  const existing     = await getById(connection_id, false);

  if (existing) {
    await runQuery(
      `UPDATE api_connections SET
         label = $1, db_type = $2, host = $3, port = $4,
         username_enc = $5, password_enc = $6, updated_at = $7
       WHERE connection_id = $8`,
      [label || connection_id, db_type.toLowerCase(), host, parseInt(port),
       username_enc, password_enc, now, connection_id]
    );
  } else {
    await runQuery(
      `INSERT INTO api_connections
         (connection_id, label, db_type, host, port,
          username_enc, password_enc, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [connection_id, label || connection_id, db_type.toLowerCase(),
       host, parseInt(port), username_enc, password_enc, now, now]
    );
  }

  return getById(connection_id, false);
}

/**
 * Obtener una conexión por ID.
 * @param {string}  id
 * @param {boolean} withCredentials — si true, descifra y devuelve username/password
 */
async function getById(id, withCredentials = false) {
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
  return extractRows(result).map(r => formatRow(r, false));
}

/**
 * Eliminar una conexión por ID.
 * @returns {boolean} true si existía y se eliminó
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
  if (!conn) throw new Error(`Conexión "${id}" no encontrada`);
  return conn;
}

// ── Formato de salida ───────────────────────────────────────
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
