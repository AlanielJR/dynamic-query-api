# Dynamic Query Executor API

API REST/JSON centralizada para ejecutar queries SQL de forma segura sobre múltiples motores de base de datos. Permite registrar conexiones a servidores de BD con credenciales cifradas y ejecutar consultas dinámicas desde cualquier sistema consumidor.

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
- **Despliegue:** Docker / Docker Compose

---

## Estructura del Proyecto

```
/
├── server.js                  # Entrada principal — rutas HTTP y middleware
├── lib/
│   ├── registry-db.js         # Pool compartido de la BD de registro (init + helpers)
│   ├── connections.js         # Helpers de credenciales (getCredentials, decodeBase64, formatRow)
│   ├── traces.js              # Trazabilidad — escribe en archivo de log
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
└── README.md
```

---

## Endpoints

### Autenticación

Todos los endpoints requieren el header HTTP:
```
X-Api-Key: <valor de API_KEY en .env>
```

---

### Conexiones — `/api/connections`

| Método | Ruta               | Descripción                            |
|--------|--------------------|----------------------------------------|
| POST   | `/api/connections` | Cifrar credenciales (NO escribe en BD) |

#### POST `/api/connections` — Cifrado de credenciales

Recibe `host`, `password` y opcionalmente `username` en **Base64**, los cifra con AES-256-GCM y devuelve los valores cifrados también en **Base64**. **No escribe en la base de datos.** El caller es responsable de almacenar los valores devueltos directamente en `api_connections`.

**Body:**
```json
{
  "host":     "MTkyLjE2OC4xLjEwMA==",
  "password": "c2VjcmV0bw==",
  "username": "dXN1YXJpbw=="
}
```

Todos los campos deben enviarse en **Base64**. `username` es opcional.

**Respuesta exitosa:**
```json
{
  "success":      true,
  "host_enc":     "<Base64(AES-256-GCM)>",
  "password_enc": "<Base64(AES-256-GCM)>",
  "username_enc": "<Base64(AES-256-GCM)>"
}
```

> `username_enc` solo aparece si se envió `username` en el request.

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

| Campo           | Tipo    | Requerido | Descripción                                       |
|-----------------|---------|-----------|---------------------------------------------------|
| `connection_id` | string  | ✓         | ID de la conexión registrada en `api_connections` |
| `database`      | string  | ✓         | Nombre de la base de datos a consultar            |
| `query`         | string  | ✓         | SQL a ejecutar. Parámetros con `$1`, `$2`...      |
| `mode`          | string  |           | `"read"` (solo SELECT) · `"write"` (INSERT/UPDATE)|
| `params`        | array   |           | Valores para los parámetros posicionales          |
| `fetchSize`     | number  |           | Máx. filas a retornar (default: 500)              |
| `timeout`       | number  |           | Timeout en ms (default: 30000)                    |

- `mode: "read"` → solo permite SELECT
- `mode: "write"` → permite INSERT y UPDATE
- Parámetros posicionales: `$1`, `$2`, `$3`... (se adaptan internamente al driver)

**Respuesta SELECT:**
```json
{
  "success":          true,
  "queryType":        "SELECT",
  "rowCount":         1,
  "rows":             [ { "id": 42, "nombre": "..." } ],
  "executionTimeMs":  35,
  "timestamp":        "2026-05-01T12:00:00.000Z"
}
```

**Respuesta INSERT/UPDATE:**
```json
{
  "success":          true,
  "queryType":        "UPDATE",
  "rowsAffected":     1,
  "executionTimeMs":  12,
  "timestamp":        "2026-05-01T12:00:00.000Z"
}
```

---

## Trazabilidad

Cada request es registrado automáticamente en un archivo de log diario:

```
logs/traces-YYYY-MM-DD.log
```

- **Formato:** NDJSON (una línea JSON por traza)
- **Rotación:** diaria automática
- **IP:** enmascarada en Base64 (nunca se guarda en texto plano)
- **Campos registrados:** `requestId`, `timestamp`, `ip`, `hostname`, `method`, `path`, `execTimeMs`, `queryType`, `connection_id`, `database`, `success`, `rowCount`, `errorCode`, `errorMessage`

El directorio `logs/` se crea automáticamente al iniciar si no existe.

---

## Instalación

### Sin Docker

```bash
# 1. Copiar y completar variables de entorno
copy .env.example .env     # Windows
# cp .env.example .env    # Linux/Mac

# 2. Generar ENCRYPTION_KEY y pegarla en .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 3. Instalar dependencias
npm install

# 4. Iniciar
npm start
```

### Con Docker

```bash
# Construir y levantar el contenedor
docker-compose up -d --build

# Ver logs
docker-compose logs -f

# Detener
docker-compose down
```

---

## Variables de Entorno

Copiar `.env.example` a `.env` y completar los valores. Las variables obligatorias son:

| Variable               | Default            | Descripción                                            |
|------------------------|--------------------|--------------------------------------------------------|
| `PORT`                 | `3000`             | Puerto del servidor                                    |
| `API_KEY`              | `test-api-key-123` | Clave de autenticación para todos los endpoints        |
| `ENCRYPTION_KEY`       | —                  | Clave AES-256-GCM (64 caracteres hex) **OBLIGATORIA**  |
| `BLOCKED_SQL_COMMANDS` | `DROP,TRUNCATE,...`| Comandos SQL bloqueados (separados por coma)           |
| `REGISTRY_DB_TYPE`     | `mssql`            | Motor de la BD de registro: `mssql` · `postgresql`     |
| `REGISTRY_DB_HOST`     | —                  | IP o hostname del servidor de BD de registro           |
| `REGISTRY_DB_PORT`     | `1433`             | Puerto de la BD de registro                            |
| `REGISTRY_DB_NAME`     | —                  | Nombre de la base de datos de registro                 |
| `REGISTRY_DB_USER`     | —                  | Usuario de la BD de registro (solo lectura es válido)  |
| `REGISTRY_DB_PASSWORD` | —                  | Contraseña del usuario de BD de registro               |
| `TABLE_CONNECTIONS`    | `api_connections`  | Nombre de la tabla de conexiones                       |

---

## BD de Registro

Al iniciar, el servidor verifica y crea automáticamente la tabla si no existe:

- **`api_connections`** (o el nombre configurado en `TABLE_CONNECTIONS`) — almacena las conexiones con credenciales cifradas

> El usuario de BD de registro puede ser de **solo lectura**. El único endpoint de conexiones (`POST /api/connections`) no realiza escrituras en BD — solo cifra y devuelve los valores para que el caller los inserte directamente en la tabla.

**Esquema de `api_connections` (PostgreSQL):**
```sql
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

## Seguridad

- Todas las rutas requieren `X-Api-Key` en el header HTTP.
- Las credenciales de conexión se cifran con AES-256-GCM. Nunca se exponen en respuestas.
- Comandos SQL destructivos bloqueados por defecto (`DROP`, `TRUNCATE`, `ALTER`, `CREATE`, `GRANT`, `REVOKE`, `DELETE`), configurable por env.
- El modo `"read"` impide ejecución accidental de escrituras.
- Las IPs se enmascaran en Base64 en los logs — nunca se guardan en texto plano fuera de la BD.
- Las credenciales nunca se loguean — solo fluyen en memoria durante el ciclo de vida del request.
- El contenedor Docker corre con usuario no-root.

---

## Licencia

MIT
