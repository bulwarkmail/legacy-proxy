FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++ sqlite-dev
COPY package.json package-lock.json* tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080
RUN apk add --no-cache sqlite-libs tini \
 && addgroup -S proxy \
 && adduser -S proxy -G proxy \
 && mkdir -p /data \
 && chown -R proxy:proxy /data
COPY package.json package-lock.json* ./
RUN apk add --no-cache --virtual .build python3 make g++ sqlite-dev \
 && npm install --omit=dev --no-audit --no-fund \
 && apk del .build \
 && npm cache clean --force
COPY --from=build /app/dist ./dist
USER proxy
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
