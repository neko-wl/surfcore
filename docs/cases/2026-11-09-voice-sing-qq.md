# 2026-11-09 QQ 点歌链路（全自动翻唱 → 语音条 / 文件）

## 现象

- 用户诉求：QQ 里的角色能「点歌」，说出「点歌」「唱《晴天》」「我想听你唱歌」就发一条唱出来的语音。
- 逐步扩展：清唱、副歌定位、30~50 秒随机、完整版文件发送、Hi-Res 音源。
- 触发的真实故障：
  1. 渲染机（5070 Ti）被「外部客户端反复提交整段人声」打到显存溢出，Windows 在 WDDM 分页里打转，机器近乎卡死；
  2. 分离/换嗓偶尔 `fetch failed`（Node fetch 300 秒硬超时）；
  3. 服务端跑 demucs 时 `/v1/health` 不响应（同步阻塞事件循环）；
  4. 模型对比时 `sisi3` 把 `sisi` 的成品覆盖（输出名不含模型名）。

## 环境

| 项 | 值 |
| --- | --- |
| VM（大脑） | VMware ESXi guest，Xeon E5-2683 v4，16GB，无 GPU，`192.168.1.60` |
| 渲染机 | Win11 + RTX 5070 Ti 16GB，`192.168.1.21`，RVC 在 `E:\ai\rvc`，demucs 在 `E:\ai\demucs-env` |
| SurfCore | 0.8.8（`D:\Nexus\surfcore`） |
| 渲染服务 | FastAPI `:8877`（`/v1/health` `/v1/models` `/v1/sing` `/v1/separate`） |
| 语音库 | `D:\Nexus\surfcore\audio`（AI 只能发这里面的文件） |

## 根因

1. **显存溢出**：客户端把「整首人声」（4~6 分钟、50MB+）POST 给 `/v1/sing`，RVC 整段载入显存 → 16GB 打满 → Windows 把显存分页到内存（WDDM）→ 推理从 22 秒劣化到 663 秒并最终被 `-1` 杀掉。
2. **`fetch failed`**：undici（Node fetch）默认 `bodyTimeout=300s`，分离慢于 5 分钟就中断；改用系统 `curl`。
3. **health 转圈**：FastAPI `async def` 里直接 `subprocess.run` 阻塞事件循环；改成 `asyncio.to_thread` + 单任务锁。
4. **文件覆盖**：`sing-<BV>-<秒>s.wav` 不含模型名，换模型对比时后者覆盖前者。

## 完整逻辑

- **链路**：QQ 消息 → DSH 会话 → MCP 工具 `qq_sing`（`src/mcp-snowluma-safe.js`）→ 子进程 `voice-ai/client/sing-request.mjs` → B站取流（`fetch-audio.mjs`）→ 渲染机 `/v1/separate`、`/v1/sing` → 本地 ffmpeg 混音 → 落 `surfcore/audio` → 回到工具结果 → 模型调用 `qq_send_voice`（或 `qq_send_file`）发送。
- **机制**：为什么必须在 VM 切段——RVC 的显存占用与输入时长成正比，而不是与「要发多长」成正比；先切 30~50 秒再上传，显存占用与整首无关。
- **爆炸半径**：MCP 工具表 36 个、桥接路由 1 条新增（`/api/socialV2/send-file`）；只读语音库目录内的文件，不触碰 config/state；不花钱（B站取流免费，大会员为账号自带）。
- **取舍**：
  - A 方案「整首上传 + 服务端自己切」：服务端已实现 45s 分片，但客户端仍会白传 50MB，且断线重传成本高 → 采用 **B 方案「客户端先切，服务端仍是兜底」**（双层）。
  - 清唱「加混响遮毛刺」 vs 「保持干声」：实测用户更反感混响 → 默认 0，保留 `--reverb`。
  - 音源「换 VIP 账号登录 SurfCore」 vs 「双账号分离」：用户要求主身份保持「肆肆の鱼鱼」→ 采用双凭据（`credentials.json` 主身份 / `credentials.hires.json` 仅取流）。
- **生效与重启**：`client/*`、`scripts/*` 改完即生效；`server/sing_server.py` 需拷到渲染机并重启 `start.ps1`；`bridge.js` / `mcp-snowluma-safe.js` 需**重启 DSH**。

