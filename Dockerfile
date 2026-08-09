FROM node:20-alpine

WORKDIR /app

# Dependencies first so a source-only change reuses the cached layer.
COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY scripts ./scripts

# State lives on a mounted volume; the image itself stays disposable.
RUN mkdir -p /data
ENV NODE_ENV=production \
    STATE_FILE=/data/state.json \
    PREDICTIONS_FILE=/data/predictions.jsonl
VOLUME ["/data"]

# The host injects PORT at runtime — nothing is hardcoded here.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
