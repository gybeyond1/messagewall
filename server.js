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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);
// 兼容旧库：补 voice_path 列（已存在则忽略）
try { db.exec(`ALTER TABLE messages ADD COLUMN voice_path TEXT DEFAULT ''`); } catch (_) {}

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

function buildWebhookBody(title, content, imageDataUri, voiceDataUri) {
  const body = { source: "messagewall", title, content };
  if (imageDataUri) body.image = imageDataUri;
  if (voiceDataUri) body.voice = voiceDataUri;
  return body;
}

async function sendWebhook(title, content, imageDataUri, voiceDataUri) {
  const wUrl = getSetting('webhook_url') || '';
  const wEnabled = getSetting('webhook_enabled') === 'true';
  if (!wEnabled || !wUrl) return;
  try {
    await fetch(wUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildWebhookBody(title, content, imageDataUri, voiceDataUri))
    });
  } catch (e) {
    console.error('Webhook 发送失败:', e.message);
  }
}

// ffmpeg 转 AMR（企业微信语音要求：8kHz 单声道 AMR-NB）
function convertToAmr(inputPath) {
  return new Promise((resolve, reject) => {
    const outputPath = inputPath + '.amr';
    // 多种编码器配置依次尝试（alpine ffmpeg 可能只有部分可用）
    const attempts = [
      ['-ar', '8000', '-ac', '1', '-ab', '12.2k', '-c:a', 'libopencore_amrnb'],
      ['-ar', '8000', '-ac', '1', '-c:a', 'libopencore_amrnb'],
      ['-ar', '8000', '-ac', '1', '-ab', '12.2k'],
      ['-ar', '8000', '-ac', '1'],
    ];
    let idx = 0;
    function tryNext() {
      if (idx >= attempts.length) {
        reject(new Error('所有 AMR 转码尝试均失败'));
        return;
      }
      const args = ['-y', '-i', inputPath, ...attempts[idx], outputPath];
      idx++;
      execFile('ffmpeg', args, (err, stdout, stderr) => {
        if (err) {
          console.error('ffmpeg 转码尝试失败:', err.message, stderr ? stderr.slice(-300) : '');
          tryNext();
        } else {
          resolve(outputPath);
        }
      });
    }
    tryNext();
  });
}

