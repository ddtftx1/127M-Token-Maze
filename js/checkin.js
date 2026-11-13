/* ============================================================
 * js/checkin.js
 * 每日签到（MG.Checkin）
 *
 * 设计要点（详见设计任务书「签到功能设计.md」，该文档不入库）：
 * - 数据独立：新 localStorage key 为 maze3d.checkin.v1，**不动** maze3d.wallet.v1
 * - 奖励入账：金币走 MG.Shop.addCoins、道具走 MG.Shop.addItem，与商店购买 / 迷宫拾取共用同一份钱包
 * - 日期口径：直接复用 MG.Maze.dailySeed()，与「每日挑战」永不漂移；本地 00:00 重置
 * - 断签：连签清零回第 1 天；漏签 1~5 天且有「签到护符」时自动消耗 1 个保住连签
 * - 降级：localStorage 不可用时退化为内存存档，游戏照常运行
 *
 * 约束：ES5 / IIFE / 无第三方依赖 / 只挂 window.MG
 * ============================================================ */
(function (global) {
  'use strict';

  var MG = global.MG = global.MG || {};

  /* ------------------------------------------------------------
   * 常量
   * ---------------------------------------------------------- */
  /** 签到数据存储键（与钱包分开，避免签到逻辑改动波及经济存档） */
  var STORAGE_KEY = 'maze3d.checkin.v1';
  var SCHEMA_VERSION = 1;
  /** 连签循环长度：第 7 / 14 / 21… 天额外掉落一件保底道具 */
  var CYCLE = 7;
  /** 历史首签只给 1 金币（之后按 5~10 随机发） */
  var FIRST_COINS = 1;
  var COINS_MIN = 5;
  var COINS_MAX = 10;
  /** 签到大吉：当日金币 ×3 */
  var LUCKY_CHANCE = 0.01;
  var LUCKY_MULT = 3;
  /** 财宝箱：额外随机道具 ×1 */
  var RARE_CHANCE = 0.08;
  /** 签到护符最多保住"漏签 5 天"；超过则视为彻底中断 */
  var SHIELD_MAX_MISSED = 5;
  /**
   * "时钟倒退"异常持续达到该天数即自愈（用户 2026-11-08 拍板）。
   * 为什么是 3：1 天可能只是时区/夏令时/手动校时的抖动，2 天仍可能只是玩家忘了把时间调回来，
   * 连续 3 天还早于上次签到日，就足以确认存档里的那个"未来日期"不可能再等到，再锁下去
   * 只会让玩家（尤其是不常开机的）永久拿不到签到 —— 与 parseDay 注释里"不能永久锁死"的承诺一致。
   */
  var CLOCK_RESET_DAYS = 3;
  /** 留痕天数（异常审计用） */
  var HISTORY_MAX = 14;
  /** 跨零点轮询间隔 */
  var DAY_CHECK_MS = 30000;
  /** boot 后自动弹出面板的延时（给玩家留出点「开始游戏」的时机） */
  var AUTO_OPEN_DELAY = 700;
  /** 可掉落的计数类道具（护符不参与掉落，避免自我循环） */
  var DROPS = ['mapUnlock', 'fastPath', 'bestPath'];

  /* ------------------------------------------------------------
   * 状态
   * ---------------------------------------------------------- */
  /** 内存副本：localStorage 不可用时的唯一真源 */
  var cache = null;
  /** 随机源（测试可注入，见 _setRng） */
  var rng = Math.random;
  /** DOM 缓存 */
  var els = {};
  /** 本会话是否已自动弹过面板（不落盘） */
  var autoOpened = false;
  /** 面板是否打开 */
  var panelOpen = false;
  var tickTimer = null;
  var dayTimer = null;
  var lastKnownDay = '';
  /** 当前展示快照：{ day, plan, reward, data } —— 面板显示与实发共用同一份 */
  var view = null;
  /**
   * 本会话是否已发生过"写盘失败"。
   * 写盘失败时磁盘上是旧存档、内存里才是最新状态；若后续 load() 仍以磁盘为准，
   * 就会把"今天已签"读丢 → 同一天可无限重复领取（多标签页/配额满/隐私模式）。
   * 因此写盘失败后本会话一律以内存副本为准（仅本次会话降级，刷新后恢复正常语义）。
   */
  var degraded = false;

  /* ------------------------------------------------------------
   * 日期工具
   * ---------------------------------------------------------- */
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  /** 只校验格式（8 位数字），不校验日历有效性 */
  function isDayKeyFormat(k) { return typeof k === 'string' && /^[0-9]{8}$/.test(k); }

  /**
   * 'YYYYMMDD' → 本地 0 点的 Date；格式或日历非法（20261340 / 20260231 等）返回 null。
   * 必须校验日历有效性：只验 8 位数字的话，一个手改出来的非法日期会让
   * "today < lastDay" 恒成立，玩家被永久锁在"系统时间异常"且没有自愈路径。
   */
  function parseDay(k) {
    if (!isDayKeyFormat(k)) return null;
    var y = parseInt(k.slice(0, 4), 10);
    var m = parseInt(k.slice(4, 6), 10);
    var d = parseInt(k.slice(6, 8), 10);
    var dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
    return dt;
  }

  /** 是否是合法日历日期键（格式 + 日历双重校验） */
  function isDayKey(k) { return parseDay(k) !== null; }

  /**
   * 今天的日期键 'YYYYMMDD'
   * 直接复用 MG.Maze.dailySeed()（'daily-YYYYMMDD'，本地时区），保证签到日与每日挑战日一致；
   * maze 模块缺失时才走同算法的兜底实现。
   */
  function dayKey() {
    if (MG.Maze && typeof MG.Maze.dailySeed === 'function') {
      // 兜底包一层 try：老内核若缺少 dailySeed 用到的某个新 API（历史上曾因 padStart 踩过），
      // 这里抛错会顺着 refreshBadge → init → boot 冒到顶层，导致主循环 loop() 根本不启动（黑屏）
      try {
        var s = MG.Maze.dailySeed();
        if (typeof s === 'string' && s.indexOf('daily-') === 0) return s.slice(6);
      } catch (e) { /* 退回下面的本地实现 */ }
    }
    var d = new Date();
    return '' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
  }

  /** 两个日期键相差的自然日数（to - from）；任一非法返回 null */
  function dayDiff(fromKey, toKey) {
    var a = parseDay(fromKey), b = parseDay(toKey);
    if (!a || !b) return null;
    return Math.round((b.getTime() - a.getTime()) / 86400000);
  }

  /** 距离下一个本地 00:00 的毫秒数 */
  function msToNextReset() {
    var now = new Date();
    var next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
    return next.getTime() - now.getTime();
  }

  /** 把毫秒格式化成「11 小时 23 分 05 秒」 */
  function formatCountdown(ms) {
    if (ms < 0) ms = 0;
    var total = Math.floor(ms / 1000);
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    return h + ' 小时 ' + pad2(m) + ' 分 ' + pad2(s) + ' 秒';
  }

  /* ------------------------------------------------------------
   * 存储（失败静默降级为内存）
   * ---------------------------------------------------------- */
  function safeGet() {
    try { return global.localStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
  }
  function safeSet(text) {
    try { global.localStorage.setItem(STORAGE_KEY, text); return true; } catch (e) { return false; }
  }

  function isArray(v) { return Object.prototype.toString.call(v) === '[object Array]'; }

  function clampInt(v, min, max) {
    var n = typeof v === 'number' && isFinite(v) ? Math.floor(v) : min;
    if (n < min) n = min;
    if (n > max) n = max;
    return n;
  }

  /** 规范化签到数据：缺字段补默认、非法值钳制、永不抛错 */
  function normalize(raw) {
    var d = {
      v: SCHEMA_VERSION,
      firstDone: false,
      lastDay: '',
      streak: 0,
      totalDays: 0,
      maxStreak: 0,
      days: [],
      anomaly: 0,
      // 本轮"时钟倒退"异常的首次观测日（'YYYYMMDD'）。自愈判定的锚点，
      // 领取成功后清零（见 claim()），因此它存在即代表"这轮异常还没结束"
      anomalyFrom: ''
    };
    if (!raw || typeof raw !== 'object' || isArray(raw)) return d;

    d.firstDone = raw.firstDone === true;
    if (isDayKey(raw.lastDay)) d.lastDay = raw.lastDay;
    d.streak = clampInt(raw.streak, 0, 1000000);
    d.totalDays = clampInt(raw.totalDays, 0, 1000000000);
    d.maxStreak = clampInt(raw.maxStreak, 0, 1000000);
    d.anomaly = clampInt(raw.anomaly, 0, 1000000);
    if (isDayKey(raw.anomalyFrom)) d.anomalyFrom = raw.anomalyFrom;
    // 一致性兜底：有锚点就至少已观测到 1 天（手改档把 anomaly 清 0 时别把天数算少了）
    if (d.anomalyFrom && d.anomaly < 1) d.anomaly = 1;

    if (isArray(raw.days)) {
      for (var i = 0; i < raw.days.length; i++) {
        if (isDayKey(raw.days[i])) d.days.push(raw.days[i]);
      }
      if (d.days.length > HISTORY_MAX) d.days = d.days.slice(d.days.length - HISTORY_MAX);
    }

    // 一致性兜底：连签数不可能超过累计天数；最长连签不得小于当前连签。
    // 缺 totalDays 的老档（或被手改掉的）不能反过来把合法 streak 清成 0 ——
    // 那样玩家会莫名丢掉连签进度且无法恢复，所以这里抬 totalDays 而不是压 streak。
    if (d.totalDays < d.streak) d.totalDays = d.streak;
    if (d.maxStreak < d.streak) d.maxStreak = d.streak;
    return d;
  }

  /** 读取签到数据（每次都读盘：多标签页时以磁盘为准） */
  function load() {
    // 本会话已发生过写盘失败：磁盘是旧数据，必须以内存副本为准（否则同日可重复领取）
    if (degraded) return normalize(cache);
    var raw = safeGet();
    if (raw === null) return normalize(cache); // 存储不可用 / 首次进入：退回内存副本
    try {
      cache = JSON.parse(raw);
    } catch (e) {
      console.warn('[checkin] 签到存档损坏，已重置', e);
      cache = null;
    }
    return normalize(cache);
  }

  /** 保存签到数据；无论磁盘是否成功，内存副本都会更新 */
  function save(data) {
    cache = data;
    var ok = safeSet(JSON.stringify(data));
    if (!ok) {
      // 关键：置降级标记，让后续 load() 不再去读那份"没写进去"的旧磁盘数据
      degraded = true;
      console.warn('[checkin] 签到存档写入失败（localStorage 不可用），本会话内改用内存');
    }
    return ok;
  }

  /* ------------------------------------------------------------
   * 奖励骰子
   * ---------------------------------------------------------- */

  /** 某 id 的展示名（商店里没有时回落 id 本身） */
  function itemName(id) {
    var it = MG.Shop && MG.Shop.getItem ? MG.Shop.getItem(id) : null;
    return it ? (it.short || it.name || id) : id;
  }

  /** 某 id 的图标 key */
  function itemIcon(id) {
    var it = MG.Shop && MG.Shop.getItem ? MG.Shop.getItem(id) : null;
    return (it && it.icon) || 'money';
  }

  /** 某棋位（1..7）在本轮的奖励预告文案，用于格子上显示 */
  function cyclePosOf(streak) {
    var s = streak < 1 ? 1 : streak;
    return ((s - 1) % CYCLE) + 1;
  }

  /** 本轮（连签循环）第 7 天会掉落的保底道具 */
  function weeklyDropOf(streak) {
    var s = streak < 1 ? 1 : streak;
    var idx = Math.floor((s - 1) / CYCLE) % DROPS.length;
    return DROPS[idx];
  }

  /**
   * 摇一次奖励
   * @param {number} streak 本次签到后的连签天数
   * @param {boolean} isFirst 是否历史首签
   * @returns {{coins:number, items:string[], special:string, cyclePos:number}}
   */
  function rollReward(streak, isFirst) {
    var out = { coins: 0, items: [], special: '', cyclePos: cyclePosOf(streak) };

    if (isFirst) {
      out.coins = FIRST_COINS;
      out.special = 'first';
      return out;
    }

    var coins = COINS_MIN + Math.floor(rng() * (COINS_MAX - COINS_MIN + 1));

    if (rng() < LUCKY_CHANCE) {
      coins = coins * LUCKY_MULT;
      out.special = 'lucky';
    }

    if (out.cyclePos === CYCLE) {
      out.items.push(weeklyDropOf(streak));
      if (!out.special) out.special = 'weekly';
    }

    if (rng() < RARE_CHANCE) {
      out.items.push(DROPS[Math.floor(rng() * DROPS.length) % DROPS.length]);
      if (!out.special) out.special = 'rare';
    }

    out.coins = coins;
    return out;
  }

  /* ------------------------------------------------------------
   * 判定
   * ---------------------------------------------------------- */

  function shieldCount() {
    return (MG.Shop && MG.Shop.countOf) ? MG.Shop.countOf('streakShield') : 0;
  }

  /**
   * 当前"时钟倒退"已持续到第几天（今天算第 1 天）。纯函数，不写盘。
   * 以首次观测日 data.anomalyFrom 为锚累加：观测不到的那几天无法判定，
   * 按"异常仍在持续"计入（宁可提前自愈，也不要让不常开机的玩家被永久锁死）。
   * @returns {number} >= 1
   */
  function clockStrikes(data, today) {
    if (!data || !isDayKey(data.anomalyFrom)) return 1;
    var d = dayDiff(data.anomalyFrom, today);
    if (d === null) return 1;
    if (d < 0) d = 0;   // 观测日自身倒退（异常输入）：不重复累加，按当天算
    return d + 1;
  }

  /**
   * 记下"今天又一次检测到时钟倒退"。
   * - 只维护锚点 anomalyFrom：本轮首次异常日一旦记下就不再改，直到领取成功后清零；
   * - 同一天重复调用不写盘（计数没变），因此角标刷新 / 打开面板这类高频入口不会写盘放大。
   * @returns {boolean} 是否真的写了盘
   */
  function recordClockAnomaly(data) {
    if (!data) return false;
    var today = dayKey();
    if (!isDayKey(data.anomalyFrom)) {
      data.anomalyFrom = today;
      data.anomaly = 1;
      return save(data);
    }
    var n = clockStrikes(data, today);
    if (n === data.anomaly) return false;
    data.anomaly = n;
    return save(data);
  }

  /**
   * 依据当前存档判断"今天能不能签、签了连签到第几天"
   * @returns {{day:string, canClaim:boolean, reason:string, kind:string,
   *            streak:number, missed:number, useShield:boolean, shields:number, data:object}}
   */
  function evaluate(data) {
    var today = dayKey();
    var out = {
      day: today, canClaim: false, reason: '', kind: '',
      streak: 0, missed: 0, useShield: false, shields: shieldCount(), data: data
    };

    // 从未签到
    if (!data.lastDay) {
      out.canClaim = true;
      // 首签只给一次：firstDone 已经是 true 却丢了 lastDay（手改存档 / 旧档），
      // 按"断签后第 1 天"发常规奖励，避免白送第二次首签
      out.kind = data.firstDone === true ? 'normal' : 'first';
      out.streak = 1;
      return out;
    }

    // 今天已签
    if (today === data.lastDay) {
      out.reason = 'already';
      out.streak = data.streak;
      return out;
    }

    // 时间倒流（改系统时间 / 时区回退）：只拦不罚，记一次 anomaly
    if (today < data.lastDay) {
      var strikes = clockStrikes(data, today);
      out.anomaly = strikes;
      // 连续 CLOCK_RESET_DAYS 天仍早于上次签到日：认定那份"未来日期"存档已不可能等到，
      // 按今天重置基准日恢复签到（连签清零、护符不消耗、异常计数清零）——否则玩家被永久锁死
      if (strikes >= CLOCK_RESET_DAYS) {
        out.canClaim = true;
        out.kind = 'clock-reset';
        out.reason = 'clock-reset';
        out.streak = 1;
        return out;
      }
      out.reason = 'clock';
      out.streak = data.streak;
      return out;
    }

    var diff = dayDiff(data.lastDay, today);
    if (diff === null) {
      // 存档里的日期无法解析：按彻底中断处理
      out.canClaim = true;
      out.kind = 'reset';
      out.streak = 1;
      return out;
    }

    var missed = diff - 1;
    out.missed = missed;

    if (missed <= 0) {
      out.canClaim = true;
      out.kind = 'normal';
      out.streak = data.streak + 1;
      return out;
    }

    // 漏签 1~5 天且背包里有护符：消耗 1 个保住连签（漏掉的日子不补发奖励）
    if (missed <= SHIELD_MAX_MISSED && out.shields > 0) {
      out.canClaim = true;
      out.kind = 'shielded';
      out.useShield = true;
      out.streak = data.streak + 1;
      return out;
    }

    out.canClaim = true;
    out.kind = 'reset';
    out.streak = 1;
    return out;
  }

  /* ------------------------------------------------------------
   * 领取
   * ---------------------------------------------------------- */
  function uiToast(msg, dur, html) {
    if (MG.UI && MG.UI.toast) MG.UI.toast(msg, dur || 1800, !!html);
  }
  function play(name) {
    try { if (MG.Audio && typeof MG.Audio[name] === 'function') MG.Audio[name](); } catch (e) { /* 无声降级 */ }
  }

  /** 摇好并缓存本次展示/实发共用的奖励 */
  function syncView() {
    var data = load();
    var plan = evaluate(data);
    // 面板一打开 / 跨天重绘就把"今天检测到时钟倒退"记下来（同一天只写一次盘）。
    // 放在 evaluate 之后、缓存 view 之前：view.data 直接带上最新锚点，
    // claim() 落签时不会把刚记的锚点又写回旧值。
    if (plan.reason === 'clock' && !plan.canClaim) {
      recordClockAnomaly(data);
      plan.anomaly = data.anomaly;
    }
    var reward = plan.canClaim ? rollReward(plan.streak, plan.kind === 'first') : null;
    view = { day: plan.day, plan: plan, reward: reward, data: data };
    return view;
  }

  /** 领取今日奖励 */
  function claim() {
    var data = load();               // 每次都重读磁盘：多标签页时后者会拿到"今日已签到"
    var plan = evaluate(data);

    if (!plan.canClaim) {
      if (plan.reason === 'clock') {
        // 与角标 / 面板共用同一条计数路径：以"首次异常日"为锚按天累加，
        // 同一天重复调用不会把天数刷多（避免连点几下就被当成"连续 3 天"而提前自愈）
        recordClockAnomaly(data);
        play('error');
        uiToast('检测到系统时间异常，本次签到未发放');
        return { ok: false, reason: 'clock', anomaly: data.anomaly, anomalyFrom: data.anomalyFrom };
      }
      uiToast('今天已经签到过了，明天再来');
      return { ok: false, reason: plan.reason };
    }

    // 面板打开时摇好的那份（保证"显示即实发"）；没有则现摇。
    // 复用缓存必须同时校验"日期 + 连签天数 + 奖励类型"：面板打开期间后台状态可能
    // 已经变化（多标签页、护符被消耗、跨过零点），只比日期会把旧状态摇出的奖励
    // 发给新状态，表现为"提示里的连签/奖励与预览对不上"（BUG-024）。
    var reward;
    var cacheOk = !!view && !!view.reward && !!view.plan &&
      view.day === plan.day &&
      view.plan.streak === plan.streak &&
      view.plan.kind === plan.kind;
    if (cacheOk) reward = view.reward;
    else reward = rollReward(plan.streak, plan.kind === 'first');

    // ① 先落签（写盘），再发奖：
    //    写盘失败只会降级成内存存档（save() 里已处理），发奖照常继续；
    //    顺序反过来的话，一旦落签失败就会出现"没记上却已发奖"的无限领取
    var isFirst = plan.kind === 'first';
    data.lastDay = plan.day;
    data.streak = plan.streak;
    data.totalDays = (data.totalDays || 0) + 1;
    data.maxStreak = Math.max(data.maxStreak || 0, data.streak);
    if (isFirst) data.firstDone = true;
    // 成功领取（含时钟自愈）即视为"连续异常"结束：锚点与计数一起清零
    data.anomaly = 0;
    data.anomalyFrom = '';
    data.days = (data.days || []).concat([plan.day]);
    if (data.days.length > HISTORY_MAX) data.days = data.days.slice(data.days.length - HISTORY_MAX);
    var saved = save(data);

    // ② 护符：自动消耗，无需玩家操作。
    //    放在落签之后：即便扣减失败，玩家也是"保住了连签但少花一个护符"，不会反向吃亏
    var shieldLeft = -1;
    if (plan.useShield && MG.Shop && MG.Shop.consumeItem) {
      // 扣护符失败不能影响后面发奖（连签已经落盘，这里只是少花一个护符）
      try { if (MG.Shop.consumeItem('streakShield')) shieldLeft = shieldCount(); }
      catch (e) { console.error('[checkin] 护符扣减失败', e); }
    }

    // ③ 发奖：金币与道具都进同一份钱包
    var coinsOk = true;
    var itemsOk = [];
    if (MG.Shop) {
      if (reward.coins > 0 && MG.Shop.addCoins) {
        try {
          MG.Shop.addCoins(reward.coins);
          /* addCoins 内部会把 saveWallet() 的返回值吞掉、也不会抛错，
             所以"钱包写盘失败"在这里必须自己补一次判定，否则 coinsOk 永远是 true，
             玩家会落到"签到记上了、金币却没进存档"的无提示状态。 */
          if (MG.Shop.saveWallet && MG.Shop.saveWallet() === false) coinsOk = false;
        } catch (e) { coinsOk = false; }
      }
      for (var i = 0; i < reward.items.length; i++) {
        // 单个道具发放失败不中断（并发/写盘异常都可能抛），失败项记为 false 由上层提示
        try { itemsOk.push(!!(MG.Shop.addItem && MG.Shop.addItem(reward.items[i], 1))); }
        catch (e) { console.error('[checkin] 道具发放失败：' + reward.items[i], e); itemsOk.push(false); }
      }
    }

    // ④ 反馈（写盘类失败要如实告诉玩家，不能一律报"领取成功"）
    var badItems = 0;
    for (var bi = 0; bi < itemsOk.length; bi++) { if (itemsOk[bi] === false) badItems++; }
    var warn = '';
    if (!saved) warn += '；签到记录未能写入存档（存储空间不足？）';
    if (!coinsOk) warn += '；金币未能入账';
    if (badItems > 0) warn += '；' + badItems + ' 件道具未能发放';
    play(reward.special === 'lucky' ? 'purchase' : 'coin');
    uiToast(claimMessage(reward, plan, shieldLeft) + warn, warn ? 3600 : 2800, true);
    syncView();
    refreshBadge();
    if (panelOpen) renderPanel();

    return {
      ok: true,
      day: plan.day,
      kind: plan.kind,
      streak: data.streak,
      coins: reward.coins,
      items: reward.items,
      special: reward.special,
      shieldUsed: plan.useShield,
      shieldLeft: shieldLeft,
      saved: saved,
      coinsOk: coinsOk,
      itemsOk: itemsOk
    };
  }

  /** 领取成功的提示文案（HTML） */
  function claimMessage(reward, plan, shieldLeft) {
    var icon = (MG.UI && MG.UI.iconHtml) ? MG.UI.iconHtml : function (k) { return ''; };
    var coins = icon('money') + ' +' + reward.coins + ' 金币';
    var head;
    if (reward.special === 'first') head = '首次签到成功';
    else if (reward.special === 'lucky') head = '签到大吉！金币 ×' + LUCKY_MULT;
    else if (reward.special === 'weekly') head = '连签 ' + plan.streak + ' 天（第 ' + CYCLE + ' 天保底）';
    else if (reward.special === 'rare') head = '财宝箱！';
    else head = '签到成功';

    var body = coins;
    for (var i = 0; i < reward.items.length; i++) {
      body += '、' + icon(itemIcon(reward.items[i])) + ' ' + itemName(reward.items[i]) + ' ×1';
    }

    var tail = '';
    if (plan.useShield && shieldLeft >= 0) {
      tail += '（' + icon('shield') + ' 护符生效，连签保住，剩 ×' + shieldLeft + '）';
    } else if (plan.kind === 'clock-reset') {
      // 自愈要如实告诉玩家：连签为什么回到第 1 天（数字走常量，避免与阈值漂移）
      tail += '（连续 ' + CLOCK_RESET_DAYS + ' 天检测到系统时间早于上次签到日期，已按今天重新开始累计连签）';
    } else if (plan.kind === 'reset' && plan.missed > 0) {
      tail += '（漏签 ' + plan.missed + ' 天，连签已从第 1 天重算）';
    }
    return head + '：' + body + tail;
  }

  /* ------------------------------------------------------------
   * 面板渲染
   * ---------------------------------------------------------- */
  function icon(k) {
    return (MG.UI && MG.UI.iconHtml) ? MG.UI.iconHtml(k) : '';
  }

  function cellHtml(pos, state, streakForWeekly) {
    var cls = 'sign-cell sign-' + state;
    var inner = '';
    if (state === 'done') {
      inner = '<span class="sign-cell-icon">' + icon('check') + '</span><span class="sign-cell-text">已签</span>';
    } else if (state === 'today') {
      inner = '<span class="sign-cell-icon">' + icon('alarm') + '</span><span class="sign-cell-text">今天</span>';
    } else {
      // 未来格：只显示锁（不写天数、不写奖励）
      inner = '<span class="sign-cell-icon">' + icon('lock') + '</span>';
    }
    // 第 7 格右下角挂保底道具角标
    var corner = '';
    if (pos === CYCLE) {
      corner = '<span class="sign-cell-corner">' + icon(itemIcon(weeklyDropOf(streakForWeekly))) + '</span>';
    }
    return '<div class="' + cls + '">' + inner + corner + '</div>';
  }

  function shieldLineHtml(shields) {
    var n = shields || 0;
    var box = els['checkin-shield'];
    if (!box) return;
    if (n > 0) {
      box.className = 'sign-shield';
      box.innerHTML = icon('shield') + ' 护符 ×' + n + '　漏签 ' + SHIELD_MAX_MISSED + ' 天内自动保住连签';
    } else {
      box.className = 'sign-shield sign-shield-empty';
      box.innerHTML = icon('shield') + ' 护符 ×0　可在商店购买，防止漏签断掉连签';
    }
  }

  function rewardPreviewHtml(plan, reward) {
    if (!plan.canClaim || !reward) {
      return '今日已签到，明天 00:00 后可再次签到';
    }
    var parts = [icon('money') + ' ' + reward.coins + ' 金币'];
    for (var i = 0; i < reward.items.length; i++) {
      parts.push(icon(itemIcon(reward.items[i])) + ' ' + itemName(reward.items[i]) + ' ×1');
    }
    var prefix = '今日奖励：';
    if (reward.special === 'first') prefix = '首次签到奖励：';
    else if (reward.special === 'lucky') prefix = '签到大吉（金币 ×' + LUCKY_MULT + '）：';
    else if (reward.special === 'rare') prefix = '财宝箱（稀有）：';
    else if (reward.special === 'weekly') prefix = '第 ' + CYCLE + ' 天保底奖励：';
    return prefix + parts.join(' + ');
  }

  function renderPanel() {
    if (!els['checkin-screen']) return;
    if (!view || view.day !== dayKey()) syncView();

    var plan = view.plan;
    var data = view.data;
    var claimed = !plan.canClaim && plan.reason === 'already';

    // 连签展示：可签时预览"签完后的天数"，已签时显示实际天数
    var showStreak = plan.canClaim ? plan.streak : data.streak;
    var pos = cyclePosOf(showStreak);

    if (els['checkin-streak']) els['checkin-streak'].textContent = String(showStreak);
    if (els['checkin-total']) els['checkin-total'].textContent = String(data.totalDays || 0);
    if (els['checkin-best']) els['checkin-best'].textContent = String(Math.max(data.maxStreak || 0, showStreak));

    shieldLineHtml(plan.shields);

    // 7 格
    if (els['checkin-grid']) {
      var html = '';
      for (var i = 1; i <= CYCLE; i++) {
        var state;
        if (i < pos) state = 'done';
        else if (i === pos) state = (claimed || !plan.canClaim) ? 'done' : 'today';
        else state = 'future';
        html += cellHtml(i, state, showStreak);
      }
      els['checkin-grid'].innerHTML = html;
    }

    // 奖励预告
    if (els['checkin-reward']) {
      els['checkin-reward'].innerHTML = rewardPreviewHtml(plan, view.reward);
    }

    // 主按钮
    var btn = els['btn-checkin-claim'];
    if (btn) {
      if (plan.canClaim) {
        btn.textContent = '领取今日奖励';
        btn.disabled = false;
        btn.className = 'primary-btn sign-claim-btn';
      } else {
        btn.textContent = (plan.reason === 'clock') ? '系统时间异常，暂不可签到' : '今日已签到';
        btn.disabled = true;
        btn.className = 'primary-btn sign-claim-btn is-disabled';
      }
    }

    // 提示行
    if (els['checkin-hint']) {
      var hint = '';
      if (plan.canClaim) {
        if (plan.kind === 'first') hint = '首次签到，明天再来可以开始累计连签';
        else if (plan.kind === 'shielded') hint = '你漏签了 ' + plan.missed + ' 天，签到护符将自动生效并保住连签';
        // 时钟自愈：提前说清"为什么连签从第 1 天开始"，否则和兜底那句对不上
        else if (plan.kind === 'clock-reset') hint = '检测到系统时间已连续 ' + CLOCK_RESET_DAYS +
          ' 天早于上次签到日期，本次签到将按今天重新开始累计连签';
        else if (plan.kind === 'reset' && plan.missed > 0) hint = '你漏签了 ' + plan.missed + ' 天，连签将从第 1 天重新开始';
        else hint = '连签到第 ' + plan.streak + ' 天，明天再来可继续累计';
      } else if (plan.reason === 'clock') {
        // 第 1~2 天被拦时也告诉玩家出口：连续 N 天仍未恢复会自动重置基准日
        hint = '检测到系统时间早于上次签到日期，请校准时区或时间后再试；连续 ' + CLOCK_RESET_DAYS +
          ' 天仍未恢复将自动重置签到基准日';
      } else {
        hint = '明天 00:00 之后可以再次签到';
      }
      els['checkin-hint'].textContent = hint;
    }

    updateCountdown();
  }

  function updateCountdown() {
    var box = els['checkin-countdown'];
    if (!box) return;
    // 倒计时只跟"距离今天 24:00 还有多久"有关，与能否领取无关（原来两个分支是同一句）
    box.textContent = '距下次签到 ' + formatCountdown(msToNextReset());
  }

  /* ------------------------------------------------------------
   * 角标与入口
   * ---------------------------------------------------------- */
  function refreshBadge() {
    var btn = els['btn-checkin'];
    if (!btn) return;
    var data = load();
    var plan = evaluate(data);
    // 角标是"每天一定会走到"的入口（boot / 回主菜单 / 跨天轮询），
    // 时钟倒退的连续天数在这里累计；同一天只写一次盘，高频调用无写放大。
    // 第 3 天 plan.canClaim 已为 true，下面的判定自然跳过（自愈当天不再记异常）。
    if (plan.reason === 'clock' && !plan.canClaim) {
      recordClockAnomaly(data);
      plan.anomaly = data.anomaly;
    }
    var dot = els['checkin-dot'];
    var label = els['checkin-entry-label'];
    var iconBox = els['checkin-entry-icon'];

    /* 时钟异常（第 1~2 天，尚未触发自愈）：今天其实**没有签上**，不能沿用「今日已签到」
       —— 玩家点进去看到的是"系统时间异常、不予发放"，角标与内容对不上（BUG-060，
       2026-11-09 用户拍板）。这里给一句如实的「系统时间异常」，图标也从对勾换成锁。 */
    var clockBlocked = (!plan.canClaim && plan.reason === 'clock');

    if (dot) {
      if (plan.canClaim) dot.classList.remove('hidden');
      else dot.classList.add('hidden');
    }
    if (label) {
      label.textContent = plan.canClaim
        ? '每日签到'
        : (clockBlocked ? '系统时间异常' : '今日已签到');
    }
    if (btn.classList) {
      if (plan.canClaim) btn.classList.remove('is-claimed');
      else btn.classList.add('is-claimed');
    }
    if (iconBox) {
      iconBox.innerHTML = icon(plan.canClaim ? 'alarm' : (clockBlocked ? 'lock' : 'check'));
    }
  }

  /** 竖屏？老内核没有 matchMedia 时按宽高比兜底 */
  function isPortrait() {
    try {
      if (global.matchMedia) return global.matchMedia('(orientation: portrait)').matches;
    } catch (e) { /* 忽略 */ }
    return (global.innerHeight || 0) >= (global.innerWidth || 0);
  }

  /**
   * 入口按钮落点：
   * - 竖屏：留在「商店」与「成就」之间（index.html 里的初始位置就是那里）
   * - 横屏：搬到左列难度卡片组下方
   */
  function placeEntry() {
    var btn = els['btn-checkin'];
    if (!btn) return;
    var anchor = els['btn-achievements-menu'] || document.getElementById('btn-achievements-menu');
    var leftCol = document.getElementById('menu-col-diff');
    if (isPortrait()) {
      if (anchor && anchor.parentNode && btn.nextSibling !== anchor) {
        anchor.parentNode.insertBefore(btn, anchor);
      }
    } else if (leftCol) {
      leftCol.appendChild(btn);
    }
  }

  /* ------------------------------------------------------------
   * 面板开关
   * ---------------------------------------------------------- */
  function bindMiniCountdown() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    tickTimer = setInterval(function () {
      /* 面板可能被别的界面顶掉（开发者入口、重开一局、返回主菜单都会走 hideAllScreens，
         而签到屏并没有"被隐藏时收尾"的钩子）：这种情况必须自愈，
         否则这个 1 秒定时器会一直空转，每秒读一次存档并写已经隐藏的 DOM。 */
      var scr = els['checkin-screen'];
      if (scr && scr.classList && scr.classList.contains('hidden')) {
        panelOpen = false;
        if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
        return;
      }
      // 跨天时重新摇一次奖励并重绘
      if (view && view.day !== dayKey()) {
        syncView();
        renderPanel();
      } else {
        updateCountdown();
      }
    }, 1000);
  }

  function openPanel() {
    if (!els['checkin-screen']) return;
    autoOpened = true;
    panelOpen = true;
    syncView();
    if (MG.UI && MG.UI.hideAllScreens) MG.UI.hideAllScreens();
    if (MG.UI && MG.UI.show) MG.UI.show('checkin-screen');
    renderPanel();
    bindMiniCountdown();
  }

  function closePanel() {
    panelOpen = false;
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    /* BUG-064（2026-11-13）：返回落点交给 UI 层统一判定 ——
       签到面板既可从主菜单进，也可在对局暂停中经开发者面板的「快速跳转 → 签到」
       （以及数据页的「打开签到面板」）进；从暂停局进来时若直接 showMainMenu()，
       主菜单会盖在一局 state === 'paused' 的僵尸对局上（背景还是那一局）。
       ui.js 比本模块先加载，正常一定存在；万一取不到就退回修复前的行为，保持可降级。 */
    if (MG.UI && MG.UI.backFromOverlay) MG.UI.backFromOverlay();
    else if (MG.UI && MG.UI.showMainMenu) MG.UI.showMainMenu();
    else if (MG.UI && MG.UI.hide) MG.UI.hide('checkin-screen');
  }

  function isPanelOpen() { return panelOpen; }

  /* ------------------------------------------------------------
   * 初始化
   * ---------------------------------------------------------- */
  var IDS = [
    'btn-checkin', 'checkin-dot', 'checkin-entry-label', 'checkin-entry-icon',
    'checkin-screen', 'btn-checkin-close', 'checkin-streak', 'checkin-total', 'checkin-best',
    'checkin-shield', 'checkin-grid', 'checkin-reward', 'checkin-countdown',
    'btn-checkin-claim', 'checkin-hint', 'btn-achievements-menu'
  ];

  function cacheEls() {
    for (var i = 0; i < IDS.length; i++) els[IDS[i]] = document.getElementById(IDS[i]);
  }

  function bindEvents() {
    if (els['btn-checkin']) {
      els['btn-checkin'].addEventListener('click', function () {
        play('click');
        openPanel();
      });
    }
    if (els['btn-checkin-close']) {
      els['btn-checkin-close'].addEventListener('click', function () {
        play('click');
        closePanel();
      });
    }
    if (els['btn-checkin-claim']) {
      els['btn-checkin-claim'].addEventListener('click', function () {
        claim();
      });
    }
  }

  /** 方向变化时重新摆放入口按钮（Chrome 49 只有 addListener，没有 addEventListener） */
  function listenOrientation() {
    try {
      var mq = global.matchMedia('(orientation: portrait)');
      var handler = function () { placeEntry(); };
      if (mq.addEventListener) mq.addEventListener('change', handler);
      else if (mq.addListener) mq.addListener(handler);
    } catch (e) { /* 忽略 */ }
  }

  /** 除主菜单外，是否有别的 screen 正开着（商店 / 成就 / 排行榜 / 设置 / 签到 / 道具面板 / 暂停 / 幽灵询问…） */
  function otherScreenVisible() {
    var ids = [
      'shop-screen', 'achievement-screen', 'ranking-screen', 'settings-panel',
      'item-panel', 'pause-menu', 'win-screen', 'replay-bar', 'secret-modal', 'dev-screen',
      // 幽灵询问弹窗也算"别的 screen"：它弹出时 Game.state 仍是 'menu'
      // （要等玩家选完才进 loading），只查 state 会把签到面板盖到它上面（BUG-023）
      'ghost-modal'
    ];
    for (var i = 0; i < ids.length; i++) {
      var n = document.getElementById(ids[i]);
      if (n && !n.classList.contains('hidden')) return true;
    }
    return false;
  }

  /**
   * boot 后自动弹一次（本会话只弹一次）。
   * 只在"玩家停在主菜单"时弹：Game.state 在这些面板里仍然是 'menu'，
   * 所以不能只看 state，要额外确认没有别的 screen 开着，否则会把玩家刚打开的
   * 商店 / 排行榜 / 设置 / 签到面板强行顶掉。
   */
  function scheduleAutoOpen() {
    global.setTimeout(function () {
      if (autoOpened) return;
      if (MG.Game && MG.Game.state && MG.Game.state !== 'menu') return;
      if (otherScreenVisible()) return;
      var plan = evaluate(load());
      if (!plan.canClaim) return;
      openPanel();
    }, AUTO_OPEN_DELAY);
  }

  /** 跨零点轮询：页面一直开着时，第二天自动点亮角标 */
  function startDayWatcher() {
    lastKnownDay = dayKey();
    if (dayTimer) clearInterval(dayTimer);
    dayTimer = setInterval(function () {
      var today = dayKey();
      if (today === lastKnownDay) return;
      lastKnownDay = today;
      refreshBadge();
      if (panelOpen) { syncView(); renderPanel(); }
    }, DAY_CHECK_MS);
  }

  function init() {
    cacheEls();
    if (!els['btn-checkin']) {
      // 老 HTML 里没有签到入口（例如用户缓存了旧 index.html）：静默降级，不影响游戏
      console.warn('[checkin] 未找到签到入口，已跳过初始化');
      return false;
    }
    bindEvents();
    placeEntry();
    listenOrientation();
    refreshBadge();
    renderPanel();
    scheduleAutoOpen();
    startDayWatcher();
    return true;
  }

  /* ------------------------------------------------------------
   * 导出
   * ---------------------------------------------------------- */
  MG.Checkin = {
    STORAGE_KEY: STORAGE_KEY,
    CYCLE: CYCLE,
    SHIELD_MAX_MISSED: SHIELD_MAX_MISSED,
    DROPS: DROPS,
    /** 今日日期键 'YYYYMMDD'（与每日挑战同口径） */
    dayKey: dayKey,
    /** 只读查询：{ canClaim, reason, kind, streak, shields }，用于角标等轻量场景 */
    peek: function () {
      var data = load();
      var plan = evaluate(data);
      return {
        canClaim: plan.canClaim, reason: plan.reason, kind: plan.kind,
        streak: plan.streak, shields: plan.shields, day: plan.day,
        // 时钟异常观测：anomaly = 已持续到第几天（含今天），anomalyFrom = 本轮首次异常日
        anomaly: (plan.anomaly != null ? plan.anomaly : data.anomaly),
        anomalyFrom: data.anomalyFrom
      };
    },
    /** 完整状态（面板 / 调试用） */
    state: function () {
      var data = load();
      var plan = evaluate(data);
      return { data: data, plan: plan };
    },
    claim: claim,
    openPanel: openPanel,
    closePanel: closePanel,
    isPanelOpen: isPanelOpen,
    refreshBadge: refreshBadge,
    init: init,
    /** 测试专用：注入随机源（传 null 恢复 Math.random） */
    _setRng: function (fn) { rng = (typeof fn === 'function') ? fn : Math.random; },
    /** 测试专用：清掉内存副本，强制下次从 localStorage 重读 */
    _resetCache: function () {
      cache = null;
      view = null;
      /* degraded 的语义是"本会话写过盘失败，磁盘是旧的，以内存为准"。
         既然要"清掉内存副本、重新以磁盘为准"，这个标记就必须一起清 ——
         否则 load() 仍不读盘，反而把刚清空的 cache 当成真相
         （表现为：面板显示"从未签到"，一领取就以空档覆盖磁盘、连签全丢还白拿首签）。 */
      degraded = false;
    }
  };

})(window);
