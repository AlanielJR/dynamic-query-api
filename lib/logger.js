/**
 * =============================================================
 *  lib/logger.js — Logger de trazas a archivo
 * =============================================================
 *
 *  Escribe cada traza en un archivo JSON por línea (NDJSON).
 *  Los archivos rotan diariamente: logs/traces-YYYY-MM-DD.log
 *  El directorio logs/ se crea automáticamente si no existe.
 *
 *  La IP ya llega enmascarada en Base64 desde traces.js.
 * =============================================================
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const LOG_DIR = path.join(process.cwd(), 'logs');

/**
 * Devuelve la ruta del archivo de log del día actual.
 * Rotación diaria: logs/traces-YYYY-MM-DD.log
 */
function getLogFilePath() {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(LOG_DIR, `traces-${date}.log`);
}

/**
 * Crea el directorio logs/ si no existe.
 */
function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

/**
 * Escribe una entrada de traza en el archivo de log del día.
 * Formato: una línea JSON por traza (NDJSON).
 * Fire-and-forget — no lanza excepciones al llamador.
 *
 * @param {Object} entry — mismos campos que traces.insert()
 */
function writeLog(entry) {
  try {
    ensureLogDir();
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(getLogFilePath(), line, 'utf8');
  } catch (err) {
    console.error('[Logger] Error escribiendo log en archivo:', err.message);
  }
}

module.exports = { writeLog };
