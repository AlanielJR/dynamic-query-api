/**
 * =============================================================
 *  lib/crypto.js — Cifrado AES-256-GCM para credenciales
 * =============================================================
 *
 *  Usa el módulo nativo `crypto` de Node.js — sin dependencias externas.
 *  AES-256-GCM provee cifrado autenticado: si alguien modifica el dato
 *  cifrado, el descifrado falla con error (no devuelve basura silenciosa).
 *
 *  ENCRYPTION_KEY en .env debe ser exactamente 32 bytes (64 chars hex).
 *  Generar con:
 *    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 * =============================================================
 */

'use strict';

const crypto = require('crypto');

const ALGORITHM  = 'aes-256-gcm';
const IV_LENGTH  = 16;   // bytes — generado aleatoriamente por cada cifrado
const TAG_LENGTH = 16;   // bytes — tag de autenticación GCM

/**
 * Devuelve el buffer de la clave de 32 bytes desde la variable de entorno.
 * Lanza un error claro si la clave no está configurada o tiene largo incorrecto.
 */
function getKey() {
  const raw = process.env.ENCRYPTION_KEY || '';
  if (!raw) {
    throw new Error(
      'ENCRYPTION_KEY no está definida en el entorno. ' +
      'Generá una con: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  // Acepta la clave en hex (64 chars) o como string directo de 32 chars
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  const buf = Buffer.from(raw, 'utf8');
  if (buf.length !== 32) {
    throw new Error(
      `ENCRYPTION_KEY debe ser 64 caracteres hexadecimales (32 bytes). Largo actual: ${raw.length}`
    );
  }
  return buf;
}

/**
 * Cifra un texto plano.
 * @param {string} plaintext — texto a cifrar
 * @returns {string} — string base64 con formato: iv:tag:ciphertext
 */
function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined) return null;
  const key  = getKey();
  const iv   = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });

  const encrypted = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();

  // Formato: base64(iv):base64(tag):base64(ciphertext)
  return [
    iv.toString('base64'),
    tag.toString('base64'),
    encrypted.toString('base64')
  ].join(':');
}

/**
 * Descifra un valor cifrado previamente con encrypt().
 * @param {string} encryptedStr — string en formato iv:tag:ciphertext (base64)
 * @returns {string} — texto plano original
 */
function decrypt(encryptedStr) {
  if (!encryptedStr) return null;
  const key    = getKey();
  const parts  = encryptedStr.split(':');
  if (parts.length !== 3) {
    throw new Error('Formato de dato cifrado inválido. Se esperaba: iv:tag:ciphertext');
  }

  const iv         = Buffer.from(parts[0], 'base64');
  const tag        = Buffer.from(parts[1], 'base64');
  const ciphertext = Buffer.from(parts[2], 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(tag);

  try {
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]);
    return decrypted.toString('utf8');
  } catch {
    throw new Error('Fallo al descifrar: el dato puede estar corrupto o la clave es incorrecta');
  }
}

module.exports = { encrypt, decrypt };
