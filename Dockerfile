# =============================================================
#  Dynamic Query Executor API — Dockerfile
#  Multi-stage build: build limpio e imagen final minimalista
# =============================================================

# ── Stage 1: Instalar dependencias ────────────────────────────
FROM node:20-alpine AS dependencies

WORKDIR /app

# Copiar solo package.json primero para aprovechar cache de capas.
# Si package.json no cambia, esta capa se reutiliza en builds futuros.
COPY package*.json ./

# Instalar únicamente dependencias de producción (sin devDependencies)
RUN npm install --omit=dev

# ── Stage 2: Imagen final ──────────────────────────────────────
FROM node:20-alpine AS production

LABEL maintainer="desarrollo@tuempresa.com"
LABEL description="Dynamic Query Executor API — REST/JSON multi-motor"
LABEL version="1.0.0"

WORKDIR /app

# Crear usuario no-root para mayor seguridad
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copiar dependencias del stage anterior
COPY --from=dependencies /app/node_modules ./node_modules

# Copiar código fuente
COPY server.js ./
COPY lib/      ./lib/

# Asignar permisos al usuario no-root
RUN chown -R appuser:appgroup /app

USER appuser

# Puerto del servicio (debe coincidir con PORT en .env o docker-compose)
EXPOSE 3000

# Health check — verifica que el servidor HTTP responda
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/connections \
    --header "X-Api-Key: ${API_KEY:-test-api-key-123}" | grep -q "success" || exit 1

CMD ["node", "server.js"]
