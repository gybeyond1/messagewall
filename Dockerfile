FROM node:22-slim

WORKDIR /app

# 安装编译 better-sqlite3 所需的依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --production

COPY . .

# 创建数据目录并设置权限
RUN mkdir -p /app/data && chmod 777 /app/data

EXPOSE 3000

ENV NODE_ENV=production

CMD ["node", "server.js"]