## 修法

| 文件 | 改动 |
| --- | --- |
| `voice-ai/client/sing-request.mjs` | 先切 30~50 秒再上传；副歌检测（ebur128 后半段最响窗口）；时长随机；`--acapella` / `--full` / `--timeoutMs`；输出名带模型名 |
| `voice-ai/client/lib/curl-upload.mjs` | 用 curl 上传替代 fetch；429/503 自动重试（队列满） |
| `voice-ai/client/cover.mjs` | 同样改为切段后上传；`--acapella` |
| `voice-ai/scripts/fetch-audio.mjs` | 只下音频流；优先 Hi-Res FLAC → 杜比 → AAC 最高；双凭据取流 |
| `voice-ai/scripts/bili-qr-login.mjs` | B站扫码登录，写入凭据（备份旧文件） |
| `surfcore/src/mcp-snowluma-safe.js` | 新增 `qq_sing`（song/seconds/acapella/full）、`qq_send_file`；失败契约带 code/hint |
| `surfcore/src/bridge.js` | 新增 `POST /api/socialV2/send-file`：agent token 校验、会话白名单、只允许语音库目录、200MB 上限 |
| 渲染机 `sing_server.py` | 异步子进程 + 单任务锁 + `-d cuda` + 时长闸门/分片（该机 DSH 已自行升级为 45s 分片 + 队列 4） |

## 验证

```powershell
# 端到端（含下载/分离/换嗓/混音）
node D:\Nexus\voice-ai\client\sing-request.mjs --song "学猫叫"
# → {"ok":true,"file":"sing-BV1A3Kr6BERQ-38s-sisi.wav","seconds":38,"ms":57984}

# 清唱（副歌检测 + 无混响）
node D:\Nexus\voice-ai\client\sing-request.mjs --bv BV1A3411J7HX --acapella
# → chorusDetected:true, startAt:129（218 秒的歌，落在第二段副歌）

# 完整版
node D:\Nexus\voice-ai\client\sing-request.mjs --bv BV1Ps4y1a7x8 --full
# → {"full":true,"totalSeconds":274,"mb":46.1}

# 文件发送（QQ）
POST /api/socialV2/send-file {key,file,name} → 200 + onebot.file_id

# 音源品质
node scripts/fetch-audio.mjs BV1Ps4y1a7x8 → 选定音质：Hi-Res FLAC 1638kbps
```

实测数据（2026-11-09）：3 分半的歌端到端 **58 秒**；分离 20~30 秒；换嗓（45 秒片段）5~10 秒；显存溢出修复前单首最长 663 秒且会崩，修复后稳定。

## 回滚

- 关掉能力：MCP 工具可随时停用（模型不再看到 `qq_sing`）；`send-file` 路由可单独移除，不影响语音条。
- 凭据回滚：`~/.dsh/surfcore/bili/credentials.json.bak-*` 直接改回原名即可。
- 渲染机：旧版 `sing_server.py` 在共享盘历史备份中；`start.ps1` 重启即加载。

## 残余风险

- 素材来自录播，模型带一点「播客感」；清唱瑕疵会放大（无伴奏掩盖）。
- 不是每个 B站视频都有 FLAC；AAC 回退时音质提升有限。
- QQ 语音条 300 秒/20MB，完整版必须走文件；文件大小上限 200MB，超过需切段。
- MCP 工具描述在 DSH 启动时快照，改描述必须重启才能被模型看到（行为改动不受影响）。

## 补充（同日 13:00 前后）

### 新增机制

1. **女声独唱优先选歌**（`scoreFemaleSolo()`）：按标题关键词打分，女声/女生/女版 +3，对唱/合唱 -4，男声 -3，伴奏/remix -5。输出带 `picks`（前 5 名及分数）便于追溯。
2. **自动识别男女对唱**：不依赖模型判断，也不依赖音量（实测音量判据会把女声独唱误判成对唱：串音只差 2.1dB）。改为**基频差**——对目标 30~50 秒片段跑一次 `engine=chorus`，比较两条人声轨的中位基频：
   - 学猫叫副歌：主唱 205Hz / male 125Hz → 对唱 ✅
   - 小幸运：主唱 205Hz / male 205Hz（串音）→ 独唱 ✅
   - 判据：`maleF0 < vocalF0 - 30Hz` 且两轨有声帧占比 > 30%
