'use strict';

require('dotenv').config({ override: true });

const express = require('express');
const dns     = require('dns');
const os      = require('os');

const app = express();

const PORT    = process.env.PORT    || 3000;
const API_KEY = process.env.API_KEY || 'test-api-key-123';

const BLOCKED_COMMANDS = (process.env.BLOCKED_SQL_COMMANDS || 'DROP,TRUNCATE,ALTER,CREATE,GRANT,REVOKE,DELETE')
  .split(',').map(c => c.trim().toUpperCase());

// ── Módulos internos ─────────────────────────────────────────
const registryDb            = require('./lib/registry-db');
const connections           = require('./lib/connections');
const traces                = require('./lib/traces');
const { executeQuery }      = require('./lib/query-executor');
const { encrypt }           = require('./lib/crypto');

// ── Middleware global ────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));

// ── Helpers de red ───────────────────────────────────────────

/**
 * Extrae la IP real del cliente normalizando IPv6-mapped a IPv4.
 */
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  const raw = req.socket?.remoteAddress || 'unknown';
  if (raw === '::1') return '127.0.0.1';
  if (raw.startsWith('::ffff:')) return raw.slice(7);
  return raw;
}

/**
 * Resuelve hostname por IP vía DNS reverse. Para loopback devuelve el hostname del SO.
 */
function resolveHostname(ip) {
  return new Promise(resolve => {
    if (!ip || ip === 'unknown' || ip === '127.0.0.1') {
      return resolve(os.hostname());
    }
    dns.reverse(ip, (err, hosts) => resolve(err || !hosts?.length ? null : hosts[0]));
  });
}

/**
 * Inserta una traza en la BD de forma asíncrona (no bloquea la respuesta).
 */
async function writeTrace(entry) {
  if (entry.ip && !entry.hostname) {
    entry.hostname = await resolveHostname(entry.ip);
  }
  traces.insert(entry); // fire-and-forget
}

// ── Middleware de autenticación ──────────────────────────────

/**
 * Valida el header X-Api-Key en todas las rutas protegidas.
 */
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || key !== API_KEY) {
    return res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Header X-Api-Key inválido o ausente.' }
    });
  }
  next();
}

// ============================================================
//  CONEXIONES  —  /api/connections
// ============================================================

/**
 * POST /api/connections
 * Endpoint de cifrado — NO escribe en la BD.
 *
 * Recibe host y password en Base64 (requeridos) y username en Base64 (opcional).
 * Los decodifica y los cifra con AES-256-GCM.
 * Devuelve los valores cifrados para que el caller los almacene manualmente.
 *
 * Body: { host, password, username? }
 *   host     {string} — IP o hostname en Base64 (requerido)
 *   password {string} — Contraseña en Base64 (requerido)
 *   username {string} — Usuario en Base64 (opcional)
 *
 * Respuesta:
 *   { success: true, host_enc, password_enc, username_enc? }
 */
app.post('/api/connections', requireApiKey, async (req, res) => {
  try {
    const { host, password, username } = req.body;

    if (!host || !String(host).trim()) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_REQUEST', message: 'Campo requerido: host.' } });
    }
    if (!password || !String(password).trim()) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_REQUEST', message: 'Campo requerido: password.' } });
    }

    const rawHost     = connections.decodeBase64(host,     'host');
    const rawPassword = connections.decodeBase64(password, 'password');

    const response = {
      success:      true,
      host_enc:     Buffer.from(encrypt(rawHost)).toString('base64'),
      password_enc: Buffer.from(encrypt(rawPassword)).toString('base64'),
    };

    if (username && String(username).trim()) {
      const rawUsername     = connections.decodeBase64(username, 'username');
      response.username_enc = Buffer.from(encrypt(rawUsername)).toString('base64');
    }

    return res.status(200).json(response);
  } catch (err) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_REQUEST', message: err.message } });
  }
});


// ============================================================
//  EJECUCIÓN DE QUERIES  —  POST /api/query
// ============================================================

/**
 * POST /api/query
 * Ejecuta una query SQL sobre una conexión registrada.
 *
 * Body:
 *   connection_id  {string}   — ID de la conexión registrada
 *   database       {string}   — Nombre de la base de datos a consultar
 *   query          {string}   — SQL a ejecutar (usar $1, $2... para parámetros)
 *   params         {Array}    — Valores para los parámetros (opcional)
 *   mode           {string}   — "read" (solo SELECT) | "write" (INSERT/UPDATE)
 *   fetchSize      {number}   — Máx filas a retornar (default 500)
 *   timeout        {number}   — Timeout en ms (default 30000)
 */
