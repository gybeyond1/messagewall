const express = require('express');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const Database = require('better-sqlite3');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;
const DEFAULT_ADMIN_PASSWORD = 'admin123';
const DEFAULT_WALL_USER = 'gybeyond';
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
    voice_path TEXT DEFAULT '',
    wall_username TEXT DEFAULT 'gybeyond',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS wall_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    display_name TEXT DEFAULT '',
    webhook_url TEXT DEFAULT '',
    webhook_enabled TEXT DEFAULT 'false',
    wx_corpid TEXT DEFAULT '',
    wx_agentid TEXT DEFAULT '',
    wx_secret TEXT DEFAULT '',
    wx_userid TEXT DEFAULT '',
    wx_message_format TEXT DEFAULT '',
    wx_pic_base TEXT DEFAULT '',
    frontend_tip TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
// 兼容旧库：补列
try { db.exec(`ALTER TABLE messages ADD COLUMN voice_path TEXT DEFAULT ''`); } catch (_) {}
try { db.exec(`ALTER TABLE messages ADD COLUMN wall_username TEXT DEFAULT 'gybeyond'`); } catch (_) {}

// 初始化管理员密码
const passwordHash = db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_password') || null;
if (!passwordHash) {
  const salt = bcrypt.genSaltSync(10);
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('admin_password', bcrypt.hashSync(DEFAULT_ADMIN_PASSWORD, salt));
}

// 迁移：把旧的全局 settings 配置迁移到默认用户 gybeyond
function migrateDefaultUser() {
  const existing = db.prepare('SELECT id FROM wall_users WHERE username = ?').get(DEFAULT_WALL_USER);
  if (existing) return;
  const get = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value || '';
  db.prepare(`INSERT INTO wall_users (username, display_name, webhook_url, webhook_enabled, wx_corpid, wx_agentid, wx_secret, wx_userid, wx_message_format, wx_pic_base, frontend_tip)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    DEFAULT_WALL_USER, '默认留言板',
    get('webhook_url'), get('webhook_enabled') || 'false',
    get('wx_corpid'), get('wx_agentid'), get('wx_secret'), get('wx_userid'),
    get('wx_message_format') || '[留言板]\n{title}\n\n{content}',
    get('wx_pic_base'), get('frontend_tip') || '写下你想说的话，我会转达给主人'
  );
  console.log(`[migrate] 已创建默认留言板用户: ${DEFAULT_WALL_USER}`);
}
migrateDefaultUser();

// 获取留言板用户配置
function getWallUser(username) {
  return db.prepare('SELECT * FROM wall_users WHERE username = ?').get(username) || null;
}

// ============ 通知发送（按用户配置） ============
function buildWebhookBody(title, content, imageDataUri, voiceDataUri) {
  const body = { source: "messagewall", title, content };
  if (imageDataUri) body.image = imageDataUri;
  if (voiceDataUri) body.voice = voiceDataUri;
  return body;
}

async function sendWebhook(user, title, content, imageDataUri, voiceDataUri) {
  if (!user) return;
  const wUrl = user.webhook_url || '';
  const wEnabled = user.webhook_enabled === 'true';
  if (!wEnabled || !wUrl) return;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    await fetch(wUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildWebhookBody(title, content, imageDataUri, voiceDataUri)),
      signal: controller.signal
    });
    clearTimeout(timeout);
  } catch (e) {
    console.error('Webhook 发送失败:', e.message);
  }
}

// ffmpeg 转 AMR
function convertToAmr(inputPath) {
  return new Promise((resolve, reject) => {
    const outputPath = inputPath + '.amr';
    const attempts = [
      ['-ar', '8000', '-ac', '1', '-ab', '12.2k', '-c:a', 'libopencore_amrnb'],
      ['-ar', '8000', '-ac', '1', '-c:a', 'libopencore_amrnb'],
      ['-ar', '8000', '-ac', '1', '-ab', '12.2k'],
      ['-ar', '8000', '-ac', '1'],
    ];
    let idx = 0;
    function tryNext() {
      if (idx >= attempts.length) { reject(new Error('所有 AMR 转码尝试均失败')); return; }
      const args = ['-y', '-i', inputPath, ...attempts[idx], outputPath];
      idx++;
      execFile('ffmpeg', args, (err, stdout, stderr) => {
        if (err) { console.error('ffmpeg 转码尝试失败:', err.message); tryNext(); }
        else resolve(outputPath);
      });
    }
    tryNext();
  });
}

async function uploadVoiceMedia(accessToken, amrPath) {
  const form = new FormData();
  const buf = fs.readFileSync(amrPath);
  form.append('media', new Blob([buf], { type: 'audio/amr' }), 'voice.amr');
  const resp = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/media/upload?access_token=${accessToken}&type=voice`, { method: 'POST', body: form });
  const data = await resp.json();
  if (data.errcode) throw new Error('上传语音素材失败: ' + data.errmsg);
  return data.media_id;
}

