/* ============================================================
 * js/settings.js
 * 设置管理模块
 * - 默认设置定义
 * - localStorage 读写（刷新后仍生效）
 * - 设置变更事件广播（供主循环 / UI 实时响应）
 * ============================================================ */
(function (global) {
  'use strict';

  // 全局命名空间（各模块共用，避免污染 window）
  var MG = global.MG = global.MG || {};

  /** localStorage 存储键 */
  var STORAGE_KEY = 'maze3d.settings.v1';
  /** 最佳记录 & 成就 存储键 */
  var RECORD_KEY = 'maze3d.records.v1';
  var ACHIEVE_KEY = 'maze3d.achievements.v1';

  /* ------------------------------------------------------------
   * 默认设置
   * ---------------------------------------------------------- */
  var DEFAULT_SETTINGS = {
    fov: 75,              // 视场角 60~110，默认 75
    invertYaw: false,     // 水平滑动视角翻转
    invertPitch: false,   // 垂直滑动视角翻转
    sensitivity: 1.0,     // 视角灵敏度 0.2~3
    moveSpeed: 1.0,       // 移动速度倍率 0.5~2
    quality: 'mid',       // 画质 low | mid | high
    shadows: false,       // 阴影开关
    fog: true,            // 雾效开关
    minimap: true,        // 小地图开关
    minimapCoins: false,  // 小地图显示全部金币位置（未探索用轮廓）
    volume: 0.6,          // 音量 0~1
    sfx: true,            // 音效开关
    theme: 'tech',        // 主题 tech | dungeon | forest
    colorblind: false,    // 色盲友好模式
    ghostMode: 'ask',     // 幽灵对手：ask=询问 | always=总是启用 | never=从不启用
    autoPerformance: true // 自动性能适配（低端机自动降画质）
  };

  /** 当前设置（深拷贝默认值） */
  var settings = assign({}, DEFAULT_SETTINGS);

  /** 订阅者列表 */
  var listeners = [];

  /** 简易对象浅拷贝 */
  function assign(target) {
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i];
      if (!src) continue;
      for (var k in src) {
        if (Object.prototype.hasOwnProperty.call(src, k)) target[k] = src[k];
      }
    }
    return target;
  }

  /** 数值钳制 */
  function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

  /* ------------------------------------------------------------
   * 读写 localStorage（失败时静默降级）
   * ---------------------------------------------------------- */
  function safeGet(key) {
    try { return global.localStorage.getItem(key); } catch (e) { return null; }
  }
  function safeSet(key, value) {
    try { global.localStorage.setItem(key, value); return true; } catch (e) { return false; }
  }

  /** 从 localStorage 加载设置 */
  function loadSettings() {
    var raw = safeGet(STORAGE_KEY);
    if (raw) {
      try {
        var parsed = JSON.parse(raw);
        mergeValidated(parsed);
      } catch (e) {
        console.warn('[settings] 解析失败，使用默认设置', e);
      }
    }
    // 自动性能适配：低端设备首次进入时自动降低画质
    if (settings.autoPerformance) autoDetectPerformance();
    return settings;
  }

  /** 合并并校验外部数据，保证类型与范围合法 */
  function mergeValidated(data) {
    if (!data || typeof data !== 'object') return;
    if (typeof data.fov === 'number') settings.fov = clamp(data.fov, 60, 110);
    if (typeof data.invertYaw === 'boolean') settings.invertYaw = data.invertYaw;
    if (typeof data.invertPitch === 'boolean') settings.invertPitch = data.invertPitch;
    if (typeof data.sensitivity === 'number') settings.sensitivity = clamp(data.sensitivity, 0.2, 3);
    if (typeof data.moveSpeed === 'number') settings.moveSpeed = clamp(data.moveSpeed, 0.5, 2);
    if (['low', 'mid', 'high'].indexOf(data.quality) >= 0) settings.quality = data.quality;
    if (typeof data.shadows === 'boolean') settings.shadows = data.shadows;
    if (typeof data.fog === 'boolean') settings.fog = data.fog;
    if (typeof data.minimap === 'boolean') settings.minimap = data.minimap;
    if (typeof data.minimapCoins === 'boolean') settings.minimapCoins = data.minimapCoins;
    if (typeof data.volume === 'number') settings.volume = clamp(data.volume, 0, 1);
    if (typeof data.sfx === 'boolean') settings.sfx = data.sfx;
    if (['tech', 'dungeon', 'forest'].indexOf(data.theme) >= 0) settings.theme = data.theme;
    if (typeof data.colorblind === 'boolean') settings.colorblind = data.colorblind;
    // 幽灵对手：仅接受合法枚举值
    if (['ask', 'always', 'never'].indexOf(data.ghostMode) >= 0) settings.ghostMode = data.ghostMode;
    if (typeof data.autoPerformance === 'boolean') settings.autoPerformance = data.autoPerformance;
  }

  /** 低端设备自动降配：内存/核心数偏低时降低画质与像素比 */
  function autoDetectPerformance() {
    var lowEnd = false;
    try {
      var mem = navigator.deviceMemory;         // Chrome/Android 支持
      var cores = navigator.hardwareConcurrency || 4;
      if (typeof mem === 'number' && mem <= 4) lowEnd = true;
      if (cores <= 4) lowEnd = true;
      // 移动端 UA 也倾向保守
      if (/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) && cores <= 6) lowEnd = true;
    } catch (e) { /* 忽略 */ }
    if (lowEnd && settings.quality === 'high') {
      settings.quality = 'mid';
      console.info('[settings] 检测到低端设备，已自动将画质调整为"中"');
    }
  }

  /** 保存设置 */
  function saveSettings() {
    safeSet(STORAGE_KEY, JSON.stringify(settings));
  }

  /** 修改单个设置项并广播（realTime 表示是否需要立即作用于引擎） */
  function setSetting(key, value) {
    if (!(key in DEFAULT_SETTINGS)) return;
    settings[key] = value;
    // 用户手动改过画质 → 关掉自动性能适配，避免下次加载被静默降回 mid
    if (key === 'quality') settings.autoPerformance = false;
    saveSettings();
    emit({ key: key, value: value, settings: settings });
  }

  /** 批量应用（用于 UI 初始化同步，不触发广播） */
  function replaceAll(data) {
    mergeValidated(data);
    saveSettings();
  }

  /** 重置为默认设置 */
  function resetSettings() {
    settings = assign({}, DEFAULT_SETTINGS);
    saveSettings();
    emit({ key: '*', value: null, settings: settings, reset: true });
    return settings;
  }

  /** 订阅设置变更 */
  function onSettingChange(fn) {
    if (typeof fn === 'function') listeners.push(fn);
  }

  /** 广播变更 */
  function emit(evt) {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](evt); } catch (e) { console.warn('[settings] listener error', e); }
    }
  }

  /* ------------------------------------------------------------
   * 最佳记录： { simple: {time, steps}, medium: {...}, hard: {...} }
   * ---------------------------------------------------------- */
  function loadRecords() {
    var raw = safeGet(RECORD_KEY);
    if (!raw) return {};
    try { return JSON.parse(raw) || {}; } catch (e) { return {}; }
  }
  function saveRecords(rec) { safeSet(RECORD_KEY, JSON.stringify(rec)); }

  /**
   * 提交一条成绩，仅当更优时更新
   * @returns {{isBest:boolean, best:object}}
   */
  function submitRecord(diff, time, steps) {
    var rec = loadRecords();
    var cur = rec[diff];
    var isBest = false;
    // 时间按 1ms 容差比较：存储的是未舍入的 elapsed，浮点严格相等几乎不可能命中，
    // 会导致"同样快但步数更少"无法更新记录
    var EPS = 1e-3;
    var better = !cur ||
      (time < cur.time - EPS) ||
      (Math.abs(time - cur.time) <= EPS && steps < cur.steps);
    if (better) {
      rec[diff] = { time: time, steps: steps, date: new Date().toISOString().slice(0, 10) };
      saveRecords(rec);
      isBest = true;
    }
    return { isBest: isBest, best: rec[diff] || null, all: rec };
  }

  /* ------------------------------------------------------------
   * 成就
   * ---------------------------------------------------------- */
  var ACHIEVEMENTS = [
    { id: 'first_win',   name: '初次通关',       desc: '首次到达迷宫终点' },
    { id: 'no_autopath', name: '自力更生',       desc: '不使用自动寻路通关' },
    { id: 'hard_win',    name: '勇者无畏',       desc: '困难难度通关' },
    { id: 'fast_simple', name: '疾风步',         desc: '简单难度 40 秒内通关' },
    { id: 'explorer',    name: '探险家',         desc: '累计通关 5 次' },
    { id: 'collector',   name: '收藏家',         desc: '单局收集所有金币' }
  ];

  function loadAchievements() {
    var raw = safeGet(ACHIEVE_KEY);
    if (!raw) return {};
    try { return JSON.parse(raw) || {}; } catch (e) { return {}; }
  }
  function saveAchievements(a) { safeSet(ACHIEVE_KEY, JSON.stringify(a)); }

  /** 解锁成就，返回是否为新解锁 */
  function unlockAchievement(id) {
    var a = loadAchievements();
    if (a[id]) return false;
    a[id] = { date: new Date().toISOString().slice(0, 10) };
    saveAchievements(a);
    return true;
  }

  /** 增加计数器类成就数据（如通关次数） */
  function bumpCounter(id) {
    var a = loadAchievements();
    a['counter_' + id] = (a['counter_' + id] || 0) + 1;
    saveAchievements(a);
    return a['counter_' + id];
  }
  function getCounter(id) {
    var a = loadAchievements();
    return a['counter_' + id] || 0;
  }

  /* ------------------------------------------------------------
   * 导出
   * ---------------------------------------------------------- */
  MG.Settings = {
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    ACHIEVEMENTS: ACHIEVEMENTS,
    get: function () { return settings; },
    load: loadSettings,
    save: saveSettings,
    set: setSetting,
    replaceAll: replaceAll,
    reset: resetSettings,
    onSettingChange: onSettingChange,
    clamp: clamp,
    // 记录 / 成就
    loadRecords: loadRecords,
    submitRecord: submitRecord,
    loadAchievements: loadAchievements,
    unlockAchievement: unlockAchievement,
    bumpCounter: bumpCounter,
    getCounter: getCounter
  };

  // data 只作为只读兼容入口：始终指向"当前"设置对象，
  // 不再是可能过期的旧快照（resetSettings 后引用会被替换）
  Object.defineProperty(MG.Settings, 'data', {
    get: function () { return settings; },
    enumerable: false,
    configurable: true
  });

})(window);