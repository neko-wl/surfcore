// 承诺定时（promise）回归。
//
// 这套东西的风险不在调度，在**认错时间**：解析错一次就会在不相干的时刻突然冒出来。
// 所以这里把中文时间表达逐个钉死，再验调度/去重/错过/取消。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { computeAskFireAt, computePromiseFireAt, detectIncomingPromise, detectPromise, parseChineseNumber, parseClockTime, parseHHMM } from '../src/promise-time.mjs';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const KEY = 'private:123';
/** 造一个本地时刻，避免测试绑死时区。 */
function at(dayOffset, hour, minute) {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

// ── 时间解析 ──────────────────────────────────────────────────────────────
await test('parseChineseNumber：十一/二十/两/纯数字', () => {
  assert.equal(parseChineseNumber('十一'), 11);
  assert.equal(parseChineseNumber('十'), 10);
  assert.equal(parseChineseNumber('二十三'), 23);
  assert.equal(parseChineseNumber('两'), 2);
  assert.equal(parseChineseNumber('7'), 7);
  assert.equal(parseChineseNumber('半'), null);
});

await test('parseClockTime：冒号 / 点 / 中文 / 半点', () => {
  assert.deepEqual(parseClockTime('23:30'), { hour: 23, minute: 30 });
  assert.deepEqual(parseClockTime('晚上11:05'), { hour: 11, minute: 5 });
  assert.deepEqual(parseClockTime('十一点半'), { hour: 11, minute: 30 });
  assert.deepEqual(parseClockTime('十点'), { hour: 10, minute: 0 });
  assert.deepEqual(parseClockTime('十一点三十分'), { hour: 11, minute: 30 });
  assert.deepEqual(parseClockTime('25:00'), null, '越界不认');
  assert.equal(parseClockTime('晚一点'), null, '没有具体钟点');
});

await test('detectPromise：认得出「今晚十一点半来找你」', () => {
  const now = at(0, 22, 19);
  const hit = detectPromise('好，那我今晚十一点半来找你，快去睡', now);
  assert.ok(hit, '应当认出约定');
  assert.equal(new Date(hit.forAt).getHours(), 23, '「晚上/今晚 + 11 点」要补成 23 点');
  assert.equal(new Date(hit.forAt).getMinutes(), 30);
});

await test('detectPromise：没有「约」的语气 / 过去的事 / 没具体钟点，都不登记', () => {
  const now = at(0, 22, 19);
  assert.equal(detectPromise('我十点就睡了', now), null, '没约');
  assert.equal(detectPromise('昨天十一点半我们聊到很晚', now), null, '过去的事');
  assert.equal(detectPromise('晚点来找你', now), null, '没具体钟点');
  assert.equal(detectPromise('今晚十一点半来找你', at(0, 23, 40)), null, '时间点已经过了就不猜明天');
});

await test('detectPromise：明天九点喊你起床 → 次日 09:00', () => {
  const now = at(0, 22, 0);
  const hit = detectPromise('明天九点喊你起床', now);
  assert.ok(hit);
  const d = new Date(hit.forAt);
  assert.equal(d.getDate(), new Date(at(1, 9, 0)).getDate(), '要跨到明天');
  assert.equal(d.getHours(), 9);
});

await test('computePromiseFireAt：只落在 [约定-提前量, 约定] 区间内', () => {
  const forAt = 1_700_000_000_000;
  const lead = 10 * 60 * 1000;
  assert.equal(computePromiseFireAt(forAt, lead, () => 0), forAt - lead, 'rand=0 → 窗口起点');
  const high = computePromiseFireAt(forAt, lead, () => 0.999999);
  assert.ok(high < forAt, '永远不越过约定时刻本身');
  assert.ok(high >= forAt - lead);
  assert.equal(computePromiseFireAt(forAt, 0, () => 0.5), forAt, '提前量为 0 时就是准点');
});

await test('parseHHMM：工具入参只认 24 小时制', () => {
  assert.deepEqual(parseHHMM('23:30'), { hour: 23, minute: 30 });
  assert.deepEqual(parseHHMM('9:05'), { hour: 9, minute: 5 });
  assert.equal(parseHHMM('23-30'), null);
  assert.equal(parseHHMM('24:00'), null);
});

// ── 登记与调度（真 bridge.js + VM 夹具）──────────────────────────────────
await test('登记 → 到点赴约：唤醒原因带 promise:<id>', async () => {
  const h = await bridgeHarness({ config: { socialV2: { enabled: true } } });
  try {
    h.setMode('reserved2');
    h.getSocialV2State(KEY);
    const res = h.registerPromiseV2(KEY, { forAt: Date.now() + 5 * 60_000, text: '今晚来找你', source: 'tool' });
    assert.equal(res.ok, true);
    // 把触发点挪到过去，等价于「随机挑中的那一刻已经到了」。
    res.promise.fireAt = Date.now() - 1;
    const before = h.calls.created.length;
    h.runPromiseTick();
    const started = Date.now();
    while (h.calls.created.length === before && Date.now() - started < 2000) await new Promise((r) => setTimeout(r, 10));
    assert.ok(h.calls.created.length > before, '到点必须唤醒');
    assert.equal(h.getSocialV2State(KEY).lastWakeReason, `promise:${res.promise.id}`);
  } finally { h.dispose?.(); }
});

await test('幂等：同一条约定只赴约一次', async () => {
  const h = await bridgeHarness({ config: { socialV2: { enabled: true } } });
  try {
    h.setMode('reserved2');
    h.getSocialV2State(KEY);
    const res = h.registerPromiseV2(KEY, { forAt: Date.now() + 5 * 60_000, source: 'tool' });
    res.promise.fireAt = Date.now() - 1;
    const before = h.calls.created.length;
    h.runPromiseTick();
    const started = Date.now();
    while (h.calls.created.length === before && Date.now() - started < 2000) await new Promise((r) => setTimeout(r, 10));
    const afterFirst = h.calls.created.length;
    h.runPromiseTick();
    h.runPromiseTick();
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(h.calls.created.length, afterFirst, '不得重复赴约');
  } finally { h.dispose?.(); }
});

await test('超过补发窗口：记 missed，不唤醒', async () => {
  const h = await bridgeHarness({ config: { socialV2: { enabled: true } } });
  try {
    h.setMode('reserved2');
    h.getSocialV2State(KEY);
    const res = h.registerPromiseV2(KEY, { forAt: Date.now() + 5 * 60_000, source: 'tool' });
    res.promise.forAt = Date.now() - 60 * 60_000;
    res.promise.fireAt = Date.now() - 90 * 60_000;
    const before = h.calls.created.length;
    h.runPromiseTick();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(h.calls.created.length, before, '过期不得再叫');
    assert.equal(res.promise.status, 'missed', '要留下 missed 状态，不能静默');
  } finally { h.dispose?.(); }
});

await test('取消后不再赴约', async () => {
  const h = await bridgeHarness({ config: { socialV2: { enabled: true } } });
  try {
    h.setMode('reserved2');
    h.getSocialV2State(KEY);
    const res = h.registerPromiseV2(KEY, { forAt: Date.now() + 5 * 60_000, source: 'tool' });
    const cancelled = h.cancelPromiseV2(KEY, res.promise.id);
    assert.equal(cancelled.ok, true);
    res.promise.fireAt = Date.now() - 1;
    const before = h.calls.created.length;
    h.runPromiseTick();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(h.calls.created.length, before, '取消后不得唤醒');
  } finally { h.dispose?.(); }
});

await test('失败路径有 code + hint（不静默）', async () => {
  const h = await bridgeHarness({ config: { socialV2: { enabled: true } } });
  try {
    h.setMode('reserved2');
    h.getSocialV2State(KEY);
    const past = h.registerPromiseV2(KEY, { forAt: Date.now() - 60_000, source: 'tool' });
    assert.equal(past.ok, false);
    assert.ok(past.code && past.hint, '过去的时间必须给出 code 与 hint');
    const none = h.cancelPromiseV2(KEY, '');
    assert.equal(none.ok, false);
    assert.ok(none.code && none.hint, '没有可取消的约定也要说清楚');
  } finally { h.dispose?.(); }
});

await test('出站扫描：她自己说了就算数（工具没调也能兜住）', async () => {
  const h = await bridgeHarness({ config: { socialV2: { enabled: true } } });
  try {
    h.setMode('reserved2');
    const st = h.getSocialV2State(KEY);
    h.notePromiseFromOutbound(KEY, ['好呀，那我今晚十一点半来找你']);
    const list = h.promisesOf(st);
    assert.equal(list.length, 1, '应当自动登记一条');
    assert.equal(list[0].source, 'scan');
    // 同一句话重复记录不重复登记
    h.notePromiseFromOutbound(KEY, ['好呀，那我今晚十一点半来找你']);
    assert.equal(h.promisesOf(st).filter((p) => p.status === 'pending').length, 1, '同一时刻只留一条');
    // 不是承诺的话不登记
    h.notePromiseFromOutbound(KEY, ['我今天十点就睡了']);
    assert.equal(h.promisesOf(st).filter((p) => p.status === 'pending').length, 1);
  } finally { h.dispose?.(); }
});

// ── 反向：对方答应来找她（等不到人 → 追问） ───────────────────────────────
await test('detectIncomingPromise：认得出「我今晚十一点半来找你」', () => {
  const now = at(0, 22, 0);
  const hit = detectIncomingPromise('我今晚十一点半来找你', now);
  assert.ok(hit, '应当认出对方的约定');
  assert.equal(hit.direction, 'in');
  assert.equal(new Date(hit.forAt).getHours(), 23);
  assert.equal(new Date(hit.forAt).getMinutes(), 30);
});

await test('detectIncomingPromise：没有第一人称/没有「过去」的动作，都不登记', () => {
  const now = at(0, 22, 0);
  assert.equal(detectIncomingPromise('今晚十一点半', now), null, '没说谁来');
  assert.equal(detectIncomingPromise('我十点就睡了', now), null, '不是来赴约');
  assert.equal(detectIncomingPromise('我去睡了，晚安', now), null, '只是去睡觉');
  assert.equal(detectIncomingPromise('昨天我十一点半来找你', now), null, '过去的事');
});

await test('computeAskFireAt：落在 [约定+等多久, 约定+等多久+追问窗口]', () => {
  const forAt = 1_700_000_000_000;
  const miss = 10 * 60 * 1000;
  const win = 10 * 60 * 1000;
  assert.equal(computeAskFireAt(forAt, miss, win, () => 0), forAt + miss, 'rand=0 → 窗口起点');
  const high = computeAskFireAt(forAt, miss, win, () => 0.999999);
  assert.ok(high > forAt + miss, '不能早于「算他爽约」的时刻');
  assert.ok(high < forAt + miss + win, '不能越过追问窗口终点');
});

await test('等不到人：到点后没人说话 → 追问一次（noshow）', async () => {
  const h = await bridgeHarness({ config: { socialV2: { enabled: true } } });
  try {
    h.setMode('reserved2');
    const st = h.getSocialV2State(KEY);
    const res = h.registerPromiseV2(KEY, { forAt: Date.now() + 5 * 60_000, source: 'tool', direction: 'in' });
    assert.equal(res.promise.direction, 'in');
    assert.equal(res.promise.fireAt, undefined, '反向的没有「提前赴约」触发点');
    assert.ok(res.promise.askAt, '反向的要有追问时刻');
    // 造出「约定已过、追问时刻已到、期间没人说话」
    res.promise.forAt = Date.now() - 5 * 60_000;
    res.promise.askAt = Date.now() - 1;
    st.lastIncomingAt = Date.now() - 60 * 60_000;
    const before = h.calls.created.length;
    h.runPromiseTick();
    const started = Date.now();
    while (h.calls.created.length === before && Date.now() - started < 2000) await new Promise((r) => setTimeout(r, 10));
    assert.ok(h.calls.created.length > before, '等不到人必须叫醒她去问');
    assert.equal(h.getSocialV2State(KEY).lastWakeReason, `noshow:${res.promise.id}`);
  } finally { h.dispose?.(); }
});

await test('人来了：约定之后有过入站消息 → 不追问', async () => {
  const h = await bridgeHarness({ config: { socialV2: { enabled: true } } });
  try {
    h.setMode('reserved2');
    const st = h.getSocialV2State(KEY);
    const res = h.registerPromiseV2(KEY, { forAt: Date.now() + 5 * 60_000, source: 'tool', direction: 'in' });
    res.promise.forAt = Date.now() - 5 * 60_000;
    res.promise.askAt = Date.now() - 1;
    // 约定之后他说过话
    st.lastIncomingAt = Date.now();
    const before = h.calls.created.length;
    h.runPromiseTick();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(h.calls.created.length, before, '人来了就不该再问');
    assert.equal(res.promise.status, 'kept', '要记为「如约出现」而不是静默');
  } finally { h.dispose?.(); }
});

await test('入站扫描：他自己说了「我 11 点半来找你」就登记', async () => {
  const h = await bridgeHarness({ config: { socialV2: { enabled: true } } });
  try {
    h.setMode('reserved2');
    const st = h.getSocialV2State(KEY);
    h.notePromiseFromIncoming(KEY, { text: '我今晚十一点半来找你', plain: '我今晚十一点半来找你', isSelf: false, isOwner: true, time: Date.now() });
    const list = h.promisesOf(st);
    assert.equal(list.length, 1);
    assert.equal(list[0].direction, 'in', '方向必须标成对方来');
    // 她自己的发言走另一个入口，不该被这个钩子重复登记
    h.notePromiseFromIncoming(KEY, { text: '我今晚十一点半来找你', plain: '我今晚十一点半来找你', isSelf: true, time: Date.now() });
    assert.equal(h.promisesOf(st).length, 1);
  } finally { h.dispose?.(); }
});

if (failures) {
  console.error(`\n${failures} 个用例失败`);
  process.exit(1);
}
console.log('\n全部通过');
