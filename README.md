# 留言板 MessageWall

一个轻量级的扫码留言板应用。访客敲门无人应答时，扫码进入网页填写文字 / 图片 / 语音留言，系统自动推送到配置的接收端（Webhook / 企业微信 / EchoLink）。支持多用户，每个用户独立留言板页面和通知配置。

## 功能特性

- **扫码留言**：访客手机扫码进入简洁的留言页面，支持文字、图片、语音
- **长按录音**：微信式语音交互，长按说话、上滑取消，语音气泡带时长和播放动画
- **图片/视频预览**：留言支持图片和视频，点开全屏查看、左右滑动切换
- **多用户体系**：管理员可添加多个留言板用户，每个用户独立页面 `/:username`、独立通知配置
- **EchoLink 联动**：配合 [EchoLink](https://github.com/gybeyond1/echolink) 使用，留言直接推送到对应账号的手机/平板/电脑
- **多渠道通知**：
  - Webhook：自定义接收地址，POST JSON 推送
  - 企业微信：自建应用消息推送，支持文字和图文
- **管理后台**：`/admin` 路径，密码登录，查看/删除留言，管理用户，配置通知
- **轻量镜像**：基于 Alpine，镜像体积小

## 一键部署

创建 `docker-compose.yml`：

```yaml
services:
  messagewall:
    image: gybeyond/messagewall:latest
    container_name: messagewall
    restart: unless-stopped
    ports:
      - "13000:3000"
    environment:
      - DB_PATH=/app/data/messages.db
    volumes:
      - ./data:/app/data
      - ./pic:/app/uploads
```

启动：

```bash
docker compose up -d
```

访问：
- 默认留言板：`http://你的IP:13000/message`（对应默认用户）
- 用户留言板：`http://你的IP:13000/用户名`
- 管理后台：`http://你的IP:13000/admin`
- 默认管理员密码：`admin123`（首次登录后请立即修改）

数据持久化：
- `./data`：SQLite 数据库
- `./pic`：用户上传的图片和语音文件

如需公网访问，用 Nginx / Caddy 反代到 `13000` 端口并配置 HTTPS。家用宽带无 80/443 端口时用其他端口即可。

## 多用户说明

系统支持多个留言板用户，适合家庭多成员或多场景使用：

1. 管理员登录后台 → 「留言板用户」→ 添加用户
2. 每个用户填写：用户名（URL 路径）、显示名、首页提示语、Webhook 地址、企业微信配置
3. 访客访问 `http://留言板地址/用户名` 进入该用户的专属留言板
4. 原始地址 `/message` 保留，对应默认用户
5. 每个用户的留言和通知完全独立

### 默认用户

系统启动时自动创建默认用户（用户名 `gybeyond`，可在后台修改显示名和配置）。旧版全局配置会自动迁移到默认用户，升级不丢数据。

## 通知配置

每个留言板用户独立配置通知，在后台 → 留言板用户 → 编辑用户中设置。

### Webhook

- 填写接收地址（如 EchoLink 的 `http://echolink地址/api/webhook/messagewall/用户名`）
- 勾选「启用 Webhook 通知」
- 留言提交后 POST JSON 到该地址

**推送格式：**
```json
{
  "title": "张三（13800138000）",
  "content": "你好，我在门外按门铃但没人应...",
  "image": "data:image/jpeg;base64,...",
  "voice": "data:audio/webm;base64,..."
}
```

### 企业微信

- **CorpID**：企业微信管理端 → 我的企业
- **AgentId**：应用管理 → 创建或选择自建应用
- **Secret**：应用的 Secret
- **UserIds**：接收消息的员工 UserID，多人逗号分隔
- **图片公网地址**：带图留言走图文推送，需填写公网可访问的留言板地址（企业微信服务器会来拉图片）

### EchoLink 联动（推荐）

1. 在后台 → 系统设置 → EchoLink 联动 → 填写 EchoLink 内网地址（如 `http://192.168.1.100:4000`）
2. EchoLink 注册新用户时会自动在此创建对应留言板用户，Webhook 地址自动拼接
3. 访客留言直接推送到 EchoLink 对应用户的所有设备

## 项目结构

```
messagewall/
├── server.js          # 后端服务
├── public/
│   ├── index.html     # 留言板前端
│   └── admin.html     # 管理后台
└── Dockerfile         # Docker 构建
```

## 技术栈

- **后端**：Node.js + Express + better-sqlite3
- **前端**：原生 HTML/CSS/JS，无框架依赖
- **部署**：Docker 多阶段构建，Alpine 基础镜像

## 相关链接

- GitHub：https://github.com/gybeyond1/messagewall
- Docker Hub：https://hub.docker.com/r/gybeyond/messagewall
- EchoLink：https://github.com/gybeyond1/echolink

## License

MIT
