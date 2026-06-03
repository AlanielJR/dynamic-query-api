# CLAUDE.md — Dynamic Query Executor API

## Visión General

API REST/JSON que recibe una `connection_id` (referencia a una conexión registrada) y una query SQL, la ejecuta contra el motor de base de datos correspondiente y devuelve el resultado en JSON.

Las credenciales de conexión se almacenan cifradas con AES-256-GCM en una base de datos de registro dedicada. El API nunca expone credenciales en sus respuestas.

---

## Stack

- **Runtime:** Node.js 20+
- **Framework:** Express.js
- **Cifrado:** AES-256-GCM (módulo nativo `crypto` de Node)
- **Drivers de BD:**
  - `mssql` — SQL Server
  - `pg` — PostgreSQL
  - `mysql2` — MySQL / MariaDB
- **BD de registro:** SQL Server o PostgreSQL (configurable por env)

---

## Estructura del Proyecto

```
/
├── server.js                  # Entrada principal — rutas HTTP y middleware
├── lib/
│   ├── registry-db.js         # Pool compartido de la BD de registro (init + helpers)
│   ├── connections.js         # Helpers de credenciales (getCredentials, decodeBase64, formatRow)
│   ├── traces.js              # Trazabilidad — escribe en archivo de log (fire-and-forget)
│   ├── logger.js              # Escritura NDJSON en logs/traces-YYYY-MM-DD.log
│   ├── query-executor.js      # Ejecutor multi-motor (MSSQL, PostgreSQL, MySQL)
│   └── crypto.js              # encrypt / decrypt AES-256-GCM
├── logs/                      # Archivos de traza diarios (auto-generado)
│   └── traces-YYYY-MM-DD.log
├── Documentacion/
│   └── DynamicQuery_API.postman_collection.json
├── .env.example
├── package.json
├── Dockerfile
├── docker-compose.yml
└── CLAUDE.md
```

---

## Endpoints

### Autenticación

Todos los endpoints requieren el header HTTP:
```
X-Api-Key: <valor de API_KEY en .env>
```

### Conexiones — `/api/connections`

| Método | Ruta               | Descripción                            |
|--------|--------------------|----------------------------------------|
| POST   | `/api/connections` | Cifrar credenciales (NO escribe en BD) |

**Body para POST — endpoint de cifrado:**
```json
{
  "host":     "<IP o hostname en Base64>",
  "password": "<contraseña en Base64>",
  "username": "<usuario en Base64 — opcional>"
}
```

- Todos los campos deben enviarse codificados en **Base64** (transporte, no cifrado)
- El endpoint **no escribe en la base de datos** — devuelve los valores cifrados con AES-256-GCM
- El caller es responsable de insertar los valores cifrados en `api_connections`

**Respuesta:**
```json
{
  "success":      true,
  "host_enc":     "<Base64(AES-256-GCM)>",
  "password_enc": "<Base64(AES-256-GCM)>",
  "username_enc": "<Base64(AES-256-GCM)>"
}
```

Los valores devueltos son el resultado AES-256-GCM **codificado en Base64**. El caller los almacena directamente en `api_connections` (`host_enc`, `password_enc`, `username_enc`).

---

### Ejecución de Queries — `/api/query`

| Método | Ruta         | Descripción               |
|--------|--------------|---------------------------|
| POST   | `/api/query` | Ejecutar una query SQL    |

**Body:**
```json
{
  "connection_id": "mi_servidor",
  "database":      "MiBaseDatos",
  "mode":          "read",
  "query":         "SELECT * FROM usuarios WHERE id = $1",
  "params":        [42],
  "fetchSize":     500,
  "timeout":       30000
}
```

- `mode: "read"` → solo permite SELECT
- `mode: "write"` → permite INSERT y UPDATE
- Parámetros posicionales: `$1`, `$2`, `$3`... (se adaptan internamente al driver)

**Respuesta SELECT:**
```json
{
  "success": true,
  "queryType": "SELECT",
  "rowCount": 1,
  "rows": [ { "id": 42, "nombre": "..." } ],
  "executionTimeMs": 35
}
```

**Respuesta INSERT/UPDATE:**
```json
{
  "success": true,
  "queryType": "UPDATE",
  "rowsAffected": 1,
  "executionTimeMs": 12
}
```

---

## Trazabilidad

