/* ============================================================
 * js/dev.js
 * 开发者选项（MG.Dev）—— 仅在通过两题验证后、本会话内可用
 *
 * 定位：一个"测试台"，用来快速验证图标 / 音频 / 视觉 / 玩法 / 存档 / 环境 / 日志，
 * 并提供「空关卡沙盒」用于新功能试作（沙盒内道具面板会多出生成器入口）。
 *
 * 硬约束：
 * - ES5（var / function / IIFE）+ 无第三方依赖；Chrome 49 / Win7 可用
 * - 样式与逻辑都不使用 CSS Grid、flex gap、ES6+ 语法（老内核同样能开）
 * - 解锁状态只存内存（本会话有效），不写 localStorage
 * - 面板内静音只包装 MG.Audio 方法，**不修改设置**；退出即原样恢复
 * ============================================================ */
(function (global) {
  'use strict';

  var MG = global.MG = global.MG || {};

  /* ------------------------------------------------------------
   * 常量
   * ---------------------------------------------------------- */
  var LOG_MAX = 100;              // 日志环形缓冲上限
  var STATUS_MS = 4000;           // 状态条自动消失时间
  var CHECKIN_KEY = 'maze3d.checkin.v1';
  /* 老内核"模拟降级"三档（BUG-032）。
   * 注意与 legacy-* 的区别：legacy-env / legacy-inset / legacy-gap / legacy-dvh 是
   * **能力补偿**（只在浏览器确实不支持某项特性时才挂上，现代浏览器上永远不触发），
   * 拿它做"模拟"必然点哪个都一样。这里改成三档**真的会降低 UI 观感**的 body class，
   * 单选互斥、全站生效，方便去各个正常界面做验收。 */
  var SIM_CLASSES = ['sim-legacy-1', 'sim-legacy-2', 'sim-legacy-3'];
  var SIM_LABELS = {
    'sim-legacy-1': '旧内核（无模糊/无动画/直角）',
    'sim-legacy-2': '更老内核（叠加无渐变、面板不透明）',
    'sim-legacy-3': '无硬件加速（叠加图标灰化、重边框）'
  };
  /** 解锁后挂"免密入口"的容器（BUG-034）：每个界面一个 */
  var QUICK_MOUNT_IDS = [
    'main-menu', 'pause-menu', 'settings-panel', 'win-screen',
    'achievement-screen', 'ranking-screen', 'shop-screen',
    'checkin-screen', 'item-panel', 'ghost-modal', 'hud'
  ];
  /** 真正会发声的音效（顺序即展示顺序） */
  var AUDIO_SFX = [
    'click', 'step', 'pathStart', 'pathCancel', 'coin',
    'purchase', 'mapFound', 'error', 'win', 'achieve', 'portal'
  ];
  /** 不发声的工具方法（unlock 只做 resume，syncVolume 只设增益） */
  var AUDIO_UTIL = ['unlock', 'syncVolume'];
  /** 带节流的音效：短时间内连点会被内部丢弃，不是坏了 */
  var AUDIO_THROTTLED = {
    step: '380ms 节流（防脚步叠音）',
    portal: '0.9s 低频低鸣（贴近终点才明显；已加泛音，手机喇叭可闻）'
  };
  /** 图标 key → 用途说明（与 js/icons.js 的顺序一致） */
  var ICON_LABELS = {
    trophy: '排行榜 / 成就', shop: '商店', map: '小地图', bag: '道具背包',
    ghost: '幽灵对手', money: '金币', compass: '最佳路径', bolt: '最快路径',
    calendar: '每日挑战', party: '胜利 / 庆祝', shush: '隐藏入口',
    pause: '暂停', medal: '名次奖牌', check: '已解锁 / 已签',
    lock: '未解锁 / 未来格', camera: '回放跟随',
    shield: '签到护符', alarm: '每日签到'
  };

  /* ------------------------------------------------------------
   * 状态
   * ---------------------------------------------------------- */
  var unlocked = false;           // 本会话是否已通过验证（不落盘）
  var panelOpen = false;
  var pauseResume = false;      // 面板是从「对局/暂停」里打开的：关闭时回暂停菜单而不是主菜单
  var opening = false;          // 正在执行 open()：期间忽略 onScreenShown 的"被顶掉"回调
  var activeTab = 'icons';
  var statusKind = '';
  var statusMsg = '';
  var statusTimer = null;
  var audioBackup = null;         // 静音前的原始 MG.Audio 方法
  var logs = [];                  // {t, level, text}
  var logSeq = 0;
  var consoleHooked = false;
  var els = {};
  var fps = { raf: 0, frames: 0, last: 0, value: 0, running: false };

  /* 沙盒 */
  var sandboxPending = false;     // 下一次开局走沙盒
  var sandboxActive = false;      // 当前这一局是沙盒
  var sandboxAutoMap = true;      // 沙盒里自动解锁小地图

  /* ------------------------------------------------------------
   * 小工具
   * ---------------------------------------------------------- */
  function $(id) { return document.getElementById(id); }

  function trim(s) { return String(s === undefined || s === null ? '' : s).replace(/^\s+|\s+$/g, ''); }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function icon(k) { return (MG.UI && MG.UI.iconHtml) ? MG.UI.iconHtml(k) : ''; }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function ymd(d) { return '' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()); }

  function setStatus(kind, msg) {
    statusKind = kind;
    statusMsg = msg;
    var node = els['dev-status'];
    if (node) {
      node.className = 'dev-status' + (kind === 'ok' ? ' is-ok' : (kind === 'err' ? ' is-err' : ''));
      node.textContent = msg || '';
    }
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(function () {
      statusTimer = null;
      if (!els['dev-status']) return;
      els['dev-status'].className = 'dev-status';
      els['dev-status'].textContent = '';
    }, STATUS_MS);
  }

  /** 让签到模块丢掉内存副本 + 刷新角标（删/清/导入存档后必须调，否则界面显示的是旧档） */
  function resetCheckinCache() {
    if (MG.Checkin && MG.Checkin._resetCache) MG.Checkin._resetCache();
    if (MG.Checkin && MG.Checkin.refreshBadge) MG.Checkin.refreshBadge();
  }

  /** 让钱包模块丢掉内存缓存（同上：shop 缓存着整份钱包，不回读就会把刚删/刚导入的档整份写回） */
  function resetShopCache() {
    if (MG.Shop && MG.Shop.invalidateCache) MG.Shop.invalidateCache();
  }

  function safeGet(key) {
    try { return global.localStorage.getItem(key); } catch (e) { return null; }
  }
  function safeSet(key, val) {
    try { global.localStorage.setItem(key, val); return true; } catch (e) { return false; }
  }
  function safeDel(key) {
    try { global.localStorage.removeItem(key); return true; } catch (e) { return false; }
  }

  function storageKeys() {
    var out = [];
    try {
      for (var i = 0; i < global.localStorage.length; i++) {
        var k = global.localStorage.key(i);
        if (k) out.push(k);
      }
    } catch (e) { /* 存储不可用 */ }
    out.sort();
    return out;
  }

  function sizeOf(text) {
    if (!text) return 0;
    if (typeof text.length === 'number') return text.length;
    return 0;
  }

  /* ------------------------------------------------------------
   * 复制：优先剪贴板 API，失败退化为"给出可选中的文本框"
   * （项目要支持 file:// 双击打开，那种协议下 clipboard API 常常不可用）
   * ---------------------------------------------------------- */
  function copyText(text, label) {
    var done = false;
    var cb = global.navigator && global.navigator.clipboard;
    // writeText 返回 Promise：拒绝（file:// 非安全上下文、权限被拒）不会进 catch，
    // 所以只能走 .catch / .then 的第二参数，在失败回调里再跑下面的退路
    if (cb && typeof cb.writeText === 'function') {
      try {
        var pr = cb.writeText(text);
        if (pr && typeof pr.then === 'function') {
          pr.then(function () {
            setStatus('ok', '已复制：' + (label || '内容'));
          }, function () {
            copyFallback(text, label);   // 异步失败 → 走后两步同步退路
          });
          return;                          // 结果由上面的回调决定，不再往下走
        }
        done = true;                       // 极老的实现可能返回 undefined：按成功处理
      } catch (e) { done = false; }
    }
    if (!done) copyFallback(text, label);
  }

  /** 剪贴板不可用时的两级退路：execCommand → 可选中的文本框 */
  function copyFallback(text, label) {
    var done = false;
    // 退路一：临时 textarea + execCommand
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      done = document.execCommand && document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e2) { done = false; }
    if (done) {
      setStatus('ok', '已复制：' + (label || '内容'));
    } else {
      // 退路二：把内容展示到一个可选中的文本框里，让玩家自己长按复制
      var box = $('dev-clip');
      if (box) {
        box.value = text;
        box.style.display = 'block';
        try { box.focus(); box.select(); } catch (e3) { /* 忽略 */ }
        setStatus('err', '剪贴板不可用，已把内容放进下方文本框，请手动复制');
      } else {
        setStatus('err', '剪贴板不可用');
      }
    }
  }

  /* ------------------------------------------------------------
   * 音频静音：只包装 MG.Audio 的方法，不碰 MG.Settings
   * ---------------------------------------------------------- */
  function muteAudio() {
    if (audioBackup || !MG.Audio) return;
    var backup = {};
    // 先把原始方法全部记下来，**再**统一替换。
    // 反过来的话，一旦某个属性赋值抛错（'use strict' 下对只读属性赋值会抛 TypeError），
    // open() 的 catch 会调 unmuteAudio()，而那时 audioBackup 还是 null → 已替换掉的方法找不回来，
    // 本会话音效就永久哑了。
    for (var k in MG.Audio) {
      if (!Object.prototype.hasOwnProperty.call(MG.Audio, k)) continue;
      if (typeof MG.Audio[k] !== 'function') continue;
      backup[k] = MG.Audio[k];
    }
    audioBackup = backup;
    for (var k2 in backup) {
      if (!Object.prototype.hasOwnProperty.call(backup, k2)) continue;
      try { MG.Audio[k2] = function () { }; } catch (e) { /* 只读属性：跳过，不影响其余 */ }
    }
  }

  function unmuteAudio() {
    if (!audioBackup) return;
    for (var k in audioBackup) {
      if (Object.prototype.hasOwnProperty.call(audioBackup, k)) {
        MG.Audio[k] = audioBackup[k];
      }
    }
    audioBackup = null;
  }

  /**
   * 读取真实音频诊断信息。
   * 必须优先走备份：面板打开期间 MG.Audio 的方法（含 diagnostics）会被整体替换成空函数，
   * 直接调 MG.Audio.diagnostics() 只会拿到 undefined。返回 null 表示拿不到（旧版 audio.js）。
   */
  function audioDiag() {
    var fn = (audioBackup && audioBackup.diagnostics) ||
             (MG.Audio && typeof MG.Audio.diagnostics === 'function' ? MG.Audio.diagnostics : null);
    if (typeof fn !== 'function') return null;
    try { return fn(); } catch (e) { return null; }
  }

  /** 音频页专用：绕过面板静音，调用"进面板前"的真实方法 */
  function playAudioRaw(name) {
    var mute = audioMuteReason();
    if (mute) {
      setStatus('err', '不会出声：' + mute + '。请到「设置」里打开音效 / 调高音量');
      return;
    }
    var fn = null;
    if (audioBackup && audioBackup[name]) fn = audioBackup[name];
    else if (MG.Audio && typeof MG.Audio[name] === 'function') fn = MG.Audio[name];
    if (typeof fn !== 'function') {
      setStatus('err', 'MG.Audio.' + name + ' 不存在');
      return;
    }
    /* 如实反馈（BUG-061）：音频上下文没解锁 / 被挂起时，audio.js 的 tone() 会**直接放弃**
       本次发音（为了不在解锁瞬间齐发，它刻意不排队），此时再报"已播放"就是假消息 ——
       用户 2026-11-09 反馈的就是"portal 不响，但仍提示已播放"。

       判定要用**调用前**的状态：tone() 在挂起时会顺手调一次 resume()，真实浏览器里
       resume() 是异步的、但状态可能很快就不是 suspended 了 —— 只看调用后会把"这次其实没出声"
       误判成成功。调用前若已是非 running，就一定是被放弃的那一次。 */
    var before = audioDiag();
    try {
      fn();
      var after = audioDiag();
      var st = null;
      if (before && before.created && before.ctxState !== 'running') st = before.ctxState;
      else if (after && after.created && after.ctxState !== 'running') st = after.ctxState;
      if (st) {
        setStatus('err', '已调用 MG.Audio.' + name + '()，但音频上下文是「' + st +
          '」，本次不会出声：先点一下页面任意处（需要用户手势解锁）再试');
      } else {
        setStatus('ok', '已播放 MG.Audio.' + name + '()');
      }
    } catch (e) {
      setStatus('err', '播放 ' + name + ' 抛错：' + (e && e.message ? e.message : e));
    }
  }

  /* ------------------------------------------------------------
   * 日志捕获（只记录，不拦截原输出）
   * ---------------------------------------------------------- */
  function fmtArg(a) {
    if (a === null || a === undefined) return String(a);
    if (typeof a === 'string') return a;
    if (typeof a === 'number' || typeof a === 'boolean') return String(a);
    try { return JSON.stringify(a); } catch (e) { return String(a); }
  }

  function pushLog(level, text) {
    var d = new Date();
    logs.push({
      id: ++logSeq,
      t: pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()),
      level: level,
      text: text
    });
    while (logs.length > LOG_MAX) logs.shift();
    if (activeTab === 'logs' && panelOpen) renderBody();
  }

  function hookConsole() {
    if (consoleHooked || !global.console) return;
    consoleHooked = true;
    var wrap = function (level) {
      var orig = global.console[level];
      if (typeof orig !== 'function') return;
      global.console[level] = function () {
        var parts = [];
        for (var i = 0; i < arguments.length; i++) parts.push(fmtArg(arguments[i]));
        try { pushLog(level, parts.join(' ')); } catch (e) { /* 忽略 */ }
        return orig.apply(global.console, arguments);
      };
    };
    wrap('warn');
    wrap('error');
    if (typeof global.addEventListener !== 'function') return;
    global.addEventListener('error', function (e) {
      var msg = (e && e.message) ? e.message : 'unknown';
      var where = (e && e.filename) ? (' @ ' + e.filename + ':' + e.lineno) : '';
      pushLog('error', 'onerror: ' + msg + where);
    });
  }

  /* ------------------------------------------------------------
   * FPS 采样（独立 rAF，不影响主循环）
   * ---------------------------------------------------------- */
  function startFps() {
    if (fps.running || !global.requestAnimationFrame) return;
    fps.running = true;
    fps.frames = 0;
    fps.value = 0;
    fps.last = Date.now();
    var tick = function () {
      if (!fps.running) return;
      fps.frames++;
      var now = Date.now();
      if (now - fps.last >= 500) {
        fps.value = Math.round(fps.frames * 1000 / (now - fps.last));
        fps.frames = 0;
        fps.last = now;
        var out = $('dev-fps');
        if (out) out.textContent = String(fps.value);
        // BUG-066：顺手刷新长帧读数（同一处 500ms 节拍，不额外加定时器）
        var lf = $('dev-longframes');
        if (lf) lf.textContent = longFrameText();
      }
      fps.raf = global.requestAnimationFrame(tick);
    };
    fps.raf = global.requestAnimationFrame(tick);
  }

  function stopFps() {
    fps.running = false;
    if (fps.raf && global.cancelAnimationFrame) global.cancelAnimationFrame(fps.raf);
    fps.raf = 0;
  }

  /* ------------------------------------------------------------
   * 面板开关
   * ---------------------------------------------------------- */
  function unlockAndOpen() {
    unlocked = true;
    mountQuickEntries();   // BUG-034：解锁后各界面常驻免密入口
    open();
  }

  function open() {
    if (!unlocked) { setStatus('err', '未通过验证'); return; }
    if (!els['dev-screen']) return;
    panelOpen = true;
    opening = true;
    /* opening 用 try/finally 收口：中途任何一步抛错（比如某个 DOM 方法异常）
       都必须把 opening 复位，否则 onScreenShown 会被**永久**屏蔽，
       "面板被顶掉后不还原音频"那个 bug 就又回来了。 */
    try {
      /* BUG-036：从 HUD 入口在对局中打开时**必须先暂停**。
         否则面板背后这一局还在跑：WASD 继续移动角色、计时继续走，
         甚至走到终点会在主菜单上弹出胜利结算并写排行榜/回放/钱包（等于凭空刷一局成绩）。
         把"暂停"复用既有的 pauseGame（MG.UI.hudCallbacks.onPause），不新增引擎侧接口。 */
      pauseResume = false;
      if (MG.Game && MG.Game.state === 'playing') {
        pauseResume = true;
        if (MG.UI && MG.UI.hudCallbacks && MG.UI.hudCallbacks.onPause) MG.UI.hudCallbacks.onPause(false);
      } else if (MG.Game && MG.Game.state === 'paused') {
        pauseResume = true;   // 本来就是暂停态：关面板时回到暂停菜单
      }
      if (MG.UI && MG.UI.hideAllScreens) MG.UI.hideAllScreens();
      if (MG.UI && MG.UI.show) MG.UI.show('dev-screen');
      try {
        renderTabs();
        renderBody();
        if (activeTab === 'env') startFps();
        // 静音放在"面板已显示且渲染成功"之后：渲染一旦抛错，玩家不会落到
        // "面板没出来、声音却没了"的处境（只能刷新页面才能恢复）
        muteAudio();
      } catch (e) {
        console.error('[dev] 面板渲染失败', e);
        unmuteAudio();                     // 兜底：任何异常都立刻还原音频
        setStatus('err', '面板渲染出错，声音已还原');
      }
    } finally {
      opening = false;
    }
  }

  /**
   * 关闭面板
   * @param {boolean} [silent] 静默关闭：不回到主菜单（供"跳到别的面板 / 直接开局"使用，
   *                           避免中间闪一下主菜单）
   */
  function close(silent) {
    panelOpen = false;
    stopFps();
    // 状态条定时器要清：否则关闭面板后 4 秒内仍有一次回调去改已隐藏的 dev-status
    if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
    unmuteAudio();
    // 注意：这里**不要**清掉 sim-legacy-* —— 模拟降级要能延续到别的界面去验收（BUG-032）
    // 显式隐藏：即使 hideAllScreens 的名单将来又被漏改，面板本身也一定关得掉（双保险）
    if (MG.UI && MG.UI.hide) MG.UI.hide('dev-screen');
    var node = $('dev-screen');
    if (node && node.classList) node.classList.add('hidden');
    if (silent) { pauseResume = false; return; }
    if (pauseResume) {
      pauseResume = false;
      // 从对局里进来的：回到暂停菜单，让玩家自己选「继续游戏 / 返回主菜单」。
      // 直接 showMainMenu 会把这一局留在 state==='playing' 的僵尸态（见 open() 的注释）。
      if (MG.UI && MG.UI.showPause) { MG.UI.showPause(); return; }
    }
    /* BUG-065（2026-11-14，用户口径 A）：剩下的两种来源都交给 MG.UI.backFromOverlay() 现算 ——
       主菜单进来 → 回主菜单；**已通关的胜利界面**进来 → 回胜利界面（state === 'win'）。
       原来这里无条件 showMainMenu()，会把主菜单盖在一局 state === 'win' 的僵尸对局上，
       玩家还看不到「再玩一次 / 看回放」的入口。走同一个函数而不是再加一个来源标记，
       是为了不再重复"新增入口忘记传来源"的老坑（BUG-056 → BUG-064 → 本条）。 */
    if (MG.UI && MG.UI.backFromOverlay) { MG.UI.backFromOverlay(); return; }
    if (MG.UI && MG.UI.showMainMenu) MG.UI.showMainMenu();
  }

  function isOpen() { return panelOpen; }
  function isUnlocked() { return unlocked; }

  /* ------------------------------------------------------------
   * 页签
   * ---------------------------------------------------------- */
  var TABS = [
    { id: 'icons', label: '图标', render: renderIcons },
    { id: 'audio', label: '音频', render: renderAudio },
    { id: 'visual', label: '视觉', render: renderVisual },
    { id: 'game', label: '玩法', render: renderGame },
    { id: 'data', label: '数据', render: renderData },
    { id: 'env', label: '环境', render: renderEnv },
    { id: 'logs', label: '日志', render: renderLogs }
  ];

  function renderTabs() {
    var box = els['dev-tabs'];
    if (!box) return;
    var html = '';
    for (var i = 0; i < TABS.length; i++) {
      var t = TABS[i];
      html += '<button class="dev-tab' + (t.id === activeTab ? ' is-active' : '') + '"' +
        ' data-act="tab" data-arg="' + t.id + '">' + esc(t.label) + '</button>';
    }
    box.innerHTML = html;
  }

  /** 重绘时需要保留现场的表单元素（renderBody 会重建 innerHTML，值会丢） */
  var PRESERVE_IDS = ['dev-seed', 'dev-io', 'dev-icon-pick', 'dev-icon-count', 'dev-diff'];
  var rendering = false;

  function snapshotInputs() {
    var snap = {};
    for (var i = 0; i < PRESERVE_IDS.length; i++) {
      var n = $(PRESERVE_IDS[i]);
      if (n && typeof n.value === 'string') snap[PRESERVE_IDS[i]] = n.value;
    }
    return snap;
  }

  function restoreInputs(snap) {
    for (var id in snap) {
      if (!Object.prototype.hasOwnProperty.call(snap, id)) continue;
      var n = $(id);
      if (n && snap[id] !== '') n.value = snap[id];
    }
  }

  function renderBody() {
    var box = els['dev-body'];
    if (!box) return;
    // 防重入：renderBody 期间若有代码触发 console.warn/error，pushLog 会再次调到这里
    if (rendering) return;
    var snap = snapshotInputs();
    rendering = true;
    try {
      if (activeTab === 'env') startFps(); else stopFps();
      var done = false;
      for (var i = 0; i < TABS.length; i++) {
        if (TABS[i].id === activeTab) { TABS[i].render(box); done = true; break; }
      }
      if (!done) box.innerHTML = '';
    } finally {
      rendering = false;
    }
    restoreInputs(snap);
  }

  function card(title, note, inner) {
    return '<div class="dev-card">' +
      '<div class="dev-card-head"><b>' + esc(title) + '</b>' +
      (note ? '<span>' + note + '</span>' : '') + '</div>' +
      inner + '</div>';
  }

  function btn(label, act, arg, cls) {
    return '<button class="dev-btn' + (cls ? ' ' + cls : '') + '" data-act="' + act + '"' +
      (arg !== undefined && arg !== null ? ' data-arg="' + esc(arg) + '"' : '') + '>' + label + '</button>';
  }

  /* ------------------------------------------------------------
   * ① 图标
   * ---------------------------------------------------------- */
  function iconKeys() {
    var keys = [];
    if (MG.Icons && MG.Icons.svg) {
      for (var k in MG.Icons.svg) {
        if (Object.prototype.hasOwnProperty.call(MG.Icons.svg, k)) keys.push(k);
      }
    }
    return keys;
  }

  function renderIcons(box) {
    var keys = iconKeys();
    var grid = '';
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      grid += '<button class="dev-icon-cell" data-act="copy-icon" data-arg="' + k + '">' +
        '<span class="dev-icon-box">' + icon(k) + '</span>' +
        '<span class="dev-icon-key">' + k + '</span>' +
        '<span class="dev-icon-use">' + esc(ICON_LABELS[k] || '') + '</span>' +
        '</button>';
    }

    var opts = '';
    for (var j = 0; j < keys.length; j++) {
      opts += '<option value="' + keys[j] + '">' + keys[j] + '</option>';
    }

    var html = '';
    html += card('图标总览', keys.length + ' 个 · 点一下复制 iconHtml 代码',
      '<div class="dev-icon-grid">' + grid + '</div>');

    html += card('多实例隔离测试', '同一图标多次出现时，内部 id / 渐变引用不能串味',
      '<div class="dev-row">' +
        '<label>图标</label><select class="dev-select" id="dev-icon-pick">' + opts + '</select>' +
        '<label>份数</label><select class="dev-select" id="dev-icon-count">' +
          '<option>2</option><option>4</option><option>8</option>' +
        '</select>' +
        btn('生成', 'gen-icons') +
      '</div>' +
      '<div id="dev-icon-out" class="dev-icon-strip"></div>');

    html += card('尺寸与基线 / 缺失兜底', '检查 1em / 2em / 3em 与中文混排；不存在的 key 必须返回空串',
      '<div class="dev-row dev-baseline">' +
        '<span class="dev-em1">' + icon('trophy') + ' 1em 对齐</span>' +
        '<span class="dev-em2">' + icon('alarm') + ' 2em</span>' +
        '<span class="dev-em3">' + icon('shield') + ' 3em</span>' +
      '</div>' +
      '<div class="dev-row">' + btn('测试不存在的 key', 'test-missing') +
        '<span id="dev-missing-out" class="dev-mono"></span></div>');

    box.innerHTML = html;
  }

  /* ------------------------------------------------------------
   * ② 音频
   * ---------------------------------------------------------- */
  /** 设置层面的静音原因（返回空串表示正常） */
  function audioMuteReason() {
    if (!MG.Settings) return '';
    var s = MG.Settings.get();
    if (s.sfx === false) return '设置里「音效」是关闭的';
    if (typeof s.volume === 'number' && s.volume <= 0) return '设置里「音量」是 0';
    return '';
  }

  function renderAudio(box) {
    var sfxBtns = '';
    for (var i = 0; i < AUDIO_SFX.length; i++) {
      var n = AUDIO_SFX[i];
      var tag = AUDIO_THROTTLED[n] ? '<span class="dev-tag">' + esc(AUDIO_THROTTLED[n]) + '</span>' : '';
      sfxBtns += '<button class="dev-btn" data-act="play-audio" data-arg="' + n + '">' +
        'MG.Audio.' + n + '()' + tag + '</button>';
    }
    var utilBtns = '';
    for (var j = 0; j < AUDIO_UTIL.length; j++) {
      utilBtns += '<button class="dev-btn" data-act="play-audio" data-arg="' + AUDIO_UTIL[j] + '">' +
        'MG.Audio.' + AUDIO_UTIL[j] + '()</button>';
    }

    var mute = audioMuteReason();
    var warn = mute
      ? '<div class="dev-warn">当前不会出声：' + esc(mute) + '（到「设置」里打开音效 / 调高音量）</div>'
      : '';

    var html = '';
    html += card('音效试听', '面板内其它操作全部静音，只有这里的按钮会发声',
      warn +
      '<div class="dev-btn-grid">' + sfxBtns + '</div>' +
      '<div class="dev-row">' + btn('连播 5 次 click', 'play-audio-5') + '</div>');

    html += card('工具方法（本身不发声）', '只做上下文/增益操作，点了不会有声音是正常的',
      '<div class="dev-btn-grid">' + utilBtns + '</div>' +
      '<p class="dev-hint">unlock() 负责用用户手势唤醒 AudioContext；syncVolume() 只把总增益同步到当前设置。</p>');

    var diag = audioDiag();
    var ctxText = diag
      ? (diag.created ? diag.ctxState : '尚未创建（需要一次用户手势）')
      : '未加载';
    var ctxWarn = (diag && diag.created && diag.ctxState !== 'running')
      ? '<div class="dev-warn">音频上下文当前是「' + esc(diag.ctxState) +
        '」：试听按钮会提示"已调用但不会出声"。先点一下页面任意处解锁，再回来重试。</div>'
      : '';
    html += card('当前音频状态', '面板静音只发生在面板打开期间，退出即恢复；不写设置',
      '<div class="dev-kv">' +
        kv('sfx 设置', (MG.Settings && MG.Settings.get().sfx) ? '开' : '关') +
        kv('volume 设置', String(MG.Settings ? MG.Settings.get().volume : '-')) +
        kv('AudioContext', ctxText) +
        kv('实际总增益', diag ? String(diag.volume) : '-') +
        kv('面板内方法', audioBackup ? '已被静音包装（试听按钮走备份）' : '正常') +
      '</div>' + ctxWarn);
    box.innerHTML = html;
  }

  /* ------------------------------------------------------------
   * ③ 视觉
   * ---------------------------------------------------------- */
  function themeRow() {
    var cur = MG.Settings ? MG.Settings.get().theme : 'tech';
    var themes = [['tech', '科技'], ['dungeon', '地牢'], ['forest', '森林']];
    var out = '<div class="dev-row"><label>主题</label>';
    for (var i = 0; i < themes.length; i++) {
      out += '<button class="dev-btn' + (cur === themes[i][0] ? ' is-active' : '') + '"' +
        ' data-act="set-setting" data-arg="theme:' + themes[i][0] + '">' + themes[i][1] + '</button>';
    }
    out += '</div>';
    return out;
  }

  function renderVisual(box) {
    var s = MG.Settings ? MG.Settings.get() : {};
    var q = s.quality || 'mid';
    var html = '';
    html += card('主题 / 色盲', '切换后立即应用到 3D 场景与 UI',
      themeRow() +
      '<div class="dev-row"><label>色盲友好</label>' +
        btn(s.colorblind ? '开' : '关', 'toggle-setting', 'colorblind') + '</div>');

    html += card('画质 / 特效', '',
      '<div class="dev-row"><label>画质</label>' +
        [['low', '低'], ['mid', '中'], ['high', '高']].map(function (it) {
          return '<button class="dev-btn' + (q === it[0] ? ' is-active' : '') + '"' +
            ' data-act="set-setting" data-arg="quality:' + it[0] + '">' + it[1] + '</button>';
        }).join('') +
      '</div>' +
      '<div class="dev-row"><label>阴影</label>' + btn(s.shadows ? '开' : '关', 'toggle-setting', 'shadows') +
        '<label>雾</label>' + btn(s.fog ? '开' : '关', 'toggle-setting', 'fog') + '</div>');

    html += card('视角 / 手感', '',
      '<div class="dev-row"><label>FOV</label>' +
        '<input class="dev-range" type="range" id="dev-fov" min="60" max="110" step="1" value="' + (s.fov || 75) + '" />' +
        '<span class="dev-mono" id="dev-fov-val">' + (s.fov || 75) + '</span></div>' +
      '<div class="dev-row"><label>移速</label>' +
        '<input class="dev-range" type="range" id="dev-speed" min="0.5" max="2" step="0.1" value="' + (s.moveSpeed || 1) + '" />' +
        '<span class="dev-mono" id="dev-speed-val">' + (s.moveSpeed || 1) + '</span></div>');

    var simCur = currentSim();
    var simRow = '';
    for (var i = 0; i < SIM_CLASSES.length; i++) {
      var c = SIM_CLASSES[i];
      simRow += '<button class="dev-btn' + (simCur === c ? ' is-active' : '') + '"' +
        ' data-act="set-sim" data-arg="' + c + '">' + SIM_LABELS[c] + '</button>';
    }
    html += card('老内核模拟（真降级）',
      '单选互斥：点一个只留一个，再点一次取消。降级会作用到所有正常界面，' +
      '关掉面板后仍然保持 —— 可以退回主菜单 / 商店 / 排行榜 / 开局现场逐一验收。刷新页面即还原。',
      '<div class="dev-btn-grid">' + simRow + '</div>' +
      '<div class="dev-row">' + btn('关闭模拟', 'clear-sim') +
        '<span class="dev-hint">回到正常观感</span></div>' +
      (simCur ? '<div class="dev-sim-warn">当前正在模拟：' + SIM_LABELS[simCur] + '（仅用于测试）</div>' : ''));

    box.innerHTML = html;
  }

  /* ------------------------------------------------------------
   * ④ 玩法（含沙盒入口）
   * ---------------------------------------------------------- */
  function renderGame(box) {
    var diffs = MG.Maze ? MG.Maze.DIFFICULTIES : {};
    var diffOpts = '';
    for (var k in diffs) {
      if (!Object.prototype.hasOwnProperty.call(diffs, k)) continue;
      diffOpts += '<option value="' + k + '">' + esc(diffs[k].name) + '</option>';
    }
    var todaySeed = (MG.Maze && MG.Maze.dailySeed) ? MG.Maze.dailySeed().slice(6) : '';
    var wallet = MG.Shop ? MG.Shop.getWallet() : { coins: 0 };

    var html = '';
    html += card('开局参数', '沙盒固定用 15×15 全开放场地（无墙 / 无金币 / 无天花板）',
      '<div class="dev-row"><label>难度</label><select class="dev-select" id="dev-diff">' + diffOpts + '</select></div>' +
      '<div class="dev-row"><label>种子</label>' +
        '<input class="dev-input" id="dev-seed" type="text" maxlength="24" placeholder="留空=随机" />' +
        btn('用今日种子', 'fill-today-seed') +
        '<span class="dev-mono">' + esc(todaySeed) + '</span></div>' +
      '<div class="dev-row">' + btn('开始游戏（正常）', 'start-normal') +
        btn('进入空关卡（沙盒）', 'start-sandbox', null, 'is-primary') + '</div>' +
      '<div class="dev-row"><label>沙盒自动解锁小地图</label>' +
        btn(sandboxAutoMap ? '开' : '关', 'toggle-sandbox-map') + '</div>');

    html += card('钱包 / 道具', '与商店、签到共用同一份钱包',
      '<div class="dev-kv">' +
        kv('金币余额', String(wallet.coins)) +
        kv('小地图解锁', String(MG.Shop ? MG.Shop.countOf('mapUnlock') : 0)) +
        kv('最佳路径', String(MG.Shop ? MG.Shop.countOf('bestPath') : 0)) +
        kv('最快路径', String(MG.Shop ? MG.Shop.countOf('fastPath') : 0)) +
        kv('签到护符', String(MG.Shop ? MG.Shop.countOf('streakShield') : 0)) +
      '</div>' +
      '<div class="dev-row">' + btn('金币 +1000', 'coins-add') +
        btn('金币归零', 'coins-zero', null, 'is-danger') +
        btn('各道具 +10', 'items-add') +
        btn('道具清零', 'items-zero', null, 'is-danger') + '</div>');

    box.innerHTML = html;
  }

  /* ------------------------------------------------------------
   * ⑤ 数据 / 存档 / 签到快进
   * ---------------------------------------------------------- */
  function readCheckin() {
    var raw = safeGet(CHECKIN_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  function renderData(box) {
    var keys = storageKeys();
    var rows = '';
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var val = safeGet(k) || '';
      rows += '<details class="dev-details">' +
        '<summary><span class="dev-key">' + esc(k) + '</span>' +
        '<span class="dev-size">' + sizeOf(val) + ' 字符</span></summary>' +
        '<pre class="dev-pre">' + esc(val.length > 4000 ? val.slice(0, 4000) + ' …（已截断）' : val) + '</pre>' +
        '<div class="dev-row">' + btn('删除此项', 'del-key', k, 'is-danger') + '</div>' +
        '</details>';
    }
    if (!rows) rows = '<p class="dev-hint">localStorage 不可用或为空</p>';

    var ck = readCheckin();
    var ckInfo = ck
      ? kv('lastDay', esc(String(ck.lastDay || '（空）'))) +
        kv('streak', String(ck.streak || 0)) +
        kv('累计天数', String(ck.totalDays || 0)) +
        kv('最长连签', String(ck.maxStreak || 0)) +
        kv('护符', String(MG.Shop ? MG.Shop.countOf('streakShield') : 0))
      : '<p class="dev-hint">还没有签到存档，先去签到一次</p>';

    var html = '';
    html += card('签到快进', '把上次签到日往前挪 N 天 → 回主菜单点签到即可验证护符/断签',
      '<div class="dev-kv">' + ckInfo + '</div>' +
      '<div class="dev-btn-grid">' +
        btn('快进 1 天', 'ck-rewind', '1') +
        btn('快进 3 天', 'ck-rewind', '3') +
        btn('快进 5 天', 'ck-rewind', '5') +
        btn('快进 6 天', 'ck-rewind', '6') +
        btn('快进 7 天', 'ck-rewind', '7') +
      '</div>' +
      '<div class="dev-row">' + btn('护符 +1', 'shield-add') +
        btn('重置签到存档（回到从未签到）', 'ck-reset', null, 'is-danger') +
        btn('打开签到面板', 'open-checkin') + '</div>' +
      '<p class="dev-hint">提示：漏签 1~5 天护符生效；漏签 ≥6 天（快进 7 天）则连签清零且护符不消耗。</p>');

    html += card('存档一览', keys.length + ' 个 key · 点开看内容',
      rows +
      '<div class="dev-row">' + btn('清空全部 maze3d.* 存档', 'wipe-all', null, 'is-danger') + '</div>');

    html += card('导出 / 导入', '导入会覆盖同名 key',
      '<textarea class="dev-textarea" id="dev-io" placeholder="点「导出」把全部存档写到这里；或粘贴 JSON 后点「导入」"></textarea>' +
      '<div class="dev-row">' + btn('导出到文本框', 'export-all') +
        btn('从文本框导入', 'import-all', null, 'is-danger') + '</div>');

    box.innerHTML = html;
  }

  /* ------------------------------------------------------------
   * ⑥ 环境
   * ---------------------------------------------------------- */
  function mm(query) {
    try {
      if (!global.matchMedia) return '-';
      return global.matchMedia(query).matches ? '命中' : '不命中';
    } catch (e) { return '不支持'; }
  }

  function bodyClasses() {
    return trim(document.body.className || '') || '（无）';
  }

  function envReport() {
    var lines = [];
    lines.push('UA: ' + (global.navigator ? global.navigator.userAgent : '-'));
    lines.push('视口: ' + global.innerWidth + ' x ' + global.innerHeight);
    lines.push('DPR: ' + (global.devicePixelRatio || 1));
    lines.push('orientation:landscape = ' + mm('(orientation: landscape)'));
    lines.push('hover:none = ' + mm('(hover: none)'));
    lines.push('pointer:coarse = ' + mm('(pointer: coarse)'));
    lines.push('max-height:640px = ' + mm('(max-height: 640px)'));
    lines.push('body class: ' + bodyClasses());
    lines.push('Three.js: ' + (global.THREE ? global.THREE.REVISION : '-'));
    lines.push('FPS: ' + fps.value);
    lines.push('长帧(>25ms): ' + longFrameText());
    if (global.performance && global.performance.memory) {
      lines.push('JS 堆: ' + Math.round(global.performance.memory.usedJSHeapSize / 1048576) + ' MB');
    }
    return lines.join('\n');
  }

  /**
   * 长帧统计文案（BUG-066）。
   * 数据来自 main.js 主循环里的探针（`MG.Game.perf`）：按 10 秒窗口统计
   * "两帧间隔 > 25ms"的次数。60fps 的预算是 16.7ms，超过 25ms 已经能感觉到顿一下，
   * 所以这个数字比"平均 FPS"更能反映**滑动时的手感**。
   * 为什么不用 fps.value：那是 startFps 自己的 rAF 计数，只在「环境」页开着时才跑，
   * 玩家滑菜单的那几秒根本不在这个页面上 —— 量不到他真正遇到的问题。
   * 探针挂在常驻的主循环上，所以"先滑一遍菜单、再回来开面板看数字"是有效的。
   */
  function longFrameText() {
    var g = MG.Game;
    var p = g && g.perf;
    if (!p || !p.frames) return '暂无数据（主循环未跑满一个窗口）';
    var nowFrames = p.frames;
    var nowLong = p.longFrames;
    // 同时给出"上一个完整窗口"的数：玩家停留在本页时，当前窗口的数字一直在长大
    var prev = (p.lastFrames > 0)
      ? ('；上一个 10 秒窗口 ' + p.lastLongFrames + ' / ' + p.lastFrames + ' 帧')
      : '';
    return nowLong + ' / ' + nowFrames + ' 帧（当前窗口累计）' + prev;
  }

  function renderEnv(box) {
    var jump = '';
    var jumps = [
      ['主菜单', 'goto:menu'], ['商店', 'goto:shop'], ['成就', 'goto:ach'],
      ['排行榜', 'goto:rank'], ['签到', 'goto:checkin'], ['设置', 'goto:settings']
    ];
    for (var i = 0; i < jumps.length; i++) {
      var split = jumps[i][1].split(':');
      jump += btn(jumps[i][0], 'goto', split[1]);
    }

    var html = '';
    html += card('环境信息', '实时采样（FPS 每 0.5 秒刷新）',
      '<div class="dev-kv">' +
        kv('视口', global.innerWidth + ' x ' + global.innerHeight) +
        kv('DPR', String(global.devicePixelRatio || 1)) +
        kv('横屏媒体查询', mm('(orientation: landscape)')) +
        kv('hover: none', mm('(hover: none)')) +
        kv('pointer: coarse', mm('(pointer: coarse)')) +
        kv('高 ≤ 640', mm('(max-height: 640px)')) +
        kv('body class', esc(bodyClasses())) +
        kv('Three.js', String(global.THREE ? global.THREE.REVISION : '-')) +
        kv('FPS', '<span id="dev-fps">0</span>') +
        /* BUG-066：滑动卡顿的量尺。先退出面板去滑一遍菜单，再回来读这个数字 ——
           探针挂在常驻主循环上，不依赖本页是否打开。 */
        kv('长帧 &gt;25ms', '<span id="dev-longframes">—</span>') +
      '</div>' +
      '<details class="dev-details"><summary>User-Agent</summary>' +
        '<pre class="dev-pre">' + esc(global.navigator ? global.navigator.userAgent : '-') + '</pre></details>' +
      '<div class="dev-row">' + btn('复制环境报告', 'copy-env') + '</div>');

    html += card('快速跳转', '会先退出面板再打开目标界面',
      '<div class="dev-btn-grid">' + jump + '</div>');

    box.innerHTML = html;
  }

  /* ------------------------------------------------------------
   * ⑦ 日志
   * ---------------------------------------------------------- */
  function renderLogs(box) {
    var body = '';
    if (!logs.length) {
      body = '<p class="dev-hint">暂无日志。触发一次 warn / error 后会出现在这里。</p>';
    } else {
      for (var i = logs.length - 1; i >= 0; i--) {
        var it = logs[i];
        body += '<div class="dev-log-item is-' + it.level + '">' +
          '<span class="dev-log-t">' + it.t + '</span>' +
          '<span class="dev-log-lv">' + it.level + '</span>' +
          '<span class="dev-log-tx">' + esc(it.text) + '</span>' +
          '</div>';
      }
    }
    var html = card('日志（最近 ' + LOG_MAX + ' 条）', 'warn / error / window.onerror',
      '<div class="dev-log-list">' + body + '</div>' +
      '<div class="dev-row">' + btn('复制全部', 'copy-logs') +
        btn('清空', 'clear-logs', null, 'is-danger') + '</div>');
    box.innerHTML = html;
  }

  function kv(k, v) {
    return '<div class="dev-kv-row"><span class="dev-kv-k">' + esc(k) + '</span>' +
      '<span class="dev-kv-v">' + v + '</span></div>';
  }

  /* ------------------------------------------------------------
   * 沙盒
   * ---------------------------------------------------------- */
  function takeSandboxFlag() {
    var v = sandboxPending;
    sandboxPending = false;
    return v;
  }

  /** 沙盒场地的单元格数：7 单元格 → 15×15 网格（约 30×30 米），与游戏里描述难度的口径一致 */
  var SANDBOX_CELLS = 7;

  /** 由 main.js 的 buildLevel 调用：给沙盒准备一份"无墙、无金币、无天花板"的难度副本 */
  function patchDiff(diff) {
    var copy = {};
    for (var k in diff) {
      if (Object.prototype.hasOwnProperty.call(diff, k)) copy[k] = diff[k];
    }
    copy.cells = SANDBOX_CELLS;   // 15×15 网格
    copy.coins = 0;               // 不放金币（需要时用道具面板生成）
    copy.ceiling = false;         // 没有天花板
    copy.farCell = false;
    copy.wallHeight = 3;          // 无墙，仅用于内部参数占位
    copy.name = '沙盒';            // HUD / 胜利结算都读难度名，沿用原难度名会显示成"困难"（BUG-025）
    // 空地一览无余，雾按"能看清整个场地"给（沿用困难档 0.0252 会糊成一片）
    copy.fogDensity = 0.006;
    return copy;
  }

  /** 由 main.js 的 buildLevel 调用：把整张网格打通，形成"只有地面"的空场 */
  function prepareMaze(maze) {
    if (!maze || !maze.grid) return;
    for (var i = 0; i < maze.grid.length; i++) maze.grid[i] = 0;
    maze.start = { x: 1, y: 1 };
    maze.end = { x: maze.size - 2, y: maze.size - 2 };
  }

  /** 由 main.js 在 MazeView / Player 构建完成后调用 */
  function afterBuild() {
    if (!MG.Game || !MG.Game.mazeView) return;
    var view = MG.Game.mazeView;
    if (view.portal) view.portal.visible = false;
    if (view.startOrb) view.startOrb.visible = false;
    if (view.endLight) view.endLight.visible = false;
    if (view.particles) view.particles.visible = false;
    if (view.walls) view.walls.visible = false;
    if (view.mapItem && view.mapItem.group) {
      view.mapItem.group.visible = false;
      // 光隐藏不够：tryCollectMap 只判 collected、不判 visible，玩家路过卷轴真实坐标
      // 会"隔空"捡到地图（沙盒语义被破坏）。标记 collected 后由 spawnMapItem 再复位。
      view.mapItem.collected = true;
    }
    var i;
    for (i = 0; i < view.coins.length; i++) {
      view.coins[i].mesh.visible = false;
      // 同理：金币也只判 collected，一起标记，避免"看不见却能捡"
      view.coins[i].collected = true;
    }
    if (sandboxAutoMap) {
      MG.Game.mapFound = true;
      if (MG.UI && MG.UI.updateMinimapLock) MG.UI.updateMinimapLock(false, '');
    }
    setStatus('ok', '已进入空关卡：' + view.maze.size + '×' + view.maze.size + ' 全开放，无墙无物');
  }

  /** 玩家前方 dist 米处的世界坐标 */
  function pointAhead(dist) {
    var p = MG.Game && MG.Game.player;
    if (!p) return null;
    var fx = -Math.sin(p.yaw || 0);
    var fz = -Math.cos(p.yaw || 0);
    return { x: p.pos.x + fx * dist, z: p.pos.z + fz * dist };
  }

  function worldToCell(worldX, worldZ, maze) {
    // 不要硬编码 2.0：格子尺寸是 maze.js 的常量，这里复制一份会在将来改尺寸时静默错位
    var cell = (MG.Maze && MG.Maze.CELL) || 2.0;
    var half = (maze.size * cell) / 2;
    return {
      x: Math.round((worldX + half - cell / 2) / cell),
      y: Math.round((worldZ + half - cell / 2) / cell)
    };
  }

  /** 生成一枚金币（沙盒道具面板用） */
  function spawnCoin() {
    var view = MG.Game && MG.Game.mazeView;
    var pt = pointAhead(2.5);
    if (!view || !pt || !global.THREE) { setStatus('err', '不在游戏中'); return; }
    var THREE = global.THREE;
    var geo = new THREE.TorusGeometry(0.26, 0.09, 8, 20);
    var mat = new THREE.MeshLambertMaterial({ color: 0xffd24a, emissive: 0x4a3200 });
    var mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(pt.x, 1.0, pt.z);
    mesh.rotation.x = Math.PI / 2;
    view.group.add(mesh);
    var gc = worldToCell(pt.x, pt.z, view.maze);
    view.coins.push({ mesh: mesh, x: gc.x, y: gc.y, world: { x: pt.x, z: pt.z }, collected: false });
    view.totalCoins = view.coins.length;
    setStatus('ok', '已生成 1 枚金币（前方 2.5 米）');
  }

  /** 生成地图卷轴：复用本局已建好的模型，挪到玩家前方 */
  function spawnMapItem() {
    var view = MG.Game && MG.Game.mazeView;
    var pt = pointAhead(3);
    if (!view || !view.mapItem || !pt) { setStatus('err', '本局没有地图卷轴模型'); return; }
    var mi = view.mapItem;
    mi.collected = false;
    mi.group.visible = true;
    mi.group.position.x = pt.x;
    mi.group.position.z = pt.z;
    mi.world = { x: pt.x, z: pt.z };
    var gc = worldToCell(pt.x, pt.z, view.maze);
    mi.x = gc.x;
    mi.y = gc.y;
    if (mi.sprite) mi.sprite.visible = true;
    setStatus('ok', '已生成地图卷轴（前方 3 米）');
  }

  /** 供 ui.js 的 renderItemPanel 追加"生成器"行（仅沙盒内） */
  function getItemPanelRows() {
    if (!sandboxActive || !MG.Game || !MG.Game.mazeView) return '';
    return '<li class="item-row">' +
        '<span class="item-icon">' + icon('map') + '</span>' +
        '<span class="item-name">生成地图卷轴</span>' +
        '<span class="item-count">测试</span>' +
        '<button class="mini-btn item-use-btn" data-use-id="dev:spawnMap">生成</button>' +
      '</li>' +
      '<li class="item-row">' +
        '<span class="item-icon">' + icon('money') + '</span>' +
        '<span class="item-name">生成金币 ×1</span>' +
        '<span class="item-count">测试</span>' +
        '<button class="mini-btn item-use-btn" data-use-id="dev:spawnCoin">生成</button>' +
      '</li>';
  }

  /** 供 main.js 的 useItem 处理 dev: 前缀 */
  function handleItemUse(id) {
    if (id === 'dev:spawnMap') spawnMapItem();
    else if (id === 'dev:spawnCoin') spawnCoin();
    if (MG.UI && MG.UI.renderItemPanel) MG.UI.renderItemPanel();
  }

  function startSandbox() {
    if (!MG.UI || !MG.UI.menuCallbacks || !MG.UI.menuCallbacks.onStart) {
      setStatus('err', '无法开局（menuCallbacks 未就绪）');
      return;
    }
    // 先确认没有在飞的开局：startGame 首句会因 _startPending 提前返回而不消费标记，
    // 那一局 buildLevel 就会把"别人的局"变成沙盒
    if (MG.Game && MG.Game._startPending) { setStatus('err', '正在加载中，请稍候再试'); return; }
    sandboxPending = true;
    sandboxActive = true;
    close(true);   // 静默关闭：直接进加载流程，中间不闪主菜单
    MG.UI.menuCallbacks.onStart('hard', 'dev-sandbox', false);
  }

  /** 沙盒局结束（回主菜单 / 重新开局）时复位 */
  function resetSandbox() {
    sandboxActive = false;
    // pending 也必须清：若"进入空关卡"后、buildLevel 消费标记前发生异常，
    // 这个一次性标记会活到下一局正常游戏，把正常局静默变成沙盒
    sandboxPending = false;
  }

  /* ------------------------------------------------------------
   * 签到快进
   * ---------------------------------------------------------- */
  function rewindCheckin(days) {
    var data = readCheckin();
    if (!data || typeof data !== 'object' || !data.lastDay) {
      setStatus('err', '还没有签到存档，先去签到一次');
      return;
    }
    var last = String(data.lastDay);
    if (!/^[0-9]{8}$/.test(last)) {
      setStatus('err', '存档里的 lastDay 不合法：' + last);
      return;
    }
    var d = new Date(parseInt(last.slice(0, 4), 10), parseInt(last.slice(4, 6), 10) - 1, parseInt(last.slice(6, 8), 10));
    d.setDate(d.getDate() - days);
    data.lastDay = ymd(d);
    if (!safeSet(CHECKIN_KEY, JSON.stringify(data))) {
      setStatus('err', '写入失败（localStorage 不可用）');
      return;
    }
    if (MG.Checkin) {
      if (MG.Checkin._resetCache) MG.Checkin._resetCache();
      if (MG.Checkin.refreshBadge) MG.Checkin.refreshBadge();
    }
    setStatus('ok', '已把上次签到日往前挪 ' + days + ' 天 → ' + data.lastDay + '（回主菜单点签到验证）');
    renderBody();
  }

  function resetCheckin() {
    if (!safeDel(CHECKIN_KEY)) { setStatus('err', '删除失败'); return; }
    if (MG.Checkin) {
      if (MG.Checkin._resetCache) MG.Checkin._resetCache();
      if (MG.Checkin.refreshBadge) MG.Checkin.refreshBadge();
    }
    setStatus('ok', '签到存档已重置（回到"从未签到"）');
    renderBody();
  }

  /* ------------------------------------------------------------
   * 事件（统一委托，减少绑定数量）
   * ---------------------------------------------------------- */
  function onBodyClick(e) {
    var node = e.target;
    while (node && node !== els['dev-body']) {
      if (node.getAttribute && node.getAttribute('data-act')) {
        doAction(node.getAttribute('data-act'), node.getAttribute('data-arg'));
        return;
      }
      node = node.parentNode;
    }
  }

  function doAction(act, arg) {
    /* --- 页签 --- */
    if (act === 'tab') {
      activeTab = arg;
      renderTabs();
      renderBody();
      return;
    }
    /* --- 图标 --- */
    if (act === 'copy-icon') {
      copyText("MG.UI.iconHtml('" + arg + "')", 'iconHtml(\'' + arg + '\')');
      return;
    }
    if (act === 'gen-icons') {
      var pick = $('dev-icon-pick');
      var countSel = $('dev-icon-count');
      var key = (pick && pick.value) ? pick.value : 'trophy';
      var n = parseInt(countSel ? countSel.value : '', 10);
      if (!(n >= 1 && n <= 16)) n = 4;
      var out = '';
      for (var i = 0; i < n; i++) out += '<span class="dev-icon-one">' + icon(key) + '</span>';
      var box = $('dev-icon-out');
      if (box) box.innerHTML = out;
      setStatus('ok', '已生成 ' + n + ' 个 ' + key + ' 实例（渐变不应串色）');
      return;
    }
    if (act === 'test-missing') {
      var miss = (MG.UI && MG.UI.iconHtml) ? MG.UI.iconHtml('no_such_icon_key') : 'NO_UI';
      var res = $('dev-missing-out');
      if (res) res.textContent = '返回长度 = ' + String(miss === undefined ? 'undefined(异常)' : miss.length) +
        '（期望 0，且界面上不出现 undefined 字样）';
      setStatus('ok', '缺失图标测试完成');
      return;
    }
    /* --- 音频 --- */
    if (act === 'play-audio') { playAudioRaw(arg); return; }
    if (act === 'play-audio-5') {
      for (var j = 0; j < 5; j++) playAudioRaw('click');
      setStatus('ok', '已连播 5 次 click');
      return;
    }
    /* --- 视觉 --- */
    if (act === 'set-setting') {
      var parts = String(arg).split(':');
      if (MG.Settings) MG.Settings.set(parts[0], parts[1]);
      renderBody();
      setStatus('ok', '已设置 ' + parts[0] + ' = ' + parts[1]);
      return;
    }
    if (act === 'toggle-setting') {
      if (MG.Settings) {
        var cur = MG.Settings.get()[arg];
        MG.Settings.set(arg, !cur);
      }
      renderBody();
      setStatus('ok', '已切换 ' + arg);
      return;
    }
    if (act === 'set-sim') {
      applySim(arg);
      renderBody();
      var now = currentSim();
      setStatus('ok', now ? ('当前模拟：' + SIM_LABELS[now]) : '已关闭老内核模拟');
      return;
    }
    if (act === 'clear-sim') {
      applySim(null);
      renderBody();
      setStatus('ok', '已关闭老内核模拟，界面恢复原样');
      return;
    }
    /* --- 玩法 --- */
    if (act === 'fill-today-seed') {
      var inp = $('dev-seed');
      if (inp && MG.Maze && MG.Maze.dailySeed) inp.value = MG.Maze.dailySeed().slice(6);
      setStatus('ok', '已填入每日挑战种子');
      return;
    }
    if (act === 'toggle-sandbox-map') {
      sandboxAutoMap = !sandboxAutoMap;
      renderBody();
      setStatus('ok', '沙盒自动解锁小地图：' + (sandboxAutoMap ? '开' : '关'));
      return;
    }
    if (act === 'start-normal') { startNormal(); return; }
    if (act === 'start-sandbox') { startSandbox(); return; }
    if (act === 'coins-add') {
      if (MG.Shop) MG.Shop.addCoins(1000);
      renderBody();
      setStatus('ok', '金币 +1000');
      return;
    }
    if (act === 'coins-zero') {
      if (MG.Shop) { var w = MG.Shop.getWallet(); w.coins = 0; MG.Shop.saveWallet(); }
      renderBody();
      setStatus('ok', '金币已归零');
      return;
    }
    if (act === 'items-add') {
      if (MG.Shop) {
        MG.Shop.addItem('mapUnlock', 10);
        MG.Shop.addItem('bestPath', 10);
        MG.Shop.addItem('fastPath', 10);
        MG.Shop.addItem('streakShield', 10);
      }
      renderBody();
      setStatus('ok', '各计数类道具 +10');
      return;
    }
    if (act === 'items-zero') {
      if (MG.Shop) {
        var ids = ['mapUnlock', 'bestPath', 'fastPath', 'streakShield'];
        for (var q = 0; q < ids.length; q++) {
          var ww = MG.Shop.getWallet();
          ww[ids[q]] = 0;
        }
        MG.Shop.saveWallet();
      }
      renderBody();
      setStatus('ok', '计数类道具已清零');
      return;
    }
    /* --- 数据 --- */
    if (act === 'ck-rewind') { rewindCheckin(parseInt(arg, 10) || 1); return; }
    if (act === 'ck-reset') { resetCheckin(); return; }
    if (act === 'shield-add') {
      if (MG.Shop) MG.Shop.addItem('streakShield', 1);
      renderBody();
      setStatus('ok', '签到护符 +1');
      return;
    }
    if (act === 'open-checkin') {
      close();
      if (MG.Checkin && MG.Checkin.openPanel) MG.Checkin.openPanel();
      return;
    }
    if (act === 'del-key') {
      if (safeDel(arg)) {
        // 签到模块会缓存内存副本：key 删掉后它的 load() 会走"存储不可用"分支拿旧档，
        // 表现为"已删除但角标还是今日已签到"。删到签到 key 就同步清缓存。
        if (arg === CHECKIN_KEY) resetCheckinCache();
        // 钱包同理：shop 缓存着整份钱包，不清缓存的话下一次加币 / 购买会把刚删除的 key 写回来
        if (MG.Shop && arg === MG.Shop.STORAGE_KEY) resetShopCache();
        setStatus('ok', '已删除 ' + arg);
        renderBody();
      } else setStatus('err', '删除失败');
      return;
    }
    if (act === 'wipe-all') {
      var keys = storageKeys(), n = 0;
      for (var m = 0; m < keys.length; m++) {
        if (keys[m].indexOf('maze3d.') === 0 && safeDel(keys[m])) n++;
      }
      resetCheckinCache();   // 全清了，签到内存副本同样要作废
      resetShopCache();      // 钱包缓存同样要作废，否则旧钱包会被后续操作整份写回
      setStatus('ok', '已清空 ' + n + ' 个存档 key（刷新页面后完全生效）');
      renderBody();
      return;
    }
    if (act === 'export-all') {
      var dump = {};
      var allKeys = storageKeys();
      for (var x = 0; x < allKeys.length; x++) dump[allKeys[x]] = safeGet(allKeys[x]);
      var ta = $('dev-io');
      if (ta) ta.value = JSON.stringify(dump, null, 2);
      setStatus('ok', '已导出 ' + allKeys.length + ' 个 key 到文本框');
      return;
    }
    if (act === 'import-all') {
      var src = $('dev-io');
      if (!src || !trim(src.value)) { setStatus('err', '文本框是空的'); return; }
      var parsed;
      try { parsed = JSON.parse(src.value); } catch (e) { setStatus('err', 'JSON 解析失败：' + e.message); return; }
      /* 必须是对象：JSON.parse('"abc"') 得到的是字符串，for-in 会把它枚举成 "0"/"1"/"2"，
         于是往 localStorage 里写进几个无前缀的垃圾 key（还会出现在「存档一览」里被再次导出）。 */
      if (!parsed || typeof parsed !== 'object' || Object.prototype.toString.call(parsed) === '[object Array]') {
        setStatus('err', '需要一个 JSON 对象（形如 { "maze3d.xxx.v1": "..." }）');
        return;
      }
      var count = 0, skipped = 0;
      for (var kk in parsed) {
        if (!Object.prototype.hasOwnProperty.call(parsed, kk)) continue;
        if (kk.indexOf('maze3d.') !== 0 || typeof parsed[kk] !== 'string') { skipped++; continue; }
        if (safeSet(kk, parsed[kk])) count++;
      }
      resetCheckinCache();
      resetShopCache();   // 导入同样可能覆盖钱包 key，缓存要一起作废才真正生效
      setStatus('ok', '已导入 ' + count + ' 个 key' +
        (skipped ? '（跳过 ' + skipped + ' 个非 maze3d.* 或非字符串项）' : '') +
        '（刷新页面后完全生效）');
      renderBody();
      return;
    }
    /* --- 环境 --- */
    if (act === 'copy-env') { copyText(envReport(), '环境报告'); return; }
    if (act === 'goto') { doGoto(arg); return; }
    /* --- 日志 --- */
    if (act === 'copy-logs') {
      var lines = [];
      for (var li = 0; li < logs.length; li++) lines.push(logs[li].t + ' [' + logs[li].level + '] ' + logs[li].text);
      copyText(lines.join('\n'), '日志 ' + logs.length + ' 条');
      return;
    }
    if (act === 'clear-logs') {
      logs = [];
      renderBody();
      setStatus('ok', '日志已清空');
      return;
    }
  }

  function doGoto(target) {
    // close(true) 是静默关闭：它会把 pauseResume 清零（:409），而"设置"页的返回目标要靠
    // settingsFrom 记住来源。不先把暂停态记下来，从暂停局跳到设置后点「返回」会落到主菜单，
    // 把一局 state==='paused' 的对局盖在下面（导航不一致，见 BUG(2026.11.08) 的 BUG-052）。
    var wasPaused = pauseResume;
    close(true);
    /* BUG-064（2026-11-13）：「主菜单」这一跳必须真正结束对局。
       原来无条件 MG.UI.showMainMenu()，于是从对局（暂停态 / 胜利界面）点「主菜单」时，
       主菜单会盖在一局还没释放的关卡上：state 仍是 paused/win、mazeView 还在、
       背景还是那一局的画面（与 BUG-056 同一族，那条只修了"设置"一条路径）。
       存在活关卡时改走引擎的 backToMenu()（MG.UI.pauseCallbacks.onMenu）——
       它会释放关卡、把 state 归 menu、清掉关卡遗留的雾与背景色，
       与暂停菜单里的「返回主菜单」按钮走完全同一条路径。 */
    if (target === 'menu' && MG.UI) {
      var hasLiveLevel = !!(MG.Game && MG.Game.mazeView);
      if (hasLiveLevel && MG.UI.pauseCallbacks && MG.UI.pauseCallbacks.onMenu) {
        MG.UI.pauseCallbacks.onMenu();
      } else {
        MG.UI.showMainMenu();
      }
    }
    else if (target === 'shop' && MG.UI) MG.UI.openShop();
    else if (target === 'ach' && MG.UI) MG.UI.openAchievements();
    else if (target === 'rank' && MG.UI) MG.UI.openRanking();
    else if (target === 'settings' && MG.UI) MG.UI.showSettings(wasPaused ? 'pause-menu' : 'main-menu');
    else if (target === 'checkin' && MG.Checkin) MG.Checkin.openPanel();
  }

  function startNormal() {
    if (!MG.UI || !MG.UI.menuCallbacks || !MG.UI.menuCallbacks.onStart) {
      setStatus('err', '无法开局');
      return;
    }
    var diffSel = $('dev-diff');
    var seedInp = $('dev-seed');
    var diff = diffSel ? diffSel.value : 'simple';
    var seed = seedInp ? trim(seedInp.value) : '';
    sandboxPending = false;
    sandboxActive = false;
    close(true);
    MG.UI.menuCallbacks.onStart(diff, seed, false);
  }

  /* ------------------------------------------------------------
   * 老内核模拟（BUG-032）与免密入口（BUG-034）
   * ---------------------------------------------------------- */

  /** 当前处于哪一档模拟：取"最高"的那一档（三档是叠加关系）；没有则返回 '' */
  function currentSim() {
    var cls = document.body.className || '';
    var found = '';
    for (var i = 0; i < SIM_CLASSES.length; i++) {
      if (cls.indexOf(SIM_CLASSES[i]) >= 0) found = SIM_CLASSES[i];
    }
    return found;
  }

  /** 档位序号，非本档位返回 -1 */
  function simIndex(tier) {
    for (var i = 0; i < SIM_CLASSES.length; i++) {
      if (SIM_CLASSES[i] === tier) return i;
    }
    return -1;
  }

  /**
   * 应用老内核模拟（单选互斥）。
   * 三档是**叠加**关系：选第 2 档会同时挂上第 1 档的 class，
   * 这样 CSS 侧每档只用写"本档新增的降级"，不必把前档规则复制一遍。
   * @param {string|null} tier 目标档位；传 null，或与当前最高档相同 → 全部关闭
   */
  function applySim(tier) {
    var body = document.body;
    if (!body || !body.classList) return;
    var cur = currentSim();
    var target = (tier && tier === cur) ? null : tier;
    var upto = target ? simIndex(target) : -1;
    for (var i = 0; i < SIM_CLASSES.length; i++) {
      var want = (i <= upto);
      var has = body.classList.contains(SIM_CLASSES[i]);
      if (want && !has) body.classList.add(SIM_CLASSES[i]);
      else if (!want && has) body.classList.remove(SIM_CLASSES[i]);
    }
    // 模拟降级只改 CSS 观感，**不碰** MG.Settings、不碰 3D 场景、不写 localStorage
  }

  /**
   * 在每一个界面上挂一个低调的开发者入口（BUG-034）。
   * 解锁状态仍然只存内存：刷新页面 / 重开游戏后入口全部消失，需要重新过两题口令。
   */
  function mountQuickEntries() {
    for (var i = 0; i < QUICK_MOUNT_IDS.length; i++) {
      var host = $(QUICK_MOUNT_IDS[i]);
      if (!host) continue;
      if (host.querySelector && host.querySelector('.dev-quick')) continue;
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'dev-quick' + (QUICK_MOUNT_IDS[i] === 'hud' ? ' dev-quick-hud' : '');
      b.title = '开发者选项';
      // 入口图标用内联 SVG（用户提供的 Noto 图标），与 icons.js 里其他图标同一套机制。
      // 取不到时回落到一个**与旧版不同**的字符：旧版画的是 '◇'，这里故意用 '◈'，
      // 这样从外观就能分辨"浏览器还在跑旧 JS（◇）"还是"新 JS 但图标没取到（◈）"。
      var svgHtml = (MG.UI && MG.UI.iconHtml) ? MG.UI.iconHtml('dev') : '';
      if (svgHtml) {
        b.innerHTML = svgHtml;
      } else {
        b.appendChild(document.createTextNode('◈'));
        if (global.console && console.warn) {
          console.warn('[dev] 入口图标 dev 取不到：MG.Icons.count=' +
            (MG.Icons && MG.Icons.count) + '，可能是 icons.js 未更新（缓存）');
        }
      }
      b.addEventListener('click', function (e) {
        if (e) {
          if (e.stopPropagation) e.stopPropagation();
          if (e.preventDefault) e.preventDefault();
        }
        playAudioRaw('click');
        open();
      });
      host.appendChild(b);
    }
  }

  /* ------------------------------------------------------------
   * 滑块（滑块用 input 事件，不能走 click 委托）
   * ---------------------------------------------------------- */
  function onBodyInput(e) {
    var node = e.target;
    if (!node || !node.id) return;
    if (node.id === 'dev-fov') {
      var v = parseInt(node.value, 10) || 75;
      if (MG.Settings) MG.Settings.set('fov', v);
      var out1 = $('dev-fov-val');
      if (out1) out1.textContent = String(v);
      return;
    }
    if (node.id === 'dev-speed') {
      var sp = parseFloat(node.value) || 1;
      if (MG.Settings) MG.Settings.set('moveSpeed', sp);
      var out2 = $('dev-speed-val');
      if (out2) out2.textContent = String(sp);
      return;
    }
  }

  /* ------------------------------------------------------------
   * 初始化
   * ---------------------------------------------------------- */
  var IDS = [
    'dev-screen', 'dev-tabs', 'dev-body', 'dev-status', 'btn-dev-close', 'btn-dev-sound',
    'btn-dev-info'
  ];

  function cacheEls() {
    for (var i = 0; i < IDS.length; i++) els[IDS[i]] = $(IDS[i]);
  }

  function init() {
    cacheEls();
    if (!els['dev-screen']) {
      console.warn('[dev] 未找到开发者面板 DOM，已跳过初始化');
      return false;
    }
    hookConsole();
    if (els['dev-body']) {
      els['dev-body'].addEventListener('click', onBodyClick);
      els['dev-body'].addEventListener('input', onBodyInput);
    }
    if (els['dev-tabs']) els['dev-tabs'].addEventListener('click', onBodyClick);
    if (els['btn-dev-close']) {
      els['btn-dev-close'].addEventListener('click', function () { close(); });
    }
    if (els['btn-dev-sound']) {
      els['btn-dev-sound'].addEventListener('click', function () {
        if (audioBackup) {
          unmuteAudio();
          setStatus('ok', '面板内声音已恢复；再点一次可重新静音');
        } else {
          muteAudio();
          setStatus('ok', '面板内声音已重新静音（仅音频页试听按钮会发声）');
        }
      });
    }
    if (els['btn-dev-info']) {
      els['btn-dev-info'].addEventListener('click', function () {
        copyText(envReport(), '环境报告');
      });
    }
    return true;
  }

  /* ------------------------------------------------------------
   * 导出
   * ---------------------------------------------------------- */
  MG.Dev = {
    init: init,
    open: open,
    close: close,
    unlockAndOpen: unlockAndOpen,
    isOpen: isOpen,
    isUnlocked: isUnlocked,
    /** main.js：取出并清掉"下一次开局进沙盒"的标记 */
    takeSandboxFlag: takeSandboxFlag,
    /** main.js：沙盒的难度副本 */
    patchDiff: patchDiff,
    /** main.js：把网格打通 */
    prepareMaze: prepareMaze,
    /** main.js：场景构建完成后的沙盒收尾 */
    afterBuild: afterBuild,
    /** main.js：局结束复位 */
    resetSandbox: resetSandbox,
    /** ui.js：道具面板追加"生成器"行 */
    getItemPanelRows: getItemPanelRows,
    /** main.js：处理 dev: 前缀的道具点击 */
    handleItemUse: handleItemUse,
    /** 调试用：当前是否沙盒局 */
    isSandbox: function () { return sandboxActive; },
    /**
     * ui.js：每次 show(id) 后回调。
     * 面板开着时如果别的界面被显示（重开一局、返回主菜单、通关…），
     * 说明 dev-screen 被顶掉了 —— 此时必须走一遍 close()，
     * 否则面板内静音包装过的 MG.Audio.* 永远不会还原（整场没声），且 panelOpen 卡在 true。
     */
    onScreenShown: function (id) {
      /* opening 期间必须忽略：open() 会先调 pauseGame()，而 pauseGame 会 show('pause-menu')，
         那条 show 同样会打到这个回调上 —— 不挡的话，正在打开的面板会把自己 close 掉，
         pauseResume 也被提前清零（关闭时就回不到暂停菜单了）。 */
      if (opening) return;
      if (panelOpen && id && id !== 'dev-screen') close(true);
    },
    /** ui.js：每次切换界面后补挂免密入口（幂等），防止界面 DOM 重建后入口消失（BUG-034） */
    mountQuickEntries: function () {
      if (!unlocked) return;
      mountQuickEntries();
    }
  };

})(window);
