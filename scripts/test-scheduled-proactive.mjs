// 定点主动（scheduledProactive）回归。
//
// 钉住的边界（每条对应一个真实失败形态）：
//   1. 到点必发：不吃夜间概率折扣、不吃收尾冷却 —— 这是这个功能存在的唯一理由；
//   2. 同一天同一 item 只投一次（心跳 30 秒一拍，没有去重就会连环刷屏）；
//   3. 停机错过：还在 graceMs 内 → 开机补发；超了 → 记为 missed 并留日志，不静默吞掉；
//   4. 会话没建立过 → 不主动创建 DSH 会话（凭空烧 token，且可能是 key 写错）；
//   5. 配置错误（时间格式 / 缺 keys / disabled）→ 丢弃该条，不影响别的条目；
//   6. 唤醒提示词必须自报家门是「定点」，不能让模型误以为又是随机机会。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { normalizeScheduledItems, scheduledDayKey, scheduledDueState } from '../src/scheduled-proactive.mjs';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const KEY = 'private:123';
const pad = (n) => String(n).padStart(2, '0');
/** 用「现在往前 offset 分钟」的本地时刻，避免把测试绑死在某个固定钟点上。 */
function hhmm(offsetMinutes = 0) {
  const d = new Date(Date.now() + offsetMinutes * 60_000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function itemConfig(time, extra = {}) {
  return {
    socialV2: {
      enabled: true,
      scheduledProactive: {
        enabled: true,
        items: [{ id: 'night-check', time, keys: [KEY], text: '约定的查岗：催主人去睡', ...extra }],
      },
    },
  };
}
/** 等到 predicate 为真；sendWakePromptV2 是异步投递，tick 本身是同步函数。 */
async function waitFor(predicate, label, timeoutMs = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待超时：${label}`);
}

// ── 纯函数 ────────────────────────────────────────────────────────────────
await test('normalizeScheduledItems：丢弃时间格式错/缺 keys/disabled 的条目', () => {
  const out = normalizeScheduledItems({
    enabled: true,
    items: [
      { id: 'ok', time: '23:30', keys: [KEY] },
      { id: 'bad-time', time: '25:00', keys: [KEY] },
      { id: 'bad-format', time: '晚上十一点', keys: [KEY] },
      { id: 'no-keys', time: '23:30', keys: [] },
      { id: 'bad-key', time: '23:30', keys: ['private:abc'] },
      { id: 'off', time: '23:30', keys: [KEY], enabled: false },
    ],
  });
  assert.deepEqual(out.map((i) => i.id), ['ok'], '只有合法条目能活下来');
  assert.equal(out[0].graceMs, 30 * 60 * 1000, 'grace 默认 30 分钟');
  assert.equal(normalizeScheduledItems({ enabled: false, items: [{ time: '23:30', keys: [KEY] }] }).length, 0, '总开关关闭时一条都不许生效');
  assert.equal(normalizeScheduledItems(undefined).length, 0);
});

await test('scheduledDueState：未到点 / 窗口内 / 超窗口三种状态', () => {
  // 用本地时刻构造，不写死字符串：桥接按本地钟走，测试若依赖固定时区会在别的机器上假绿/假红。
  const at = (hour, minute, second = 0, dayOffset = 0) => {
    const d = new Date();
    d.setDate(d.getDate() + dayOffset);
    d.setHours(hour, minute, second, 0);
    return d.getTime();
  };
  const mk = (time, graceMs = 30 * 60 * 1000) => ({ time, graceMs, keys: [KEY], id: 'x' });
  assert.equal(scheduledDueState(mk('23:30'), at(23, 20)), null, '没到点不触发');
  assert.equal(scheduledDueState(mk('23:30'), at(23, 30, 20)).state, 'due', '到点即触发');
  assert.equal(scheduledDueState(mk('23:30'), at(23, 45)).state, 'due', '窗口内仍算 due（停机补发）');
  assert.equal(scheduledDueState(mk('00:05'), at(23, 45)).state, 'missed', '超窗口记 missed，不静默跳过');
  assert.equal(scheduledDueState(mk('25:00'), at(23, 45)), null, '非法时刻不产生状态');
  assert.equal(scheduledDayKey(at(23, 45)), `${new Date().getFullYear()}-${pad(new Date().getMonth() + 1)}-${pad(new Date().getDate())}`);
});

// ── 端到端（真 bridge.js + VM 夹具）─────────────────────────────────────
await test('到点必发：配置 1 分钟前 → 唤醒一次，lastWakeReason 是 scheduled:<id>', async () => {
  const h = await bridgeHarness({ config: itemConfig(hhmm(-1)) });
  try {
    h.setMode('reserved2');
    h.getSocialV2State(KEY); // 会话已建立过
    const before = h.calls.created.length;
    h.runScheduledProactiveTick();
    await waitFor(() => h.calls.created.length > before, '唤醒并创建 DSH 会话');
    assert.equal(h.getSocialV2State(KEY).lastWakeReason, 'scheduled:night-check', '唤醒原因要能追到具体条目');
  } finally { h.dispose?.(); }
});

await test('幂等：同一拍连跑两次只投一次', async () => {
  const h = await bridgeHarness({ config: itemConfig(hhmm(-1)) });
  try {
    h.setMode('reserved2');
    h.getSocialV2State(KEY);
    const before = h.calls.created.length;
    h.runScheduledProactiveTick();
    await waitFor(() => h.calls.created.length > before, '第一拍投递');
    const afterFirst = h.calls.created.length;
    h.runScheduledProactiveTick();
    h.runScheduledProactiveTick();
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(h.calls.created.length, afterFirst, '同一天同一 item 不得重复投递');
  } finally { h.dispose?.(); }
});

await test('错过补发窗口：不唤醒，但记 missed 标记（失败可见）', async () => {
  // 不能直接用「现在 -90 分钟」：跨过午夜时会落到昨天，同一天的判定自然看不到它。
  // 改成「今天凌晨到现在的某个已过时刻」，再把补发窗口压到 1 分钟。
  const now = new Date();
  const minutesToday = now.getHours() * 60 + now.getMinutes();
  const past = Math.max(0, minutesToday - 90);
  const pastTime = `${pad(Math.floor(past / 60))}:${pad(past % 60)}`;
  const h = await bridgeHarness({ config: itemConfig(pastTime, { graceMs: 60 * 1000 }) });
  try {
    h.setMode('reserved2');
    const st = h.getSocialV2State(KEY);
    const before = h.calls.created.length;
    h.runScheduledProactiveTick();
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(h.calls.created.length, before, '超窗口不得补发');
    assert.equal(st.scheduledProactiveFired?.['night-check'], `missed:${scheduledDayKey(Date.now())}`, '必须留下 missed 记录，不能当作没发生');
  } finally { h.dispose?.(); }
});

await test('会话没建立过：不主动创建 DSH 会话', async () => {
  const h = await bridgeHarness({ config: itemConfig(hhmm(-1)) });
  try {
    h.setMode('reserved2');
    const before = h.calls.created.length;
    h.runScheduledProactiveTick(); // 不先 getSocialV2State
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(h.calls.created.length, before, '凭空创建会话会烧 token，必须挡住');
  } finally { h.dispose?.(); }
});

await test('唤醒提示词自报「定点主动」，并带上配置里的由头', async () => {
  const h = await bridgeHarness({ config: itemConfig('23:30') });
  try {
    const prompt = h.buildWakePromptV2(KEY, 'scheduled:night-check');
    assert.match(prompt, /【定点主动】/, '必须和随机【主动机会】区分开');
    assert.match(prompt, /约定的查岗：催主人去睡/, '配置里的 text 要进提示词');
    assert.match(prompt, /23:30/, '要告诉模型约定的是几点');
  } finally { h.dispose?.(); }
});

if (failures) {
  console.error(`\n${failures} 个用例失败`);
  process.exit(1);
}
console.log('\n全部通过');
