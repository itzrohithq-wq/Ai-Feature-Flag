FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
COPY scripts/cluster.mjs scripts/backup.mjs scripts/recovery.mjs ./scripts/
RUN mkdir /app/data && chown -R node:node /app
USER node
ENV PORT=4315 BIND_HOST=0.0.0.0 FLAG_DB_PATH=/app/data/flags.sqlite
EXPOSE 4315
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:4315/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","src/server.js"]
