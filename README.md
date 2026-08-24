# 留言板 Messagewall

一个轻量级的扫码/NFC 留言板应用。访客敲门无人应答时，扫码进入网页填写留言，系统自动推送到配置的接收端。

## 功能特性

- **扫码留言**：访客通过手机扫码进入简洁美观的留言页面
- **管理后台**：`/admin` 路径，密码登录，查看/删除留言
- **多渠道通知**：
  - Webhook：支持自定义接收端（AI 服务、自有服务器等）
  - 企业微信：支持自建应用消息推送
- **图片上传**：留言时可附带图片（选填）
- **Docker 部署**：64MB 轻量镜像，一键启动

## 快速部署

```bash
# 1. 克隆项目
git clone https://github.com/gybeyond1/messagewall.git
cd messagewall

# 2. 创建 .env 文件（可选，默认值已够用）
echo 'PORT=3000' > .env

# 3. 启动服务
docker compose up -d

# 4. 访问
# 留言页面：http://你的IP:3000/message
# 管理后台：http://你的IP:3000/admin
# 默认密码：admin123（首次登录后请在设置中修改）
```

## 配置说明

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务端口 | `3000` |
| `DB_PATH` | 数据库路径 | `/app/data/messages.db` |

### 数据持久化

挂载 `./data` 目录到容器，留言数据和配置都会保存在宿主机：

```yaml
volumes:
  - ./data:/app/data
```

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

## Docker 镜像

镜像已发布到 Docker Hub：

```bash
docker pull gybeyond/messagewall:latest
```

镜像大小：**64MB**

GitHub Release 中也提供了镜像下载链接，方便网络受限的环境。

## 项目结构

```
messagewall/
├── server.js          # Node.js 服务入口
├── package.json       # 依赖配置
├── Dockerfile         # 多阶段构建，优化镜像大小
├── docker-compose.yml # Docker 部署配置
├── public/
│   ├── index.html     # 留言页面
│   └── admin.html     # 管理后台
└── data/              # 数据目录（需挂载）
```

## 技术栈

- **后端**：Node.js + Express
- **数据库**：SQLite（better-sqlite3）
- **前端**：原生 HTML/CSS/JS，无框架依赖
- **部署**：Docker + GitHub Actions CI/CD

## 注意事项

1. **首次启动密码**：默认 `admin123`，进入管理后台后请在设置中修改
2. **密码存储**：密码哈希存储在 SQLite 数据库中，重新部署不会被覆盖
3. **图片存储**：上传图片保存在 `./data/uploads/` 目录，随数据一起备份
4. **企业微信**：确保应用可见范围包含接收用户，否则消息可能发送失败

## 相关链接

- GitHub 仓库：https://github.com/gybeyond1/messagewall
- Docker Hub：https://hub.docker.com/r/gybeyond/messagewall
