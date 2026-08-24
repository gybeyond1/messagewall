# 第一阶段：编译 better-sqlite3 原生模块
FROM node:22-alpine AS builder
WORKDIR /build
COPY package*.json ./
RUN apk add --no-cache python3 make g++ && \
    npm install --production && \
    find node_modules -name "better-sqlite3" -exec sh -c 'cd "{}" && npm run build-release 2>/dev/null || true' \;

# 第二阶段：最小运行时
FROM node:22-alpine
WORKDIR /app
COPY --from=builder /build/node_modules ./node_modules
COPY . .
RUN mkdir -p /app/data /app/uploads
EXPOSE 3000
ENV NODE_ENV=production
CMD ["node", "server.js"]