3. **三层混音（对唱）**：女声换嗓 + 男声保留原唱(0.85) + 伴奏(0.60)。
4. **`qq_send_file` + `/api/socialV2/send-file`**：完整版走 QQ 文件（语音条 300s/20MB 上限），只允许语音库目录、200MB 上限。
5. **语音配额 10→30 条/小时**（`socialV2.voice.maxPerHour`），工具描述补充限流话术（「你等我一会儿」而不是报错）。
6. **`--start` 手动起点 + 文件名带起点/模型/duet 标记**（对比实验时被覆盖过两次）。

### 引擎对比结论（demucs vs karaoke）

同段 30 秒、同模型：`demucs` r=0.043 / 低频 -14.5dB；`karaoke` r=0.033 / -15.5dB；听感「差不多」。
→ 默认保持 demucs，karaoke 仅作和声重歌曲的可选引擎，不做自动切换（需跑两次分离，收益不抵成本）。

### 验证（随机歌曲端到端）

随机抽「有点甜」（汪苏泷 & BY2，对唱）：

```json
{"ok":true,"file":"sing-BV15u411H7kP-38s-duet-sisi.wav","seconds":38,
 "section":"verse","duetProbe":{"vocalF0":250,"maleF0":125},"ms":84124}
```

- 自动选中 Hi-Res 版本（picks 前 5 名均 +1）
- 自动识别为对唱（250Hz vs 125Hz）
- 自动主歌起点 24 秒
- 端到端 **84 秒**，语音发送 verified

### 残余风险（更新）

- 自动对唱探针多约 20 秒；若片段内只有一方在唱，可能漏判（可用 `duet=true` 强制）。
- 女声优先依赖标题关键词，纯男声歌仍会被选中（分数最高者），换嗓后偏中性。
- karaoke 引擎未参与自动选择，需要手动 `--engine karaoke`。
## 补充二（同日 14:30 前后）：选歌策略收敛到「女声原唱独唱」

### 用户最终要求

- 只唱**女声原唱独唱**；
- **不要**女声翻唱版；
- 男声原唱 → 不硬唱，直接说换一首；
- 男女对唱 → 先问对方要不要只唱女声部分。

### 选歌流水线（五层，`searchSong()`）

1. **时长闸门**：搜索结果里的 `时长` 字段 > 8 分钟直接排除（合集/串烧源头，实测遇到过 217MB、3 小时的源）；
2. **排除现场/演唱会**：演唱会、现场、live、concert、应援、粉丝、音乐节、巡演、livehouse；
3. **排除合集**：合集、精选、串烧、歌单、100首、50首、循环播；
4. **排除对唱标题**：对唱、合唱、双人、男女、feat、`A&B`；
5. **排除男歌手 + 翻唱**：男歌手名录（标题与 UP 名都比），以及 `翻唱/cover/模仿/扒带`；
6. 白名单优先：官方、MV、无损、Hi-Res、4K、原唱、录音棚；
7. 内容打分：女声/女生/女版 +3、独唱 +2、原唱/无损 +1、对唱 -4、男声 -3、伴奏/remix -5、AI 生成（SUNO 等）-9。

### 歌曲性别表（方案 A+C）

`voice-ai/config/song-gender.json`：

```json
{ "起风了": "f", "小幸运": "f", "晴天": "m", "告白气球": "m", "学猫叫": "duet" }
```

| 值 | 行为 |
|---|---|
| `f` | 正常搜、正常出 |
| `m` | 直接返回 `MALE_SONG`（她回「这首原唱是男声，换一首女声的吧」） |
| `duet` | 返回 `DUET_DETECTED`（先问要不要只唱女声部分） |
| 表外 | 按未知处理，允许尝试（C：接受偶发漏网） |

### 对唱检测判据的演进（踩了三次）

| 版本 | 判据 | 结果 |
|---|---|---|
| v1 | 只看 `male.wav` 音量（差 <12dB 算对唱） | ❌ 女声独唱串音也差 2.1dB → 全误判 |
| v2 | 基频差 >30Hz | ❌ 《起风了》贝斯残留 78Hz 被当男声 |
| v3 | 基频比 0.52~0.72 + 男声 85~200Hz + 音量差 <12dB | ✅ 学猫叫 125/205=0.61 命中；❌ 小酒窝 131/296=0.44 漏判 |
| 现状 | v3 + 歌曲性别表兜底 | ✅ 表内全对，表外靠 v3 |