Cada request se registra automáticamente en un archivo de log diario. **No hay escritura en BD.**

- **Ruta:** `logs/traces-YYYY-MM-DD.log`
- **Formato:** NDJSON (una línea JSON por traza)
- **Rotación:** diaria automática
- **IP:** enmascarada en Base64 antes de escribir (`traces.js → maskIp()`)
- El directorio `logs/` se crea automáticamente si no existe

> No existen endpoints HTTP para consultar o limpiar trazas — el acceso a los logs es directo al sistema de archivos.

---

## Variables de Entorno (`.env`)

```env
# Servidor
PORT=3000
NODE_ENV=development

# Seguridad
API_KEY=test-api-key-123

# Clave AES-256-GCM para cifrar credenciales (OBLIGATORIA)
# Generar con: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
ENCRYPTION_KEY=<64 chars hex>

# Comandos SQL bloqueados
BLOCKED_SQL_COMMANDS=DROP,TRUNCATE,ALTER,CREATE,GRANT,REVOKE,DELETE

# Timeouts
CONNECTION_TIMEOUT=10000
QUERY_TIMEOUT=30000

# BD de registro (donde se guarda api_connections)
REGISTRY_DB_TYPE=mssql
REGISTRY_DB_HOST=localhost
REGISTRY_DB_PORT=1433
REGISTRY_DB_NAME=DynamicQueryRegistry
REGISTRY_DB_USER=usuario
REGISTRY_DB_PASSWORD=password

# Nombre de la tabla de conexiones (configurable)
TABLE_CONNECTIONS=api_connections
```

---

## BD de Registro

Al iniciar, el servidor crea automáticamente la tabla si no existe:

- **`api_connections`** (nombre configurable via `TABLE_CONNECTIONS`) — almacena las conexiones registradas con credenciales cifradas

> **No existe tabla `api_traces`** — las trazas van exclusivamente al archivo de log.

**Esquema de `api_connections`:**
```sql
-- PostgreSQL
CREATE TABLE IF NOT EXISTS api_connections (
  connection_id VARCHAR(100) NOT NULL PRIMARY KEY,
  label         VARCHAR(200),
  db_type       VARCHAR(20)  NOT NULL,
  host          VARCHAR(255) NOT NULL,
  port          INTEGER      NOT NULL,
  username_enc  TEXT         NOT NULL,
  password_enc  TEXT         NOT NULL,
  created_at    VARCHAR(30)  NOT NULL,
  updated_at    VARCHAR(30)  NOT NULL
);
```

---

## Cómo Levantar

```bash
# 1. Copiar y completar variables de entorno
copy .env.example .env

# 2. Generar ENCRYPTION_KEY y pegarla en .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 3. Instalar dependencias
npm install

# 4. Iniciar
npm start
```

---

## Seguridad

- Todas las rutas requieren `X-Api-Key` en el header HTTP.
- Las credenciales de conexión se cifran con AES-256-GCM antes de guardarse. Nunca se exponen en respuestas.
- Comandos SQL destructivos bloqueados por defecto (`DROP`, `TRUNCATE`, `ALTER`, etc.), configurable por env.
- El modo `"read"` impide ejecución accidental de escrituras.
- Las IPs se enmascaran en Base64 en los logs — nunca en texto plano fuera de la BD.
- Las credenciales nunca se loguean — solo fluyen en memoria durante el ciclo de vida del request.

---

## Instrucciones para IA

Al trabajar en este repositorio:

1. Leer este `CLAUDE.md` completo antes de modificar código.
2. Verificar `package.json` antes de agregar dependencias.
3. El driver prioritario es `mssql` (SQL Server).
4. Toda lógica de ejecución de queries va en `lib/query-executor.js`.
5. Las credenciales nunca deben aparecer en logs ni en respuestas HTTP.
6. Cada función debe tener `try/catch` y propagar errores con `code` y `httpStatus`.
7. POST `/api/connections` es un endpoint de **solo cifrado** — no escribe en BD.
8. Las trazas van **solo al archivo de log** (`lib/logger.js`) — no hay tabla `api_traces` en BD.
9. El nombre de la tabla de conexiones se toma de `TABLE_CONNECTIONS` (env) via `tableConnections()` en `registry-db.js` — nunca hardcodear el nombre.
10. `lib/connections.js` exporta `decodeBase64` para uso en `server.js` (POST /api/connections).
