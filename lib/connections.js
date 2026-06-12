'use strict';

const { runQuery, extractRows, dbInfo, tableConnections } = require('./registry-db');
const { decrypt } = require('./crypto');

/**
 * Intenta descifrar un valor AES-256-GCM.
 * Si falla (valor en texto plano o formato distinto), lo devuelve tal cual.
 */
function decryptOrPlain(val) {
  if (!val) return val;
  try {
    return decrypt(val);
  } catch (e) {
    return val;
  }
}

/**
 * Decodifica un string Base64 a texto plano.
 * Usado en POST /api/connections (cifrado de credenciales).
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
 * Obtiene y desencripta las credenciales de una conexión por su código.
 * NUNCA exponer el resultado en respuestas HTTP.
 */
async function getCredentials(id) {
  var result = await runQuery(
    'SELECT * FROM ' + tableConnections() + ' WHERE codigo = $1', [id]
  );
  var rows = extractRows(result);
  if (!rows.length) throw new Error('Conexion "' + id + '" no encontrada');

  var row = rows[0];
  return {
    codigo:      row.codigo,
    descripcion: row.descripcion,
    db_type:     row.db_tipo,
    host:        decryptOrPlain(row.servidor),
    port:        row.puerto,
    username:    decryptOrPlain(row.usuario),
    password:    decryptOrPlain(row.contrasena),
    registry:    dbInfo()
  };
}

module.exports = { decodeBase64, getCredentials };
