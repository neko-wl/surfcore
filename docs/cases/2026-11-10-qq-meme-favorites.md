# QQ 表情：图库接进 QQ 收藏表情（send_custom_face）

日期：2026-11-10
版本：0.9.0（待发布）
相关：`src/bridge.js`、`src/mcp-snowluma-safe.js`

## 现象

模型按 `[表情: 描述]` 写标记，QQ 侧只会收到一行字——**QQ 通道没有渲染层**，网页端能把标记渲染成图，QQ 不能。

第一版把图库图片用 OneBot `image` 段发出去，能发出去，但显示成**普通图片**（带边框、可点开、能保存），不是 QQ 的表情面板那种「收藏表情」。

## 根因

1. QQ 的「收藏表情」和「图片」在协议层是两种呈现：收藏表情走 `custom face`（`emoji_id`），图片走 `image` 段。
2. SnowLuma 有扩展动作 `add_custom_face`（把图加入账号收藏）与 `send_custom_face`（按 emoji_id 以表情呈现发送），但 OneBot v11 标准里没有这两个动作，所以必须走扩展。
3. 收藏表情有数量上限，同一张图反复收藏会刷满收藏夹。

## 修法

### 1. 桥接新增 `POST /api/socialV2/send-meme`

```
图库图片 → sha256 查 state/meme-favorites.json
  ├ 已缓存 emoji_id → send_custom_face（表情呈现）
  └ 未缓存 → add_custom_face（base64 上传）→ 记缓存 → send_custom_face
        └ add/send 失败 → 回退 image 段（图片呈现）
```

返回 `via: "sticker" | "image"`，调用方据此知道走了哪条路。

### 2. 安全边界

新增 `resolveMemeImagePathForOperator()`：只允许图库目录内的图片。

```
✓ ~/.dsh/meme-packs/
✓ config.socialV2.meme.dir
✓ .../node_modules/dsh-meme/memes/
✗ 任意绝对路径 / http(s) URL / base64://
```

原因：`add_custom_face` 会把文件内容编码后发出去，若接受任意路径就等于「读任意文件并外传」。

### 3. MCP 新工具 `meme_qq`

- 遍历各图库包的 `index.db`（sqlite），按 tag + 描述打分
- 打分：整词 +10、二字词组 +4、单字 +1；只有最高分附近（差距 ≤2）才随机
- 意图别名：`累/加班 → cpu`、`困 → sleep`、`吃/干饭 → daily`、`被夸 → happy`…
- 同图不连发（记住上次路径）

## 验证

| 场景 | 结果 |
|---|---|
| `add_custom_face` + `send_custom_face` 手工调用 | ✅ 返回 emoji_id 与 messageId，QQ 里显示为表情 |
| `meme_qq {description:"开心"}` | ✅ `via: sticker`，messageId 591897121 |
| `meme_qq {description:"摸鱼"}` | ✅ `via: sticker`，messageId 2043349797 |
| 收藏夹去重 | ✅ 第二次发同一张图不再新增收藏，直接命中缓存 |
| 关键词准确性 | ✅ 干饭→干饭图、摸鱼→躺平图、被夸→飘了图、好困→睡觉图 |

## 影响面

- 只影响表情发送路径；文字/语音/文件通道不变。
- 首次发某张图会在用户 QQ 账号里**新增一条收藏表情**（用户已知悉并同意）。
- 换到不支持 `send_custom_face` 的协议端（NapCat/Lagrange）时自动回退为发图片，不会报错。

## 残留问题

- 图库只有 24 张（dsh-meme 自带 pack），覆盖的情绪有限。
- 收藏表情有数量上限，图库规模大了以后需要「按需收藏 + 清理」策略。
- 收藏缓存 `state/meme-favorites.json` 以图片 SHA256 为键，图片被替换后需要重新收藏（会自动发生）。