// 上传语音临时素材，返回 media_id
async function uploadVoiceMedia(accessToken, amrPath) {
  const form = new FormData();
  const buf = fs.readFileSync(amrPath);
  form.append('media', new Blob([buf], { type: 'audio/amr' }), 'voice.amr');
  const resp = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/media/upload?access_token=${accessToken}&type=voice`, {
    method: 'POST',
    body: form
  });
  const data = await resp.json();
  if (data.errcode) throw new Error('上传语音素材失败: ' + data.errmsg);
  return data.media_id;
}

async function sendWeChatWork(title, content, imageDataUri, imagePath, voicePath, voiceAmrPath) {
  const corpId = getSetting('wx_corpid') || '';
  const agentId = getSetting('wx_agentid') || '';
  const secret = getSetting('wx_secret') || '';
  const userIds = getSetting('wx_userid') || '';
  const picBase = getSetting('wx_pic_base') || '';
  const msgFormat = getSetting('wx_message_format') || '[留言板]\n{title}\n\n{content}';
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

  // ===== 有语音文件 → 先发文本通知，再发语音条（企业微信语音消息不能带文字，必须分开发） =====
  if (voicePath) {
    // 1. 文本通知
    let noticeText;
    if (content && content.trim()) {
      noticeText = `🆕你有一条新留言\n👤用户：${title}\n📝留言：${content}`;
    } else {
      noticeText = `🆕你有一条新语音留言\n👤用户：${title}`;
    }
    try {
      const textResp = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${accessToken}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          touser: userIds,
          msgtype: 'text',
          agentid: agentId,
          text: { content: noticeText }
        })
      });
      const textData = await textResp.json();
      if (textData.errcode) console.error('企业微信发送语音通知失败:', textData.errmsg);
    } catch (e) {
      console.error('企业微信发送语音通知失败:', e.message);
    }

    // 等文本通知送达后再发语音条，确保企业微信里文本在前、语音在后
    await new Promise(r => setTimeout(r, 800));

    // 2. 语音条（转码成功才发）
    if (voiceAmrPath) {
      try {
        const mediaId = await uploadVoiceMedia(accessToken, voiceAmrPath);
        const resp = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${accessToken}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            touser: userIds,
            msgtype: 'voice',
            agentid: agentId,
            voice: { media_id: mediaId }
          })
        });
        const d = await resp.json();
        if (d.errcode) console.error('企业微信发送 voice 失败:', d.errmsg);
      } catch (e) {
        console.error('企业微信发送 voice 失败:', e.message);
      }
    } else {
      console.error('语音转 AMR 失败，仅发送了文本通知（请检查 ffmpeg 日志）');
    }
    return;
  }

  // 带图且配置了图片公网地址 → 发送 news 图文消息（picurl 走外链，不受 2MB 限制）
  if (imagePath && picBase) {
    const imgUrl = picBase.replace(/\/+$/, '') + '/uploads/' + imagePath;
    const desc = (content && content.trim()) ? `📝留言：${content}` : '（仅图片留言）';
    try {
      const resp = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${accessToken}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          touser: userIds,
          msgtype: 'news',
          agentid: agentId,
          news: {
            articles: [{
              title: `🆕新留言｜${title}`,
              description: desc,
              picurl: imgUrl,
              url: imgUrl
            }]
          }
        })
      });
      const d = await resp.json();
      if (d.errcode) console.error('企业微信发送 news 失败:', d.errmsg);
      return;
    } catch (e) {
      console.error('企业微信发送 news 失败:', e.message);
      return;
    }
  }

  // 无图，或未配置公网地址 → 发送文本消息
  const messageContent = msgFormat
    .replace(/{title}/g, title)
    .replace(/{content}/g, content || '');
  let text;
  if (imagePath && !picBase) {
    text = `🆕你有一条新留言（⚠️未配置图片公网地址，图片未推送）\n\n👨🏻用户：${title}\n📝留言：${content || '（仅图片）'}`;
  } else {
    text = `🆕你有一条新留言\n\n👨🏻用户：${title}\n📝留言：${content || ''}`;
  }
  try {
    await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${accessToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        touser: userIds,
        msgtype: 'text',
        agentid: agentId,
        text: { content: text }
      })
    });
  } catch (e) {
    console.error('企业微信发送文字失败:', e.message);
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

// ============ 文件上传配置 ============
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const ALLOWED_VOICE_TYPES = ['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2'];
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_VOICE_SIZE = 10 * 1024 * 1024; // 10MB（转 AMR 后会小很多）
const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: Math.max(MAX_IMAGE_SIZE, MAX_VOICE_SIZE) },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'image') {
      if (ALLOWED_IMAGE_TYPES.includes(file.mimetype)) cb(null, true);
      else cb(new Error('仅支持 JPEG / PNG / WebP 格式的图片'));
    } else if (file.fieldname === 'voice') {
      if (ALLOWED_VOICE_TYPES.includes(file.mimetype) || file.mimetype.startsWith('audio/')) cb(null, true);
      else cb(new Error('仅支持音频格式'));
    } else {
      cb(new Error('未知字段: ' + file.fieldname));
    }
  }
});

// ============ 前端路由 ============
app.get('/message', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ============ API：提交留言 ============
app.post('/api/message', (req, res) => {
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

    // 保存图片（补扩展名），并读出 base64 用于 webhook
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

    // 保存语音（补扩展名），转 AMR 用于企业微信，原始格式 base64 用于 webhook
    let voicePath = '';
    let voiceDataUri = '';
    let voiceAmrPath = '';
    if (voiceFile) {
      const extMap = { 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg' };
      const ext = extMap[voiceFile.mimetype] || 'webm';
      const newName = voiceFile.filename + '.' + ext;
      fs.renameSync(voiceFile.path, path.join(uploadsDir, newName));
      voicePath = newName;
      // webhook 用原始格式 base64（EchoLink 直接存和播放）
      const buf = fs.readFileSync(path.join(uploadsDir, newName));
      voiceDataUri = `data:${voiceFile.mimetype};base64,${buf.toString('base64')}`;
      // 转 AMR 用于企业微信 voice 通道
      try {
        voiceAmrPath = await convertToAmr(path.join(uploadsDir, newName));
      } catch (e) {
        console.error('语音转 AMR 失败:', e.message);
        // 转码失败则不发企业微信语音，但 webhook 仍发原始格式
      }
    }

    const stmt = db.prepare('INSERT INTO messages (name, content, contact, image_path, voice_path) VALUES (?, ?, ?, ?, ?)');
    const info = stmt.run(displayName, textContent, contact || '', imagePath, voicePath);

    // 发送通知
    const title = contact ? `${displayName}（${contact}）` : displayName;
    await Promise.all([
      sendWebhook(title, textContent, imageDataUri, voiceDataUri),
      sendWeChatWork(title, textContent, imageDataUri, imagePath, voicePath, voiceAmrPath)
    ]);

    res.json({ id: info.lastInsertRowid, success: true });
  });
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
  const msg = db.prepare('SELECT image_path, voice_path FROM messages WHERE id = ?').get(id);
  if (msg?.image_path) {
    const imgPath = path.join(__dirname, 'uploads', msg.image_path);
    if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
  }
  if (msg?.voice_path) {
    const voicePath = path.join(__dirname, 'uploads', msg.voice_path);
    if (fs.existsSync(voicePath)) fs.unlinkSync(voicePath);
    // 同时删转码产物
    if (fs.existsSync(voicePath + '.amr')) fs.unlinkSync(voicePath + '.amr');
  }
  db.prepare('DELETE FROM messages WHERE id = ?').run(id);
  res.json({ success: true });
});

// ============ API：清空所有留言 ============
app.delete('/api/messages', (req, res) => {
  const msgs = db.prepare('SELECT image_path, voice_path FROM messages').all();
  msgs.forEach(m => {
    if (m?.image_path) {
      const imgPath = path.join(__dirname, 'uploads', m.image_path);
      if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
    }
    if (m?.voice_path) {
      const voicePath = path.join(__dirname, 'uploads', m.voice_path);
      if (fs.existsSync(voicePath)) fs.unlinkSync(voicePath);
      if (fs.existsSync(voicePath + '.amr')) fs.unlinkSync(voicePath + '.amr');
    }
  });
  db.prepare('DELETE FROM messages').run();
  res.json({ success: true });
});

// ============ API：更新配置 ============
app.put('/api/settings', (req, res) => {
  const { webhookUrl, webhookEnabled, newPassword, wxCorpid, wxAgentid, wxSecret, wxUserid, wxMessageFormat, wxPicBase, frontendTip } = req.body;
  const save = (key, value) => {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value != null ? String(value) : '');
  };
  save('webhook_url', webhookUrl);
  save('webhook_enabled', webhookEnabled === true || webhookEnabled === 'true' ? 'true' : 'false');
  save('wx_corpid', wxCorpid);
  save('wx_agentid', wxAgentid);
  save('wx_secret', wxSecret);
  save('wx_userid', wxUserid);
  save('wx_message_format', wxMessageFormat);
  save('wx_pic_base', wxPicBase);
  save('frontend_tip', frontendTip);
  if (newPassword) {
    const salt = bcrypt.genSaltSync(10);
    save('admin_password', bcrypt.hashSync(newPassword, salt));
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
    wxMessageFormat: settings.wx_message_format || '[留言板]\n{title}\n\n{content}',
    wxPicBase: settings.wx_pic_base || '',
    frontendTip: settings.frontend_tip || '写下你想说的话，我会转达给主人',
    hasPassword: !!settings.admin_password
  });
});

// ============ API：公开配置（首页提示语等，无需登录） ============
app.get('/api/config', (req, res) => {
  const tip = getSetting('frontend_tip');
  res.json({ frontendTip: tip || '写下你想说的话，我会转达给主人' });
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
      body: JSON.stringify(buildWebhookBody(title || '测试员', content || '这是一条测试留言', ''))
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
        agentid: agentId,
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