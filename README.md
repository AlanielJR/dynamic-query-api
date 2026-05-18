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
│   ├── connections.js         # CRUD sobre api_connections (upsert, list, remove...)
│   ├── traces.js              # Trazabilidad sobre api_traces (insert, query, clear)
│   ├── query-executor.js      # Ejecutor multi-motor (MSSQL, PostgreSQL, MySQL)
│   └── crypto.js              # encrypt / decrypt AES-256-GCM
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

### Conexiones — `/api/connections`

| Método | Ruta                      | Descripción                              |
|--------|---------------------------|------------------------------------------|
| POST   | `/api/connections`        | Registrar o actualizar una conexión      |
| GET    | `/api/connections`        | Listar todas las conexiones              |
| GET    | `/api/connections/:id`    | Detalle de una conexión                  |
| DELETE | `/api/connections/:id`    | Eliminar una conexión                    |

**Body para POST:**
```json
{
  "connection_id": "mi_servidor",
  "label":         "Descripción legible",
  "db_type":       "mssql",
  "host":          "192.168.1.100",
  "port":          1433,
  "username":      "usuario",
  "password":      "secreto"
}
```
`db_type` válidos: `mssql` | `postgresql` | `mysql`

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

### Trazabilidad — `/trace`

| Método | Ruta     | Descripción                                         |
|--------|----------|-----------------------------------------------------|
| GET    | `/trace` | Consultar trazas con filtros opcionales             |
| DELETE | `/trace` | Limpiar todas las trazas                            |

**Filtros disponibles (query string):**

| Parámetro       | Ejemplo              |
|-----------------|----------------------|
| `ip`            | `?ip=192.168.1.5`    |
| `success`       | `?success=false`     |
| `queryType`     | `?queryType=SELECT`  |
| `connection_id` | `?connection_id=x`   |
| `from`          | `?from=2026-05-01`   |
| `to`            | `?to=2026-05-15`     |
| `limit`         | `?limit=200`         |

---

## Instalación

### Sin Docker

```bash
# 1. Copiar y completar variables de entorno
cp .env.example .env

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

| Variable              | Descripción                                              |
|-----------------------|----------------------------------------------------------|
| `API_KEY`             | Clave de autenticación para todos los endpoints          |
| `ENCRYPTION_KEY`      | Clave AES-256-GCM (64 caracteres hex)                    |
| `REGISTRY_DB_TYPE`    | Motor de la BD de registro: `mssql` · `postgresql`       |
| `REGISTRY_DB_HOST`    | IP o hostname del servidor de BD de registro             |
| `REGISTRY_DB_NAME`    | Nombre de la base de datos de registro                   |
| `REGISTRY_DB_USER`    | Usuario de la BD de registro                             |
| `REGISTRY_DB_PASSWORD`| Contraseña del usuario de BD de registro                 |

---

## BD de Registro

Al iniciar, el servidor crea automáticamente las tablas si no existen:

- **`api_connections`** — almacena las conexiones registradas con credenciales cifradas
- **`api_traces`** — almacena una traza por cada request recibido

La BD de registro puede ser SQL Server o PostgreSQL, se configura con `REGISTRY_DB_TYPE`.

---

## Seguridad

- Todas las rutas requieren `X-Api-Key` en el header HTTP.
- Las credenciales de conexión se cifran con AES-256-GCM antes de guardarse. Nunca se exponen en respuestas.
- Comandos SQL destructivos bloqueados por defecto (`DROP`, `TRUNCATE`, `ALTER`, etc.), configurable por env.
- El modo `"read"` impide ejecución accidental de escrituras.
- Las credenciales nunca se loguean — solo fluyen en memoria durante el ciclo de vida del request.
- El contenedor Docker corre con usuario no-root.

---

## Licencia

MIT
