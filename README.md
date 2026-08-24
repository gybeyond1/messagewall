# 留言板 Messagewall

一个轻量级的扫码/NFC 留言板应用。访客敲门无人应答时，扫码进入网页填写留言，系统自动推送到配置的接收端。

## 功能特性

- **扫码留言**：访客通过手机扫码进入简洁美观的留言页面
- **管理后台**：`/admin` 路径，密码登录，查看/删除留言
- **多渠道通知**：
  - Webhook：支持自定义接收端（AI 服务、自有服务器等）
  - 企业微信：支持自建应用消息推送
- **图片上传**：留言时可附带图片（选填）
- **轻量镜像**：64MB，基于 Alpine Linux

## 一键部署

```bash
# 创建项目目录并启动
mkdir -p messagewall && cd messagewall
cat > docker-compose.yml << 'EOF'
version: '3.8'
services:
  messagewall:
    image: gybeyond/messagewall:latest
    container_name: messagewall
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - DB_PATH=/app/data/messages.db
    volumes:
      - ./data:/app/data
EOF
docker compose up -d
```

访问：
- 留言页面：`http://你的IP:3000/message`
- 管理后台：`http://你的IP:3000/admin`
- 默认密码：`admin123`（首次登录后请在设置中修改）

## 通知配置

### Webhook

在管理后台 → 系统设置 → Webhook 通知：
- 填写接收地址（如 `https://你的AI服务/webhook`）
- 点击「🧪 测试」验证连接
- 勾选「启用 Webhook 通知」

**推送格式：**
```json
{
  "source": "messagewall",
  "sourceName": "留言板",
  "sourceDesc": "一个轻量级扫码/NFC触发留言板应用...",
  "title": "张三（13800138000）",
  "content": "你好，我在门外按门铃但没人应..."
}
```

### 企业微信

在管理后台 → 系统设置 → 企业微信通知：
- **CorpID**：企业微信管理端 → 我的企业
- **AgentId**：应用管理 → 创建或选择应用
- **Secret**：应用管理 → 应用的密钥
- **UserIds**：通讯录 → 点击员工 → URL 中 `userid=` 后的值

点击「🧪 测试发送」验证配置。

## 项目结构

```
messagewall/
├── docker-compose.yml  # Docker 部署配置（只需这一个文件）
├── data/               # 数据目录（自动创建，包含数据库和图片）
```

## 技术栈

- **后端**：Node.js + Express
- **数据库**：SQLite（better-sqlite3）
- **前端**：原生 HTML/CSS/JS，无框架依赖
- **部署**：Docker，多阶段构建优化镜像大小

## 相关链接

- GitHub：https://github.com/gybeyond1/messagewall
- Docker Hub：https://hub.docker.com/r/gybeyond/messagewall