app.post('/api/query', requireApiKey, async (req, res) => {
  const startTime  = Date.now();
  const requestId  = Date.now().toString(36).toUpperCase();
  const clientIp   = getClientIp(req);
  const { connection_id, database, mode, query, params = [], fetchSize, timeout } = req.body;

  // Validaciones básicas
  if (!connection_id) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_REQUEST', message: 'Campo requerido: connection_id.' } });
  }
  if (!database || !String(database).trim()) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_REQUEST', message: 'Campo requerido: database.' } });
  }
  if (!query || !String(query).trim()) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_REQUEST', message: 'Campo requerido: query.' } });
  }
  if (mode && !['read', 'write'].includes(mode)) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_REQUEST', message: 'mode debe ser "read" o "write".' } });
  }

  // Obtener credenciales desencriptadas de la BD de registro
  let creds;
  try {
    creds = await connections.getCredentials(connection_id);
  } catch (err) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: err.message } });
  }

  // Ejecutar la query
  try {
    const result = await executeQuery({
      db_type:   creds.db_type,
      host:      creds.host,
      port:      creds.port,
      database:  String(database).trim(),
      username:  creds.username,
      password:  creds.password,
      mode,
      query:     String(query).trim(),
      params,
      timeout:   parseInt(timeout)   || 30000,
      fetchSize: parseInt(fetchSize) || 500,
    });

    const execTimeMs = Date.now() - startTime;

    writeTrace({
      requestId, timestamp: new Date().toISOString(), ip: clientIp,
      method: 'POST', path: '/api/query', execTimeMs, api: 'json',
      queryType: result.queryType, connection_id,
      dbHost: creds.host, database: String(database).trim(),
      success: true,
      rowCount: result.queryType === 'SELECT' ? result.rows.length : result.rowsAffected,
    });

    const response = {
      success:         true,
      queryType:       result.queryType,
      executionTimeMs: execTimeMs,
      timestamp:       new Date().toISOString(),
    };

    if (result.queryType === 'SELECT') {
      response.rowCount  = result.rows.length;
      response.rows      = result.rows;
      if (result.truncated) {
        response.truncated = true;
        response.fetchSize = result.fetchSize;
      }
    } else {
      response.rowsAffected = result.rowsAffected;
    }

    return res.json(response);

  } catch (err) {
    const execTimeMs = Date.now() - startTime;
    const code       = err.code       || 'INTERNAL_ERROR';
    const status     = err.httpStatus || 500;

    writeTrace({
      requestId, timestamp: new Date().toISOString(), ip: clientIp,
      method: 'POST', path: '/api/query', execTimeMs, api: 'json',
      connection_id, success: false, errorCode: code, errorMessage: err.message,
    });

    return res.status(status).json({
      success: false,
      error:   { code, message: err.message, timestamp: new Date().toISOString() },
    });
  }
});

// ============================================================
//  MIDDLEWARE GLOBAL DE ERRORES
//  Captura cualquier error no manejado: JSON inválido,
//  errores de middleware, rutas inexistentes, etc.
//  Siempre guarda la traza antes de responder.
// ============================================================

/**
 * Ruta no encontrada (404).
 */
app.use((req, res) => {
  const clientIp = getClientIp(req);
  writeTrace({
    requestId:    Date.now().toString(36).toUpperCase(),
    timestamp:    new Date().toISOString(),
    ip:           clientIp,
    method:       req.method,
    path:         req.path,
    execTimeMs:   0,
    api:          'json',
    success:      false,
    errorCode:    'NOT_FOUND',
    errorMessage: `Ruta no encontrada: ${req.method} ${req.path}`,
  });
  return res.status(404).json({
    success: false,
    error:   { code: 'NOT_FOUND', message: `Ruta no encontrada: ${req.method} ${req.path}` },
  });
});

/**
 * Manejador global de errores (4 parámetros — requerido por Express).
 * Captura errores lanzados por middlewares: JSON mal formado,
 * payload demasiado grande, errores inesperados, etc.
 */
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const clientIp = getClientIp(req);

  // Clasificar el tipo de error
  let code    = 'INTERNAL_ERROR';
  let status  = 500;
  let message = err.message || 'Error interno del servidor.';

  if (err.type === 'entity.parse.failed' || err.status === 400) {
    code    = 'INVALID_JSON';
    status  = 400;
    message = 'El body del request no es JSON válido. Verificá comillas dobles en strings y formato correcto.';
  } else if (err.status === 413) {
    code    = 'PAYLOAD_TOO_LARGE';
    status  = 413;
    message = 'El body del request supera el tamaño máximo permitido (1mb).';
  }

  writeTrace({
    requestId:    Date.now().toString(36).toUpperCase(),
    timestamp:    new Date().toISOString(),
    ip:           clientIp,
    method:       req.method,
    path:         req.path,
    execTimeMs:   0,
    api:          'json',
    success:      false,
    errorCode:    code,
    errorMessage: message,
  });

  return res.status(status).json({
    success: false,
    error:   { code, message, timestamp: new Date().toISOString() },
  });
});

// ============================================================
//  INICIO DEL SERVIDOR
// ============================================================

async function startServer() {
  try {
    await registryDb.init();
  } catch (err) {
    console.error('\n[Registry] ✗ No se pudo conectar al registro de BD:');
    console.error('           ', err.message);
    console.error('            Revisá las variables REGISTRY_DB_* en el archivo .env\n');
  }

  app.listen(PORT, () => {
    console.log('\n================================================');
    console.log('  Dynamic Query Executor API');
    console.log('================================================');
    console.log(`  POST  http://localhost:${PORT}/api/query`);
    console.log(`  POST  http://localhost:${PORT}/api/connections`);
    console.log('------------------------------------------------');
    console.log(`  API Key      : ${API_KEY}`);
    console.log(`  Bloqueados   : ${BLOCKED_COMMANDS.join(', ')}`);
    console.log('================================================\n');
  });
}

startServer();
