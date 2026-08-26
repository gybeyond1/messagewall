# Build stage
FROM node:22-bookworm-slim AS builder
WORKDIR /build
COPY package*.json ./
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && \
    npm install --production && \
    find node_modules -name "better-sqlite3" -exec sh -c 'cd "{}" && npm run build-release 2>/dev/null || true' \; && \
    npm cache clean --force && rm -rf /root/.npm /tmp/* && \
    apt-get purge -y python3 make g++ && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# Runtime stage
# 用 Debian slim 而非 alpine：alpine 的 ffmpeg 因专利问题不含 AMR 编码器，
# 企业微信 voice 通道要求 AMR 格式，必须用带 libopencore-amrnb 的 ffmpeg。
FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*
COPY --from=builder /build/node_modules ./node_modules
COPY . .
RUN npm prune --production && npm cache clean --force && rm -rf /root/.npm /tmp/*
RUN mkdir -p /app/data /app/uploads
EXPOSE 3000
ENV NODE_ENV=production
CMD ["node", "server.js"]
