FROM node:22-bookworm-slim AS build

WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/ ./
RUN npm run prisma:generate \
    && npm run build \
    && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PYTHONUNBUFFERED=1 \
    PYTHON_BIN=/opt/worker-venv/bin/python \
    WORKER_DIR=/app/worker

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
      python3 \
      python3-venv \
      poppler-utils \
      tesseract-ocr \
      tesseract-ocr-eng \
      tesseract-ocr-ron \
    && rm -rf /var/lib/apt/lists/*

COPY worker/requirements.txt /tmp/worker-requirements.txt
RUN python3 -m venv /opt/worker-venv \
    && /opt/worker-venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/worker-venv/bin/pip install --no-cache-dir -r /tmp/worker-requirements.txt \
    && rm /tmp/worker-requirements.txt

WORKDIR /app/backend
COPY --from=build --chown=node:node /app/backend/dist ./dist
COPY --from=build --chown=node:node /app/backend/node_modules ./node_modules
COPY --from=build --chown=node:node /app/backend/package.json ./package.json
COPY --from=build --chown=node:node /app/backend/prisma ./prisma
COPY --chown=node:node worker /app/worker

USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
