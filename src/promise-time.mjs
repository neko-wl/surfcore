// 「她说几点来」→ 一个可执行的时刻。
//
// 为什么要单独成文件：中文时间表达（十一点半 / 晚上11:30 / 今晚十点）解析是这个功能里
// 唯一没法靠日志事后核对的部分 —— 解析错了就会在完全不相干的时刻冒出来。所以把它做成
// 纯函数，用固定文本钉死每一个能想到的写法，而不是塞进 bridge 里靠肉眼验。
//
// 设计原则：**宁可漏，不可错**。漏一次只是这次没按约来（还有工具登记兜底）；
// 猜错一次就是凌晨三点突然弹一句「我来啦」。

const CN_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 「十一」「二十」→ 数字；只用于 1~59 这种小范围。 */
export function parseChineseNumber(input) {
  const s = String(input ?? '').trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  if (/^十[一二三四五六七八九]?$/.test(s)) return 10 + (s.length > 1 ? CN_DIGITS[s[1]] : 0);
  if (/^[一二两三四五六七八九]十[一二三四五六七八九]?$/.test(s)) return CN_DIGITS[s[0]] * 10 + (s.length > 2 ? CN_DIGITS[s[2]] : 0);
  if (/^[一二两三四五六七八九]$/.test(s)) return CN_DIGITS[s];
  return null;
}

// 出现这些词才有「约」的意思，否则「我十点就睡了」也会被当成承诺。
const CUE_RE = /(约好|说好|答应|来找你|去找你|来找我|跟你聊|喊你|叫你|查岗|催你|等你|提醒你|见你|跟你见|发消息给你|跟你说话)/;

// 入站方向（**对方**答应来找她）：「我 11 点半来找你」「等我 11 点半」「我这就过来」。
// 必须带第一人称 + 明确的「过去」动作 —— 否则「我去睡了」这种也会中招。
const INCOMING_CUE_RE = /((我|咱)[^。！？\n]{0,12}(来找你|来见你|过来|到你那|到你家|准时到|我到了|见你|等你)|等我|我(马上|这就|立刻|准时就))/;

// 模糊承诺（没有具体时间）：「晚点找你」「稍后再聊」「待会儿说」「等下回你」。
// 必须跟一个「联系你」的动词，否则「早点睡」「一会儿就凉了」全都会中。
const VAGUE_CUE_RE = /(晚点|稍后|待会儿|待会|一会儿|一会|等会儿|等会|等下|马上)[^。！？\n]{0,10}(找你|来找|聊|说|回你|联系|过来|来|见|理你)/;

// 明显的过去/习惯叙述，一律不登记。
const PAST_RE = /(昨天|昨晚|前天|刚才|已经|早就|上个|上一次|平时|每天|以前)/;

// 时段修饰：晚上/今晚默认按当下这一天；明天/明晚 +1 天。
const NEXT_DAY_RE = /(明天|明晚|明儿|次日)/;
const EVENING_RE = /(晚上|今晚|夜里|夜间|傍晚|下午|中午|早上|早晨|上午)/;

// 「晚一点」「快一点」「少一点」里的「一点」不是钟点。紧跟在这些字后面的点，一律不认。
const ADVERB_BEFORE_RE = /[晚早快慢多少再差好]/;
// 「一点」单独出现时最容易误判，只有前面没有上述副词时才当钟点。

/**
 * 从一句话里认出「几点」。
 * 返回 { hour, minute } 或 null；不负责判断今天还是明天。
 */
export function parseClockTime(text) {
  const s = String(text ?? '');
  const clock = /(\d{1,2})\s*[:：]\s*(\d{2})/.exec(s);
  if (clock) {
    const hour = Number(clock[1]);
    const minute = Number(clock[2]);
    if (hour <= 23 && minute <= 59) return { hour, minute };
  }
  const re = /([零一二两三四五六七八九十]{1,3}|\d{1,2})\s*点\s*(半|[零一二两三四五六七八九十]{1,3}|\d{1,2})?/g;
  let m;
  while ((m = re.exec(s))) {
    // 只有「一点」会被副词吃掉（晚一点/快一点/少一点）；「十一点」里的「一点」不算，
    // 否则「今晚十一点半」会被前一个字「晚」误杀。
    if (m[1] === '一' && ADVERB_BEFORE_RE.test(s[m.index - 1] ?? '')) continue;
    const hour = parseChineseNumber(m[1]);
    const tail = String(m[2] ?? '').trim();
    let minute = 0;
    if (tail === '半') minute = 30;
    else if (tail) minute = parseChineseNumber(tail) ?? -1;
    if (!Number.isFinite(hour) || hour > 23) continue;
    if (!Number.isFinite(minute) || minute < 0 || minute > 59) continue;
    return { hour, minute };
  }
  return null;
}

