FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY flows.json flows_cred.json settings.prod.js ./
COPY static ./static
RUN mkdir -p /app/data && chown -R node:node /app/data /app/flows.json /app/flows_cred.json
USER node
ENV PORT=1880
EXPOSE 1880
CMD ["node", "node_modules/node-red/red.js", "--settings", "/app/settings.prod.js"]
