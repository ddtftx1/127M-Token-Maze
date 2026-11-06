/* ============================================================
 * js/audio.js
 * 音效模块（纯 WebAudio 程序化合成，不依赖任何音频文件）
 * - 按钮点击声、脚步、终点胜利、自动寻路、金币、错误提示
 * - 音量 / 音效开关跟随设置
 * - 首次用户交互后可解锁 AudioContext（移动端浏览器策略）
 * ============================================================ */
(function (global) {
  'use strict';

  var MG = global.MG = global.MG || {};

  var ctx = null;         // AudioContext
  var masterGain = null;  // 总音量节点
  var lastStepTimeMap = {}; // 脚步节流（按来源区分：player / ghost / …）
  var Settings = null;    // 设置引用（延迟获取）

  /** 惰性创建 AudioContext */
  function ensureContext() {
    if (!Settings) Settings = MG.Settings;
    if (ctx) return ctx;
    try {
      var AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      masterGain = ctx.createGain();
      var v0 = currentVolume();
      if (!isFinite(v0)) v0 = 0.6;          // 音量被写成 NaN 时不能让 gain 变 NaN（会抛错并废掉本次会话音频）
      masterGain.gain.value = v0;
      masterGain.connect(ctx.destination);
    } catch (e) {
      console.warn('[audio] AudioContext 创建失败', e);
      ctx = null;
    }
    return ctx;
  }

  /** 读取当前音量（结合音效开关） */
  function currentVolume() {
    var s = (MG.Settings && MG.Settings.get()) || {};
    if (s.sfx === false) return 0;
    var v = typeof s.volume === 'number' ? s.volume : 0.6;
    return Math.max(0, Math.min(1, v));
  }

  /** 实时同步音量（设置变化时调用） */
  function syncVolume() {
    if (masterGain && ctx) {
      var target = currentVolume();
      // 平滑过渡，避免爆音
      try {
        masterGain.gain.cancelScheduledValues(ctx.currentTime);
        masterGain.gain.setTargetAtTime(target, ctx.currentTime, 0.03);
      } catch (e) { masterGain.gain.value = target; }
    }
  }

  /** 挂起时的一次性解锁节流：1 秒内最多尝试一次，避免每个音效都 resume 一次 */
  var unlockAt = 0;
  function ensureUnlockSoon() {
    var now = Date.now();
    if (now - unlockAt < 1000) return;
    unlockAt = now;
    unlock();
  }

  /** 浏览器自动播放策略：需在用户手势中调用 */
  function unlock() {
    var c = ensureContext();
    if (!c) return;
    if (c.state === 'suspended') {
      try {
        var p = c.resume();
        if (p && p.then) p.catch(function () {});
      } catch (e) { /* 忽略 */ }
    }
  }

  /**
   * 首次用户手势自动解锁：四个事件都挂上，命中任意一个即可。
   * - 部分浏览器要求 resume 必须在手势调用栈内，故在真实事件里再试一次
   * - 只注册一次（靠 unlockBound 守卫防重复绑定）；注意 { once: true } 是 Chrome 55+
   *   才支持的语义，Chrome 49 会把它当成 useCapture 用、监听器不会自动移除，
   *   所以这里不依赖 once —— unlock() 本身是幂等的，重复触发无副作用
   */
  var unlockBound = false;
  function bindAutoUnlock() {
    if (unlockBound) return;
    unlockBound = true;
    var events = ['mousedown', 'touchstart', 'click', 'keydown'];
    for (var i = 0; i < events.length; i++) {
      try {
        global.addEventListener(events[i], unlock, { once: true, passive: true });
      } catch (e) {
        try { global.addEventListener(events[i], unlock, false); } catch (e2) { /* 忽略 */ }
      }
    }
  }

  /**
   * 播放一个简短的合成音
   * @param {Object} opt {freq, freq2, type, dur, vol, attack, decay, delay}
   */
  function tone(opt) {
    // 先判静音再建上下文：静音时连锁都不该开（否则隐私模式/静音场景白建 AudioContext）
    if (currentVolume() <= 0) return;
    var c = ensureContext();
    if (!c) return;
    // 上下文挂起（自动播放策略未解锁）：直接放弃本次发音。
    // 原实现每个音都 resume() 一次并把振荡器排进未运行的上下文，解锁瞬间会齐发/爆音。
    if (c.state === 'suspended') {
      ensureUnlockSoon();
      return;
    }
    var t0 = c.currentTime + (opt.delay || 0);
    var dur = opt.dur || 0.12;
    var osc = c.createOscillator();
    var gain = c.createGain();
    osc.type = opt.type || 'sine';
    osc.frequency.setValueAtTime(opt.freq || 440, t0);
    if (opt.freq2) {
      // 频率滑音
      osc.frequency.exponentialRampToValueAtTime(Math.max(30, opt.freq2), t0 + dur);
    }
    var vol = (opt.vol != null ? opt.vol : 0.3);
    var attack = opt.attack != null ? opt.attack : 0.008;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t0 + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain);
    gain.connect(masterGain);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
    osc.onended = function () {
      try { gain.disconnect(); osc.disconnect(); } catch (e) {}
    };
  }

  /** 白噪声（用于脚步/粒子感） */
  function noise(opt) {
    if (currentVolume() <= 0) return;
    var c = ensureContext();
    if (!c) return;
    // 同 tone()：挂起时放弃本次噪声，交给统一的解锁流程（不排队，避免解锁后齐发）
    if (c.state === 'suspended') {
      ensureUnlockSoon();
      return;
    }
    opt = opt || {};
    var dur = opt.dur || 0.08;
    var len = Math.max(1, Math.floor(c.sampleRate * dur));
    var buf = c.createBuffer(1, len, c.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < len; i++) {
      // 带渐弱的噪声
      data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    }
    var src = c.createBufferSource();
    src.buffer = buf;
    var filter = c.createBiquadFilter();
    filter.type = opt.filterType || 'lowpass';
    filter.frequency.value = opt.frequency || 900;
    var gain = c.createGain();
    gain.gain.value = opt.vol != null ? opt.vol : 0.16;
    src.connect(filter);
    filter.connect(gain);
    gain.connect(masterGain);
    src.start();
    src.onended = function () {
      try { gain.disconnect(); filter.disconnect(); src.disconnect(); } catch (e) {}
    };
  }

  /* ------------------------------------------------------------
   * 对外具体音效
   * ---------------------------------------------------------- */
  var API = {
    unlock: unlock,
    syncVolume: syncVolume,

    /** 按钮点击 */
    click: function () { tone({ freq: 620, freq2: 880, type: 'triangle', dur: 0.07, vol: 0.22 }); },

    /** 脚步（带节流，按移动速度触发）；ownerKey 区分脚步来源（默认 'player'，未来幽灵可传 'ghost'） */
    step: function (fast, ownerKey) {
      var now = performance.now();
      var interval = fast ? 260 : 380;
      var key = ownerKey || 'player';
      var last = lastStepTimeMap[key] || 0;
      if (now - last < interval) return;
      lastStepTimeMap[key] = now;
      noise({ dur: 0.07, frequency: 620 + Math.random() * 200, vol: 0.10 });
    },

    /** 自动寻路启动 */
    pathStart: function () {
      tone({ freq: 420, freq2: 840, type: 'sawtooth', dur: 0.16, vol: 0.16 });
      tone({ freq: 840, freq2: 1260, type: 'sine', dur: 0.18, vol: 0.12, delay: 0.12 });
    },

    /** 取消寻路 */
    pathCancel: function () { tone({ freq: 520, freq2: 220, type: 'sawtooth', dur: 0.16, vol: 0.14 }); },

    /** 收集金币 */
    coin: function () {
      tone({ freq: 1180, type: 'square', dur: 0.06, vol: 0.14 });
      tone({ freq: 1760, type: 'square', dur: 0.1, vol: 0.12, delay: 0.06 });
    },

    /** 商店购买成功 */
    purchase: function () {
      tone({ freq: 880, type: 'triangle', dur: 0.08, vol: 0.16 });
      tone({ freq: 1318.5, type: 'triangle', dur: 0.1, vol: 0.14, delay: 0.07 });
      tone({ freq: 1760, type: 'sine', dur: 0.22, vol: 0.12, delay: 0.14 });
    },

    /** 找到迷宫地图 */
    mapFound: function () {
      tone({ freq: 660, type: 'sine', dur: 0.1, vol: 0.15 });
      tone({ freq: 990, type: 'sine', dur: 0.12, vol: 0.15, delay: 0.09 });
      tone({ freq: 1320, type: 'triangle', dur: 0.24, vol: 0.17, delay: 0.18 });
    },

    /** 错误 / 不可用 */
    error: function () { tone({ freq: 200, freq2: 120, type: 'square', dur: 0.16, vol: 0.16 }); },

    /** 到达终点：上行和弦 */
    win: function () {
      var notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
      for (var i = 0; i < notes.length; i++) {
        tone({ freq: notes[i], type: 'triangle', dur: 0.5, vol: 0.2, delay: i * 0.13 });
      }
      noise({ dur: 0.6, frequency: 3000, filterType: 'highpass', vol: 0.06 });
    },

    /** 成就解锁 */
    achieve: function () {
      tone({ freq: 784, type: 'sine', dur: 0.18, vol: 0.18 });
      tone({ freq: 1175, type: 'sine', dur: 0.3, vol: 0.16, delay: 0.14 });
    },

    /** 传送门环境低鸣（可循环调用，用于接近终点时） */
    portal: function (intensity) {
      // 不传参时 intensity 是 undefined，undefined * 0.14 = NaN；
      // Web Audio 对 NaN 参数会抛 TypeError（gamma/指数曲线），表现就是"点了没声音"
      var k = (typeof intensity === 'number' && isFinite(intensity)) ? intensity : 1;
      var v = Math.max(0.02, Math.min(0.14, k * 0.14));
      tone({ freq: 180, freq2: 240, type: 'sine', dur: 0.9, vol: v });
    }
  };

  // 首次用户手势自动解锁音频（脚本加载即绑定，才能捕获页面上的第一次点击 / 触摸 / 按键）
  bindAutoUnlock();

  MG.Audio = API;

})(window);
