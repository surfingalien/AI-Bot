FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY server.js ./
COPY src ./src
COPY bin ./bin

# The CLI ships in the image so users can be managed inside the container:
#   docker compose exec proxy surfingalien user add ada --role admin
RUN ln -sf /app/bin/surfingalien.js /usr/local/bin/surfingalien \
 && chmod +x /app/bin/surfingalien.js \
 && mkdir -p /app/data/users && chown -R node:node /app

ENV NODE_ENV=production PORT=8787 DATA_DIR=/app/data SURFINGALIEN_ENV_FILE=/app/.env
EXPOSE 8787
VOLUME ["/app/data"]
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
