# 留言板 (messagewall) → Webhook 接收端格式对齐

收到你的 4 个问题，逐条答复如下。下面这套是**发送端（messagewall）的标准 webhook 契约**，你按这个对接即可。

> 说明：当前线上版本（v1）只发 `title` + `content`，**图片 base64 是下一版（v2）要新增的能力**。我会改完代码再构建新镜像，在那之前先用下面契约对齐，避免来回返工。

## 标准 JSON 样例

```json
{
  "source": "messagewall",
  "title": "测试员（13040251382）",
  "content": "这是一条带图测试",
  "image": "data:image/jpeg;base64,/9j/4AAQSkZJRg..."
}
```

---

## 1. 标题 / 联系方式格式（最关键）

- **合并成一个字段 `title`，不拆分 `contact` / `phone`**。
- 格式：`名字（联系方式）`，使用**中文全角括号 `（）`**（U+FF08 / U+FF09）。
- 无联系方式时：`title` 只写名字，不加括号、不补空串。例：`"title": "测试员"`。
- 你那边**无需解析**括号里的联系方式，整段当作标题展示即可。如果以后你需要单独拿到联系方式做回拨，我们再补一个 `contact` 字段——但默认不拆，保持合并。

## 2. 图片怎么传

- **base64 内嵌在 JSON 里**，字段名 `image`，格式 `data:image/jpeg;base64,xxxx...`。
- 不推荐 URL 方案：messagewall 跑在内网（`192.168.x.x`），外网 WebUI 拉不到图；也不走 `multipart/form-data` 文件上传，JSON 最省事。
- **无图时：直接省略 `image` 字段**（不要传 `null` / 空串）。
- 体积上限：发送端单图控制在 **5MB** 以内；建议你把 webhook 接收端的 body 上限设到 **≥10MB** 留余量。
- 支持格式：**JPEG / PNG / WebP**（GIF 暂不支持，需要可加）。

## 3. 内容字段的边界情况

- `content` **可以为空**（纯图片留言）：传空串 `""`。
- 图片：**当前单张**，用 `image`。多张需求出现时，升级为数组字段 `images: ["data:...", "data:..."]`（同一 webhook 一次发完，不分多次）。v1 先按单张对接。

## 4. 其他固定字段

- `source` 固定为 `"messagewall"`，不变。
- **不发送 `timestamp`**，由**你服务端收到的时间**作为权威时间（更可靠，避免发送端时钟偏差）。
- （当前 webhook 还会带 `sourceName`、`sourceDesc` 两个描述性字段，说明来源用，可忽略。）

---

### 一句话总结对接要点
- `title` = `名字（联系方式）`，中文全角括号，无联系方式只写名字；
- `content` 可空（空串 `""`）；
- `image` 有图才发 base64，无图省略该字段；
- `source` 固定 `messagewall`，时间用你服务端接收时间。
