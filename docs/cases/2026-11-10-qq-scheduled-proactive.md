# QQ：定点主动（到点必发的约定）

日期：2026-11-10
版本：待定（dev）
相关：`src/bridge.js`、`src/scheduled-proactive.mjs`、`config.example.json`

## 现象

AI 在 QQ 私聊里跟主人约好「十一点半查岗催他去睡」，22:19 还写进了对话收尾记录。23:30 什么都没发，23:42 主人来问「说好 11:30 主动发起聊天，现在却没有发起」。

桥接日志把两条时间线都留了下来：

```
22:19:04 [收尾] private:40722995 自然结束（natural）：…还约好十一点半查岗催他去睡。
21:39:28 [目的] 暂不出发：daily-max，下次 2026/11/11 10:30:00      ← 今天 4 次用完了
23:30:17 [目的] 安静时段，等到 2026/11/11 10:30:00 之后再看        ← quietStart=23:30
22:28:02 [收尾] private:40722995 冷却中，跳过本次主动机会
23:39:56 [reserved2] 已安排主动机会检查 private:40722995，约 72min 后
```

## 根因

**能把消息主动推出去的只有两条路，没有一条提供「到点必发」。**

1. `[目的]`（`purpose`）——有 `quietStart/quietEnd` 和 `dailyMax`。当天额度早用完，且 23:30 正好进安静时段。
2. `[reserved2] 主动机会`（`socialV2.proactive`）——间隔随机 30~90 分钟，再按概率判定。`src/bridge.js` 里那道算式是：

   ```
   prob = 0.3                     基础
        × 1.4  若有待说未说
        × 0.5  若 30 分钟内刚回过
        × 0.3  若 23 点后 / 8 点前     ← 夜里砍到 9%
        × 0.3  若 1 小时内自己已发 ≥5 条
   ```

   23:39 那一次净概率约 9%，没掷中；下一拍排在 72 分钟后（≈00:52），夜里仍是 9%。

而「十一点半」这个承诺只是一段自然语言，**没有任何东西把它翻译成定时器**。模型写那句话时也不知道自己的唤醒是概率制的。

> 一句话：不是它忘了，是它从来就没有准点能力。

## 修法

新增 `socialV2.scheduledProactive`：配置里写死本地时刻，到点必发。

```json
"scheduledProactive": {
  "enabled": true,
  "items": [
    { "id": "night-check", "time": "23:30", "keys": ["private:40722995"],
      "text": "约定的查岗：催主人去睡", "graceMs": 1800000 }
  ]
}
```

- 30 秒心跳检查（`startScheduledProactiveLoop`），本地钟判断；
- 同一天同一 `id` 只投一次（`st.scheduledProactiveFired[id] = 'YYYY-MM-DD'`）；
- 停机错过后，仍在 `graceMs`（默认 30 分钟）内 → 开机补发；超过 → 记 `missed:<日期>` 并打日志；
- 唤醒原因 `scheduled:<id>`，提示词分支是【定点主动】，明确告诉模型「这是约定，不是随机机会」，并把 `text` 作为「由头」带进去；
- 纯逻辑（归一化 / 日期键 / 到点判定）抽到 `src/scheduled-proactive.mjs`，可脱离桥接单测。

### 明确不做的（边界）

| 约束 | 为什么仍然保留 |
| --- | --- |
| 发送通道闸（`qqSendChannelStatus`） | 通道断了就是发不出去，硬发只会烧 token |
| 模式允许范围（`isSessionAllowedInCurrentMode`） | 定点不能成为绕过白名单的口子 |
| 唤醒暂停（`wakeSuspendedUntil`） | 连续发送失败后暂停中，再叫醒只会再失败一次 |
| 会话不存在就不创建 | 写错 key 或对方从没聊过时，不该凭空起一个 DSH 会话 |

**明确绕过的**：夜间概率折扣（`hour >= 23 → ×0.3`）、收尾冷却（`closureSuppressesWake`）。定点的意义就是准点，这两条一旦生效，这个功能就等于没做。

## 完整逻辑

### 1. 链路

`config.json` 的 `socialV2.scheduledProactive` → `startScheduledProactiveLoop()`（DSH 就绪时启动，`src/bridge.js` 约 3889 行）→ `setInterval(runScheduledProactiveTick, 30s)` → 命中的条目 → `sendWakePromptV2(key, 'scheduled:<id>')` → DSH 会话 → AI 通过 QQ 工具发消息。

读者：只有桥接进程自己。不改协议、不改 DSH 侧。

### 2. 机制

判定是「每个 tick 重新问一遍今天该不该发」，不是「排一个精确的 setTimeout」。原因：

- 精确 setTimeout 在跨天、睡眠唤醒、系统改时间时会漂；
- 30 秒粒度对「催睡」这种场景足够，而且天然自带「错过就补」的语义；
- 幂等靠 `scheduledProactiveFired` 日期键兜底，进程重启也不会重发。

### 3. 爆炸半径

进程数 1（桥接）× 读者 1。**不碰用户数据**，只新增一个 state 字段（`scheduledProactiveFired`，已加入 `saveSocialV2State` 白名单）。不发消息除非配置里显式写了条目 —— 默认 `items: []`，装载即静默。

### 4. 取舍

| 路线 | 收益 | 成本/风险 |
| --- | --- | --- |
| **A. 本次方案：配置化定点 + 30s tick**（选） | 准点 100%，与概率系统解耦，可单测 | 多一个心跳；配置要手写 |
| B. 调 `socialV2.proactive` 参数 | 不改代码 | 夜间 ×0.3 硬编码，最多 30%；且全天变吵 |
| C. 让 DSH 定时任务投递 | 不碰桥接 | 要跨进程两跳（DSH → 唤醒 QQ 会话），任一环断就静默失败 |

选 A：它把「准点」变成配置事实，而不是概率期望。

### 5. 生效与重启

改 `config.json` 后**必须重启桥接进程**（`src/bridge.js` 只在启动时读一次配置）。DSH 不用重启。

### 6. 验证

```bash
node scripts/test-scheduled-proactive.mjs     # 7 个用例
node scripts/test-audit.mjs                   # 门禁（见「未验证」）
node scripts/test-audit-regressions.mjs       # 桥接回归
```

线上验证：日志出现 `[定点] 已启动：1 条（23:30）；每 30 秒检查`，到点出现 `[定点] 到点投递 private:xxx（23:30 night-check · …）`。

### 7. 回滚与残余

- 回滚：`config.json` 里把 `scheduledProactive.enabled` 改 `false`，或整体删掉该块并重启；代码层无迁移、无数据格式变更。
- 残余：`test-audit.mjs` 有 3 条既有失败（`test-audit-setup.mjs`，`fs.cpSync` 在该环境静默不复制 `node_modules/js-yaml`）。**主工作区同样复现**，与本次改动无关，未修。

## 影响面

- 只新增一条主动路径；不改现有 `[目的]` / `[主动机会]` 的任何行为。
- 默认关闭（`items: []`），不配置就不会有任何新消息。
- 失败可见：错过窗口 → `[定点] 错过 …`；投递异常 → `[定点] 投递异常 …` 并写 `st.lastScheduledProactiveError`（含 `hint`）；会话没建立 → `[定点] 跳过 …`（每条每天只记一次，不刷屏）。
