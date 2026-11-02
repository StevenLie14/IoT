# AquaGuard server + dashboard
FROM node:22-alpine

WORKDIR /app

COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server/ ./

ENV NODE_ENV=production \
    PORT=7575 \
    DB_FILE=/app/data/aquaguard.db

# SQLite file lives in a volume mounted at /app/data
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

EXPOSE 7575
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1

CMD ["node", "server.js"]