async function sendWeChatWork(user, title, content, imageDataUri, imagePath, voicePath, voiceAmrPath) {
  if (!user) return;
  const corpId = user.wx_corpid || '';
  const agentId = user.wx_agentid || '';
  const secret = user.wx_secret || '';
  const userIds = user.wx_userid || '';
  const picBase = user.wx_pic_base || '';
  const msgFormat = user.wx_message_format || '[留言板]\n{title}\n\n{content}';
  if (!corpId || !agentId || !secret || !userIds) return;

  let accessToken;
  try {
    const tokenResp = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpId}&corpsecret=${secret}`);
    const tokenData = await tokenResp.json();
    if (tokenData.errcode) { console.error('企业微信获取 token 失败:', tokenData.errmsg); return; }
    accessToken = tokenData.access_token;
  } catch (e) { console.error('企业微信获取 token 失败:', e.message); return; }

  // 有语音 → 先发文本通知，再发语音条
  if (voicePath) {
    let noticeText;
    if (content && content.trim()) {
      noticeText = `🆕你有一条新留言\n👤用户：${title}\n📝留言：${content}`;
    } else {
      noticeText = `🆕你有一条新语音留言\n👤用户：${title}`;
    }
    try {
      await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${accessToken}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ touser: userIds, msgtype: 'text', agentid: agentId, text: { content: noticeText } })
      });
    } catch (e) { console.error('企业微信发送语音通知失败:', e.message); }
    await new Promise(r => setTimeout(r, 800));
    if (voiceAmrPath) {
      try {
        const mediaId = await uploadVoiceMedia(accessToken, voiceAmrPath);
        await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${accessToken}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ touser: userIds, msgtype: 'voice', agentid: agentId, voice: { media_id: mediaId } })
        });
      } catch (e) { console.error('企业微信发送 voice 失败:', e.message); }
    }
    return;
  }

  // 带图且配置了图片公网地址 → news 图文
  if (imagePath && picBase) {
    const imgUrl = picBase.replace(/\/+$/, '') + '/uploads/' + imagePath;
    const desc = (content && content.trim()) ? `📝留言：${content}` : '（仅图片留言）';
    try {
      await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${accessToken}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ touser: userIds, msgtype: 'news', agentid: agentId, news: { articles: [{ title: `🆕新留言｜${title}`, description: desc, picurl: imgUrl, url: imgUrl }] } })
      });
      return;
    } catch (e) { console.error('企业微信发送 news 失败:', e.message); return; }
  }

  // 无图 → 文本
  let text;
  if (imagePath && !picBase) {
    text = `🆕你有一条新留言（⚠️未配置图片公网地址，图片未推送）\n\n👨🏻用户：${title}\n📝留言：${content || '（仅图片）'}`;
  } else {
    text = `🆕你有一条新留言\n\n👨🏻用户：${title}\n📝留言：${content || ''}`;
  }
  try {
    await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${accessToken}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ touser: userIds, msgtype: 'text', agentid: agentId, text: { content: text } })
    });
  } catch (e) { console.error('企业微信发送文字失败:', e.message); }
}

// 中间件
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// ============ 文件上传配置 ============
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const MAX_VOICE_SIZE = 10 * 1024 * 1024;
const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: Math.max(MAX_IMAGE_SIZE, MAX_VOICE_SIZE) },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'image') {
      if (ALLOWED_IMAGE_TYPES.includes(file.mimetype)) cb(null, true);
      else cb(new Error('仅支持 JPEG / PNG / WebP 格式的图片'));
    } else if (file.fieldname === 'voice') {
      if (file.mimetype.startsWith('audio/')) cb(null, true);
      else cb(new Error('仅支持音频格式'));
    } else cb(new Error('未知字段: ' + file.fieldname));
  }
});

// ============ 前端路由 ============
app.get('/message', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// 用户留言板路由：/:username（排除保留路径）
const RESERVED_PATHS = ['admin', 'message', 'api', 'uploads', 'favicon.ico'];
app.get('/:username', (req, res, next) => {
  const username = req.params.username;
  if (RESERVED_PATHS.includes(username) || username.startsWith('.')) return next();
  const user = getWallUser(username);
  if (!user) return res.status(404).send('留言板不存在');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============ 提交留言（通用处理函数） ============
async function handleMessageSubmit(req, res, wallUsername) {
  const user = getWallUser(wallUsername);
  if (!user) return res.status(404).json({ error: '留言板用户不存在' });

  upload.fields([{ name: 'image', maxCount: 1 }, { name: 'voice', maxCount: 1 }])(req, res, async (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? '文件过大' : err.message;
      return res.status(400).json({ error: msg });
    }
    const { name, content, contact } = req.body;
    const textContent = (content || '').toString();
    const imageFile = req.files?.image?.[0] || null;
    const voiceFile = req.files?.voice?.[0] || null;

    const displayName = (name && name.trim()) ? name.trim() : '匿名访客';
    if (!textContent.trim() && !imageFile && !voiceFile) {
      return res.status(400).json({ error: '留言内容、图片、语音至少填写一项' });
    }

    let imagePath = '';
    let imageDataUri = '';
    if (imageFile) {
      const extMap = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
      const ext = extMap[imageFile.mimetype] || 'jpg';
      const newName = imageFile.filename + '.' + ext;
      fs.renameSync(imageFile.path, path.join(uploadsDir, newName));
      imagePath = newName;
      const buf = fs.readFileSync(path.join(uploadsDir, newName));
      imageDataUri = `data:${imageFile.mimetype};base64,${buf.toString('base64')}`;
    }

    let voicePath = '';
    let voiceDataUri = '';
    let voiceAmrPath = '';
    if (voiceFile) {
      const extMap = { 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg' };
      const ext = extMap[voiceFile.mimetype] || 'webm';
      const newName = voiceFile.filename + '.' + ext;
      fs.renameSync(voiceFile.path, path.join(uploadsDir, newName));
      voicePath = newName;
      const buf = fs.readFileSync(path.join(uploadsDir, newName));
      voiceDataUri = `data:${voiceFile.mimetype};base64,${buf.toString('base64')}`;
      try { voiceAmrPath = await convertToAmr(path.join(uploadsDir, newName)); }
      catch (e) { console.error('语音转 AMR 失败:', e.message); }
    }

    db.prepare('INSERT INTO messages (name, content, contact, image_path, voice_path, wall_username) VALUES (?, ?, ?, ?, ?, ?)')
      .run(displayName, textContent, contact || '', imagePath, voicePath, wallUsername);

    const title = contact ? `${displayName}（${contact}）` : displayName;
    await Promise.all([
      sendWebhook(user, title, textContent, imageDataUri, voiceDataUri),
      sendWeChatWork(user, title, textContent, imageDataUri, imagePath, voicePath, voiceAmrPath)
    ]);

    res.json({ success: true });
  });
}

// 默认留言板（兼容旧地址）
app.post('/api/message', (req, res) => handleMessageSubmit(req, res, DEFAULT_WALL_USER));
// 指定用户留言板
app.post('/api/message/:username', (req, res) => handleMessageSubmit(req, res, req.params.username));

// ============ 管理员认证 ============
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  const stored = db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_password');
  if (stored && bcrypt.compareSync(password, stored.value)) {
    res.json({ success: true });
  } else {
    res.status(401).json({ error: '密码错误' });
  }
});

// ============ 留言管理 ============
app.get('/api/messages', (req, res) => {
  const { username } = req.query;
  let msgs;
  if (username) {
    msgs = db.prepare('SELECT * FROM messages WHERE wall_username = ? ORDER BY created_at DESC').all(username);
  } else {
    msgs = db.prepare('SELECT * FROM messages ORDER BY created_at DESC').all();
  }
  res.json(msgs);
});

app.delete('/api/message/:id', (req, res) => {
  const { id } = req.params;
  const msg = db.prepare('SELECT image_path, voice_path FROM messages WHERE id = ?').get(id);
  if (msg?.image_path) { const p = path.join(uploadsDir, msg.image_path); if (fs.existsSync(p)) fs.unlinkSync(p); }
  if (msg?.voice_path) {
    const p = path.join(uploadsDir, msg.voice_path); if (fs.existsSync(p)) fs.unlinkSync(p);
    if (fs.existsSync(p + '.amr')) fs.unlinkSync(p + '.amr');
  }
  db.prepare('DELETE FROM messages WHERE id = ?').run(id);
  res.json({ success: true });
});

app.delete('/api/messages', (req, res) => {
  const { username } = req.query;
  let msgs;
  if (username) msgs = db.prepare('SELECT image_path, voice_path FROM messages WHERE wall_username = ?').all(username);
  else msgs = db.prepare('SELECT image_path, voice_path FROM messages').all();
  msgs.forEach(m => {
    if (m?.image_path) { const p = path.join(uploadsDir, m.image_path); if (fs.existsSync(p)) fs.unlinkSync(p); }
    if (m?.voice_path) { const p = path.join(uploadsDir, m.voice_path); if (fs.existsSync(p)) fs.unlinkSync(p); if (fs.existsSync(p + '.amr')) fs.unlinkSync(p + '.amr'); }
  });
  if (username) db.prepare('DELETE FROM messages WHERE wall_username = ?').run(username);
  else db.prepare('DELETE FROM messages').run();
  res.json({ success: true });
});

// ============ 留言板用户管理 ============
app.get('/api/users', (req, res) => {
  const users = db.prepare('SELECT id, username, display_name, webhook_url, webhook_enabled, wx_corpid, wx_agentid, wx_userid, wx_pic_base, frontend_tip, created_at FROM wall_users ORDER BY id ASC').all();
  res.json(users);
});

app.post('/api/users', (req, res) => {
  const { username, displayName, webhookUrl, webhookEnabled, wxCorpid, wxAgentid, wxSecret, wxUserid, wxMessageFormat, wxPicBase, frontendTip } = req.body;
  if (!username || !/^[a-zA-Z0-9_-]{2,32}$/.test(username)) {
    return res.status(400).json({ error: '用户名需为 2-32 位字母、数字、下划线或连字符' });
  }
  if (RESERVED_PATHS.includes(username)) return res.status(400).json({ error: '该用户名是保留字，不可使用' });
  const existing = db.prepare('SELECT id FROM wall_users WHERE username = ?').get(username);
  if (existing) return res.status(409).json({ error: '用户名已存在' });
  try {
    db.prepare(`INSERT INTO wall_users (username, display_name, webhook_url, webhook_enabled, wx_corpid, wx_agentid, wx_secret, wx_userid, wx_message_format, wx_pic_base, frontend_tip)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      username, displayName || '', webhookUrl || '', webhookEnabled ? 'true' : 'false',
      wxCorpid || '', wxAgentid || '', wxSecret || '', wxUserid || '',
      wxMessageFormat || '[留言板]\n{title}\n\n{content}', wxPicBase || '', frontendTip || '写下你想说的话，我会转达给主人'
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/users/:username', (req, res) => {
  const { username } = req.params;
  const { displayName, webhookUrl, webhookEnabled, wxCorpid, wxAgentid, wxSecret, wxUserid, wxMessageFormat, wxPicBase, frontendTip } = req.body;
  const user = getWallUser(username);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  db.prepare(`UPDATE wall_users SET display_name=?, webhook_url=?, webhook_enabled=?, wx_corpid=?, wx_agentid=?, wx_secret=?, wx_userid=?, wx_message_format=?, wx_pic_base=?, frontend_tip=? WHERE username=?`).run(
    displayName ?? user.display_name,
    webhookUrl ?? user.webhook_url,
    webhookEnabled != null ? (webhookEnabled ? 'true' : 'false') : user.webhook_enabled,
    wxCorpid ?? user.wx_corpid,
    wxAgentid ?? user.wx_agentid,
    wxSecret ?? user.wx_secret,
    wxUserid ?? user.wx_userid,
    wxMessageFormat ?? user.wx_message_format,
    wxPicBase ?? user.wx_pic_base,
    frontendTip ?? user.frontend_tip,
    username
  );
  res.json({ success: true });
});