### 为什么不能用音频判断性别（关键结论）

| 歌手 | 人声基频中位 | 谱质心 |
|---|---|---|
| 林俊杰（男） | **286 Hz** | 3026 Hz |
| 田馥甄（女） | **286 Hz** | 3480 Hz |

男高音与女声在频域**完全重叠**，没有可靠声学特征；只能靠标题、UP 名、歌曲性别表这些外部信息。

### 新增错误码

| code | 场景 | 角色反应 |
|---|---|---|
| `MALE_SONG` | 性别表判定男声原唱 | 建议换一首女声的歌 |
| `DUET_DETECTED` | 对唱（表内或音频探针） | 先问要不要只唱女声部分 |
| `SOURCE_TOO_LONG` | 源 > 8 分钟 / 下载超 125MB | 说这首像合集，换一首 |

### 验证（5 首）

| 歌曲 | 期望 | 实际 |
|---|---|---|
| 起风了 | 女声 | ✅ 买辣椒也用券原版 |
| 小幸运 | 女声 | ✅ 4K珍藏田馥甄 |
| 晴天 | 男声拒绝 | ✅ `MALE_SONG` |
| 告白气球 | 男声拒绝 | ✅ `MALE_SONG` |
| 学猫叫 | 对唱先问 | ✅ `DUET_DETECTED` |

### 残余风险（更新）

- 表外歌曲且标题/UP 不写歌手名时（如「这才是晴天原版MV！」），男声版会漏过筛选——按 C 方案接受，用户听出来再换。
- 男歌手名录与歌曲性别表都需要人工维护，冷门歌覆盖不到。
- 女声翻唱版被硬排除后，对唱歌曲在 QQ 里只能「只唱女声部分」或换歌。
## 补充三（同日 14:40）：定稿与实测收尾

### 本轮新增验证

1. **开头噪声跳过实战命中**：《像鱼》（BV1ET4y1U7Aw）自动选段后检测到开头 2 秒掌声/说话，`noiseSkip: 2`，自动后移再截，成品无杂音。
2. **MALE_SONG 实测**：《晴天》《告白气球》均返回 `MALE_SONG`（性别表命中），未浪费下载/分离。
3. **DUET_DETECTED 实测**：《学猫叫》《小酒窝》均返回该码（性别表 + 音频探针双重命中）。
4. **随机新歌端到端**：`--song "像鱼"` → 32 秒成品，90 秒完成，语音发送 verified。

### 当前已知限制（定稿状态）

| 项 | 状态 |
|---|---|
| 表外歌曲且标题/UP 无歌手名 | 可能选到男声版（方案 C 接受） |
| 性别判定 | 只能靠外部信息，音频不可判（286Hz 重叠） |
| 女声翻唱 | 已禁用（用户要求） |
| 对唱 | 需用户明确 duet=true 才做 |

### 收尾事项

- **git 提交未执行**：本机（VM）未安装 git（`where git` 无结果、常见路径均无 `git.exe`），
  仅有 `.git` 目录。提交需在装有 git 的环境执行，命令清单见发布队列批次说明。
- 发布队列已登记：`docs/RELEASE-QUEUE.md` 批次 `2026-11-09 14:30`。
## 补充四（同日 15:20）：音源收敛到网易云 + 默认引擎换 karaoke

### 音源：网易云单一来源

- 用户拍板：**只用网易云**；网易云没有原唱版本 → 直接换歌，**不再回退 B 站**。
- 登录：用独立 Edge 配置登录网易云（`D:\Nexus\edge-netease`），通过 CDP `Network.getAllCookies`
  读明文 cookie 写入 `voice-ai/config/netease-cookie.txt`（账号 Neko_wl，vipType 110）。
  > 主 Edge 的 cookie 是 v20 app-bound 加密，复制 profile 后新实例也读不出（实测 0 条），只能走独立配置。
- 取歌：`scripts/fetch-netease.mjs`，`/api/search/get` 搜索 → 歌手名双向下标匹配 +
  可疑名过滤（迷妹/翻唱/cover/伴奏/工作室）→ 现场版直接剔除 → `song/enhance/player/url/v1`
  取 lossless → 下载 flac。
