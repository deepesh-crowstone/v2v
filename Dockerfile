# Build Vite, then serve `dist/` with a small Node server that proxies the
# Vertex AI Live API to the browser over a WebSocket.

FROM node:20-alpine AS frontend
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html ./
COPY src ./src
RUN npm run build \
    && test -f dist/index.html \
    && test "$(find dist/assets -name '*.js' | wc -l)" -ge 1

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# The server needs @google/genai + ws at runtime, so install production deps.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js .
COPY --from=frontend /src/dist ./dist

HEALTHCHECK --interval=30s --timeout=10s --start-period=45s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["node", "server.js"]
