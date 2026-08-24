const express = require('express');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;
const DEFAULT_ADMIN_PASSWORD = 'admin123';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'messages.db');

// 确保数据目录存在
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

// 初始化数据库
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    contact TEXT DEFAULT '',
    image_path TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// 初始化管理员密码（首次启动且数据库无记录时写入默认密码）
const passwordHash = db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_password') || null;
if (!passwordHash) {
  const salt = bcrypt.genSaltSync(10);
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('admin_password', bcrypt.hashSync(DEFAULT_ADMIN_PASSWORD, salt));
}

// ============ 通知发送 ============
function getSetting(key) {
  return db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value;
}

async function sendWebhook(title, content) {
  const wUrl = getSetting('webhook_url') || '';
  const wEnabled = getSetting('webhook_enabled') === 'true';
  if (!wEnabled || !wUrl) return;
  try {
    await fetch(wUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: "messagewall",
        sourceName: "留言板",
        sourceDesc: "一个轻量级扫码/NFC触发留言板应用，用于访客敲门留言。",
        title,
        content
      })
    });
  } catch (e) {
    console.error('Webhook 发送失败:', e.message);
  }
}

async function sendWeChatWork(title, content) {
  const corpId = getSetting('wx_corpid') || '';
  const agentId = getSetting('wx_agentid') || '';
  const secret = getSetting('wx_secret') || '';
  const userIds = getSetting('wx_userid') || '';
  if (!corpId || !agentId || !secret || !userIds) return;

  // 获取 access_token
  let accessToken;
  try {
    const tokenResp = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpId}&corpsecret=${secret}`);
    const tokenData = await tokenResp.json();
    if (tokenData.errcode) {
      console.error('企业微信获取 token 失败:', tokenData.errmsg);
      return;
    }
    accessToken = tokenData.access_token;
  } catch (e) {
    console.error('企业微信获取 token 失败:', e.message);
    return;
  }

  // 发送消息
  try {
    await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${accessToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        touser: userIds,
        msgtype: 'text',
        text: {
          content: `[留言板]\n${title}\n\n${content}`
        }
      })
    });
  } catch (e) {
    console.error('企业微信发送失败:', e.message);
  }
}

// 中间件
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// 创建 uploads 目录
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// ============ 前端路由 ============
app.get('/message', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ============ API：提交留言 ============
app.post('/api/message', multer({ dest: 'uploads/' }).single('image'), async (req, res) => {
  const { name, content, contact } = req.body;
  if (!name || !content) {
    return res.status(400).json({ error: '姓名和留言内容不能为空' });
  }

  const imagePath = req.file ? path.basename(req.file.filename) : '';
  const stmt = db.prepare('INSERT INTO messages (name, content, contact, image_path) VALUES (?, ?, ?, ?)');
  const info = stmt.run(name, content, contact || '', imagePath);

  // 发送通知
  const title = contact ? `${name}（${contact}）` : name;
  await Promise.all([
    sendWebhook(title, content),
    sendWeChatWork(title, content)
  ]);

  res.json({ id: info.lastInsertRowid, success: true });
});

// ============ API：管理员认证 ============
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  const stored = db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_password');
  if (stored && bcrypt.compareSync(password, stored.value)) {
    res.json({ success: true });
  } else {
    res.status(401).json({ error: '密码错误' });
  }
});

// ============ API：获取所有留言 ============
app.get('/api/messages', (req, res) => {
  const msgs = db.prepare('SELECT * FROM messages ORDER BY created_at DESC').all();
  res.json(msgs);
});

// ============ API：删除单条留言 ============
app.delete('/api/message/:id', (req, res) => {
  const { id } = req.params;
  const msg = db.prepare('SELECT image_path FROM messages WHERE id = ?').get(id);
  if (msg?.image_path) {
    const imgPath = path.join(__dirname, 'uploads', msg.image_path);
    if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
  }
  db.prepare('DELETE FROM messages WHERE id = ?').run(id);
  res.json({ success: true });
});

// ============ API：清空所有留言 ============
app.delete('/api/messages', (req, res) => {
  const msgs = db.prepare('SELECT image_path FROM messages').all();
  msgs.forEach(m => {
    if (m?.image_path) {
      const imgPath = path.join(__dirname, 'uploads', m.image_path);
      if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
    }
  });
  db.prepare('DELETE FROM messages').run();
  res.json({ success: true });
});

// ============ API：更新配置 ============
app.put('/api/settings', (req, res) => {
  const { webhookUrl, webhookEnabled, newPassword, wxCorpid, wxAgentid, wxSecret, wxUserid } = req.body;
  const save = (key, value) => {
    if (value !== undefined) {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value || '');
    }
  };
  save('webhook_url', webhookUrl);
  save('webhook_enabled', webhookEnabled);
  save('wx_corpid', wxCorpid);
  save('wx_agentid', wxAgentid);
  save('wx_secret', wxSecret);
  save('wx_userid', wxUserid);
  if (newPassword) {
    const salt = bcrypt.genSaltSync(10);
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('admin_password', bcrypt.hashSync(newPassword, salt));
  }
  res.json({ success: true });
});

// ============ API：读取配置 ============
app.get('/api/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  res.json({
    webhookUrl: settings.webhook_url || '',
    webhookEnabled: settings.webhook_enabled === 'true',
    wxCorpid: settings.wx_corpid || '',
    wxAgentid: settings.wx_agentid || '',
    wxSecret: settings.wx_secret || '',
    wxUserid: settings.wx_userid || '',
    hasPassword: !!settings.admin_password
  });
});

// ============ API：测试 Webhook ============
app.post('/api/webhook/test', async (req, res) => {
  const { url, title, content } = req.body;
  if (!url) return res.status(400).json({ error: 'URL 不能为空' });
  try {
    const start = Date.now();
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: "messagewall",
        sourceName: "留言板",
        sourceDesc: "一个轻量级扫码/NFC触发留言板应用，用于访客敲门留言。",
        title,
        content
      })
    });
    const elapsed = Date.now() - start;
    res.json({ success: resp.ok, status: resp.status, elapsed });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============ API：测试企业微信 ============
app.post('/api/wx/test', async (req, res) => {
  const { corpId, agentId, secret, userId } = req.body;
  if (!corpId || !secret || !userId) {
    return res.status(400).json({ error: '请填写完整的企业微信配置' });
  }
  try {
    const start = Date.now();
    const tokenResp = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpId}&corpsecret=${secret}`);
    const tokenData = await tokenResp.json();
    if (tokenData.errcode) {
      return res.status(400).json({ success: false, error: tokenData.errmsg });
    }
    const msgResp = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${tokenData.access_token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        touser: userId,
        msgtype: 'text',
        text: { content: '[留言板测试] 这是一条测试消息，如果你收到了说明配置正确。' }
      })
    });
    const msgData = await msgResp.json();
    const elapsed = Date.now() - start;
    if (msgData.errcode) {
      res.json({ success: false, error: msgData.errmsg, elapsed });
    } else {
      res.json({ success: true, elapsed });
    }
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============ 启动 ============
app.listen(PORT, () => {
  console.log(`留言板服务已启动 → http://localhost:${PORT}/message`);
  console.log(`管理后台 → http://localhost:${PORT}/admin`);
});