- 实测音质：起风了 **2832kbps**、后来 919、光年之外 887、红豆 866（对比 B 站 Hi-Res 1638）。
- 覆盖缺口：小幸运（田馥甄）、体面（于文文）在网易云无原唱/仅 Live → `SONG_NOT_AVAILABLE`。
- 新增错误码：`SONG_NOT_AVAILABLE`（建议换歌，不许去 B 站找替代）。

### 默认分离引擎：demucs → karaoke

| 引擎 | vocals/no_vocals 相关 | 低频残留 | 30 秒耗时 |
|---|---|---|---|
| demucs（htdemucs_ft） | 0.043 | -14.5 dB | 12s |
| **karaoke（mel_band_robertformer）** | **0.033** | **-15.5 dB** | 12s |

听感接近、耗时相同、指标略好 → 默认改 karaoke；需要时 `--engine demucs` / `--engine chorus`。
踩坑：`--engine karaoke` 早期被静默当成 demucs（只特判了 chorus），已改成通用处理。

### 对唱探针的适用范围收窄

网易云是按「歌名+歌手」精确取的，不存在 B 站那种一条视频两个歌手，所以
**对唱探针只对 B 站源启用**；网易云源直接跳过，避免把女声独唱误判成对唱。

### 同步更新

- `voice-ai/README.md`：§4.2 重写、默认引擎与音源表更新
- 共享盘 `Z:\NVME\唱歌\voice-ai\` 已同步 sing-request / fetch-netease / netease-login / song-gender
## 补充五（同日 15:55）：截取从「半句话突然开始/切断」改成按乐句边界

### 问题

原先起点/终点是算术：`第一次开口 + 5s` 起，固定随机 30~50 秒。
结果经常从半句话中间切入，或在半句上切断。

### 三级修正

1. **静音检测定句界**：`silencedetect=noise=-35dB:d=0.25` → 得到静音区间，
   起点吸到「静音结束后」、终点吸到「静音开始前」，取落在 30~50 秒内的句尾。
2. **起音点精修**：人声密的歌没有静音，改用能量包络：
   在目标点 ±15 秒内找「明显低于中位数（<42%）的局部低谷」，再找低谷之后的能量上升沿，
   起点定为上升沿之前 60ms（含辅音起音）。
3. **淡入淡出兜底**：混音末尾统一加 `afade in 0.15s / out 0.35s`（全长版按实际时长算）。
   即使乐句边界没找准，听感上也不会「啪」一下出现或消失。

### 实测

| 歌曲 | 首 30ms 响度（改前 → 改后） | 说明 |
|---|---|---|
| 年轮 | -15 dB → **-50 dB** | 人声极密，靠低谷+淡入解决 |
| 泡沫 | -20 dB → **-44 dB** | 本来就有换气间隙，边界更自然 |

### 局限

- 人声从头到尾没有间隙的歌（如《年轮》副歌段），只能靠「低谷 + 淡入」软化，无法做到绝对自然；
- 静音阈值 -35dB 对伴奏很轻的曲子可能误判，必要时调 `silencedetect` 参数。
## 补充六（2026-11-10 04:30）：取消服务端 45s 分片

用户要求去掉「防显存溢出的 45 秒分段」，改成**单次推理**。

### 实测（渲染机 192.168.1.21:8877）

| 输入时长 | 结果 | 耗时 |
|---|---|---|
| 75 秒 | ✅ 单次完成 | 14.9 秒 |
| 150 秒 | ✅ 单次完成 | 14.3 秒 |

`/v1/health` 里 `chunkSec: 0`，说明服务端已是单次推理；客户端不再依赖分片，
但仍保留 30~50 秒切段（那是语音条时长需求，不是显存需求）。

### 之前的「45 秒分片」是怎么来的

早期整首上传（3~5 分钟人声）导致 RVC 显存溢出 / WDDM 分页，进程被杀（`exit 4294967295`，单首挂 663 秒）。
当时用「客户端先切 30~50 秒 + 服务端 45s 分片 + 队列 4」兜底。现在显存问题已稳定，
分片去掉后 150 秒输入也能一次跑完（14 秒）。