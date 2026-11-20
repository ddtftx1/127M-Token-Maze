/* ============================================================
 * js/ui.js
 * 界面模块
 * - 屏幕切换（主菜单 / 加载 / 暂停 / 设置 / 胜利）
 * - 设置面板双向绑定（与 Settings 模块同步）
 * - HUD 状态刷新（计时 / 步数 / 难度 / 距离）
 * - 小地图绘制（已探索区域 + 玩家 + 终点 + 金币）
 * - 指南针指针、Toast 提示、最佳记录与成就列表
 * - 全屏切换、按钮音效
 * ============================================================ */
(function (global) {
  'use strict';

  var MG = global.MG = global.MG || {};
  var S = null; // 设置模块引用

  /** 全部 DOM 引用集中管理 */
  var el = {};

  /** 小地图画布上下文 */
  var mapCtx = null;
  var mapSize = 200;

  /**
   * 小地图离屏缓存：相对静态内容（背景 / 已探索通路 / 已探索墙 / 金币 / 起点）
   * 画好后整张贴到主画布，每帧只重绘动态元素（玩家 / 终点呼吸光 / 寻路路径 / 边框）。
   *
   * 缓存什么时候失效（不是"只画一次"）：
   *   a) 难度 / 主题 / 色盲 / 金币显示设置 / 剩余金币数 / **已探索格子数**变化（签名比对）；
   *   b) 尺寸变化（resizeMinimap 里作废）、解锁状态变化（updateMinimapLock 里作废）、
   *      重新开局（resetMinimapCache）。
   *
   * ── 2026-11-15 收窄重绘条件（性能，实测见交付说明）──
   * 原条件里还有一条"**玩家跨格**"（pgd.x/y !== mapCacheCellX/Y）。它是多余的：
   * 静态层只画 maze.grid + player.explored + mazeView.coins + maze.start ——
   * **玩家位置与朝向完全画在动态层**（drawMinimap 的后半段三角标记），
   * 所以跨格那次整层重绘没有改变任何一个像素，纯属白干。
   * 代价可不小：121×121 全探索时静态重绘一次约 8ms（低端手机会放大数倍），
   * 而 2 米/格的迷宫里玩家几乎每 0.5 秒就跨一格 —— 复杂难度下这不是小钱。
   * 去掉之后，"新探索到格子"仍会立刻出现在地图上：
   * 探索必然让 explored 的已标记数 +1，而该计数（连同解锁状态）就在下面的签名里，
   * 签名一变即置脏 —— 正确性由"计数单调递增"这一前提保证（player.js 只写 1、不写回 0；
   * 换关卡会新建 Uint8Array 并在 main.js 的 buildLevel 里调 resetMinimapCache）。
   *
   * 注：保留"签名比对 + 显式 invalidate"两条通路，而不是只留其中一条 ——
   * 签名覆盖"内容相关的变化"，invalidate 覆盖"内容无关但缓存必须作废"的时机（尺寸 / 锁 / 换局）。
   */
  var mapCacheCanvas = null;
  var mapCacheCtx = null;
  var mapCacheDpr = 1;
  /**
   * 主画布的像素比（与 mapCacheDpr 是**两个**概念，别再合回一个 —— 2026-11-15 缩放改造）：
   *   · HUD 小地图：两者恒等（缓存与主画布同分辨率，与改造前逐像素一致）；
   *   · 最大化地图：主画布仍按 dpr（上限 1.5），而离屏静态缓存可以在放大时提到更高
   *     （上限 2，见 mapFullCacheDprFor 的取舍），否则 8× 时整张 1× 缓存被硬拉，
   *     砖缝与网格糊成一片。
   * 它只是"当前渲染目标"的一部分状态：由 withMapFullTarget() 成对切换 / 还原。
   */
  var mapViewDpr = 1;
  /**
   * 当前渲染目标的"纯绘制变换"（缩放 + 平移，单位都是**逻辑像素**）。
   * 语义：屏幕坐标 = 地图坐标 × zoom + pan；HUD 小地图恒为 1 / 0 / 0。
   * 为什么做成"纯绘制变换"：它只参与 drawMinimap 的 setTransform，
   * 既不碰 player.explored，也不碰任何信息口径 —— 放大只看得到本来就已经画出来的
   * 已探索区域，**不可能泄露未探索区域**（这一点由"未探索格根本不进静态缓存"保证）。
   */
  var mapViewZoom = 1;
  var mapViewPanX = 0;
  var mapViewPanY = 0;
  /** 缓存有效性标记：置 false 后下一次 drawMinimap 会重绘缓存 */
  var mapCacheDirty = true;
  /** 上次重绘缓存时的探索标记数量（变化说明新区域被探索 —— 静态层唯一的"内容变化"来源） */
  var mapCacheExploredCount = -1;
  /** 上次重绘缓存时的静态内容签名（难度/主题/色盲/金币设置/剩余金币/探索计数/解锁状态） */
  var mapCacheSignature = '';
  /** 窗口尺寸/横竖屏变化后是否欠一次小地图分辨率重算（容器隐藏时先挂起，绘制时补算） */
  var minimapResizePending = false;
  /** resize 防抖定时器 id（0 = 无待执行任务） */
  var minimapResizeTimer = 0;
  /**
   * 最近一次成功调用的 drawMinimap 参数（player / maze / mazeView / settings）。
   * 用途：打开最大化地图时立刻补画一帧，避免"打开后到下个 120ms 节流之间"闪一下空白。
   * 只在**同一局**内使用（调用方做对象身份校验），换关卡后即使残留也画不出来。
   */
  var lastMapArgs = null;

  /** 强制小地图缓存在下一次绘制时重绘（主题 / 色盲 / 金币设置 / 重新开局时调用） */
  function invalidateMinimapCache() {
    mapCacheDirty = true;
  }

  /* ------------------------------------------------------------
   * 图标（内联 SVG，源码见 js/icons.js）
   * 为什么不用 Emoji：Win7 没有彩色 Emoji 字体（显示白框 / tofu），
   * Win10 部分字符只有单色；换成内联 SVG 后与系统字体无关。
   * ---------------------------------------------------------- */
  /** 每个实例的后缀计数：Noto 的 svg 内部有 id 与 url(#id) 引用，
      同一图标在页面上出现多次（例如奖杯同时出现在排行榜按钮和成就页）时必须各自加后缀，
      否则渐变 / 裁剪 / mask 会互相串味（先渲染的覆盖后面的） */
  var iconSeq = 0;

  /** 原样返回 svg 源码字符串（MG.Icons.svg[name]），缺失时返回空串 */
  function icon(name) {
    return (MG.Icons && MG.Icons.svg && MG.Icons.svg[name]) || '';
  }

  /** 取 svg 源码并给本实例的 id / url(#id) 引用统一加后缀（纯字符串替换，不改结构） */
  function iconSvg(name) {
    var raw = icon(name);
    if (!raw) return '';
    iconSeq++;
    var sfx = '__i' + iconSeq;
    return raw
      .replace(/\bid="([^"]+)"/g, function (m, id) { return 'id="' + id + sfx + '"'; })
      .replace(/url\(#([^)"']+)\)/g, function (m, id) { return 'url(#' + id + sfx + ')'; })
      .replace(/(xlink:href="#)([^"]+)"/g, function (m, p, id) { return p + id + sfx + '"'; })
      .replace(/(\shref="#)([^"]+)"/g, function (m, p, id) { return p + id + sfx + '"'; });
  }

  /**
   * 返回可直接拼进 innerHTML 的图标 HTML。
   * 动态内容（排行榜 / 商店 / 成就列表）必须用它，不要用 textContent，
   * 否则会把 svg 标签当文本显示出来。
   */
  function iconHtml(name) {
    var svg = iconSvg(name);
    if (!svg) return '';
    return '<span class="svg-icon">' + svg + '</span>';
  }

  /**
   * 元素级图标 HTML 缓存。
   * HUD 每 100ms 刷一次钱包余额与道具按钮，每次都重新拼一遍 svg 字符串（最大 5KB）
   * 既浪费又会不停重建 DOM 节点；同一元素上图标只会有一个实例，
   * 后缀只要稳定即可，所以缓存到元素上（不挂全局，避免不同元素共用同一份 id）。
   */
  function iconHtmlFor(node, name) {
    if (!node) return iconHtml(name);
    var cache = node.__iconCache;
    if (!cache || cache.name !== name) {
      node.__iconCache = { name: name, html: iconHtml(name) };
      cache = node.__iconCache;
    }
    return cache.html;
  }

  /**
   * 把 root（默认 document）内所有 <span data-icon="key"> 占位填充为真实 svg。
   * 幂等：已填充的节点带 data-icon-done="1"，重复调用不会重复插入。
   * 注意：boot 只能处理静态标记，动态生成的 HTML 请直接用 iconHtml()。
   */
  function fillIcons(root) {
    var scope = root || document;
    if (!scope || !scope.querySelectorAll) return;
    var nodes = scope.querySelectorAll('[data-icon]');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n.getAttribute('data-icon-done') === '1') continue;
      var svg = iconSvg(n.getAttribute('data-icon') || '');
      if (!svg) continue; // 缺图标：留空占位，不写 undefined
      n.innerHTML = svg;
      // 标记里通常已经写了 class="svg-icon"，这里只在缺失时补，避免类名重复堆叠
      if ((' ' + (n.className || '') + ' ').indexOf(' svg-icon ') < 0) {
        n.className = n.className ? n.className + ' svg-icon' : 'svg-icon';
      }
      n.setAttribute('data-icon-done', '1');
    }
  }

  /**
   * 重置小地图缓存状态（每局开始时调用）
   * 清空"探索计数 / 签名"，避免上一局的统计与签名让新一局误判为"缓存有效"。
   * 注：2026-11-15 起不再有"上次玩家格坐标"这两个字段 —— 跨格不再触发静态重绘，
   * 玩家标记在动态层，见文件上方 mapCacheCanvas 的完整说明。
   */
  function resetMinimapCache() {
    mapCacheDirty = true;
    mapCacheExploredCount = -1;
    mapCacheSignature = '';
  }

  /**
   * 按当前 CSS 显示尺寸与 DPR 重设小地图画布分辨率（BUG-028）。
   * init() 只在启动时算一次；窗口缩放 / 手机横竖屏切换后 .minimap-wrap 的 CSS 宽度
   * 会变，画布内部像素尺寸不变就会被 CSS 拉伸发虚，内部逻辑坐标也会跟着错位。
   * 容器隐藏时 clientWidth 为 0，此时不按兜底值改小，而是挂起，等下一次真正可见的
   * 绘制再补算（drawMinimap 开头会消费这个标记）。
   * @returns {boolean} 本次是否完成了重算
   */
  function resizeMinimap() {
    if (!el['minimap'] || !mapCtx) return false;
    var cssW = el['minimap'].clientWidth || 0;
    if (!cssW) {
      minimapResizePending = true;
      return false;
    }
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var size = Math.max(1, Math.round(cssW));
    if (size === mapSize && dpr === mapCacheDpr) {
      minimapResizePending = false;
      return true;
    }
    mapSize = size;
    el['minimap'].width = Math.round(mapSize * dpr);
    el['minimap'].height = Math.round(mapSize * dpr);
    mapCtx.setTransform(dpr, 0, 0, dpr, 0, 0);   // 设置 width/height 会重置变换，必须重设
    mapCacheDpr = dpr;
    if (mapCacheCanvas && mapCacheCtx) {
      mapCacheCanvas.width = Math.round(mapSize * dpr);
      mapCacheCanvas.height = Math.round(mapSize * dpr);
      mapCacheCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resetMinimapCache();   // 尺寸变了：静态缓存签名 / 坐标统计全部作废
    minimapResizePending = false;
    updateMinimapSizeBadge();   // 实际像素变了，设置面板的徽标同步（BUG-062）
    return true;
  }

  /** 计时器状态 */
  var clockEl = null;

  /* ------------------------------------------------------------
   * 初始化
   * ---------------------------------------------------------- */
  function init() {
    S = MG.Settings;

    // 缓存所有需要的元素
    var ids = [
      'game-canvas', 'look-layer', 'app',
      'loading-screen', 'loading-bar-fill', 'loading-tip',
      'main-menu', 'diff-list', 'seed-input', 'btn-seed-random', 'btn-seed-copy', 'btn-daily',
      'best-records', 'achievements-list', 'btn-start', 'btn-settings-menu', 'btn-ranking-menu', 'btn-shop',
      'hud', 'stat-time', 'stat-steps', 'stat-diff', 'stat-dist', 'stat-dist-wrap', 'stat-coins', 'stat-wallet',
      'btn-minimap', 'btn-fullscreen', 'btn-settings-hud', 'btn-pause',
      'compass-arrow', 'compass-dist', 'minimap', 'minimap-lock', 'minimap-lock-hint',
      // 最大化地图（M2/M3）：与 #hud 平级的独立层 + 小地图外框（点它 = 打开最大化）
      'minimap-wrap', 'map-full', 'map-full-inner', 'map-full-canvas', 'btn-map-full-close',
      'map-full-zoom',
      'joystick', 'joystick-knob', 'btn-items', 'btn-cancel-path', 'toast',
      'pause-menu', 'btn-resume', 'btn-restart', 'btn-settings-pause', 'btn-menu',
      'settings-panel', 'set-fov', 'val-fov', 'set-sensitivity', 'val-sensitivity',
      'set-invert-yaw', 'set-invert-pitch', 'set-speed', 'val-speed',
      'set-quality-select', 'set-shadows', 'set-fog',
      // 性能三件套（2026-11-15）：漏在这里 = bindSwitch/setCheck 静默失效（el 缓存是唯一入口）
      'set-perf-mode', 'set-view-cull',
      'set-minimap-toggle', 'set-minimap-state',
      'set-minimap-coins', 'set-minimap-size', 'set-minimap-size-state',
      'set-theme-select', 'set-colorblind', 'set-volume', 'val-volume', 'set-sfx', 'set-ghost-select',
      'btn-settings-reset', 'btn-settings-back',
      'win-screen', 'win-newrecord', 'win-time', 'win-steps',
      'win-diff', 'win-autopath', 'win-coins', 'win-best', 'btn-play-again', 'btn-win-menu',
      'win-ranking', 'btn-replay-win',
      'ranking-screen', 'ranking-tabs', 'ranking-list', 'btn-ranking-clear', 'btn-ranking-back',
      'achievement-screen', 'btn-achievements-menu', 'btn-achievements-back',
      'shop-screen', 'shop-coins', 'shop-list', 'btn-shop-back',
      'item-panel', 'item-list',
      'ghost-modal', 'ghost-modal-info', 'ghost-remember', 'btn-ghost-yes', 'btn-ghost-no',
      'secret-modal', 'secret-input', 'btn-secret-ok', 'btn-secret-cancel', 'shop-title',
      'secret-question', 'secret-note',
      'replay-bar', 'btn-replay-exit', 'btn-replay-pause', 'replay-time', 'btn-replay-view'
    ];
    for (var i = 0; i < ids.length; i++) {
      el[ids[i]] = document.getElementById(ids[i]);
    }

    // 小地图：按设备像素比放大内部画布分辨率，避免高 DPR 屏幕上被拉伸发虚
    // （绘制代码仍用逻辑像素坐标，由 ctx.setTransform 自动映射到物理像素）
    if (el['minimap']) {
      var dpr = Math.min(window.devicePixelRatio || 1, 2); // 上限 2，与 main.js 像素比策略一致
      var cssW = el['minimap'].clientWidth || 168;         // 隐藏容器里 clientWidth 可能为 0，兜底
      mapSize = Math.max(1, Math.round(cssW));             // 逻辑尺寸 = CSS 显示尺寸
      el['minimap'].width = Math.round(mapSize * dpr);     // 内部分辨率 = 逻辑尺寸 × DPR
      el['minimap'].height = Math.round(mapSize * dpr);
      mapCtx = el['minimap'].getContext('2d');
      mapCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // 离屏缓存画布：尺寸与主小地图一致（含 DPR），同样用 setTransform 做逻辑像素映射
      mapCacheDpr = dpr;
      mapCacheCanvas = document.createElement('canvas');
      mapCacheCanvas.width = Math.round(mapSize * dpr);
      mapCacheCanvas.height = Math.round(mapSize * dpr);
      mapCacheCtx = mapCacheCanvas.getContext('2d');
      mapCacheCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      mapCacheDirty = true;
    }

    // 窗口缩放 / 手机横竖屏切换：.minimap-wrap 的 CSS 尺寸会变，画布内部分辨率要跟着
    // 重算，否则小地图被 CSS 拉伸发虚（BUG-028）。防抖避免拖动窗口时反复重设画布。
    var onMinimapViewportChange = function () {
      if (minimapResizeTimer) clearTimeout(minimapResizeTimer);
      minimapResizeTimer = setTimeout(resizeMinimap, 120);
    };
    window.addEventListener('resize', onMinimapViewportChange);
    // 老 WebView 里横竖屏切换未必触发 resize，单独补一个（同一次防抖合并）
    window.addEventListener('orientationchange', onMinimapViewportChange);
    // 上面那一步在菜单态执行时 HUD 还隐藏着，只能拿到兜底宽度；标记一次，
    // 等第一帧真正可见的绘制用真实 CSS 尺寸校准（也覆盖"菜单里转了屏再开局"）
    minimapResizePending = true;

    clockEl = { t: 0 };

    bindSettingsPanel();
    /* 设置变更的统一兜底：小地图被关掉（含"重置设置"把它关掉）时，最大化地图必须跟着收起 ——
       否则屏幕上会留一层不刷新、也说不清来源的深色方块。
       用订阅而不是写进 bindSwitch：HUD 的 M 按钮、开发者面板、重置路径都会改这一项，
       只挂在下拉/开关的 change 事件上必漏（这正是"新增入口忘记接"的老坑，参 BUG-056/064）。 */
    if (S && S.onSettingChange) {
      S.onSettingChange(function (evt) {
        if (!evt) return;
        if (evt.key !== 'minimap' && !evt.reset) return;
        var st = evt.settings || (S.get ? S.get() : null);
        if (!st || !st.minimap) closeMapFull();
      });
    }
    bindMainMenu();
    bindHudButtons();
    // 最大化地图层的点击绑定（幂等；openMapFull 里也会兜一次，防止 DOM 后补）
    bindMapFull();
    bindPauseMenu();
    bindWinScreen();
    bindRankingScreen();
    bindAchievementScreen();
    bindShop();
    bindItemPanel();
    bindGhostModal();
    bindSecretDialog();
    bindReplayBar();
    syncSettingsUI();
    applyThemeToBody();
    // 小地图尺寸档位（BUG-062）：auto 时清掉 body 属性、走 CSS 的自适应公式
    applyMinimapSizeToBody();
    refreshRecords();
    refreshAchievements();
  }

  /* ------------------------------------------------------------
   * 屏幕切换
   * ---------------------------------------------------------- */
  function show(id) {
    var node = document.getElementById(id);
    if (node) node.classList.remove('hidden');
    /* BUG-034：解锁开发者选项后，各界面要常驻一个免密入口。
       这里每次切界面补挂一次（幂等、未解锁时直接返回），
       这样即使某个界面的 DOM 被重建过，入口也不会丢。 */
    if (MG.Dev && MG.Dev.isUnlocked && MG.Dev.isUnlocked() && MG.Dev.mountQuickEntries) {
      MG.Dev.mountQuickEntries();
    }
    /* 面板开着时若有别的界面被显示，说明 dev-screen 被顶掉了：
       让开发者面板自己收尾（还原音频、清定时器），否则会整场静音。 */
    if (MG.Dev && MG.Dev.onScreenShown) MG.Dev.onScreenShown(id);
  }
  function hide(id) {
    var node = document.getElementById(id);
    if (node) node.classList.add('hidden');
  }
  function hideAllScreens() {
    var screens = ['main-menu', 'loading-screen', 'pause-menu', 'settings-panel', 'win-screen', 'ranking-screen', 'achievement-screen', 'shop-screen', 'checkin-screen', 'dev-screen', 'item-panel', 'ghost-modal', 'secret-modal', 'replay-bar'];
    for (var i = 0; i < screens.length; i++) hide(screens[i]);
  }

  /** 显示主菜单 */
  function showMainMenu() {
    hideAllScreens();
    hide('hud');
    show('main-menu');
    refreshRecords();
    refreshAchievements();
  }

  /** 显示游戏 HUD */
  function showGame() {
    hideAllScreens();
    show('hud');
  }

  /** 显示暂停菜单 */
  function showPause() { show('pause-menu'); }
  function hidePause() { hide('pause-menu'); }

  /* ------------------------------------------------------------
   * 覆盖层界面的「返回」落点（BUG-064，2026-11-13）
   * ------------------------------------------------------------
   * 商店 / 排行榜 / 成就 / 签到 这四个界面既可以从主菜单进，也可以在对局**暂停中**
   * 经开发者面板的「环境 → 快速跳转」进。返回时必须回到"进来时的那一层"：
   * 从暂停局进来却直接 showMainMenu()，主菜单就会盖在一局 state === 'paused' 的
   * 僵尸对局上 —— 背景还是那一局的画面（关卡资源也没释放），HUD 与暂停菜单都不显示。
   * 这与 BUG-056（快速跳转 → 设置）是同一族缺陷，当初只修了"设置"那一条。
   *
   * 口径（用户 2026-11-13 拍板）：对局中点到的「返回」永远回暂停菜单；
   * 只有明确的「返回主菜单」按钮（暂停菜单的按钮 / 开发者面板的「主菜单」跳转）才回主菜单。
   *
   * 判定放在"点返回的那一刻"用 Game.state 现算，而不是像 settingsFrom 那样记录来源：
   * 只要没有东西能在面板开着时改掉 Game.state，现算就既够用、又不会引入"来源记错"的第二个缺陷。
   * 这也是为什么 ESC / P 必须走同一条返回路径（见 main.js 的 onPause 链里 isOverlayOpen 分支）——
   * 那条链原先会让覆盖层里的 ESC 落到 resumeGame()，把对局恢复成 playing 而面板还开着，
   * 于是"面板开着 + 状态被改掉"真的发生了（BUG-064 复查时发现，一并修掉）。
   * ---------------------------------------------------------- */

  /** 当前是否停在一局已暂停的对局里（覆盖层返回的判据） */
  function isPausedGame() {
    return !!(MG.game && MG.game.state === 'paused');
  }

  /**
   * 当前是否停在一局"已通关、还没离开"的状态（BUG-065 的判据）。
   * 此时胜利界面还在、关卡也没释放，`state === 'win'`。
   */
  function isWonGame() {
    return !!(MG.game && MG.game.state === 'win');
  }

  /**
   * 覆盖层面板（商店 / 排行榜 / 成就 / 签到）与设置面板的统一返回落点：
   * 暂停局 → 暂停菜单；已通关 → 胜利界面；否则 → 主菜单。
   *
   * BUG-065（2026-11-14，用户口径 **A：回胜利界面**）：`state === 'win'` 时也进过这个函数
   * （胜利界面上有开发者免密入口）。这一局**还没结束** —— 关卡在、结算已出，
   * 直接甩回主菜单会让玩家看不到「再玩一次 / 看回放」，还会把 state 留在 'win' 的僵尸态
   * （背景仍是那一局的画面）。所以按"回上一层"的直觉还原到胜利界面。
   */
  function backFromOverlay() {
    if (isPausedGame()) {
      // 回暂停菜单：先清掉所有界面，再把 HUD 与暂停菜单摆回来。
      // HUD 必须显式 show —— 现在这四条路径上都只走 hideAllScreens（名单里没有 hud），
      // 但只要有任一路径曾经过 showMainMenu（那里会 hide('hud')），不补这一句就会变成
      // "回到了暂停菜单，HUD 却永久消失"（与 closeSettings 的 hud 分支同一个防御理由）。
      hideAllScreens();
      show('hud');
      show('pause-menu');
      return;
    }
    if (isWonGame()) {
      // 回胜利界面：内容还是通关时 showWin() 填好的那一份，这里只把界面摆回来（不重算结算，
      // 否则会重复写记录 / 排行榜）。HUD 保持隐藏 —— 与 showWin() 的行为一致。
      hideAllScreens();
      show('win-screen');
      return;
    }
    // 从主菜单进来的：行为与修复前完全一致（含成绩 / 成就列表刷新）
    showMainMenu();
  }

  /** 显示加载界面 */
  function showLoading(text, progress) {
    hideAllScreens();
    show('loading-screen');
    if (el['loading-tip'] && text) el['loading-tip'].textContent = text;
    if (el['loading-bar-fill'] && typeof progress === 'number') {
      el['loading-bar-fill'].style.width = Math.round(progress * 100) + '%';
    }
  }
  function setLoadingProgress(progress, text) {
    if (el['loading-bar-fill']) el['loading-bar-fill'].style.width = Math.round(progress * 100) + '%';
    if (el['loading-tip'] && text) el['loading-tip'].textContent = text;
  }

  /** 显示设置（记住来源，用于返回） */
  var settingsFrom = 'main-menu';
  var settingsCallbacks = {};
  function showSettings(from) {
    settingsFrom = from || 'main-menu';
    syncSettingsUI();
    hideAllScreens();
    show('settings-panel');
    hide('hud');
  }

  function closeSettings() {
    hide('settings-panel');
    if (settingsFrom === 'pause-menu') {
      // 从暂停菜单进入设置 → 返回时先恢复 HUD，再由暂停菜单覆盖其上
      // （showSettings 会隐藏 HUD，若不在此恢复，继续游戏后 HUD 将永久消失）
      show('hud');
      show('pause-menu');
    } else if (settingsFrom === 'hud') {
      // 从游戏内 HUD 进入设置 → 返回游戏（需要通知主程序恢复运行）
      show('hud');
      if (settingsCallbacks.onCloseFromHud) settingsCallbacks.onCloseFromHud();
    } else {
      /* 其余来源（主菜单 / 开发者面板「快速跳转 → 设置」）一律交给 backFromOverlay()
         按"当前停在哪一层"现算：暂停局 → 暂停菜单，已通关 → 胜利界面，否则 → 主菜单。
         BUG-065：原来这里写死 show('main-menu')，于是从"已通关"的胜利界面经开发者面板
         进设置、再返回，会把主菜单盖在一局 state === 'win' 的僵尸对局上。
         走同一个函数而不是再记一个来源，是为了不再重复"新增入口忘记传来源"的老问题
         （BUG-056 → BUG-064 → 本条，三次都是同一个坑）。 */
      backFromOverlay();
    }
  }

  /** 设置面板当前是否可见（供 ESC / P 键判断是否需要优先关闭它，BUG-016） */
  function isSettingsOpen() {
    var node = el['settings-panel'];
    return !!(node && !node.classList.contains('hidden'));
  }

  /**
   * 商店 / 排行榜 / 成就 覆盖层是否正开着（供 ESC / P 键判断优先级，BUG-064）。
   * 签到面板不列在这里：main.js 的 ESC 链里本来就有它自己的分支（要先清倒计时定时器）。
   */
  function isOverlayOpen() {
    // 彩蛋验证弹窗浮在这些界面之上，并且自己绑了 ESC 关闭：那一下 ESC 交给它，
    // 不要顺手把底下的界面也一起关掉（逐层关闭，与签到 / 道具 / 设置的手感一致）
    if (el['secret-modal'] && !el['secret-modal'].classList.contains('hidden')) return false;
    var ids = ['shop-screen', 'ranking-screen', 'achievement-screen'];
    for (var i = 0; i < ids.length; i++) {
      var node = document.getElementById(ids[i]);
      if (node && !node.classList.contains('hidden')) return true;
    }
    return false;
  }

  /** 显示胜利界面 */
  function showWin(data) {
    hideAllScreens();
    hide('hud');
    show('win-screen');
    if (el['win-time']) el['win-time'].textContent = formatTime(data.time);
    if (el['win-steps']) el['win-steps'].textContent = data.steps + ' 步';
    if (el['win-diff']) el['win-diff'].textContent = data.diffName;
    if (el['win-autopath']) el['win-autopath'].textContent = data.usedAutoPath ? '是' : '否';
    if (el['win-coins']) el['win-coins'].innerHTML = '+' + (data.coinsEarned || 0) + ' ' + iconHtml('money');
    if (el['win-best']) {
      el['win-best'].textContent = data.best
        ? formatTime(data.best.time) + ' / ' + data.best.steps + ' 步'
        : '—';
    }
    if (el['win-newrecord']) {
      if (data.isBest) el['win-newrecord'].classList.remove('hidden');
      else el['win-newrecord'].classList.add('hidden');
    }
    // 排行榜名次提示
    if (el['win-ranking']) {
      var maxEntries = MG.Ranking ? MG.Ranking.MAX_ENTRIES : 10;
      if (data.rank && data.rank >= 1 && data.rank <= maxEntries) {
        el['win-ranking'].innerHTML = iconHtml('medal') + ' 进入排行榜第 ' + data.rank + ' 名';
        el['win-ranking'].classList.remove('hidden');
      } else {
        el['win-ranking'].classList.add('hidden');
      }
    }
    // 回放按钮（仅当本局保存了回放数据）
    if (el['btn-replay-win']) {
      if (data.hasReplay) el['btn-replay-win'].classList.remove('hidden');
      else el['btn-replay-win'].classList.add('hidden');
    }
  }

  /* ------------------------------------------------------------
   * 主菜单绑定
   * ---------------------------------------------------------- */
  var selectedDiff = 'simple';
  var menuCallbacks = {};

  function bindMainMenu() {
    // 难度卡片选择
    if (el['diff-list']) {
      el['diff-list'].addEventListener('click', function (e) {
        var card = closestWithClass(e.target, 'diff-card');
        if (!card) return;
        var all = el['diff-list'].querySelectorAll('.diff-card');
        for (var i = 0; i < all.length; i++) all[i].classList.remove('selected');
        card.classList.add('selected');
        selectedDiff = card.dataset.diff;
        playClick();
      });
    }

    // 随机种子
    if (el['btn-seed-random']) {
      el['btn-seed-random'].addEventListener('click', function () {
        if (el['seed-input']) el['seed-input'].value = MG.Maze.randomSeed();
        playClick();
      });
    }
    // 复制种子
    if (el['btn-seed-copy']) {
      el['btn-seed-copy'].addEventListener('click', function () {
        var v = (el['seed-input'] && el['seed-input'].value) || '（空）';
        copyText((el['seed-input'] && el['seed-input'].value) || '');
        toast('已复制种子：' + v);
        playClick();
      });
    }
    // 每日挑战
    if (el['btn-daily']) {
      el['btn-daily'].addEventListener('click', function () {
        var seed = MG.Maze.dailySeed();
        if (el['seed-input']) el['seed-input'].value = seed;
        toast('每日挑战种子：' + seed);
        playClick();
        // 直接开始
        if (menuCallbacks.onStart) menuCallbacks.onStart(selectedDiff, seed, true);
      });
    }

    // 开始游戏
    if (el['btn-start']) {
      el['btn-start'].addEventListener('click', function () {
        playClick();
        var seed = ((el['seed-input'] && el['seed-input'].value) || '').trim();
        if (menuCallbacks.onStart) menuCallbacks.onStart(selectedDiff, seed, false);
      });
    }

    // 设置
    if (el['btn-settings-menu']) {
      el['btn-settings-menu'].addEventListener('click', function () {
        playClick();
        showSettings('main-menu');
      });
    }

    // 排行榜
    if (el['btn-ranking-menu']) {
      el['btn-ranking-menu'].addEventListener('click', function () {
        playClick();
        openRanking();
      });
    }
    // 成就（独立页面，替代原来的主菜单折叠面板）
    if (el['btn-achievements-menu']) {
      el['btn-achievements-menu'].addEventListener('click', function () {
        playClick();
        openAchievements();
      });
    }
    // 注：商店按钮的绑定在 bindShop()（含"长按彩蛋"逻辑），此处不再重复绑定
  }

  /* ------------------------------------------------------------
   * HUD 按钮绑定
   * ---------------------------------------------------------- */
  var hudCallbacks = {};

  function bindHudButtons() {
    if (el['btn-minimap']) {
      el['btn-minimap'].addEventListener('click', function () {
        playClick();
        var g = MG.game;
        if (g && (g.state === 'playing' || g.state === 'paused') && !g.mapFound) {
          toast('尚未找到迷宫地图');
          if (MG.Audio && S.get().sfx) MG.Audio.error();
          return;
        }
        var v = !S.get().minimap;
        S.set('minimap', v);
      });
    }
    if (el['btn-fullscreen']) {
      el['btn-fullscreen'].addEventListener('click', function () {
        playClick();
        toggleFullscreen();
      });
    }
    /* 点小地图本体 → 最大化（设计 M2 的入口）。
       绑在 .minimap-wrap 上而不是 #minimap：未解锁时占位层 #minimap-lock 盖在画布上
       （它自己 pointer-events:none），绑 wrap 才能把整块区域都接住，
       再由 canOpenMapFull() 判定"未解锁不响应"（不泄露终点 / 距离，BUG-022）。
       CSS 侧必须给 .minimap-wrap 开 pointer-events:auto，否则 #hud 的 none 会继承下来、
       连 click 都收不到 —— 两处是一对，改一处记得看另一处。 */
    if (el['minimap-wrap']) {
      el['minimap-wrap'].addEventListener('click', function () {
        if (!canOpenMapFull()) return;   // 未解锁 / 小地图已关掉 / 不在局内 → 入口不响应
        playClick();
        openMapFull();
      });
    }
    if (el['btn-settings-hud']) {
      el['btn-settings-hud'].addEventListener('click', function () {
        playClick();
        // 暂停并直接打开设置界面（由主程序 pauseGame(true) 一步处理，关闭时恢复游戏）
        if (hudCallbacks.onPause) hudCallbacks.onPause(true);
      });
    }
    if (el['btn-pause']) {
      el['btn-pause'].addEventListener('click', function () {
        playClick();
        if (hudCallbacks.onPause) hudCallbacks.onPause(false);
      });
    }
    if (el['btn-items']) {
      el['btn-items'].addEventListener('click', function () {
        playClick();
        if (hudCallbacks.onOpenItems) hudCallbacks.onOpenItems();
      });
    }
    if (el['btn-cancel-path']) {
      el['btn-cancel-path'].addEventListener('click', function () {
        playClick();
        if (hudCallbacks.onCancelPath) hudCallbacks.onCancelPath();
      });
    }
  }

  /* ------------------------------------------------------------
   * 暂停菜单绑定
   * ---------------------------------------------------------- */
  var pauseCallbacks = {};

  function bindPauseMenu() {
    if (el['btn-resume']) {
      el['btn-resume'].addEventListener('click', function () {
        playClick();
        if (pauseCallbacks.onResume) pauseCallbacks.onResume();
      });
    }
    if (el['btn-restart']) {
      el['btn-restart'].addEventListener('click', function () {
        playClick();
        if (pauseCallbacks.onRestart) pauseCallbacks.onRestart();
      });
    }
    if (el['btn-settings-pause']) {
      el['btn-settings-pause'].addEventListener('click', function () {
        playClick();
        showSettings('pause-menu');
      });
    }
    if (el['btn-menu']) {
      el['btn-menu'].addEventListener('click', function () {
        playClick();
        if (pauseCallbacks.onMenu) pauseCallbacks.onMenu();
      });
    }
  }

  /* ------------------------------------------------------------
   * 胜利界面绑定
   * ---------------------------------------------------------- */
  var winCallbacks = {};

  function bindWinScreen() {
    if (el['btn-play-again']) {
      el['btn-play-again'].addEventListener('click', function () {
        playClick();
        if (winCallbacks.onPlayAgain) winCallbacks.onPlayAgain();
      });
    }
    if (el['btn-win-menu']) {
      el['btn-win-menu'].addEventListener('click', function () {
        playClick();
        if (winCallbacks.onMenu) winCallbacks.onMenu();
      });
    }
    if (el['btn-replay-win']) {
      el['btn-replay-win'].addEventListener('click', function () {
        playClick();
        if (winCallbacks.onReplay) winCallbacks.onReplay();
      });
    }
  }

  /* ------------------------------------------------------------
   * 排行榜
   * ---------------------------------------------------------- */
  var rankingDiff = 'simple';
  var clearArmed = false;
  var clearArmTimer = null;

  function bindRankingScreen() {
    if (el['ranking-tabs']) {
      el['ranking-tabs'].addEventListener('click', function (e) {
        var tab = closestWithClass(e.target, 'ranking-tab');
        if (!tab) return;
        playClick();
        rankingDiff = tab.dataset.diff;
        refreshRanking();
      });
    }
    if (el['btn-ranking-clear']) {
      el['btn-ranking-clear'].addEventListener('click', function () {
        playClick();
        if (!clearArmed) {
          // 第一次点击：进入待确认状态（3 秒内再点一次生效）
          clearArmed = true;
          el['btn-ranking-clear'].textContent = '再点一次确认清空';
          el['btn-ranking-clear'].classList.add('armed');
          if (clearArmTimer) clearTimeout(clearArmTimer);
          clearArmTimer = setTimeout(function () {
            clearArmed = false;
            el['btn-ranking-clear'].textContent = '清空本难度';
            el['btn-ranking-clear'].classList.remove('armed');
          }, 3000);
          return;
        }
        // 二次确认：执行清空
        clearArmed = false;
        if (clearArmTimer) clearTimeout(clearArmTimer);
        if (MG.Ranking) MG.Ranking.clear(rankingDiff);
        el['btn-ranking-clear'].textContent = '清空本难度';
        el['btn-ranking-clear'].classList.remove('armed');
        toast('已清空「' + (DIFF_NAMES[rankingDiff] || rankingDiff) + '」排行榜');
        refreshRanking();
      });
    }
    if (el['btn-ranking-back']) {
      el['btn-ranking-back'].addEventListener('click', function () {
        playClick();
        // 落点统一判定：暂停局 → 暂停菜单，否则 → 主菜单（BUG-064）
        backFromOverlay();
      });
    }
  }

  function openRanking() {
    hideAllScreens();
    show('ranking-screen');
    refreshRanking();
  }

  /* ------------------------------------------------------------
   * 成就独立页面（原主菜单折叠面板已移除，避免横屏撑高右列）
   * ---------------------------------------------------------- */
  /** 打开成就页 */
  function openAchievements() {
    hideAllScreens();
    show('achievement-screen');
    refreshAchievements();
  }

  /** 绑定成就页返回按钮 */
  function bindAchievementScreen() {
    if (el['btn-achievements-back']) {
      el['btn-achievements-back'].addEventListener('click', function () {
        playClick();
        // 落点统一判定：暂停局 → 暂停菜单，否则 → 主菜单（BUG-064）
        backFromOverlay();
      });
    }
  }

  function refreshRanking() {
    // 切换难度 / 重新打开时重置"清空"的二次确认状态，避免误删其它难度的数据
    if (clearArmTimer) { clearTimeout(clearArmTimer); clearArmTimer = null; }
    if (clearArmed) {
      clearArmed = false;
      if (el['btn-ranking-clear']) {
        el['btn-ranking-clear'].textContent = '清空本难度';
        el['btn-ranking-clear'].classList.remove('armed');
      }
    }
    // Tab 高亮
    if (el['ranking-tabs']) {
      var tabs = el['ranking-tabs'].querySelectorAll('.ranking-tab');
      for (var i = 0; i < tabs.length; i++) {
        if (tabs[i].dataset.diff === rankingDiff) tabs[i].classList.add('selected');
        else tabs[i].classList.remove('selected');
      }
    }
    // 列表
    if (!el['ranking-list']) return;
    var list = (MG.Ranking && MG.Ranking.list(rankingDiff)) || [];
    if (list.length === 0) {
      el['ranking-list'].innerHTML = '<li class="ranking-empty">暂无记录，快去挑战吧！</li>';
      return;
    }
    var html = '';
    var medals = ['gold', 'silver', 'bronze'];
    for (var k = 0; k < list.length; k++) {
      var r = list[k];
      var rankCls = k < 3 ? ' ' + medals[k] : '';
      // 图标是内联 SVG，整串过 escapeHtml 会把标签转义成文本，所以只转义用户可写字段
      var autoTxt = r.auto ? iconHtml('bolt') + ' 自动寻路' : '徒步';
      var sub = autoTxt + ' · 种子 ' + escapeHtml(r.seed || '—') + ' · ' + escapeHtml(r.date || '');
      html += '<li><span class="rk-rank' + rankCls + '">' + (k + 1) + '</span>' +
        '<span class="rk-info"><b>' + formatTime(r.time) + ' · ' + r.steps + ' 步</b>' +
        '<em>' + sub + '</em></span></li>';
    }
    el['ranking-list'].innerHTML = html;
  }

  /* ------------------------------------------------------------
   * 回放控制条
   * ---------------------------------------------------------- */
  var replayCallbacks = {};

  function bindReplayBar() {
    if (el['btn-replay-exit']) {
      el['btn-replay-exit'].addEventListener('click', function () {
        playClick();
        if (replayCallbacks.onExit) replayCallbacks.onExit();
      });
    }
    if (el['btn-replay-pause']) {
      el['btn-replay-pause'].addEventListener('click', function () {
        playClick();
        if (replayCallbacks.onTogglePause) replayCallbacks.onTogglePause();
      });
    }
    if (el['btn-replay-view']) {
      el['btn-replay-view'].addEventListener('click', function () {
        playClick();
        if (replayCallbacks.onToggleView) replayCallbacks.onToggleView();
      });
    }
  }

  function showReplayBar(total) {
    hideAllScreens();
    show('replay-bar');
    updateReplayBar(0, total, true);
  }
  function hideReplayBar() { hide('replay-bar'); }

  function updateReplayBar(t, total, playing) {
    if (el['replay-time']) {
      el['replay-time'].textContent = formatTime(t) + ' / ' + formatTime(total);
    }
    if (el['btn-replay-pause']) {
      var atEnd = !playing && t >= total - 0.01;
      el['btn-replay-pause'].innerHTML = playing ? iconHtml('pause') + ' 暂停' : (atEnd ? '↻ 重播' : '▶ 继续');
    }
  }

  function setReplayViewLabel(isFollow) {
    if (el['btn-replay-view']) el['btn-replay-view'].innerHTML = isFollow ? iconHtml('camera') + ' 跟随' : iconHtml('map') + ' 全景';
  }

  /* ------------------------------------------------------------
   * 商店
   * ---------------------------------------------------------- */
  function bindShop() {
    // 商店按钮：短按打开商店；长按触发隐藏彩蛋（长按检测见下方"隐藏彩蛋"节）
    if (el['btn-shop']) {
      el['btn-shop'].addEventListener('click', function () {
        // 长按弹彩蛋后的"释放合成点击"：忽略，避免同时打开商店
        if (isSecretClickGuarded()) return;
        playClick();
        openShop();
      });
    }
    if (el['btn-shop-back']) {
      el['btn-shop-back'].addEventListener('click', function () {
        playClick();
        // 落点统一判定：暂停局 → 暂停菜单，否则 → 主菜单（BUG-064）
        backFromOverlay();
      });
    }
    if (el['shop-list']) {
      el['shop-list'].addEventListener('click', function (e) {
        var btn = e.target;
        while (btn && btn !== el['shop-list'] && !(btn.dataset && btn.dataset.buyId)) {
          btn = btn.parentNode;
        }
        if (!btn || !(btn.dataset && btn.dataset.buyId)) return;
        if (btn.disabled) return;
        doBuy(btn.dataset.buyId);
      });
    }
  }

  /** 打开商店（仅主菜单入口） */
  function openShop() {
    if (!MG.Shop) return;
    hideAllScreens();
    show('shop-screen');
    refreshShop();
  }

  /** 刷新商店：余额 + 商品卡片状态（购买后调用，保证与钱包同步） */
  function refreshShop() {
    if (!el['shop-list'] || !MG.Shop) return;
    var w = MG.Shop.getWallet();
    if (el['shop-coins']) {
      // 与 HUD 钱包一致：超 1e8 用紧凑格式兜底，防止商店头部金额溢出
      el['shop-coins'].textContent = w.coins >= 1e8 ? formatCompactNum(w.coins) : formatNum(w.coins);
    }

    var items = MG.Shop.ITEMS;
    var html = '';
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var owned = MG.Shop.countOf(it.id);
      var maxed = owned >= it.limit;
      var canAfford = w.coins >= it.price;
      var btnCls = 'mini-btn shop-buy-btn' + (!maxed && !canAfford ? ' poor' : '');
      // 数量达到/超过上限时只显示实际数量（彩蛋奖励可累积超过上限，避免显示"179 / 99"的溢出感）
      // 超大数量用紧凑格式（10w+ 时显示为 "已购 12.3w / 99"），防止卡片撑破
      var ownedText = maxed
        ? ('已购 ' + formatCompactNum(owned))
        : ('已购 ' + formatCompactNum(owned) + ' / ' + it.limit);
      html += '<div class="shop-card">' +
        '<div class="shop-icon">' + iconHtml(it.icon) + '</div>' +
        '<div class="shop-info">' +
          '<div class="shop-name">' + it.name + '</div>' +
          '<div class="shop-desc">' + it.desc + '</div>' +
          '<div class="shop-meta">' + ownedText + '</div>' +
        '</div>' +
        '<div class="shop-buy">' +
          '<div class="shop-price">' + it.price + ' ' + iconHtml('money') + '</div>' +
          '<button class="' + btnCls + '" data-buy-id="' + it.id + '"' +
            (maxed ? ' disabled' : '') + '>' +
            (maxed ? '已购满' : '购买') +
          '</button>' +
        '</div>' +
      '</div>';
    }
    el['shop-list'].innerHTML = html;
  }

  /** 执行购买（成功播放 purchase 音效 / 失败播放 error 音效） */
  function doBuy(id) {
    if (!MG.Shop) return;
    var res = MG.Shop.buy(id);
    if (res.ok) {
      if (MG.Audio && S.get().sfx) MG.Audio.purchase();
      toast('购买成功：' + res.item.name);
    } else {
      if (MG.Audio && S.get().sfx) MG.Audio.error();
      if (res.reason === 'poor') toast('金币不足，去多跑几局吧');
      else if (res.reason === 'max') toast('已达购买上限');
      // 写盘失败：金币与数量都已由 shop 回滚，这里必须说清"没买成"，不能报成功
      else if (res.reason === 'save') toast('购买失败：本地存档无法写入（隐私模式或空间已满）', 3200);
    }
    refreshShop();
  }

  /* ------------------------------------------------------------
   * 开发者入口：长按"商店"按钮 / 商店界面标题 → 连答两题 → 开发者选项
   * - 短按商店：正常打开商店
   * - 长按约 0.48 秒：震动反馈并立即弹窗（无需等松开）
   * - 这是"验证门"，本身不发任何奖励；答对两题后交给 MG.Dev 打开面板
   * - 两题都答错即关闭，不提示错在哪一题
   * ---------------------------------------------------------- */
  /** 验证题（逐题校验；最多两道，题目文案见 index.html 的默认值，这里以表为准） */
  var DEV_GATE = [
    { q: '这个项目的 AI 制作者是谁？', a: 'deepseek', ignoreCase: true },
    { q: '作者的名字（游戏 ID）是什么？', a: 'AdroitHare8579', ignoreCase: false }
  ];
  var gateStep = 0;
  var SECRET_HOLD_MS = 480;     // 长按阈值：达到即弹窗（低于浏览器原生长按手势，避免被抢占）
  var secretAwaitRelease = false; // 弹窗打开后按压尚未结束（等"松开"来吞掉合成点击）
  var secretAwaitTimer = null;  // 松开等待的兜底计时器
  var secretClickGuardUntil = 0; // 防护窗口：忽略"松开"瞬间合成的点击（时间戳）

  /** 是否处于"松开合成点击"防护窗口内 */
  function isSecretClickGuarded() {
    return Date.now() < secretClickGuardUntil;
  }

  /** 渲染当前题号与题目 */
  function renderGateStep() {
    var cur = DEV_GATE[gateStep] || DEV_GATE[0];
    if (el['secret-question']) el['secret-question'].textContent = cur.q;
    if (el['secret-note']) {
      el['secret-note'].textContent = '第 ' + (gateStep + 1) + ' / ' + DEV_GATE.length + ' 题';
    }
    if (el['secret-input']) {
      el['secret-input'].value = '';
      try { el['secret-input'].focus(); } catch (e) { /* 忽略 */ }
    }
  }

  /** 打开验证弹窗（从第 1 题开始） */
  function openSecretDialog() {
    if (!el['secret-modal']) return;
    gateStep = 0;
    renderGateStep();
    show('secret-modal');
    // 记录"按压尚未结束"：稍后松开时吞掉一次合成点击，防止误触弹窗按钮
    //（兜底：6 秒内没有任何松开事件则自动解除）
    secretAwaitRelease = true;
    if (secretAwaitTimer) clearTimeout(secretAwaitTimer);
    secretAwaitTimer = setTimeout(function () {
      secretAwaitRelease = false;
      secretAwaitTimer = null;
    }, 6000);
    // 自动聚焦，方便直接输入（移动端通常会直接弹起键盘）
    setTimeout(function () {
      try { if (el['secret-input']) el['secret-input'].focus(); } catch (e) { /* 忽略 */ }
    }, 60);
  }

  /** 关闭验证弹窗（不做任何事） */
  function closeSecretDialog() {
    secretAwaitRelease = false;
    gateStep = 0;
    if (secretAwaitTimer) { clearTimeout(secretAwaitTimer); secretAwaitTimer = null; }
    if (el['secret-input']) {
      try { el['secret-input'].blur(); } catch (e) { /* 忽略 */ }
    }
    hide('secret-modal');
  }

  /**
   * 提交答案：逐题推进；两题全对才打开开发者选项。
   * 任一题答错 → 立即关闭（不提示错在哪一题，也不发任何奖励）
   */
  function submitSecretAnswer() {
    if (!el['secret-input']) return;
    var raw = el['secret-input'].value || '';
    var answer = raw.replace(/^\s+|\s+$/g, '');
    if (!answer) return; // 空输入直接忽略（也避免"松开合成点击"误触确认按钮）

    var cur = DEV_GATE[gateStep];
    if (!cur) { closeSecretDialog(); return; }
    var hit = cur.ignoreCase
      ? (answer.toLowerCase() === cur.a.toLowerCase())
      : (answer === cur.a);

    if (!hit) {
      if (MG.Audio && S.get().sfx) MG.Audio.error();
      toast('答案不对');
      closeSecretDialog();
      return;
    }

    gateStep++;
    if (gateStep < DEV_GATE.length) {
      renderGateStep();
      if (MG.Audio && S.get().sfx) MG.Audio.click();
      return;
    }

    // 两题全对
    closeSecretDialog();
    if (MG.Dev && MG.Dev.unlockAndOpen) MG.Dev.unlockAndOpen();
    else toast('开发者选项未加载');
  }

  /** 达到长按阈值：震动反馈 + 立即弹窗（不用等松开，反馈更即时） */
  function onSecretLongPress() {
    // 已打开则不重复处理（防止松开后浏览器补发的 mousedown/mouseup 组合再次触发）
    if (el['secret-modal'] && !el['secret-modal'].classList.contains('hidden')) return;
    try {
      if (navigator && navigator.vibrate) navigator.vibrate(30); // 轻微震动，明确告知"已触发"
    } catch (e) { /* 忽略 */ }
    openSecretDialog();
  }

  /** 绑定彩蛋：长按检测（商店按钮 + 商店界面标题）+ 确认/取消/回车/ESC/点击背景 */
  function bindSecretDialog() {
    // 1) 长按检测（触摸 + 鼠标双通道）：达到阈值立即弹窗；短按行为不受影响
    var bindLongPress = function (target) {
      if (!target) return;
      var timer = null;
      var pressStart = function () {
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () {
          timer = null;
          onSecretLongPress();
        }, SECRET_HOLD_MS);
      };
      var pressEnd = function () {
        if (timer) { clearTimeout(timer); timer = null; }
        // 本次按压的"松开"：若弹窗刚因此打开，吞掉一次浏览器合成的点击（防误触）
        if (secretAwaitRelease) {
          secretAwaitRelease = false;
          if (secretAwaitTimer) { clearTimeout(secretAwaitTimer); secretAwaitTimer = null; }
          secretClickGuardUntil = Date.now() + 400;
        }
      };
      target.addEventListener('touchstart', pressStart, { passive: true });
      target.addEventListener('touchend', pressEnd);
      target.addEventListener('touchcancel', pressEnd);
      target.addEventListener('mousedown', pressStart);
      target.addEventListener('mouseup', pressEnd);
      target.addEventListener('mouseleave', pressEnd);
      // 长按触发系统右键菜单会打断体验，直接屏蔽
      target.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    };
    bindLongPress(el['btn-shop']);
    bindLongPress(el['shop-title']); // 商店界面里的标题也支持长按（兼容"在商店里长按"的操作）

    // 2) 输入框与按钮（松开瞬间的合成点击一律忽略）
    if (el['btn-secret-ok']) {
      el['btn-secret-ok'].addEventListener('click', function (e) {
        if (e.detail === 0 && isSecretClickGuarded()) return;
        playClick();
        submitSecretAnswer();
      });
    }
    if (el['btn-secret-cancel']) {
      el['btn-secret-cancel'].addEventListener('click', function (e) {
        if (e.detail === 0 && isSecretClickGuarded()) return;
        playClick();
        closeSecretDialog();
      });
    }
    if (el['secret-input']) {
      el['secret-input'].addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          submitSecretAnswer();
        }
      });
    }
    if (el['secret-modal']) {
      el['secret-modal'].addEventListener('click', function (e) {
        if (e.target !== el['secret-modal']) return;
        if (e.detail === 0 && isSecretClickGuarded()) return; // 防止"松开"瞬间的合成点击把刚弹出的窗口关掉
        closeSecretDialog();
      });
    }
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && el['secret-modal'] &&
          !el['secret-modal'].classList.contains('hidden')) {
        closeSecretDialog();
      }
    });
  }

  /* ------------------------------------------------------------
   * 道具面板（暂停 / 恢复由主程序控制）
   * ---------------------------------------------------------- */
  var itemCallbacks = {};

  function bindItemPanel() {
    if (el['item-panel']) {
      // 点击面板外（遮罩层）关闭
      el['item-panel'].addEventListener('click', function (e) {
        if (e.target === el['item-panel']) {
          if (itemCallbacks.onClose) itemCallbacks.onClose();
        }
      });
    }
    if (el['item-list']) {
      el['item-list'].addEventListener('click', function (e) {
        var btn = e.target;
        while (btn && btn !== el['item-list'] && !(btn.dataset && btn.dataset.useId)) {
          btn = btn.parentNode;
        }
        if (!btn || !(btn.dataset && btn.dataset.useId)) return;
        if (btn.disabled) return;
        if (itemCallbacks.onUse) itemCallbacks.onUse(btn.dataset.useId);
      });
    }
  }

  function showItemPanel() {
    show('item-panel');
    renderItemPanel();
  }

  function hideItemPanel() { hide('item-panel'); }

  /** 渲染道具面板：列出已购买且剩余次数 > 0 的道具 */
  function renderItemPanel() {
    if (!el['item-list'] || !MG.Shop) return;
    var items = MG.Shop.ITEMS;
    var html = '';
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.type !== 'count') continue;
      // passive 道具（如「签到护符」）自动生效、没有手动使用动作，不进这个面板：
      // 这里每行都带「使用」按钮，放进来只会让人点了没反应。其数量显示在签到面板头部。
      if (it.passive) continue;
      var n = MG.Shop.countOf(it.id);
      if (n <= 0) continue;
      html += '<li class="item-row">' +
        '<span class="item-icon">' + iconHtml(it.icon) + '</span>' +
        '<span class="item-name">' + (it.short || it.name) + '</span>' +
        '<span class="item-count">×' + formatCompactNum(n) + '</span>' +
        '<button class="mini-btn item-use-btn" data-use-id="' + it.id + '">使用</button>' +
      '</li>';
    }
    // 沙盒测试局：追加"生成器"入口（js/dev.js 提供；非沙盒时返回空串，完全无副作用）
    if (MG.Dev && MG.Dev.getItemPanelRows) html += MG.Dev.getItemPanelRows();
    if (!html) {
      html = '<li class="item-empty">暂无道具，去主菜单的「' + iconHtml('shop') + ' 商店」看看吧</li>';
    }
    el['item-list'].innerHTML = html;
  }

  /* ------------------------------------------------------------
   * 幽灵询问弹窗（返回 Promise）
   * ---------------------------------------------------------- */
  var ghostResolve = null;
  /** 幽灵弹窗超时定时器（15 秒无操作自动按"独自探险"继续） */
  var ghostTimeoutTimer = null;
  /** 幽灵弹窗无操作超时时间（毫秒）；仅作兜底，不打扰玩家 */
  var GHOST_TIMEOUT_MS = 15000;

  function bindGhostModal() {
    if (el['btn-ghost-yes']) {
      el['btn-ghost-yes'].addEventListener('click', function () {
        playClick();
        resolveGhostDialog('ghost');
      });
    }
    if (el['btn-ghost-no']) {
      el['btn-ghost-no'].addEventListener('click', function () {
        playClick();
        resolveGhostDialog('solo');
      });
    }
    // 弹窗打开期间：点击背景遮罩或按 ESC 也按"独自探险"处理，避免主流程卡死
    if (el['ghost-modal']) {
      el['ghost-modal'].addEventListener('click', function (e) {
        if (e.target === el['ghost-modal']) cancelGhostDialog();
      });
    }
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && ghostResolve) cancelGhostDialog();
    });
  }

  /**
   * 显示"发现历史挑战"弹窗
   * @param {{diffName:string, time:number}} info
   * @returns {Promise<{choice:'ghost'|'solo', remember:boolean}>}
   */
  function showGhostDialog(info) {
    return new Promise(function (resolve) {
      if (ghostResolve) {
        // 当前流程下不应出现：由 main.js 的 _startPending 守卫保证串行
        console.warn('[ui] showGhostDialog called while another is pending, ignoring');
        resolve({ choice: 'solo', remember: false });
        return;
      }
      ghostResolve = resolve;
      if (el['ghost-modal-info']) {
        var t = (info && typeof info.time === 'number') ? formatTime(info.time) : '—';
        el['ghost-modal-info'].textContent =
          '难度：' + ((info && info.diffName) || '—') + ' · 用时 ' + t;
      }
      if (el['ghost-remember']) el['ghost-remember'].checked = false;
      show('ghost-modal');
      // 超时兜底：玩家不操作（切后台 / 拖走弹窗）时也要让主流程继续，
      // 否则 Promise 永远 pending，main.js 的 _startPending 永久为 true，
      // 之后所有 startGame 会被静默拦截，玩家必须刷新页面
      if (ghostTimeoutTimer) clearTimeout(ghostTimeoutTimer);
      ghostTimeoutTimer = setTimeout(function () {
        ghostTimeoutTimer = null;
        // 超时静默按"独自探险"关闭，不弹 toast 打扰玩家
        closeGhostDialog({ choice: 'solo', remember: false });
      }, GHOST_TIMEOUT_MS);
    });
  }

  /** 关闭弹窗并回传选择结果 */
  function resolveGhostDialog(choice) {
    var remember = !!(el['ghost-remember'] && el['ghost-remember'].checked);
    closeGhostDialog({ choice: choice, remember: remember });
  }

  /** 取消弹窗（点击背景遮罩 / 按 ESC 主动取消）：按"独自探险"处理，确保主流程必定继续 */
  function cancelGhostDialog() {
    closeGhostDialog({ choice: 'solo', remember: false });
  }

  /** 内部：关闭弹窗并回传结果（无待决弹窗时为空操作） */
  function closeGhostDialog(result) {
    if (!ghostResolve) return;
    // 无论何种方式关闭（玩家选择 / 点背景 / ESC / 超时），都清理超时定时器避免残留
    if (ghostTimeoutTimer) {
      clearTimeout(ghostTimeoutTimer);
      ghostTimeoutTimer = null;
    }
    var fn = ghostResolve;
    hide('ghost-modal');   // 先清理 DOM，再清空待决状态，最后回传结果
    ghostResolve = null;
    fn(result);
  }

  /* ------------------------------------------------------------
   * 小地图锁定（找到地图道具前不可用）
   * ---------------------------------------------------------- */
  function currentMinimapLocked() {
    var g = MG.game;
    if (!g) return false;
    var inGame = (g.state === 'playing' || g.state === 'paused' || g.state === 'win' || g.state === 'replay');
    if (!inGame) return false;
    return !g.mapFound;
  }

  /**
   * 更新小地图锁定占位
   * @param {boolean} locked 未拾取 → true
   * @param {string} hint 简单难度的模糊方位提示（可为空）
   */
  function updateMinimapLock(locked, hint) {
    if (el['minimap-lock']) {
      if (locked) el['minimap-lock'].classList.remove('hidden');
      else el['minimap-lock'].classList.add('hidden');
    }
    if (el['minimap-lock-hint']) {
      if (locked && hint) {
        el['minimap-lock-hint'].textContent = hint;
        el['minimap-lock-hint'].classList.remove('hidden');
      } else {
        el['minimap-lock-hint'].classList.add('hidden');
      }
    }
    // 未拾取时清空画布，避免残留上一局内容（缓存同步失效，避免贴回旧图）
    if (locked && mapCtx) {
      mapCtx.setTransform(1, 0, 0, 1, 0, 0);
      mapCtx.clearRect(0, 0, mapSize * mapCacheDpr, mapSize * mapCacheDpr);
      mapCtx.setTransform(mapCacheDpr, 0, 0, mapCacheDpr, 0, 0);
      invalidateMinimapCache();
    }
    applyMinimapSettingLock();
    // 距离信息随"是否解锁小地图"同步显示 / 隐藏
    applyDistanceVisibility(!locked);
  }

  /** 设置面板里小地图开关的置灰状态（未拾取时置灰并标注"未解锁"） */
  function applyMinimapSettingLock() {
    var locked = currentMinimapLocked();
    if (el['set-minimap-toggle']) el['set-minimap-toggle'].disabled = locked;
    // 「小地图显示全部金币」依赖小地图本身，未拾取地图卷轴时一并置灰
    if (el['set-minimap-coins']) el['set-minimap-coins'].disabled = locked;
    if (el['set-minimap-state']) {
      if (locked) el['set-minimap-state'].classList.remove('hidden');
      else el['set-minimap-state'].classList.add('hidden');
    }
  }

  /* ------------------------------------------------------------
   * 设置面板绑定与同步
   * ---------------------------------------------------------- */
  function bindSettingsPanel() {
    // 滑块类
    bindRange('set-fov', 'val-fov', 'fov', function (v) { return Math.round(v); });
    bindRange('set-sensitivity', 'val-sensitivity', 'sensitivity', function (v) { return Number(v).toFixed(1); });
    bindRange('set-speed', 'val-speed', 'moveSpeed', function (v) { return Number(v).toFixed(1); });
    bindRange('set-volume', 'val-volume', 'volume', function (v) { return Number(v).toFixed(2); });

    // 开关类
    bindSwitch('set-invert-yaw', 'invertYaw');
    bindSwitch('set-invert-pitch', 'invertPitch');
    bindSwitch('set-shadows', 'shadows');
    bindSwitch('set-fog', 'fog');
    bindSwitch('set-minimap-toggle', 'minimap');
    bindSwitch('set-minimap-coins', 'minimapCoins');
    bindSwitch('set-colorblind', 'colorblind');
    bindSwitch('set-sfx', 'sfx');
    /* 性能三件套（2026-11-15）：两个普通布尔开关。
       性能模式的级联（quality→low / shadows→false）在 js/settings.js 的 setSetting 里完成，
       设置面板里的画质下拉与阴影开关由 main.js 的 onSettingChanged 调 syncSettingsUI()
       同步显示 —— 这里只负责把开关值写进设置，不重复实现级联（两处实现必然漂移）。 */
    bindSwitch('set-perf-mode', 'perfMode');
    bindSwitch('set-view-cull', 'viewCull');

    // 下拉框
    bindSelect('set-quality-select', 'quality');
    bindSelect('set-minimap-size', 'minimapSize');
    bindSelect('set-theme-select', 'theme');
    bindSelect('set-ghost-select', 'ghostMode');

    // 重置
    if (el['btn-settings-reset']) {
      el['btn-settings-reset'].addEventListener('click', function () {
        playClick();
        S.reset();
        syncSettingsUI();
        applyThemeToBody();
        toast('设置已重置');
      });
    }

    // 返回
    if (el['btn-settings-back']) {
      el['btn-settings-back'].addEventListener('click', function () {
        playClick();
        closeSettings();
      });
    }
  }

  function bindRange(inputId, valId, key, fmt) {
    var input = el[inputId];
    if (!input) return;
    input.addEventListener('input', function () {
      var v = parseFloat(input.value);
      S.set(key, v);
      if (el[valId]) el[valId].textContent = fmt ? fmt(v) : v;
    });
  }

  function bindSwitch(inputId, key) {
    var input = el[inputId];
    if (!input) return;
    input.addEventListener('change', function () {
      S.set(key, input.checked);
      // 小地图相关开关会影响静态内容（如金币轮廓 / 显隐），立即失效缓存
      invalidateMinimapCache();
      playClick();
    });
  }

  function bindSelect(inputId, key) {
    var input = el[inputId];
    if (!input) return;
    input.addEventListener('change', function () {
      S.set(key, input.value);
      // 主题切换会改变配色，小地图缓存需重绘（色盲开关同理由 bindSwitch 处理）
      invalidateMinimapCache();
      playClick();
    });
  }

  /** 把设置值写回 UI 控件 */
  function syncSettingsUI() {
    var s = S.get();
    setRange('set-fov', 'val-fov', s.fov, Math.round);
    setRange('set-sensitivity', 'val-sensitivity', s.sensitivity, function (v) { return Number(v).toFixed(1); });
    setRange('set-speed', 'val-speed', s.moveSpeed, function (v) { return Number(v).toFixed(1); });
    setRange('set-volume', 'val-volume', s.volume, function (v) { return Number(v).toFixed(2); });

    setCheck('set-invert-yaw', s.invertYaw);
    setCheck('set-invert-pitch', s.invertPitch);
    setCheck('set-shadows', s.shadows);
    setCheck('set-fog', s.fog);
    setCheck('set-minimap-toggle', s.minimap);
    setCheck('set-minimap-coins', s.minimapCoins);
    setCheck('set-colorblind', s.colorblind);
    setCheck('set-sfx', s.sfx);
    // 性能三件套（2026-11-15）：开关值直接反映设置；画质/阴影被级联改动时也靠这里同步显示
    setCheck('set-perf-mode', s.perfMode);
    setCheck('set-view-cull', s.viewCull);

    setValue('set-quality-select', s.quality);
    setValue('set-minimap-size', s.minimapSize || 'auto');
    applyMinimapSizeToBody();
    setValue('set-theme-select', s.theme);
    setValue('set-ghost-select', s.ghostMode);

    // 小地图开关：未找到地图道具时置灰（标注"未解锁"）
    applyMinimapSettingLock();
  }

  function setRange(inputId, valId, v, fmt) {
    if (el[inputId]) el[inputId].value = v;
    if (el[valId]) el[valId].textContent = fmt ? fmt(v) : v;
  }
  function setCheck(inputId, v) {
    if (el[inputId]) el[inputId].checked = !!v;
  }
  function setValue(inputId, v) {
    if (el[inputId]) el[inputId].value = v;
  }

  /** 应用主题到 body（CSS 变量联动） */
  function applyThemeToBody() {
    var s = S.get();
    document.body.dataset.theme = s.theme || 'tech';
    if (s.colorblind) document.body.dataset.colorblind = '1';
    else delete document.body.dataset.colorblind;
    // 主题 / 色盲配色变化会影响小地图静态内容，立即失效缓存
    invalidateMinimapCache();
  }

  /* ------------------------------------------------------------
   * 小地图大小（BUG-062，2026-11-09）
   * ------------------------------------------------------------
   * 背景：尺寸原先写死 min(34vw, 168px)，视口一高过 720px 就被 168px 上限钉住，
   * 于是桌面/平板（1080p 只有屏宽 8.7%）"任何难度都小得看不清"。
   * 现在：CSS 用 --minimap-size 做自适应（见 style.css 文件头），这里只负责
   * ① 把玩家的档位写进 body[data-minimap-size]；② 立刻按新尺寸重设画布分辨率；
   * ③ 在设置面板的徽标上如实显示"当前档位 · 实际像素"，让玩家知道能调、调了多大。
   * ---------------------------------------------------------- */

  /** 应用「小地图大小」档位到 body（auto 不设属性，走 CSS 自适应公式） */
  function applyMinimapSizeToBody() {
    var mode = S.get().minimapSize || 'auto';
    if (mode === 'auto') delete document.body.dataset.minimapSize;
    else document.body.dataset.minimapSize = mode;
    updateMinimapSizeBadge();
  }

  /**
   * 把 "261.1px" 这类**纯像素**字面量解析成数字；其它形态（clamp(...) / '' / 百分比）返回 0。
   * 只认纯 px 是刻意的：只要出现函数或相对单位就说明"这个值还没被浏览器求值"，
   * 交给下面探针那条路，绝不在 JS 里自己算。
   */
  function parseCssPx(v) {
    var m = /^\s*([0-9]*\.?[0-9]+)px\s*$/.exec(String(v == null ? '' : v));
    return m ? parseFloat(m[1]) : 0;
  }

  /** 尺寸探针（懒创建并复用；只在读不到容器宽度时才会用到） */
  var minimapProbe = null;

  /**
   * 读「当前档位 / 视口在 CSS 里对应的实际像素尺寸」——BUG-069 的核心（2026-11-15）。
   *
   * ── 为什么需要它 ──
   * 设置面板打开时 showSettings() 会 hide('hud')，而 .minimap-wrap 在 #hud 里，
   * display:none 之下 clientWidth === 0 → resizeMinimap() 量不到容器，
   * 徽标只能沿用上一次的测量值（或 init 的兜底 168），于是用户看到
   * "设置里调小地图大小，数值不实时刷新，必须退出设置再进来"。
   *
   * ── 为什么不把那几条 clamp 公式抄进 JS 算 ──
   * --minimap-size 是 CSS 里**唯一事实源**（BUG-062 起）：公式里含 clamp()/min()/vw/vh/vmin，
   * 还有横屏矮屏的 :root 覆盖与 body[data-minimap-size] 四档覆盖。JS 再写一份就是两处漂移 ——
   * 以后调 CSS 忘了改 JS，徽标会报一个与真实渲染尺寸不同的假数字，
   * 而这正是既有的"读盘侧/写盘侧口径不一致"那类坑（BUG-046/051 的教训）。
   * 所以这里**只测量、不计算**，按可靠性依次尝试：
   *   ① 容器可见 → 直接量 clientWidth（最准，含所有媒体查询与兜底）；
   *   ② 容器隐藏 → 读 --minimap-size；若是纯 px（老内核兜底档 / 纯 px 档）直接用；
   *   ③ 否则挂一个探针元素、width:var(--minimap-size)，**让浏览器自己的 CSS 引擎**
   *      把 clamp/min/vmin 求值成像素再量（现代浏览器里自定义属性的计算值按规范
   *      **不会**展开数学函数，第②步读到的会是 "clamp(120px, min(34vw, 34vh), 320px)" 字面量，
   *      所以这一步不是多余的）；
   *   ④ 都测不到（无头测试环境没有布局引擎）→ 返回 0，由调用方"宁可不显示像素值"。
   * @returns {number} 像素尺寸；测不到返回 0
   */
  function readMinimapSizePx() {
    // ① 容器可见：量真实渲染尺寸（会含 border 吗？.minimap-wrap 无边框，clientWidth 即内容宽）
    if (el['minimap'] && el['minimap'].clientWidth) return Math.round(el['minimap'].clientWidth);

    // ② CSS 变量：纯 px 字面量（不依赖布局，无头环境里这一条也能先命中老内核兜底值）
    var raw = '';
    try { raw = window.getComputedStyle(document.body).getPropertyValue('--minimap-size'); } catch (e) { raw = ''; }
    var px = parseCssPx(raw);
    if (px > 0) return Math.round(px);

    // ③ 探针：把求值交给浏览器（body 可见即可用，与 #hud 是否隐藏无关）
    try {
      if (!minimapProbe) {
        minimapProbe = document.createElement('div');
        /* 与 .minimap-wrap 同口径：块级、无内外边距/边框（全局 * { box-sizing:border-box } 下也一样），
           并且 width 用同一个变量 → 档位/媒体查询变化时它会跟着变，不需要重建。
           left:-9999px + visibility:hidden + aria-hidden：不进视野、不被读屏朗读，
           也不参与命中测试（pointer-events:none 双保险）。 */
        minimapProbe.style.cssText =
          'position:absolute;left:-9999px;top:0;display:block;height:0;' +
          'width:var(--minimap-size);visibility:hidden;pointer-events:none;';
        minimapProbe.setAttribute('aria-hidden', 'true');
        if (document.body) document.body.appendChild(minimapProbe);
      }
      var w = minimapProbe.offsetWidth || minimapProbe.clientWidth || 0;
      if (w > 0) return Math.round(w);
    } catch (e) { /* 忽略：老内核不支持 var() 或环境无布局，落到 ④ */ }

    // ④ 测不到：返回 0。调用方据此**不显示像素值** ——
    //    显示"档位"总比显示一个陈旧/错误的数字强（这正是 BUG-069 的表现）。
    return 0;
  }

  /** 设置面板徽标：当前档位 + 实际像素（测不到尺寸时只显示档位，绝不显示陈旧值） */
  function updateMinimapSizeBadge() {
    var node = el['set-minimap-size-state'];
    if (!node) return;
    var mode = S.get().minimapSize || 'auto';
    var label = mode === 'auto' ? '自动'
      : (mode === 'small' ? '小' : (mode === 'medium' ? '中' : '大'));
    /* 注意这里**不能**再用 mapSize：那是"上一次真正测量到的 HUD 画布尺寸"，
       设置面板打开时它就是陈旧值（BUG-069 的根因）。改用 readMinimapSizePx() 现测。 */
    var px = readMinimapSizePx();
    if (px > 0) label += ' · ' + px + 'px';
    if (node.textContent !== label) node.textContent = label;
  }

  /**
   * 尺寸档位变化 / 屏幕变化后立刻生效：重新测量容器并按 dpr 重设画布。
   * 容器隐藏（不在对局中 / 未解锁）时量不到宽度，交给下一次 drawMinimap 兜底。
   */
  function refreshMinimapSize() {
    // 档位 → body 属性（CSS 变量靠它覆盖自适应公式）；先做这一步，
    // 再重设画布分辨率。写成"唯一入口"是为了避免出现"徽标变了但尺寸没变"这种半生效状态。
    applyMinimapSizeToBody();
    if (!resizeMinimap()) minimapResizePending = true;
    updateMinimapSizeBadge();
  }

  /* ------------------------------------------------------------
   * HUD 状态刷新
   * ---------------------------------------------------------- */
  function updateHud(data) {
    if (el['stat-time']) el['stat-time'].textContent = formatTime(data.time);
    if (el['stat-steps']) el['stat-steps'].textContent = data.steps;
    if (el['stat-diff']) el['stat-diff'].textContent = data.diffName;
    if (el['stat-dist']) {
      var d = data.euclidDist;
      el['stat-dist'].textContent = (d >= 0 ? d.toFixed(0) + 'm' : '—');
    }
    // 金币：本局拾取 / 钱包余额
    if (el['stat-coins']) el['stat-coins'].textContent = data.collectedCoins || 0;
    // 钱包余额：普通金额保留千分位（更直观），超过 1e8 时用紧凑格式兜底防溢出
    if (el['stat-wallet']) {
      var wc = data.walletCoins || 0;
      var walletHtml = (wc >= 1e8 ? formatCompactNum(wc) : formatNum(wc)) + ' ' +
        iconHtmlFor(el['stat-wallet'], 'money');
      // 数值没变就别动 DOM：innerHTML 每次都会重建节点
      if (el['stat-wallet'].innerHTML !== walletHtml) el['stat-wallet'].innerHTML = walletHtml;
    }

    // 指南针
    if (el['compass-arrow']) {
      // yaw 增大 = 向左转（forward = (-sin yaw, 0, -cos yaw)），
      // 相对偏角为正说明终点在左侧，CSS 旋转需逆时针 → 符号取反
      var deg = data.compassAngle * 180 / Math.PI;
      el['compass-arrow'].style.transform = 'rotate(' + (-deg) + 'deg)';
    }
    if (el['compass-dist']) {
      el['compass-dist'].textContent = data.gridDist >= 0 ? data.gridDist + '格' : '—';
    }

    // 道具按钮 / 取消寻路按钮
    updateItemsButton(data);

    // 小地图开关按钮高亮（未找到地图道具时置灰）
    var mapFound = !!(MG.game && MG.game.mapFound);
    if (el['btn-minimap']) {
      if (S.get().minimap && mapFound) el['btn-minimap'].classList.add('active');
      else el['btn-minimap'].classList.remove('active');
      if (mapFound) el['btn-minimap'].classList.remove('locked');
      else el['btn-minimap'].classList.add('locked');
    }
    if (el['minimap']) {
      if (S.get().minimap && mapFound) el['minimap'].classList.remove('hidden');
      else el['minimap'].classList.add('hidden');
    }
    // 占位：未找到地图时显示
    if (el['minimap-lock']) {
      if (mapFound) el['minimap-lock'].classList.add('hidden');
      else el['minimap-lock'].classList.remove('hidden');
    }

    // 未解锁小地图时：隐藏指南针距离 / "距离"状态（不泄露终点信息）
    applyDistanceVisibility(mapFound);
  }

  /** 未解锁小地图时隐藏距离信息（#compass-dist 与 #stat-dist 所在的 .stat 容器） */
  function applyDistanceVisibility(visible) {
    var cd = el['compass-dist'];
    var sd = el['stat-dist-wrap'];
    if (cd) {
      if (visible) cd.classList.remove('hidden');
      else cd.classList.add('hidden');
    }
    if (sd) {
      if (visible) sd.classList.remove('hidden');
      else sd.classList.add('hidden');
    }
  }

  /** 道具按钮 / 取消寻路按钮的显隐与文案 */
  function updateItemsButton(data) {
    var btn = el['btn-items'];
    var cancel = el['btn-cancel-path'];
    if (btn) {
      if (data.autoActive) {
        btn.classList.add('hidden');
      } else {
        btn.classList.remove('hidden');
        var n = data.itemTotal || 0;
        // 超大数量（彩蛋奖励可累积到 10w+）用紧凑格式，避免按钮文字溢出
        var itemsHtml = n > 0
          ? iconHtmlFor(btn, 'bag') + '道具 ×' + formatCompactNum(n)
          : iconHtmlFor(btn, 'bag') + '道具';
        if (btn.innerHTML !== itemsHtml) btn.innerHTML = itemsHtml;
      }
    }
    if (cancel) {
      if (data.autoActive) cancel.classList.remove('hidden');
      else cancel.classList.add('hidden');
    }
  }

  /* ------------------------------------------------------------
   * 小地图绘制
   * ---------------------------------------------------------- */

  /**
   * 绘制小地图的"相对静态"内容到离屏缓存：
   * 背景 + 已探索通路 + 已探索墙 + 金币 + 起点
   * （终点呼吸光 / 玩家 / 寻路路径 / 边框属于动态内容，由 drawMinimap 每次绘制）
   */
  function drawMinimapStatic(player, maze, mazeView, settings) {
    var ctx = mapCacheCtx;
    if (!ctx) return;
    var cb = !!settings.colorblind; // 色盲友好模式：颜色 + 形状双编码
    var size = maze.size;
    var cellPx = mapSize / size;

    ctx.setTransform(mapCacheDpr, 0, 0, mapCacheDpr, 0, 0);
    ctx.clearRect(0, 0, mapSize, mapSize);
    // 背景
    ctx.fillStyle = 'rgba(6,10,18,0.85)';
    ctx.fillRect(0, 0, mapSize, mapSize);

    /* ---------- 大迷宫降噪（2026-11-15，难度体系重构配套） ----------
       先算聚合块大小 block：121×121 在手机上只有约 1.1px/格、桌面约 2.6px/格，
       逐格 fillRect 既看不出格子、又要画 14641×2 次。
       cellPx < 3 时按 block×block 聚合：**块内任一格已探索就点亮整块**，
       用一格像素表达整块 —— 观感从"糊成一团的噪点"变成"能看出通道走向"。
       block = 1（21×21 / 31×31 那两档）时与旧实现逐格等价。 */
    var block = cellPx >= 3 ? 1 : (cellPx >= 1.5 ? 2 : 4);
    function fillLayer(cellKind) {
      for (var by = 0; by < size; by += block) {
        for (var bx = 0; bx < size; bx += block) {
          var hit = false;
          for (var sy = by; sy < by + block && sy < size && !hit; sy++) {
            for (var sx = bx; sx < bx + block && sx < size; sx++) {
              var gi = sy * size + sx;
              if (maze.grid[gi] === cellKind && player.explored[gi]) { hit = true; break; }
            }
          }
          if (hit) {
            ctx.fillRect(bx * cellPx, by * cellPx, cellPx * block + 0.6, cellPx * block + 0.6);
          }
        }
      }
    }

    // 已探索通路
    ctx.fillStyle = 'rgba(60,110,160,0.45)';
    fillLayer(0);

    // 探索到的墙体（用稍亮的颜色画出边界感）
    ctx.fillStyle = 'rgba(120,180,240,0.18)';
    fillLayer(1);

    // 金币：默认只显示已探索区域的实心点；
    // 开启「小地图显示全部金币」后，未探索区域的金币用半透明轮廓提示位置
    // （轮廓 vs 实心，明确区分"知道位置"与"亲自探索过"）
    var showAllCoins = !!(settings && settings.minimapCoins);
    if (block > 1) {
      /* 大迷宫（121×121）：金币半径最少 2.2px，比一格（约 1.1px）还大，
         画上去只会把地图糊成一片亮点。**直接不画金币** ——
         起点 / 终点 / 玩家 / 寻路路径仍有标记，金币数量在 HUD 与道具面板里另有显示。 */
    } else if (mazeView && mazeView.coins) {
      for (var c = 0; c < mazeView.coins.length; c++) {
        var coin = mazeView.coins[c];
        if (coin.collected) continue;
        var coinSeen = !!player.explored[coin.y * size + coin.x];
        if (!coinSeen && !showAllCoins) continue;
        var coinCx = coin.x * cellPx + cellPx / 2;
        var coinCy = coin.y * cellPx + cellPx / 2;
        var coinR = Math.max(2.2, cellPx * 0.3);
        if (coinSeen) {
          if (cb) {
            // 色盲：橙色方块（□），与圆形起点/三角玩家形状区分
            ctx.fillStyle = '#ff9f40';
            ctx.fillRect(coinCx - coinR, coinCy - coinR, coinR * 2, coinR * 2);
          } else {
            ctx.fillStyle = '#ffd24a';
            ctx.beginPath();
            ctx.arc(coinCx, coinCy, coinR, 0, Math.PI * 2);
            ctx.fill();
          }
        } else {
          // 未探索：只描轮廓不填充，视觉弱化
          if (cb) {
            ctx.strokeStyle = 'rgba(255,159,64,0.55)';
            ctx.lineWidth = Math.max(1, cellPx * 0.16);
            ctx.strokeRect(coinCx - coinR, coinCy - coinR, coinR * 2, coinR * 2);
          } else {
            ctx.strokeStyle = 'rgba(255,210,74,0.45)';
            ctx.lineWidth = Math.max(1, cellPx * 0.16);
            ctx.beginPath();
            ctx.arc(coinCx, coinCy, coinR, 0, Math.PI * 2);
            ctx.stroke();
          }
        }
      }
    }

    // 起点
    var startPx = maze.start.x * cellPx + cellPx / 2;
    var startPy = maze.start.y * cellPx + cellPx / 2;
    if (cb) {
      // 色盲：蓝色实心方块（■）
      var sr = Math.max(2.5, cellPx * 0.35);
      ctx.fillStyle = '#4ea1ff';
      ctx.fillRect(startPx - sr, startPy - sr, sr * 2, sr * 2);
    } else {
      ctx.fillStyle = '#44ff88';
      ctx.beginPath();
      ctx.arc(startPx, startPy, Math.max(2.5, cellPx * 0.35), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** 统计已探索格子数（用于判断缓存是否需要因"探索到新区域"而失效） */
  function countExplored(explored, total) {
    var n = 0;
    for (var i = 0; i < total; i++) {
      if (explored[i]) n++;
    }
    return n;
  }

  function drawMinimap(player, maze, mazeView, settings) {
    if (!mapCtx || !settings.minimap) return;
    // 上次 resize 时容器还隐藏着（clientWidth=0），趁这次可见补算分辨率
    if (minimapResizePending) resizeMinimap();
    // 未找到地图道具前不绘制内容（占位由 updateMinimapLock 负责）
    if (MG.game && !MG.game.mapFound) return;
    var cb = !!settings.colorblind; // 色盲友好模式：颜色 + 形状双编码
    var size = maze.size;
    var cellPx = mapSize / size;

    /* 记下本次绘制参数：最大化地图在"打开的那一刻"（还没等到下一次 120ms 节流）需要它补画一帧，
       否则会先闪一下空白。只在同一局内使用 —— 见 drawMapFullFromLastArgs() 的对象身份校验。 */
    lastMapArgs = { player: player, maze: maze, mazeView: mazeView, settings: settings };

    /* ---------- 1) 缓存失效判定 ---------- */
    var pgd = player.getGrid();
    var exploredCount = countExplored(player.explored, size * size);
    /* 静态内容签名：难度（size）/ 主题配色 / 色盲模式 / 金币显示设置 / 剩余金币数 /
       已探索格子数 / 小地图解锁状态 —— 只有这些变化才该让整层静态缓存作废。
       两条"必须有"的理由：
       ① 剩余金币数：金币画在离屏静态层上，而"道具面板生成金币"这类操作可以在玩家**不跨格**
          时改变金币集合，不把它算进来就得等走到下一格才显示新金币（BUG-042② 的既有口径）；
       ② 已探索格子数：这是静态层唯一"内容会变"的来源 —— 新格子一被探索计数就变，
          签名随之改变 → 立刻重绘（交付脚本断言过"走到新格子后静态层确实重绘"）。
       这里**刻意没有**玩家格坐标：玩家三角画在动态层，跨格不改变静态层任何一个像素，
       把它留在条件里只会让行走时白做整层重绘（实测与说明见文件头 mapCacheCanvas 注释）。 */
    var remainCoins = (typeof mazeView.remainCoins === 'function') ? mazeView.remainCoins() : 0;
    var mapFoundFlag = (MG.game && MG.game.mapFound) ? 1 : 0;
    var signature = size + '|' + (settings.theme || '') + '|' + (cb ? 1 : 0) + '|' +
      (settings.minimapCoins ? 1 : 0) + '|' + mapSize + '|' + remainCoins + '|' +
      exploredCount + '|' + mapFoundFlag;
    if (signature !== mapCacheSignature) {
      mapCacheSignature = signature;
      mapCacheDirty = true;
    }

    /* ---------- 2) 必要时重绘缓存 ---------- */
    if (mapCacheDirty || !mapCacheCanvas) {
      drawMinimapStatic(player, maze, mazeView, settings);
      mapCacheDirty = false;
      // 仅作观测 / 排错用途；失效判定已经并入上面的签名，这里不参与判断（别误当条件用）
      mapCacheExploredCount = exploredCount;
    }

    /* ---------- 3) 缓存贴到主画布 ---------- */
    /* 先算"当前是否处于缩放/平移视图"。HUD 小地图恒为 false（mapViewZoom 永远是 1、
       pan 永远是 0），所以下面那条分支与改造前**逐字节等价** —— 这是刻意的：
       既有那条路径已被一整套断言钉死（bug069-verify.js 会数 drawImage 的调用形态），
       新功能不该去动它。 */
    var viewZoomed = (mapViewZoom !== 1 || mapViewPanX !== 0 || mapViewPanY !== 0);
    mapCtx.setTransform(1, 0, 0, 1, 0, 0);
    mapCtx.clearRect(0, 0, mapCacheCanvas.width, mapCacheCanvas.height);
    if (mapCacheCanvas) {
      if (!viewZoomed) {
        mapCtx.drawImage(mapCacheCanvas, 0, 0);
      } else {
        /* 放大时**不能**"整张 drawImage 之后靠变换缩放"：8× 等于让 GPU 去采样
           64 倍面积的像素，而其中 63/64 落在画布外（白烧填充率，正是手机发烫的来源）。
           改为只取"当前可见的那一小块"源矩形贴上去 —— 采样面积与屏幕像素同量级。
           源矩形按缓存像素比换算、目标矩形按缩放后的逻辑坐标给，两边比例恰好是
           cacheDpr/zoom，所以清晰度与"整张贴再缩放"完全一致（没有任何画质损失）。
           边界钳到 [0,size]，且 x1>x0 才画：平移被 clampMapFullView() 限制在地图内，
           正常不会出现空矩形，这里只是兜住"视口比地图还大"之类的极端数值。 */
        var sizeV = mapSize;
        var sx0 = (0 - mapViewPanX) / mapViewZoom;
        var sy0 = (0 - mapViewPanY) / mapViewZoom;
        var sx1 = (sizeV - mapViewPanX) / mapViewZoom;
        var sy1 = (sizeV - mapViewPanY) / mapViewZoom;
        if (sx0 < 0) sx0 = 0;
        if (sy0 < 0) sy0 = 0;
        if (sx1 > sizeV) sx1 = sizeV;
        if (sy1 > sizeV) sy1 = sizeV;
        if (sx1 > sx0 && sy1 > sy0) {
          mapCtx.setTransform(mapViewDpr, 0, 0, mapViewDpr, 0, 0);
          mapCtx.drawImage(
            mapCacheCanvas,
            sx0 * mapCacheDpr, sy0 * mapCacheDpr, (sx1 - sx0) * mapCacheDpr, (sy1 - sy0) * mapCacheDpr,
            sx0 * mapViewZoom + mapViewPanX, sy0 * mapViewZoom + mapViewPanY,
            (sx1 - sx0) * mapViewZoom, (sy1 - sy0) * mapViewZoom
          );
        }
      }
    }
    /* 之后的动态绘制回到"逻辑像素 + 缩放平移"坐标系：
       设备像素 = dpr × (zoom × 地图坐标 + pan)。动态元素（终点 / 玩家 / 寻路路径 / 边框）
       与静态层共用同一套坐标，所以放大后它们与地图内容严丝合缝地一起放大，
       不会出现"图放大了、玩家标记还钉在原处"。
       代价（如实记录、需真机确认观感）：玩家三角与路径线宽也会跟着放大，8× 下比 1× 粗一截。
       若真机上看着别扭，正确做法是**在动态层自己除一个 zoom** 保持屏幕尺寸，
       而不是改这里的坐标系（那会让标记与格子的相对位置漂移）。 */
    mapCtx.setTransform(
      mapViewDpr * mapViewZoom, 0, 0, mapViewDpr * mapViewZoom,
      mapViewDpr * mapViewPanX, mapViewDpr * mapViewPanY
    );

    /* ---------- 4) 动态元素 ---------- */

    // 终点（普通：紫色脉动圆；色盲：蓝色十字 ✕）
    // performance.now 现代浏览器全支持；对老 X5 内核兜底用 Date.now（脉动相位不同但观感一致）
    var now = (typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now();
    var pulse = 0.6 + Math.sin(now / 320) * 0.4;
    var endPx = maze.end.x * cellPx + cellPx / 2;
    var endPy = maze.end.y * cellPx + cellPx / 2;
    var endR = Math.max(3, cellPx * 0.45);
    if (cb) {
      mapCtx.strokeStyle = 'rgba(78,161,255,' + pulse.toFixed(2) + ')';
      mapCtx.lineWidth = Math.max(1.8, cellPx * 0.22);
      mapCtx.beginPath();
      mapCtx.moveTo(endPx - endR, endPy - endR);
      mapCtx.lineTo(endPx + endR, endPy + endR);
      mapCtx.moveTo(endPx + endR, endPy - endR);
      mapCtx.lineTo(endPx - endR, endPy + endR);
      mapCtx.stroke();
    } else {
      mapCtx.fillStyle = 'rgba(178,125,255,' + pulse.toFixed(2) + ')';
      mapCtx.beginPath();
      mapCtx.arc(endPx, endPy, endR, 0, Math.PI * 2);
      mapCtx.fill();
    }

    // 玩家（三角，指示朝向）—— 复用上面动态层算出的当前格（静态层不画玩家，所以跨格只重绘这里）
    var px = pgd.x * cellPx + cellPx / 2;
    var py = pgd.y * cellPx + cellPx / 2;
    mapCtx.save();
    mapCtx.translate(px, py);
    // yaw=0 时朝向 -Z（地图上方），换算成 canvas 角度
    mapCtx.rotate(-player.yaw);
    /* 大迷宫下 cellPx 只有约 1.1px，按 cellPx 缩放玩家三角会小到看不见 →
       给一个像素下限（21×21 时 cellPx≈6.3 已大于下限，观感不变）。 */
    var mk = Math.max(cellPx, 5);
    mapCtx.beginPath();
    mapCtx.moveTo(0, -mk * 0.55);
    mapCtx.lineTo(mk * 0.38, mk * 0.45);
    mapCtx.lineTo(-mk * 0.38, mk * 0.45);
    mapCtx.closePath();
    if (cb) {
      // 色盲：橙色三角 + 白色粗描边，尖端再补一个小箭头强调朝向
      mapCtx.fillStyle = '#ff9f40';
      mapCtx.fill();
      mapCtx.strokeStyle = '#ffffff';
      mapCtx.lineWidth = Math.max(1.5, cellPx * 0.16);
      mapCtx.stroke();
      mapCtx.beginPath();
      mapCtx.moveTo(0, -mk * 0.95);
      mapCtx.lineTo(-mk * 0.16, -mk * 0.66);
      mapCtx.lineTo(mk * 0.16, -mk * 0.66);
      mapCtx.closePath();
      mapCtx.fillStyle = '#ffffff';
      mapCtx.fill();
    } else {
      mapCtx.fillStyle = '#35d0ff';
      mapCtx.fill();
    }
    mapCtx.restore();

    // 自动寻路路径（若存在）
    if (player.autoPath && player.autoPath.length > 1) {
      mapCtx.strokeStyle = cb ? '#ffe066' : 'rgba(98,230,255,0.85)';
      mapCtx.lineWidth = Math.max(1.5, cellPx * 0.25);
      mapCtx.beginPath();
      var half = (size * MG.Maze.CELL) / 2;
      for (var k = 0; k < player.autoPath.length; k++) {
        var wp = player.autoPath[k];
        var gx2 = (wp.x + half - MG.Maze.CELL / 2) / MG.Maze.CELL;
        var gy2 = (wp.z + half - MG.Maze.CELL / 2) / MG.Maze.CELL;
        var mx = gx2 * cellPx + cellPx / 2;
        var my = gy2 * cellPx + cellPx / 2;
        if (k === 0) mapCtx.moveTo(mx, my);
        else mapCtx.lineTo(mx, my);
      }
      mapCtx.stroke();
    }

    // 边框
    mapCtx.strokeStyle = 'rgba(120,190,255,0.35)';
    mapCtx.lineWidth = 2;
    mapCtx.strokeRect(1, 1, mapSize - 2, mapSize - 2);
  }

  /* ------------------------------------------------------------
   * 最大化地图（M2/M3，2026-11-15）
   * ------------------------------------------------------------
   * 设计依据：《新难度-地图可读性设计.md》§4 的 M2（交互 / 层级 / 非模态 / 生命周期）、
   * M3（逐条冲突清单）、M4（性能与内存）、M5（验收）。
   *
   * 三条不可动摇的口径（用户 2026-11-09 定稿）：
   *   ① 正方形之外的留白**不关闭地图**，而是穿透到 #look-layer 继续滑视角
   *      → 容器 pointer-events:none，只有地图本体与关闭按钮 auto；
   *        关闭只能靠 再点地图 / V / ESC / 专用关闭按钮；
   *   ② `M` 键保持"小地图开/关"语义不变，最大化是**新增的 V 键**（键位接线在 main.js）；
   *   ③ 最大化期间**不暂停**：不置 state='paused'、不动计时、不动输入状态，
   *      摇杆与道具面板照常可用（层级上 #hud 20 / 摇杆 22、.screen 40 都在本层之上）。
   *
   * ── 为什么绘制复用 drawMinimap，而不是再写一套 ──
   * 附 2 的改动面表写明：另起一套绘制 / 缓存会让 BUG-042② 的"签名失效链路"漏掉一处
   * （金币数 / 主题 / 色盲 / 尺寸任一变化都会有一边不刷新）。所以最大化只换
   * "主画布 + 离屏缓存 + 逻辑尺寸 + dpr"这四样，绘制函数仍是同一个
   * drawMinimapStatic / drawMinimap：用 withMapFullTarget() 把模块级目标变量临时切过去，
   * 画完立刻换回来。好处是两边永远同一套失效逻辑；代价是这里必须**严格成对**地保存 / 还原
   * （用 try/finally 保证，中途抛异常也不会把 HUD 的目标状态搞脏）。
   * ---------------------------------------------------------- */

  /** 最大化态的 dpr 上限（设计 M4 采纳 Q12 的 ②：1.5× 在这个尺寸下已足够锐利，内存约省一半） */
  var MAP_FULL_DPR_CAP = 1.5;
  /** 最大化地图距视口边缘的留白（12px + 安全区），与设计 M2 的公式一致 */
  var MAP_FULL_MARGIN = 12;
  /** 正方形边长下限：极窄视口 / 无布局环境下兜底，避免算出 0 或负数 */
  var MAP_FULL_MIN_SIZE = 120;

  /** 最大化地图是否处于打开状态（画面的唯一判据；DOM 的 hidden 只是它的投影） */
  var mapFullOpen = false;
  /** 最大化地图的渲染目标（打开时创建、收起时置 null；null = 当前没有占着画布资源） */
  var mapFullTarget = null;

  /* ------------------------------------------------------------
   * 最大化地图的缩放 / 拖动平移（用户 2026-11-15 口径）
   * ------------------------------------------------------------
   * 只作用在最大化地图上：HUD 小地图的 mapViewZoom/Pan 恒为 1/0/0（见 drawMinimap 的
   * viewZoomed 分支），所以"小地图保持现状"是结构性保证，不靠额外判断。
   * 数学口径：屏幕(逻辑px) = 地图坐标 × zoom + pan，zoom ∈ [1, 8]。
   * 为什么下限是 1（不做缩小）：① 用户口径写的就是 1×~8×；② 1× 时整张图刚好填满
   * 内接正方形，再缩小只剩一圈黑边，没有信息增益。
   * ---------------------------------------------------------- */
  /** 最小 / 最大缩放倍数（用户口径 1×~8×） */
  var MAP_FULL_MIN_ZOOM = 1;
  var MAP_FULL_MAX_ZOOM = 8;
  /**
   * 离屏静态缓存的像素比上限（2）。
   * ── 取舍（任务书要求给出实测数字，见 harness/perf-zoom-verify.js 的输出）──
   * 缓存越大越清晰，但内存是它的平方：以 1080p 桌面（dpr=1、size≈1056）为例，
   *   cacheDpr=1 → 1056²≈1.1M px ≈ 4.5MB
   *   cacheDpr=2 → 2112²≈4.5M px ≈ 17.8MB（+13.3MB）
   * 主画布另有 1056²×1.5²（dpr 上限 1.5）≈2.5M px ≈ 10MB，两者合计约 28MB 封顶。
   * 为什么不按 dpr×zoom 无限提：8× 且 dpr=1.5 时需要 12×，16608² ≈ 276M px ≈ 1.1GB —— 直接爆。
   * 所以在 2 处封顶，8× 时是"缓存像素被放大 6 倍"（dpr1.5×8/2），属刻意的清晰度/内存折中，
   * 真机观感需人工确认（报告里如实标注）。
   */
  var MAP_FULL_CACHE_DPR_CAP = 2;
  /**
   * 提升缓存分辨率的门槛倍数。
   * zoom < 2 时缓存与主画布同分辨率（内存与改造前**完全一致**，零回归）；
   * zoom ≥ 2 才提到 min(2, dpr×zoom)。配合上限 2，实际只有两档（dpr 与 2），
   * 于是"一次捏合 1×→8×"期间静态层最多重绘 1 次（跨过 2× 那一刻），
   * 而不是每变一点倍数就重绘一次 121×121 的整层（那会让捏合直接卡住）。
   */
  var MAP_FULL_CACHE_TIER_ZOOM = 2;
  /**
   * 判定"这是拖动、不是点击"的位移阈值（逻辑 px）。
   * 为什么需要它：点击地图本体 = 收起是既有口径，若不区分，
   * "想拖动地图"的每一次松手都会把地图关掉，拖动就完全不可用。
   * 取 6px：大于手指/鼠标的常见抖动（约 1~3px），又明显小于"有意拖动"。
   */
  var MAP_FULL_DRAG_SLOP = 6;

  /** 当前缩放倍数（仅最大化地图；HUD 小地图不受影响） */
  var mapFullZoom = 1;
  /** 当前平移量（逻辑 px；屏幕 = 地图坐标×zoom + pan） */
  var mapFullPanX = 0;
  var mapFullPanY = 0;
  /** 手势进行中的多指状态（null = 空闲；详见 bindMapFullGestures） */
  var mapGesture = null;
  /**
   * 是否吞掉"下一次点击地图本体"的收起动作。
   * 为什么需要：拖动 / 捏合松手后浏览器必定补发一次 click（触摸与鼠标都如此），
   * 不挡掉就会"每拖一次地图就自己合上"。松手时置位，click 消费后或下一次
   * pointerdown 时清除（不依赖 click 一定到达：手势被 pointercancel 打断也不会残留误判）。
   */
  var mapSuppressCloseClick = false;


  /** 收集最大化地图层的 DOM 引用（init() 已按 id 缓存过，这里只是收拢成一组方便传） */
  function mapFullRefs() {
    return {
      layer: el['map-full'],
      inner: el['map-full-inner'],
      canvas: el['map-full-canvas'],
      closeBtn: el['btn-map-full-close'],
      zoomBadge: el['map-full-zoom']
    };
  }

  /** 最大化地图当前是否开着（供 main.js 的 ESC 链 / 生命周期钩子判定） */
  function isMapFullOpen() { return mapFullOpen; }

  /**
   * 读一个安全区变量。--safe-* 由 CSS 定义为 env(safe-area-inset-*, 0px)，
   * Chrome 109 在计算值阶段会把它求值成 px；取值失败（老内核 / 无布局环境）按 0 处理 ——
   * 桌面与绝大多数手机本来就是 0，不会因为读不到而算错。
   */
  function readSafeInset(name) {
    var v = '';
    try { v = window.getComputedStyle(document.body).getPropertyValue(name); } catch (e) { v = ''; }
    var px = parseCssPx(v);
    return px > 0 ? px : 0;
  }

  /**
   * 计算最大化正方形的边长（px）。
   * 设计口径：`size = min(100vw, 100vh) − 2×(12px + 安全区)`。
   * 这里按"横 / 纵分别扣各自的安全区"展开，更严谨且与一般式等价：
   *   可用宽 = vw − 2×(12 + max(safe-l, safe-r))
   *   可用高 = vh − 2×(12 + max(safe-t, safe-b))
   *   取两者较小值 → 内接正方形；安全区为 0 时就是 min(vw, vh) − 24（与文档一致）。
   * 正方形之外的留白是**预期现象**（用户已确认可接受），也是留白穿透滑视角的作用区。
   */
  function computeMapFullSize() {
    var vw = window.innerWidth || 0;
    var vh = window.innerHeight || 0;
    var insetH = Math.max(readSafeInset('--safe-l'), readSafeInset('--safe-r'));
    var insetV = Math.max(readSafeInset('--safe-t'), readSafeInset('--safe-b'));
    var availW = vw - 2 * (MAP_FULL_MARGIN + insetH);
    var availV = vh - 2 * (MAP_FULL_MARGIN + insetV);
    var size = Math.min(availW, availV);
    if (!isFinite(size) || size <= MAP_FULL_MARGIN) size = MAP_FULL_MIN_SIZE;
    return Math.max(MAP_FULL_MIN_SIZE, Math.round(size));
  }

  /** 新建最大化渲染目标：主画布 + 同尺寸的离屏静态缓存（结构与 HUD 小地图完全一样） */
  function createMapFullTarget(canvas) {
    var t = {
      canvas: canvas,
      ctx: canvas.getContext('2d'),
      size: 0,
      dpr: 1,
      // 离屏静态缓存的像素比（可高于 dpr：放大时提清晰度用；由 applyMapFullCacheResolution 维护）
      cacheDpr: 1,
      cacheCanvas: document.createElement('canvas'),
      cacheCtx: null,
      // 缓存失效状态：语义与文件头的 mapCache* 一致，只是挂到目标对象上（两套目标互不干扰）
      dirty: true,
      signature: '',
      exploredCount: -1
    };
    t.cacheCtx = t.cacheCanvas.getContext('2d');
    return t;
  }

  /**
   * 按 dpr 与当前倍数决定离屏静态缓存的像素比。
   * 两档设计（见 MAP_FULL_CACHE_TIER_ZOOM 的说明），返回值恒 ≥ dpr：
   *   zoom < 2  → dpr        （与主画布同分辨率，内存与改造前一致）
   *   zoom ≥ 2  → min(2, dpr×zoom)
   * @param {number} dpr 主画布像素比（已受 MAP_FULL_DPR_CAP 限制）
   * @param {number} zoom 当前缩放倍数
   * @returns {number} 缓存应使用的像素比
   */
  function mapFullCacheDprFor(dpr, zoom) {
    if (!(zoom >= MAP_FULL_CACHE_TIER_ZOOM)) return dpr;
    var want = dpr * zoom;
    if (want > MAP_FULL_CACHE_DPR_CAP) want = MAP_FULL_CACHE_DPR_CAP;
    return want > dpr ? want : dpr;
  }

  /**
   * 把离屏缓存的画布尺寸 / 变换对齐到 t.size × t.cacheDpr；真的变了才重设并作废缓存。
   * 为什么必须单独成一个函数：设置 canvas.width/height 会**清空画布并重置 2D 上下文状态**，
   * 所以"分辨率没变就绝对不要碰它"，否则每次捏合都会白清一次 121×121 的静态层。
   * @returns {boolean} 本次是否真的重建了缓存画布
   */
  function applyMapFullCacheResolution(t) {
    if (!t || !t.cacheCanvas) return false;
    var want = mapFullCacheDprFor(t.dpr, mapFullZoom);
    t.cacheDpr = want;
    var px = Math.round(t.size * want);
    if (t.cacheCanvas.width === px && t.cacheCanvas.height === px) return false;
    t.cacheCanvas.width = px;
    t.cacheCanvas.height = px;
    if (t.cacheCtx) t.cacheCtx.setTransform(want, 0, 0, want, 0, 0);
    // 分辨率 / 尺寸变了：静态缓存内容作废（签名里虽含尺寸，这里是显式作废，不要省）
    t.dirty = true;
    t.signature = '';
    t.exploredCount = -1;
    return true;
  }

  /**
   * 按当前视口重算最大化地图的尺寸与 dpr，并重设画布（含离屏缓存）。
   * main.js 在 resize / orientationchange 时调用；直接再调一次 openMapFull() 也可以（幂等）。
   * @returns {number} 本次使用的逻辑边长（px）；当前没有目标时返回 0
   */
  function resizeMapFull() {
    if (!mapFullTarget) return 0;
    var refs = mapFullRefs();
    var size = computeMapFullSize();
    // dpr 上限压到 1.5（M4）：1080p 下画布从 2128²≈4.5M 像素降到 1596²≈2.5M，主画布 + 缓存两份都省一半
    var dpr = Math.min(window.devicePixelRatio || 1, MAP_FULL_DPR_CAP);
    var t = mapFullTarget;
    /* 规格（用户 2026-11-15）：resize 也把缩放 / 平移归零。
       理由：窗口 / 转屏一变，"内接正方形"的边长就变了，原来的平移量按旧边长算，
       留着会让画面偏到一角，玩家会以为地图画错了。openMapFull 是幂等的
       （已开着时只调 resizeMapFull），所以"打开时重置"由这里一并覆盖。 */
    resetMapFullView();
    if (t.size !== size || t.dpr !== dpr) {
      t.size = size;
      t.dpr = dpr;
      /* 设置 width/height 会**重置 2D 上下文状态**（变换、样式），所以紧接着必须重设变换。
         缓存画布不在这里处理：它还要看缩放倍数（cacheDpr），统一交给
         applyMapFullCacheResolution()，避免两处各写一遍尺寸公式。 */
      if (t.canvas) {
        t.canvas.width = Math.round(size * dpr);
        t.canvas.height = Math.round(size * dpr);
      }
      if (t.ctx) t.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    applyMapFullCacheResolution(t);
    // 显示尺寸交给 CSS：canvas 内部是 size×dpr 像素，由 CSS 缩到 size 逻辑像素
    if (refs.inner) {
      refs.inner.style.width = size + 'px';
      refs.inner.style.height = size + 'px';
    }
    return size;
  }

  /** 把缩放 / 平移归零（1×、pan=0）并同步徽标；**不触发重绘**（时机由调用方决定） */
  function resetMapFullView() {
    mapFullZoom = MAP_FULL_MIN_ZOOM;
    mapFullPanX = 0;
    mapFullPanY = 0;
    updateMapFullZoomBadge();
  }

  /**
   * 把平移钳在地图范围内。屏幕 = 地图坐标×zoom + pan，地图在屏幕上的边长 = size×zoom（≥size），
   * 要求地图始终**铺满**视口：pan ∈ [size×(1−zoom), 0]。
   * zoom=1 时该区间退化成 [0,0] → 平移必然为 0：
   * "1× 时平移归零"是数学结果，不是额外写的一条判断（少一处可能漏改的口径）。
   * 为什么必须钳：不钳就能把地图拖出屏幕只剩空白，玩家会以为图丢了；缩放锚点在边界处
   * 也需要一个确定的回弹行为。
   */
  function clampMapFullView() {
    var size = mapFullTarget ? mapFullTarget.size : 0;
    if (!size) return;
    var minPan = size * (1 - mapFullZoom);
    if (mapFullPanX > 0) mapFullPanX = 0;
    if (mapFullPanX < minPan) mapFullPanX = minPan;
    if (mapFullPanY > 0) mapFullPanY = 0;
    if (mapFullPanY < minPan) mapFullPanY = minPan;
  }

  /** 倍数显示（口径 ④：角落显示当前倍数，如 2.4×；1× 时也显示 1.0×） */
  function updateMapFullZoomBadge() {
    var node = el['map-full-zoom'];
    if (!node) return;
    var txt = (Math.round(mapFullZoom * 10) / 10).toFixed(1) + '×';
    if (node.textContent !== txt) node.textContent = txt;
  }

  /** 立刻用最近一次小地图参数重画一帧（缩放 / 平移是纯绘制变换，改完必须马上可见） */
  function redrawMapFullNow() {
    if (!mapFullOpen) return;
    drawMapFullFromLastArgs();
  }

  /**
   * 直接设定视图：钳制 → 同步徽标 → 按需重建缓存分辨率 → 立即重绘。
   * 三个公开操作（setMapFullView / zoomMapFullAt / panMapFullBy）都收敛到这里，
   * 保证"改视图"只有一条路径，不会出现"某处改了倍数但忘了重建缓存 / 忘了刷新徽标"。
   * @param {number} zoom 目标倍数（钳到 1~8）
   * @param {number} panX 目标平移（逻辑 px，钳到地图范围内）
   * @param {number} panY
   * @returns {Object} 生效后的 {zoom,panX,panY}
   */
  function setMapFullView(zoom, panX, panY) {
    var z = Number(zoom);
    if (!isFinite(z)) z = mapFullZoom;
    if (z < MAP_FULL_MIN_ZOOM) z = MAP_FULL_MIN_ZOOM;
    if (z > MAP_FULL_MAX_ZOOM) z = MAP_FULL_MAX_ZOOM;
    mapFullZoom = z;
    mapFullPanX = isFinite(panX) ? Number(panX) : 0;
    mapFullPanY = isFinite(panY) ? Number(panY) : 0;
    clampMapFullView();
    updateMapFullZoomBadge();
    // 倍数跨过 2× 时才真的重建缓存（内部用画布尺寸比对，没变就一个像素都不碰）
    if (mapFullTarget) applyMapFullCacheResolution(mapFullTarget);
    redrawMapFullNow();
    return { zoom: mapFullZoom, panX: mapFullPanX, panY: mapFullPanY };
  }

  /**
   * 以 (ax, ay) 为锚点缩放（逻辑 px，相对画布左上角）。
   * 锚点不动的推导：锚点下的地图坐标 m = (a − pan)/z，缩放后仍在同一屏幕位置，即
   *   a = m×z' + pan'  ⟹  pan' = a − (a − pan)×(z'/z)
   * 若 z' 被钳到 1 / 8、或 pan 被 clampMapFullView 钳到边界，锚点会随之偏移 ——
   * 这是"不许把地图拖出屏幕"的必然代价，也是主流地图应用的一致行为。
   * @param {number} factor 倍数增量（>1 放大，<1 缩小），新倍数 = 当前 × factor
   * @param {number} ax 锚点 x（逻辑 px）
   * @param {number} ay 锚点 y（逻辑 px）
   * @returns {Object} 生效后的 {zoom,panX,panY}
   */
  function zoomMapFullAt(factor, ax, ay) {
    var f = Number(factor);
    if (!isFinite(f) || f <= 0) return { zoom: mapFullZoom, panX: mapFullPanX, panY: mapFullPanY };
    var z0 = mapFullZoom;
    var z1 = z0 * f;
    if (z1 < MAP_FULL_MIN_ZOOM) z1 = MAP_FULL_MIN_ZOOM;
    if (z1 > MAP_FULL_MAX_ZOOM) z1 = MAP_FULL_MAX_ZOOM;
    if (z1 === z0) return { zoom: mapFullZoom, panX: mapFullPanX, panY: mapFullPanY };
    var ratio = z1 / z0;
    /* 锚点缺失 / 非数值时退化为"以画布中心为锚点"，而不是让 NaN 顺着公式污染整个视图
       （一次坏事件就让地图永久画不出来，是这类手势代码最典型的线上事故）。 */
    var px = isFinite(ax) ? Number(ax) : mapSize / 2;
    var py = isFinite(ay) ? Number(ay) : mapSize / 2;
    return setMapFullView(z1, px - (px - mapFullPanX) * ratio, py - (py - mapFullPanY) * ratio);
  }

  /**
   * 平移（逻辑 px；正数 = 内容往右下移动，与手指/鼠标同向）。
   * @param {number} dx
   * @param {number} dy
   * @returns {Object} 生效后的 {zoom,panX,panY}
   */
  function panMapFullBy(dx, dy) {
    var ddx = isFinite(dx) ? Number(dx) : 0;
    var ddy = isFinite(dy) ? Number(dy) : 0;
    if (ddx === 0 && ddy === 0) return { zoom: mapFullZoom, panX: mapFullPanX, panY: mapFullPanY };
    return setMapFullView(mapFullZoom, mapFullPanX + ddx, mapFullPanY + ddy);
  }

  /**
   * 只读快照（供测试 / 排错用）。**不要**拿它当写入口：改视图只有
   * setMapFullView / zoomMapFullAt / panMapFullBy 三条路（都做了钳制与缓存维护）。
   */
  function getMapFullView() {
    return {
      open: mapFullOpen,
      zoom: mapFullZoom,
      panX: mapFullPanX,
      panY: mapFullPanY,
      size: mapFullTarget ? mapFullTarget.size : 0,
      dpr: mapFullTarget ? mapFullTarget.dpr : 0,
      cacheDpr: mapFullTarget ? mapFullTarget.cacheDpr : 0,
      cacheW: (mapFullTarget && mapFullTarget.cacheCanvas) ? mapFullTarget.cacheCanvas.width : 0
    };
  }

  /**
   * 在"最大化目标"上执行 fn：把模块级渲染目标临时切到 t，画完立刻还原。
   * 为什么可以这么做：HUD 小地图与最大化地图**不会同时绘制** ——
   * 两者都由 main.js 的同一个 120ms 节流串行调用，切换期间不存在并发。
   * 必须成对处理的 13 个变量：画布 / 上下文 / 逻辑尺寸 / 缓存 dpr / 主画布 dpr /
   * 缩放 / 平移 x / 平移 y / 离屏缓存 / 其上下文 / 脏标记 / 签名 / 探索计数。
   * minimapResizePending 也要换掉：否则 drawMinimap 会走"量 HUD 容器"的 resize 分支，
   * 把最大化画布按 HUD 尺寸改掉 —— 最大化尺寸只由 resizeMapFull() 全权负责。
   */
  function withMapFullTarget(t, fn) {
    var save = {
      ctx: mapCtx, size: mapSize, dpr: mapCacheDpr, viewDpr: mapViewDpr,
      zoom: mapViewZoom, panX: mapViewPanX, panY: mapViewPanY,
      cacheCanvas: mapCacheCanvas, cacheCtx: mapCacheCtx,
      dirty: mapCacheDirty, signature: mapCacheSignature,
      exploredCount: mapCacheExploredCount, resizePending: minimapResizePending
    };
    mapCtx = t.ctx;
    mapSize = t.size;
    mapCacheDpr = t.cacheDpr || t.dpr;
    mapViewDpr = t.dpr;
    /* 缩放 / 平移在这里"注入"渲染目标：手势状态是模块级的 mapFullZoom/Pan，
       只有最大化目标才把它装进绘制变换。HUD 绘制时 mapViewZoom 恒为 1、pan 恒为 0，
       所以 HUD 那条分支与改造前逐像素一致。 */
    mapViewZoom = mapFullZoom;
    mapViewPanX = mapFullPanX;
    mapViewPanY = mapFullPanY;
    mapCacheCanvas = t.cacheCanvas;
    mapCacheCtx = t.cacheCtx;
    mapCacheDirty = t.dirty;
    mapCacheSignature = t.signature;
    mapCacheExploredCount = t.exploredCount;
    minimapResizePending = false;
    try {
      fn();
    } finally {
      // 先把目标里的最新缓存状态收回去，再还原 HUD —— 顺序不能反（反了会把 HUD 状态写进目标）
      t.dirty = mapCacheDirty;
      t.signature = mapCacheSignature;
      t.exploredCount = mapCacheExploredCount;
      mapCtx = save.ctx;
      mapSize = save.size;
      mapCacheDpr = save.dpr;
      mapViewDpr = save.viewDpr;
      mapViewZoom = save.zoom;
      mapViewPanX = save.panX;
      mapViewPanY = save.panY;
      mapCacheCanvas = save.cacheCanvas;
      mapCacheCtx = save.cacheCtx;
      mapCacheDirty = save.dirty;
      mapCacheSignature = save.signature;
      mapCacheExploredCount = save.exploredCount;
      minimapResizePending = save.resizePending;
    }
  }

  /**
   * 当前是否允许**打开**最大化地图（入口判据）。三条一起卡：
   *   ① 必须在 playing 态：paused / win / replay / menu / loading 都可能已经被 .screen 盖满
   *      （暂停菜单、胜利界面、回放条），此时打开地图玩家根本看不到它，
   *      却会吃掉一次 ESC / V（"按了没反应"的观感）。而"最大化期间被暂停"是允许的
   *      （道具面板会 pause）—— 那属于**已经开着**的情况，不受本判据约束，
   *      收起走 closeMapFull / toggleMapFull，它们只看 mapFullOpen。
   *      设计 M3 也要求进 win / replay 等状态时自动收起（main.js 的钩子），这里再兜一层；
   *   ② 已解锁小地图（mapFound）：未拾取地图卷轴前不允许最大化 ——
   *      不能靠最大化绕过解锁，否则会泄露终点与剩余距离（BUG-022 的既有口径）；
   *   ③ 玩家自己没把小地图关掉：与 #btn-minimap 的开关语义保持一致。
   */
  function canOpenMapFull() {
    var g = MG.game;
    if (!g) return false;
    if (g.state !== 'playing') return false;
    if (!g.mapFound) return false;
    if (S && S.get && !S.get().minimap) return false;
    return true;
  }

  /** 退出指针锁定：光标被锁时点不到地图与关闭按钮（与道具面板同款处理，BUG-019 一族） */
  function exitPointerLockForMap() {
    try {
      // ui.js 不反向依赖 main.js：只走 Game.input 这个既有出口；拿不到时退回标准 DOM API
      if (MG.game && MG.game.input && MG.game.input.exitPointerLock) {
        MG.game.input.exitPointerLock();
        return;
      }
      if (document.exitPointerLock) document.exitPointerLock();
    } catch (e) { /* 忽略：iOS 等没有 Pointer Lock 的环境本来就没有锁定态 */ }
  }

  /**
   * 打开最大化地图。**幂等**：已经打开时只重算尺寸并返回 true
   *（resize / orientationchange 钩子可以直接再调一次，不必先判断状态）。
   * @returns {boolean} 调用后是否处于打开状态
   */
  function openMapFull() {
    if (mapFullOpen) {
      resizeMapFull();
      return true;
    }
    if (!canOpenMapFull()) return false;
    bindMapFull();                       // 幂等（内部 done 标记）；也覆盖 init 时元素尚未就绪的极端情况
    var refs = mapFullRefs();
    if (!refs.layer || !refs.canvas) return false;  // DOM 缺失：宁可不开，也不留一个点不到的层
    mapFullTarget = createMapFullTarget(refs.canvas);
    mapFullOpen = true;                  // 先置状态再显示 DOM：resizeMapFull / draw 都读这个标记
    refs.layer.classList.remove('hidden');
    /* 口径 ⑥：换关 / 重新打开一律从 1× 开始。
       resizeMapFull() 里也会重置一次（它要处理"已开着时窗口 resize"的情形），
       这里显式再写一次是为了让"打开 = 1×"在本函数里就近可读、不依赖下游函数的副作用。 */
    resetMapFullView();
    resizeMapFull();
    exitPointerLockForMap();
    // 立刻用最近一次小地图参数补画一帧（同一局内才画），避免"打开瞬间空白"的闪烁
    drawMapFullFromLastArgs();
    return true;
  }

  /**
   * 收起最大化地图（幂等）。**不碰 state / 计时 / 输入** —— 这是"非模态"的核心：
   * 收起只做三件事：隐藏层、释放画布、作废缓存。
   * @returns {boolean} 调用后是否处于关闭状态（恒 true，便于调用方链式判断）
   */
  function closeMapFull() {
    if (!mapFullOpen && !mapFullTarget) return true;
    var refs = mapFullRefs();
    if (refs.layer) refs.layer.classList.add('hidden');
    mapFullOpen = false;
    /* 释放最大化画布：把 width/height 归零，浏览器的后备存储随之释放（M4 的内存口径）；
       缓存画布同样归零 —— 只丢引用的话，部分内核里后备存储可能在 GC 之前一直占着。 */
    if (mapFullTarget) {
      try {
        if (mapFullTarget.canvas) { mapFullTarget.canvas.width = 0; mapFullTarget.canvas.height = 0; }
        if (mapFullTarget.cacheCanvas) { mapFullTarget.cacheCanvas.width = 0; mapFullTarget.cacheCanvas.height = 0; }
      } catch (e) { /* 忽略：归零失败不影响收起 */ }
      mapFullTarget = null;
    }
    // 按交付口径：收起时缩回并作废相关缓存，避免常驻内存 / 残留上一局的旧签名
    resetMinimapCache();
    /* 口径 ⑥：收起后缩放 / 平移必须归零（下次打开是 1× 的整图）。
       同时清掉进行中的手势：ESC / V 可以在手指按着的瞬间收起地图，
       残留的指针状态会让"下次打开"的第一下拖动从一个莫名其妙的基准开始。 */
    resetMapFullView();
    mapGesture = null;
    return true;
  }

  /** 开合切换 @returns {boolean} 切换后的打开状态（true = 现在开着） */
  function toggleMapFull() {
    if (mapFullOpen) {
      closeMapFull();
      return false;
    }
    openMapFull();
    return mapFullOpen;
  }

  /** 用最近一次 drawMinimap 的参数补画一帧（只在同一局内；原因见 lastMapArgs 的说明） */
  function drawMapFullFromLastArgs() {
    if (!mapFullOpen || !lastMapArgs || !MG.game) return;
    /* 对象身份校验：buildLevel 会重建 maze 与 player。不做这个判断的话，
       "上一局的地图参数"会在新一局打开最大化的瞬间被画出来 —— 比空白更糟（画的是错的迷宫）。 */
    if (MG.game.maze !== lastMapArgs.maze || MG.game.player !== lastMapArgs.player) return;
    drawMinimapFull(lastMapArgs.player, lastMapArgs.maze, lastMapArgs.mazeView, lastMapArgs.settings);
  }

  /**
   * 绘制最大化地图（由 main.js 在既有的 120ms 小地图节流里调用；**ui.js 不开新定时器**）。
   * 未打开时是空操作，所以调用方不必先判断 isMapFullOpen()。
   * @param {Object} player 玩家（提供 getGrid / explored / yaw / autoPath）
   * @param {Object} maze 迷宫（size / grid / start / end）
   * @param {Object} mazeView 迷宫视图（coins / remainCoins）
   * @param {Object} settings 当前设置（minimap / theme / colorblind / minimapCoins）
   */
  function drawMinimapFull(player, maze, mazeView, settings) {
    if (!mapFullOpen || !mapFullTarget) return;
    /* 防御：小地图被关掉 / 掉回未解锁态时自己收起 ——
       否则会留一个"永远不刷新"的深色方块盖在画面上。
       （正常路径下 main.js 的钩子会先收起，这里只是兜底，两者不冲突） */
    if (!settings || !settings.minimap || (MG.game && !MG.game.mapFound)) {
      closeMapFull();
      return;
    }
    if (!player || !maze || !mapFullTarget.size) return;
    var t = mapFullTarget;
    withMapFullTarget(t, function () {
      drawMinimap(player, maze, mazeView, settings);
    });
  }

  /** 绑定最大化地图层的交互（幂等：点击收起 + 关闭按钮 + 缩放 / 拖动平移手势） */
  function bindMapFull() {
    if (bindMapFull.done) return;
    bindMapFull.done = true;
    var refs = mapFullRefs();
    if (refs.inner) {
      /* 点地图本体 = 收起（用户口径：再点地图关、点留白不关）。
         "点留白不关"在 CSS 层就决定了：容器 pointer-events:none，留白的事件落不到这里。
         ⚠ 2026-11-15 起必须与拖动区分：拖动 / 捏合松手时浏览器会补发一次 click，
           不挡掉的话"每拖一次地图就自己关上"，拖动功能等于不可用。 */
      refs.inner.addEventListener('click', function (e) {
        if (e.target === refs.closeBtn) return;   // 关闭按钮自己处理，避免同一次点击走两遍
        if (mapSuppressCloseClick) {               // 本次手势是拖动 / 捏合：消费掉这次合成 click
          mapSuppressCloseClick = false;
          return;
        }
        playClick();
        closeMapFull();
      });
    }
    if (refs.closeBtn) {
      refs.closeBtn.addEventListener('click', function (e) {
        // 阻止冒泡到 .map-full-inner，否则同一次点击会再触发一次"点地图收起"（重复音效）
        if (e.stopPropagation) e.stopPropagation();
        playClick();
        closeMapFull();
      });
    }
    bindMapFullGestures(refs);
  }

  /**
   * 缩放 / 拖动平移的 PointerEvent 手势（口径 ②③）。
   *
   * 为什么用 PointerEvent 而不是 touch* + mouse*：
   *   ① 一套代码同时覆盖触摸、鼠标、触控笔（Chrome 109 全支持 PointerEvent）；
   *   ② 多指天然用 pointerId 区分，不需要维护 touches 列表；
   *   ③ 与既有 input.js 的 touch 管理**互不干扰**：本层在地图方块上，
   *      事件目标不是 #look-layer，那边绑在 look-layer 上的 touchstart/move
   *      收不到（兄弟节点不冒泡），所以不会出现"拖地图顺带转视角"。
   * 为什么绑在这一个元素上就够：#map-full-inner 是地图方块本身（pointer-events:auto），
   * 方块之外是穿透区（pointer-events:none），口径 ⑦"点留白不关、还能滑视角"完全不受影响。
   *
   * 手势语义：
   *   · 1 指 / 鼠标左键拖动 → 平移（与手指同向）；
   *   · ≥2 指 → 捏合缩放（两指间距比例 → 倍数；锚点 = 两指中点）＋ 中点位移 → 平移；
   *   · 位移超过 MAP_FULL_DRAG_SLOP 或发生过捏合 → 松手后的合成 click 不关地图。
   *
   * @param {Object} refs mapFullRefs() 的结果
   */
  function bindMapFullGestures(refs) {
    var inner = refs.inner;
    if (!inner || !inner.addEventListener) return;

    /** 事件坐标 → 画布逻辑坐标（左上角原点，单位 = 逻辑 px） */
    function localPoint(evt) {
      var size = mapFullTarget ? mapFullTarget.size : 0;
      var rect = null;
      try {
        rect = (refs.canvas && refs.canvas.getBoundingClientRect) ? refs.canvas.getBoundingClientRect() : null;
      } catch (e) { rect = null; }
      /* 有布局信息就按真实矩形归一化（canvas 的 CSS 尺寸与逻辑尺寸 size 一致）。
         取不到布局（无头环境 rect 全 0）时退化为"事件坐标即逻辑坐标"：
         只影响锚点/阈值的精度，不影响功能正确性，也绝不让手势抛异常。 */
      if (rect && rect.width > 0 && rect.height > 0 && size > 0) {
        return {
          x: (evt.clientX - rect.left) / rect.width * size,
          y: (evt.clientY - rect.top) / rect.height * size
        };
      }
      return { x: Number(evt.clientX) || 0, y: Number(evt.clientY) || 0 };
    }

    /** 取出参与捏合的前两根手指（对象里整数键按数值升序枚举，等价于"最早按下的两根"） */
    function firstTwoPoints(g) {
      var out = [];
      for (var id in g.points) {
        if (!Object.prototype.hasOwnProperty.call(g.points, id)) continue;
        out.push(g.points[id]);
        if (out.length === 2) break;
      }
      return out;
    }

    /** 用当前两指位置刷新捏合基准（新手指按下 / 双指变单指时都要调，否则倍率会跳） */
    function refreshPinchBase(g) {
      var pts = firstTwoPoints(g);
      if (pts.length < 2) { g.lastDist = 0; return; }
      var dx = pts[1].x - pts[0].x;
      var dy = pts[1].y - pts[0].y;
      g.lastDist = Math.sqrt(dx * dx + dy * dy);
      g.lastCx = (pts[0].x + pts[1].x) / 2;
      g.lastCy = (pts[0].y + pts[1].y) / 2;
    }

    function onDown(evt) {
      if (!mapFullOpen) return;
      // 鼠标只认左键：右键 / 中键不参与平移（右键另有 contextmenu 被全局屏蔽）
      if (evt.pointerType === 'mouse' && evt.button !== 0) return;
      if (!mapGesture) {
        mapGesture = {
          points: {}, count: 0,
          lastX: 0, lastY: 0, startX: 0, startY: 0,
          lastDist: 0, lastCx: 0, lastCy: 0, moved: false
        };
      }
      var g = mapGesture;
      var p = localPoint(evt);
      var pid = (evt.pointerId === undefined || evt.pointerId === null) ? 'p' + g.count : evt.pointerId;
      if (!g.points[pid]) { g.points[pid] = { x: p.x, y: p.y }; g.count++; }
      else { g.points[pid].x = p.x; g.points[pid].y = p.y; }
      if (g.count === 1) {
        // 新手势开始：清掉上一次的"拖动过"标记，否则一次拖动之后的第一次真点击会被吞掉
        g.moved = false;
        mapSuppressCloseClick = false;
        g.lastX = g.startX = p.x;
        g.lastY = g.startY = p.y;
        g.lastDist = 0;
      } else {
        g.moved = true;            // 双指一定不是"点击地图收起"
        refreshPinchBase(g);
      }
      /* 指针捕获：手指/鼠标滑出地图方块后仍能收到 move / up。
         否则拖到边缘就会"断线"，松手时收不到 up，手势状态永远卡住。
         无头环境 / 老内核没有这个 API 时静默跳过（不影响基本拖拽）。 */
      try { if (inner.setPointerCapture) inner.setPointerCapture(evt.pointerId); } catch (e) { /* 忽略 */ }
      if (evt.cancelable) evt.preventDefault();
    }

    function onMove(evt) {
      var g = mapGesture;
      if (!g) return;
      var pid = (evt.pointerId === undefined || evt.pointerId === null) ? null : evt.pointerId;
      var slot = null;
      if (pid !== null && g.points[pid]) slot = g.points[pid];
      else {
        // 没有 pointerId 的桩事件（老内核 / 测试）：单指时按"唯一的那根"处理
        var pts = firstTwoPoints(g);
        if (pts.length === 1) slot = pts[0];
      }
      if (!slot) return;
      var p = localPoint(evt);
      slot.x = p.x;
      slot.y = p.y;

      if (g.count >= 2) {
        /* ---------- 双指：捏合缩放 + 中点平移（合成一次 setMapFullView，只重绘一次） ---------- */
        var two = firstTwoPoints(g);
        if (two.length < 2) return;
        var ddx = two[1].x - two[0].x;
        var ddy = two[1].y - two[0].y;
        var d = Math.sqrt(ddx * ddx + ddy * ddy);
        var cx = (two[0].x + two[1].x) / 2;
        var cy = (two[0].y + two[1].y) / 2;
        if (g.lastDist > 0 && d > 0) {
          var z0 = mapFullZoom;
          var z1 = z0 * (d / g.lastDist);
          if (z1 < MAP_FULL_MIN_ZOOM) z1 = MAP_FULL_MIN_ZOOM;
          if (z1 > MAP_FULL_MAX_ZOOM) z1 = MAP_FULL_MAX_ZOOM;
          var ratio = z1 / z0;
          /* 先按中点位移平移、再以**新中点**为锚点缩放，两步合成一个 pan 值：
             这样一次事件只重绘一次（分开调 pan/zoom 会白重绘一次）。
             锚点公式与 zoomMapFullAt 完全一致：pan' = a − (a − pan)×ratio。 */
          var panAfterMoveX = mapFullPanX + (cx - g.lastCx);
          var panAfterMoveY = mapFullPanY + (cy - g.lastCy);
          setMapFullView(
            z1,
            cx - (cx - panAfterMoveX) * ratio,
            cy - (cy - panAfterMoveY) * ratio
          );
        }
        g.lastDist = d;
        g.lastCx = cx;
        g.lastCy = cy;
        g.moved = true;
        if (evt.cancelable) evt.preventDefault();
        return;
      }

      /* ---------- 单指 / 鼠标左键：拖动平移 ---------- */
      var dx = p.x - g.lastX;
      var dy = p.y - g.lastY;
      g.lastX = p.x;
      g.lastY = p.y;
      /* 用"相对手势起点的累计位移"判拖动，而不是本次事件的增量：
         真实设备上一次 move 的增量往往只有 1~3px，拿它跟 6px 阈值比会永远判不出拖动。 */
      var movedX = p.x - g.startX;
      var movedY = p.y - g.startY;
      if (!g.moved && (movedX * movedX + movedY * movedY) > (MAP_FULL_DRAG_SLOP * MAP_FULL_DRAG_SLOP)) {
        g.moved = true;
      }
      if (dx !== 0 || dy !== 0) panMapFullBy(dx, dy);
      if (evt.cancelable) evt.preventDefault();
    }

    function endPointer(evt) {
      var g = mapGesture;
      if (!g) return;
      var pid = (evt.pointerId === undefined || evt.pointerId === null) ? null : evt.pointerId;
      if (pid !== null && g.points[pid]) {
        delete g.points[pid];
        g.count--;
      } else {
        // 无 id 的桩事件：整只指针抬起（单指情形）
        g.points = {};
        g.count = 0;
      }
      try { if (inner.releasePointerCapture) inner.releasePointerCapture(evt.pointerId); } catch (e) { /* 忽略 */ }
      if (g.count <= 0) {
        g.count = 0;
        // 拖动 / 捏合过 → 让紧随其后的合成 click 不关地图（flag 在下一次 pointerdown 时清）
        if (g.moved) mapSuppressCloseClick = true;
        mapGesture = null;
        return;
      }
      /* 双指变单指：把剩下的那根手指的基准重置到它**当前**位置，
         否则下一帧会按"从上一根手指的位置"算出一个巨大的 delta，画面猛跳一下。 */
      g.lastDist = 0;
      refreshPinchBase(g);
      var pts = firstTwoPoints(g);
      if (pts.length === 1) { g.lastX = pts[0].x; g.lastY = pts[0].y; }
      g.moved = true;
    }

    inner.addEventListener('pointerdown', onDown);
    inner.addEventListener('pointermove', onMove);
    inner.addEventListener('pointerup', endPointer);
    inner.addEventListener('pointercancel', endPointer);
  }

  /* ------------------------------------------------------------
   * 记录 / 成就渲染
   * ---------------------------------------------------------- */
  var DIFF_NAMES = { simple: '简单', medium: '中等', hard: '困难' };

  function refreshRecords() {
    if (!el['best-records']) return;
    var rec = S.loadRecords();
    var html = '';
    var keys = ['simple', 'medium', 'hard'];
    for (var i = 0; i < keys.length; i++) {
      var r = rec[keys[i]];
      /* 只认"对象且步数是有限数"的条目：
         ① 存档可能被外部改写（导出/导入、手改 localStorage），steps 里塞 HTML 会在
            每次进主菜单时被 innerHTML 执行 —— 排行榜那侧早就做了 escapeHtml，这里是唯一漏网的；
         ② 结构不对时渲染成 'undefined 步' 也不好看。 */
      if (r && typeof r === 'object' && isFinite(r.steps)) {
        html += '<li><span>' + DIFF_NAMES[keys[i]] + '</span><b>' +
          formatTime(r.time) + ' · ' + escapeHtml(r.steps) + ' 步</b></li>';
      } else {
        html += '<li><span>' + DIFF_NAMES[keys[i]] + '</span><b>—</b></li>';
      }
    }
    el['best-records'].innerHTML = html;
  }

  function refreshAchievements() {
    if (!el['achievements-list']) return;
    var got = S.loadAchievements();
    var list = S.ACHIEVEMENTS;
    var html = '';
    var unlocked = 0;
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      var has = !!got[a.id];
      if (has) unlocked++;
      html += '<li class="' + (has ? 'done' : '') + '"><span>' +
        (has ? iconHtml('check') + ' ' : iconHtml('lock') + ' ') + a.name + '</span><b>' + a.desc + '</b></li>';
    }
    html += '<li><span>总进度</span><b>' + unlocked + ' / ' + list.length + '</b></li>';
    el['achievements-list'].innerHTML = html;
  }

  /* ------------------------------------------------------------
   * Toast 提示
   * ---------------------------------------------------------- */
  var toastTimer = null;
  /**
   * @param {string} msg 提示文本
   * @param {number} [duration] 毫秒，默认 1800
   * @param {boolean} [asHtml] 为 true 时按 HTML 解析（仅供内部拼接内联 SVG 图标使用；
   *   默认 false 走 textContent，这样含种子的提示不会被当成标签）
   */
  function toast(msg, duration, asHtml) {
    var node = el['toast'];
    if (!node) return;
    if (asHtml) node.innerHTML = msg;
    else node.textContent = msg;
    node.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      node.classList.remove('show');
    }, duration || 1800);
  }

  /* ------------------------------------------------------------
   * 全屏
   * ---------------------------------------------------------- */
  /* BUG-030（2026-11-07）：原实现是"先弹 toast 再去试"——
     toast('已进入全屏') 紧跟在 requestFullscreen 之后无条件执行，而失败路径上
     promise 的 reject 挂的是空 handler、同步异常又被 try/catch 整个吞掉。
     于是浏览器拒绝进入全屏时，玩家看到的是「已进入全屏」这句假话 + 画面毫无变化，
     表现就是"全屏图标点了没反应、也没有任何解释"。
     现在三条腿一起兜：
       ① 根本没有对应 API → 直接说明；
       ② 同步异常 / promise reject → 给出失败原因；
       ③ 只有 fullscreenchange 才算成功，另有 900ms 兜底（老内核既无 promise、
          也可能不派发事件）。 */
  var fsStateKnown = null;   // 上一次已知的全屏状态，用于给重复事件去重
  var fsToggleSeq = 0;       // 每次请求全屏/退出全屏自增，用来作废过期的兜底定时器
  /* 最近一次请求的目标状态，以及它是否已被 fullscreenchange 确认达成。
     用途：900ms 兜底不能用"此刻状态 == 请求前状态"判定（BUG-042②），但只按"目标状态
     是否达成"判定也不够 —— 进全屏成功后 900ms 内按 ESC / F11 / 系统手势退出，此刻状态
     恰好不等于目标，仍会被判成"进入全屏失败"。这里把"事件确认过目标状态"记下来，
     只要达成过就算本次请求成功，之后再退出全屏也不误报。 */
  var fsPendingWant = null;
  var fsPendingReached = false;

  /** 记录本次请求的目标状态（在真正发起请求前置位） */
  function markFullscreenPending(want) {
    fsPendingWant = want;
    fsPendingReached = false;
  }

  function fullscreenElement() {
    var doc = document;
    return doc.fullscreenElement || doc.webkitFullscreenElement || null;
  }

  function onFullscreenChange() {
    var on = !!fullscreenElement();
    // 目标状态一旦被事件确认，本次请求即算成功（之后退出全屏不再算"请求失败"）
    if (fsPendingWant !== null && on === fsPendingWant) fsPendingReached = true;
    if (on === fsStateKnown) return;   // 两种事件可能都派发，同一状态只提示一次
    fsStateKnown = on;
    toast(on ? '已进入全屏' : '已退出全屏');
  }

  function bindFullscreenChange() {
    if (bindFullscreenChange.done) return;
    bindFullscreenChange.done = true;
    try {
      document.addEventListener('fullscreenchange', onFullscreenChange);
      document.addEventListener('webkitfullscreenchange', onFullscreenChange);
    } catch (e) { /* 忽略：实在不支持就只能靠 900ms 兜底 */ }
  }

  function toggleFullscreen() {
    var doc = document;
    var elem = doc.documentElement;
    bindFullscreenChange();

    var wantFull = !fullscreenElement();   // 本次请求的**目标状态**
    var seq = ++fsToggleSeq;
    var settled = false;

    function fail(err) {
      if (settled) return;
      settled = true;
      var why = err ? String(err.message || err.name || '') : '';
      var head = wantFull ? '进入全屏失败' : '退出全屏失败';
      // 退出方向给 F11 是误导（element 全屏下 F11 通常不生效），按方向给不同兜底
      var tip = wantFull ? '，可先点一下页面再试，或按 F11' : '，可再点一次按钮或按 ESC';
      toast(why ? (head + '：' + why) : (head + tip), 2600);
    }

    try {
      var ret;
      if (wantFull) {
        var reqFn = elem.requestFullscreen || elem.webkitRequestFullscreen;
        if (!reqFn) { toast('当前浏览器不支持全屏', 2600); return; }
        markFullscreenPending(wantFull);
        ret = reqFn.call(elem);
      } else {
        var exitFn = doc.exitFullscreen || doc.webkitExitFullscreen;
        if (!exitFn) { toast('当前浏览器不支持退出全屏', 2600); return; }
        markFullscreenPending(wantFull);
        ret = exitFn.call(doc);
      }
      if (ret && typeof ret['catch'] === 'function') ret['catch'](fail);
    } catch (e) {
      fail(e);
      return;
    }

    setTimeout(function () {
      if (settled) return;
      /* 过期作废：900ms 内又点了一次按钮，判定依据已经不成立（fsToggleSeq 已自增）。
         再按「目标状态是否达成」判定：达成过（fsPendingReached，由 fullscreenchange 确认）
         或此刻仍是目标状态都算成功；只有从未达成才报失败。 */
      if (seq !== fsToggleSeq) return;
      if (fsPendingReached || !!fullscreenElement() === wantFull) settled = true;
      else fail(null);
    }, 900);
  }

  /* ------------------------------------------------------------
   * 工具
   * ---------------------------------------------------------- */
  /**
   * 时间格式化：<60s → "12.3s"；<1h → "3m 5.2s"；≥1h → "1h 6m"
   * 超长局（挂机 / 调试注入超大 elapsed）不再撑破版面
   */
  function formatTime(seconds) {
    if (typeof seconds !== 'number' || !isFinite(seconds)) return '—';
    var s = Math.floor(seconds * 10) / 10;
    if (s < 60) return s.toFixed(1) + 's';
    if (s < 3600) {
      var m = Math.floor(s / 60);
      return m + 'm ' + (s - m * 60).toFixed(1) + 's';
    }
    var h = Math.floor(s / 3600);
    var mm = Math.floor((s - h * 3600) / 60);
    return h + 'h ' + mm + 'm';
  }

  /** 数字千分位格式化：99999 → "99,999" */
  function formatNum(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /**
   * 超大数字紧凑格式化（防止溢出 HUD / 商店卡片 / 道具面板）
   * 999 → "999"；1234 → "1.2k"；12345 → "1.2w"；123456789 → "1.2亿"
   */
  function formatCompactNum(n) {
    n = Number(n) || 0;
    if (n < 1000) return String(n);
    if (n < 10000) return (n / 1000).toFixed(1) + 'k';
    if (n < 1e8) return (n / 10000).toFixed(1) + 'w';
    return (n / 1e8).toFixed(1) + '亿';
  }

  function closestWithClass(node, cls) {
    var t = node;
    while (t && t !== document.body) {
      if (t.classList && t.classList.contains(cls)) return t;
      t = t.parentNode;
    }
    return null;
  }

  function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
        return;
      }
    } catch (e) { /* 继续降级 */ }
    // 降级：临时 textarea
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e) { /* 忽略 */ }
  }

  /** HTML 转义（排行榜种子等内容防注入） */
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      // 用具名实体 &quot; 等价于 \x26quot;（\x26 = &），可读性更好
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function playClick() {
    if (MG.Audio && S.get().sfx) MG.Audio.click();
  }

  /** 获取当前选中的难度 */
  function getSelectedDiff() { return selectedDiff; }
  function setSelectedDiff(key) {
    selectedDiff = key;
    if (!el['diff-list']) return;
    var all = el['diff-list'].querySelectorAll('.diff-card');
    for (var i = 0; i < all.length; i++) {
      if (all[i].dataset.diff === key) all[i].classList.add('selected');
      else all[i].classList.remove('selected');
    }
  }
  function setSeed(seed) {
    if (el['seed-input']) el['seed-input'].value = seed || '';
  }

  /* ------------------------------------------------------------
   * 导出
   * ---------------------------------------------------------- */
  MG.UI = {
    el: el,
    icon: icon,
    iconHtml: iconHtml,
    fillIcons: fillIcons,
    init: init,
    show: show,
    hide: hide,
    hideAllScreens: hideAllScreens,
    showMainMenu: showMainMenu,
    showGame: showGame,
    showPause: showPause,
    hidePause: hidePause,
    backFromOverlay: backFromOverlay,
    showLoading: showLoading,
    setLoadingProgress: setLoadingProgress,
    showSettings: showSettings,
    closeSettings: closeSettings,
    isSettingsOpen: isSettingsOpen,
    isOverlayOpen: isOverlayOpen,
    /* BUG-071（2026-11-20）：设置面板控件回写。
       main.js 的 onSettingChanged() 在「性能模式」把 quality/shadows 级联改成 low/关之后，
       靠它把面板上的画质下拉与阴影开关同步成生效值；此前这里漏了导出，
       main.js 里 `if (MG.UI.syncSettingsUI)` 的守卫永远短路（不报错、什么也不发生），
       表现为"面板里一开性能模式，画质仍显示高、阴影仍显示开"。 */
    syncSettingsUI: syncSettingsUI,
    showWin: showWin,
    updateHud: updateHud,
    drawMinimap: drawMinimap,
    refreshRecords: refreshRecords,
    refreshAchievements: refreshAchievements,
    toast: toast,
    toggleFullscreen: toggleFullscreen,
    formatTime: formatTime,
    formatNum: formatNum,
    formatCompactNum: formatCompactNum,
    getSelectedDiff: getSelectedDiff,
    setSelectedDiff: setSelectedDiff,
    setSeed: setSeed,
    applyThemeToBody: applyThemeToBody,
    applyMinimapSizeToBody: applyMinimapSizeToBody,
    refreshMinimapSize: refreshMinimapSize,
    // 小地图锁定 / 排行榜 / 回放
    updateMinimapLock: updateMinimapLock,
    resetMinimapCache: resetMinimapCache,
    // 最大化地图（M2/M3，2026-11-15）—— 生命周期由 main.js 接线：
    //   ESC 链最前面 closeMapFull；buildLevel/backToMenu/onVictory/startReplay 自动收起；
    //   resize/orientationchange 调 resizeMapFull；120ms 节流里调 drawMinimapFull。
    openMapFull: openMapFull,
    closeMapFull: closeMapFull,
    toggleMapFull: toggleMapFull,
    isMapFullOpen: isMapFullOpen,
    resizeMapFull: resizeMapFull,
    drawMinimapFull: drawMinimapFull,
    /* 缩放 / 拖动平移（2026-11-15，只作用于最大化地图）：
       get 是只读快照；set / zoomAt / panBy 是三个**唯一**的写入口（内部统一钳制、
       维护缓存分辨率、刷新倍数徽标、立即重绘）。手势代码与测试都走它们，
       避免"某一处改了倍数却忘了配套动作"。 */
    getMapFullView: getMapFullView,
    setMapFullView: setMapFullView,
    zoomMapFullAt: zoomMapFullAt,
    panMapFullBy: panMapFullBy,
    refreshRanking: refreshRanking,
    openRanking: openRanking,
    openAchievements: openAchievements,
    showReplayBar: showReplayBar,
    hideReplayBar: hideReplayBar,
    updateReplayBar: updateReplayBar,
    setReplayViewLabel: setReplayViewLabel,
    // 商店 / 道具面板 / 幽灵弹窗
    openShop: openShop,
    refreshShop: refreshShop,
    showItemPanel: showItemPanel,
    hideItemPanel: hideItemPanel,
    renderItemPanel: renderItemPanel,
    showGhostDialog: showGhostDialog,
    cancelGhostDialog: cancelGhostDialog,
    applyDistanceVisibility: applyDistanceVisibility,
    // 回调注入
    menuCallbacks: menuCallbacks,
    hudCallbacks: hudCallbacks,
    pauseCallbacks: pauseCallbacks,
    winCallbacks: winCallbacks,
    settingsCallbacks: settingsCallbacks,
    replayCallbacks: replayCallbacks,
    itemCallbacks: itemCallbacks
  };

})(window);
