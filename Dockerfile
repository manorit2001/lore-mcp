FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production \
    LORE_MCP_MAILDIR=/data/maildir

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

RUN mkdir -p /data/maildir/tmp /data/maildir/new /data/maildir/cur \
    && chown -R node:node /app /data/maildir

USER node

VOLUME ["/data/maildir"]

CMD ["node", "dist/index.js"]
