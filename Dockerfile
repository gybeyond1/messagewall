# 第一阶段：编译 better-sqlite3 原生模块
FROM node:22-alpine AS builder
WORKDIR /build
COPY package*.json ./
RUN apk add --no-cache python3 make g++ && \
    npm install --production && \
    find node_modules -name "better-sqlite3" -exec sh -c 'cd "{}" && npm run build-release 2>/dev/null || true' \; && \
    rm -rf /var/cache/apk/*

# 第二阶段：最小运行时（不使用 node 镜像，直接用 alpine + 静态二进制）
FROM alpine:3.23
WORKDIR /app
RUN apk add --no-cache nodejs npm python3 make g++ && \
    npm cache clean --force

COPY --from=builder /build/node_modules ./node_modules
COPY . .
RUN mkdir -p /app/data /app/uploads && \
    npm prune --production && \
    rm -rf /root/.npm /tmp/* /var/cache/apk/*

EXPOSE 3000
ENV NODE_ENV=production
CMD ["node", "server.js"]