/** 把「几点」落到一个具体的未来时刻上。两个方向共用，避免 12/24 小时制的转换写两遍。 */
function resolveForAt(text, parsed, now) {
  let { hour, minute } = parsed;
  const evening = EVENING_RE.test(text);
  let nextDay = NEXT_DAY_RE.test(text);
  // 12 小时制补成 24 小时制，但要分清真·晚上和真·凌晨：
  //   晚上八点(8) → 20:00；晚上十二点(12) → 次日 00:00；晚上一点(1) → 次日 01:00。
  if (evening) {
    if (hour === 12) { hour = 0; nextDay = true; }
    else if (hour >= 1 && hour <= 3) { nextDay = true; }
    else if (hour < 12) { hour += 12; }
  }
  if (hour >= 24) hour -= 24;

  const base = new Date(now);
  if (nextDay) base.setDate(base.getDate() + 1);
  base.setHours(hour, minute, 0, 0);

  const forAt = base.getTime();
  // 过后才说的（"我 11 点半就睡了"已被 PAST_RE 挡掉，这里挡的是「时间点已过」）。
  if (forAt <= now + 60 * 1000) return null;
  // 太远的不管（扫描路径只处理当天的口头约定，跨天由工具显式登记）。
  if (forAt - now > 24 * 60 * 60 * 1000) return null;
  return { forAt, hour, minute };
}

/**
 * 从**她**发出的一句话里认出「她承诺了一个时刻」（direction='out'：她要去赴约）。
 * now 传进来的同一天算当天；明天/明晚 +1 天；已经过去的时刻返回 null（不自己猜明天）。
 */
export function detectPromise(text, now) {
  const s = String(text ?? '').trim();
  if (!s || s.length > 400) return null;
  if (!CUE_RE.test(s)) return null;
  if (PAST_RE.test(s)) return null;
  const parsed = parseClockTime(s);
  if (!parsed) return null;
  const resolved = resolveForAt(s, parsed, now);
  if (!resolved) return null;
  return { ...resolved, direction: 'out', raw: s.slice(0, 200) };
}

/**
 * 从**对方**发来的一句话里认出「他要来找她」（direction='in'：她等他，等不到就追问）。
 * 和 outgoing 的判定刻意分开：这里要的是第一人称 + 「过去」的动词，
 * 否则「我去睡了」这种也会中招。
 */
export function detectIncomingPromise(text, now) {
  const s = String(text ?? '').trim();
  if (!s || s.length > 400) return null;
  if (!INCOMING_CUE_RE.test(s)) return null;
  if (PAST_RE.test(s)) return null;
  const parsed = parseClockTime(s);
  if (!parsed) return null;
  const resolved = resolveForAt(s, parsed, now);
  if (!resolved) return null;
  return { ...resolved, direction: 'in', raw: s.slice(0, 200) };
}

/**
 * 在 [forAt - leadMs, forAt] 里随机取一个触发点。
 * 取的是「提前一段时间」，不是「准点」，这样她的出现不会像闹钟。
 */
export function computePromiseFireAt(forAt, leadMs, rand = Math.random) {
  const windowMs = Math.max(0, Number(leadMs) || 0);
  const start = Number(forAt) - windowMs;
  const r = Math.min(0.999999, Math.max(0, Number(rand()) || 0));
  return start + Math.floor(r * windowMs);
}

/**
 * 等不到人时的追问时刻：在 [forAt + missMs, forAt + missMs + askWindowMs] 里随机。
 * 例如约定 23:30、missMs=10min、askWindowMs=10min → 落在 23:40~23:50。
 */
export function computeAskFireAt(forAt, missMs, askWindowMs, rand = Math.random) {
  const miss = Math.max(0, Number(missMs) || 0);
  const win = Math.max(0, Number(askWindowMs) || 0);
  const start = Number(forAt) + miss;
  const r = Math.min(0.999999, Math.max(0, Number(rand()) || 0));
  return start + Math.floor(r * win);
}

/**
 * 模糊承诺：「晚点找你」「稍后再聊」「等下说」——没有具体钟点，只有一个「等会儿」的意思。
 * 两个方向共用一套词表，区别只在方向标记：
 *   direction='out' 她自己说的（晚点去找对方）
 *   direction='in'  对方说的（晚点回来）
 * 刻意排除带具体钟点的句子：那种走精确承诺，不该被这条规则按「1~2 小时」处理。
 */
export function detectVaguePromise(text, direction) {
  const s = String(text ?? '').trim();
  if (!s || s.length > 400) return null;
  if (!VAGUE_CUE_RE.test(s)) return null;
  if (PAST_RE.test(s)) return null;
  // 已经说了具体几点，就交给 detectPromise / detectIncomingPromise，别在这里降级成模糊。
  if (parseClockTime(s)) return null;
  return { direction: direction === 'in' ? 'in' : 'out', raw: s.slice(0, 200) };
}

/**
 * 在 [createdAt + minMs, createdAt + maxMs] 里随机取一个触发点。
 * 例如「晚点」= 1~2 小时：说这句话起 1 小时后，到 2 小时前，随机挑一刻。
 */
export function computeVagueFireAt(createdAt, minMs, maxMs, rand = Math.random) {
  const lo = Math.max(0, Number(minMs) || 0);
  const hi = Math.max(lo, Number(maxMs) || 0);
  const r = Math.min(0.999999, Math.max(0, Number(rand()) || 0));
  return Number(createdAt) + lo + Math.floor(r * (hi - lo));
}

/** 'HH:MM'（给工具登记用；跨天由 forAt 自己表达）。 */
export function parseHHMM(input) {
  const m = /^(\d{1,2})[:：](\d{1,2})$/.exec(String(input ?? '').trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}