app.delete('/api/users/:username', (req, res) => {
  const { username } = req.params;
  if (username === DEFAULT_WALL_USER) return res.status(400).json({ error: '默认用户不可删除' });
  const user = getWallUser(username);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  // 删除该用户的留言和文件
  const msgs = db.prepare('SELECT image_path, voice_path FROM messages WHERE wall_username = ?').all(username);
  msgs.forEach(m => {
    if (m?.image_path) { const p = path.join(uploadsDir, m.image_path); if (fs.existsSync(p)) fs.unlinkSync(p); }
    if (m?.voice_path) { const p = path.join(uploadsDir, m.voice_path); if (fs.existsSync(p)) fs.unlinkSync(p); if (fs.existsSync(p + '.amr')) fs.unlinkSync(p + '.amr'); }
  });
  db.prepare('DELETE FROM messages WHERE wall_username = ?').run(username);
  db.prepare('DELETE FROM wall_users WHERE username = ?').run(username);
  res.json({ success: true });
});

// ============ EchoLink 用户同步 ============
// EchoLink 注册新用户时自动调用，在留言板创建对应用户
app.post('/api/sync-user', (req, res) => {
  const { username } = req.body;
  if (!username || !/^[a-zA-Z0-9_-]{2,32}$/.test(username)) {
    return res.status(400).json({ error: '用户名不合法' });
  }
  if (RESERVED_PATHS.includes(username)) return res.status(400).json({ error: '保留字' });
  const existing = db.prepare('SELECT id FROM wall_users WHERE username = ?').get(username);
  if (existing) return res.json({ success: true, skipped: true });
  const echolinkBase = db.prepare('SELECT value FROM settings WHERE key = ?').get('echolink_webhook_base')?.value || '';
  const webhookUrl = echolinkBase ? `${echolinkBase.replace(/\/$/, '')}/api/webhook/messagewall/${username}` : '';
  try {
    db.prepare(`INSERT INTO wall_users (username, display_name, webhook_url, webhook_enabled, wx_corpid, wx_agentid, wx_secret, wx_userid, wx_message_format, wx_pic_base, frontend_tip)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      username, `${username}的留言板`,
      webhookUrl, 'true',
      '', '', '', '',
      '[留言板]\n{title}\n\n{content}', '',
      '有事请留言'
    );
    console.log(`[sync] 已创建留言板用户: ${username}`);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ 配置（兼容旧接口 + 新接口） ============
app.put('/api/settings', (req, res) => {
  // 旧接口：更新默认用户配置
  const { webhookUrl, webhookEnabled, newPassword, wxCorpid, wxAgentid, wxSecret, wxUserid, wxMessageFormat, wxPicBase, frontendTip, echolinkWebhookBase } = req.body;
  db.prepare(`UPDATE wall_users SET webhook_url=?, webhook_enabled=?, wx_corpid=?, wx_agentid=?, wx_secret=?, wx_userid=?, wx_message_format=?, wx_pic_base=?, frontend_tip=? WHERE username=?`).run(
    webhookUrl ?? '', webhookEnabled ? 'true' : 'false',
    wxCorpid ?? '', wxAgentid ?? '', wxSecret ?? '', wxUserid ?? '',
    wxMessageFormat ?? '[留言板]\n{title}\n\n{content}', wxPicBase ?? '', frontendTip ?? '', DEFAULT_WALL_USER
  );
  if (newPassword) {
    const salt = bcrypt.genSaltSync(10);
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('admin_password', bcrypt.hashSync(newPassword, salt));
  }
  if (echolinkWebhookBase != null) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('echolink_webhook_base', echolinkWebhookBase);
  }
  res.json({ success: true });
});

app.get('/api/settings', (req, res) => {
  const user = getWallUser(DEFAULT_WALL_USER);
  res.json({
    webhookUrl: user?.webhook_url || '',
    webhookEnabled: user?.webhook_enabled === 'true',
    wxCorpid: user?.wx_corpid || '',
    wxAgentid: user?.wx_agentid || '',
    wxSecret: user?.wx_secret || '',
    wxUserid: user?.wx_userid || '',
    wxMessageFormat: user?.wx_message_format || '[留言板]\n{title}\n\n{content}',
    wxPicBase: user?.wx_pic_base || '',
    frontendTip: user?.frontend_tip || '写下你想说的话，我会转达给主人',
    echolinkWebhookBase: db.prepare('SELECT value FROM settings WHERE key = ?').get('echolink_webhook_base')?.value || '',
    hasPassword: !!db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_password')
  });
});

// 公开配置（首页提示语）
app.get('/api/config', (req, res) => {
  const user = getWallUser(DEFAULT_WALL_USER);
  res.json({ frontendTip: user?.frontend_tip || '写下你想说的话，我会转达给主人', wallUsername: DEFAULT_WALL_USER });
});
app.get('/api/config/:username', (req, res) => {
  const user = getWallUser(req.params.username);
  if (!user) return res.status(404).json({ error: '留言板不存在' });
  res.json({ frontendTip: user.frontend_tip || '写下你想说的话，我会转达给主人', wallUsername: user.username });
});

// ============ 测试 Webhook ============
app.post('/api/webhook/test', async (req, res) => {
  const { url, title, content } = req.body;
  if (!url) return res.status(400).json({ error: 'URL 不能为空' });
  try {
    const start = Date.now();
    const resp = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildWebhookBody(title || '测试员', content || '这是一条测试留言', ''))
    });
    res.json({ success: resp.ok, status: resp.status, elapsed: Date.now() - start });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ============ 测试企业微信 ============
app.post('/api/wx/test', async (req, res) => {
  const { corpId, agentId, secret, userId } = req.body;
  if (!corpId || !secret || !userId) return res.status(400).json({ error: '请填写完整的企业微信配置' });
  try {
    const start = Date.now();
    const tokenResp = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpId}&corpsecret=${secret}`);
    const tokenData = await tokenResp.json();
    if (tokenData.errcode) return res.status(400).json({ success: false, error: tokenData.errmsg });
    const msgResp = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${tokenData.access_token}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ touser: userId, msgtype: 'text', agentid: agentId, text: { content: '[留言板测试] 这是一条测试消息，如果你收到了说明配置正确。' } })
    });
    const msgData = await msgResp.json();
    if (msgData.errcode) res.json({ success: false, error: msgData.errmsg, elapsed: Date.now() - start });
    else res.json({ success: true, elapsed: Date.now() - start });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ============ 启动 ============
app.listen(PORT, () => {
  console.log(`留言板服务已启动 → http://localhost:${PORT}/message`);
  console.log(`管理后台 → http://localhost:${PORT}/admin`);
  const users = db.prepare('SELECT username FROM wall_users').all();
  console.log(`已加载留言板用户: ${users.map(u => u.username).join(', ')}`);
});
