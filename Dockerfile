# ===== 阶段1：编译精简 ffmpeg（仅 opus 解码 + AMR 编码，strip 后约 5MB） =====
# alpine 的 ffmpeg 因专利问题不含 AMR 编码器，debian apt 版 ffmpeg 重达 100MB+。
# 这里从源码编译，--disable-everything 后只启用留言板语音转码必需的组件。
# libopencore-amrnb 直接用 debian 包，避免 SourceForge 下载链接失效。
FROM node:22-bookworm-slim AS ffmpeg-build
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends \
    autoconf automake libtool pkg-config make gcc g++ yasm nasm curl ca-certificates xz-utils \
    libopencore-amrnb-dev \
    && rm -rf /var/lib/apt/lists/*

# 编译精简 ffmpeg：matroska/webm 解封装 → opus 解码 → aresample 重采样 → libopencore_amrnb 编码 → amr 封装
RUN curl -fsSL https://ffmpeg.org/releases/ffmpeg-7.1.tar.xz -o ffmpeg.tar.xz \
    && tar xJf ffmpeg.tar.xz \
    && cd ffmpeg-7.1 \
    && ./configure \
        --prefix=/opt/ffmpeg \
        --disable-everything \
        --enable-libopencore-amrnb \
        --enable-decoder=opus \
        --enable-encoder=libopencore_amrnb \
        --enable-muxer=amr \
        --enable-demuxer=matroska \
        --enable-demuxer=ogg \
        --enable-parser=opus \
        --enable-protocol=file \
        --enable-filter=aresample \
        --disable-doc \
        --disable-ffplay \
        --disable-ffprobe \
        --disable-network \
    && make -j"$(nproc)" && make install \
    && cd /build && rm -rf ffmpeg-7.1 ffmpeg.tar.xz \
    && strip /opt/ffmpeg/bin/ffmpeg

# ===== 阶段2：构建 Node 应用依赖（better-sqlite3 需原生编译） =====
FROM node:22-bookworm-slim AS builder
WORKDIR /build
COPY package*.json ./
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --production \
    && find node_modules -name "better-sqlite3" -exec sh -c 'cd "{}" && npm run build-release 2>/dev/null || true' \; \
    && npm cache clean --force && rm -rf /root/.npm /tmp/*

# ===== 阶段3：运行时（仅拷贝精简 ffmpeg 二进制 + node_modules + 源码） =====
FROM node:22-bookworm-slim
WORKDIR /app
# ffmpeg 动态链接 libopencore-amrnb，需装运行时库（仅几十KB）
RUN apt-get update && apt-get install -y --no-install-recommends libopencore-amrnb0 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ffmpeg-build /opt/ffmpeg/bin/ffmpeg /usr/local/bin/ffmpeg
COPY --from=builder /build/node_modules ./node_modules
COPY . .
RUN npm prune --production && npm cache clean --force && rm -rf /root/.npm /tmp/* \
    && mkdir -p /app/data /app/uploads
EXPOSE 3000
ENV NODE_ENV=production
CMD ["node", "server.js"]
