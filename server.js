const express = require('express');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme123';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const WEBHOOK_ENABLED = process.env.WEBHOOK_ENABLED === 'true';
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

// 初始化管理员密码
const passwordHash = db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_password') || null;
if (!passwordHash) {
  const salt = bcrypt.genSaltSync(10);
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('admin_password', bcrypt.hashSync(ADMIN_PASSWORD, salt));
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

  // 发送 Webhook 通知
  if (WEBHOOK_ENABLED && WEBHOOK_URL) {
    const title = contact
      ? `${name}（${contact}）`
      : name;
    try {
      await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, content })
      });
    } catch (e) {
      console.error('Webhook 发送失败:', e.message);
    }
  }

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

// ============ API：更新 Webhook 配置 ============
app.put('/api/settings', (req, res) => {
  const { webhookUrl, webhookEnabled, newPassword } = req.body;
  if (webhookUrl !== undefined) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('webhook_url', webhookUrl || '');
  }
  if (webhookEnabled !== undefined) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('webhook_enabled', webhookEnabled ? 'true' : 'false');
  }
  if (newPassword) {
    const salt = bcrypt.genSaltSync(10);
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('admin_password', bcrypt.hashSync(newPassword, salt));
  }
  res.json({ success: true });
});

// ============ API：读取当前配置 ============
app.get('/api/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  res.json({
    webhookUrl: settings.webhook_url || '',
    webhookEnabled: settings.webhook_enabled === 'true',
    hasPassword: !!settings.admin_password
  });
});

// ============ 启动 ============
app.listen(PORT, () => {
  console.log(`留言板服务已启动 → http://localhost:${PORT}/message`);
  console.log(`管理后台 → http://localhost:${PORT}/admin`);
});
