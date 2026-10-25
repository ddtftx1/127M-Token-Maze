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
   * 画一次后整张贴到主画布，每帧只重绘动态元素（玩家 / 终点呼吸光 / 寻路路径 / 边框）。
   * 困难难度 31×31 = 961 格 × 2 次遍历，原先每 120ms 全量重扫一遍，低端机掉帧。
   */
  var mapCacheCanvas = null;
  var mapCacheCtx = null;
  var mapCacheDpr = 1;
  /** 缓存有效性标记：置 false 后下一次 drawMinimap 会重绘缓存 */
  var mapCacheDirty = true;
  /** 上次重绘缓存时的玩家格子坐标 */
  var mapCacheCellX = -1;
  var mapCacheCellY = -1;
  /** 上次重绘缓存时的探索标记数量（变化说明新区域被探索） */
  var mapCacheExploredCount = -1;
  /** 上次重绘缓存时的静态内容签名（难度/主题/色盲/金币设置变化时失效） */
  var mapCacheSignature = '';

  /** 强制小地图缓存在下一次绘制时重绘（主题 / 色盲 / 金币设置 / 重新开局时调用） */
  function invalidateMinimapCache() {
    mapCacheDirty = true;
  }

  /**
   * 重置小地图缓存状态（每局开始时调用）
   * 清空"上次格坐标 / 探索计数 / 签名"，避免上一局的统计与签名让新一局误判为"缓存有效"
   */
  function resetMinimapCache() {
    mapCacheDirty = true;
    mapCacheCellX = -1;
    mapCacheCellY = -1;
    mapCacheExploredCount = -1;
    mapCacheSignature = '';
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
      'joystick', 'joystick-knob', 'btn-items', 'btn-cancel-path', 'toast',
      'pause-menu', 'btn-resume', 'btn-restart', 'btn-settings-pause', 'btn-menu',
      'settings-panel', 'set-fov', 'val-fov', 'set-sensitivity', 'val-sensitivity',
      'set-invert-yaw', 'set-invert-pitch', 'set-speed', 'val-speed',
      'set-quality-select', 'set-shadows', 'set-fog', 'set-minimap-toggle', 'set-minimap-state',
      'set-minimap-coins',
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

    clockEl = { t: 0 };

    bindSettingsPanel();
    bindMainMenu();
    bindHudButtons();
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
    refreshRecords();
    refreshAchievements();
  }

  /* ------------------------------------------------------------
   * 屏幕切换
   * ---------------------------------------------------------- */
  function show(id) {
    var node = document.getElementById(id);
    if (node) node.classList.remove('hidden');
  }
  function hide(id) {
    var node = document.getElementById(id);
    if (node) node.classList.add('hidden');
  }
  function hideAllScreens() {
    var screens = ['main-menu', 'loading-screen', 'pause-menu', 'settings-panel', 'win-screen', 'ranking-screen', 'achievement-screen', 'shop-screen', 'item-panel', 'ghost-modal', 'secret-modal', 'replay-bar'];
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
      show('main-menu');
    }
  }

  /** 设置面板当前是否可见（供 ESC / P 键判断是否需要优先关闭它，BUG-016） */
  function isSettingsOpen() {
    var node = el['settings-panel'];
    return !!(node && !node.classList.contains('hidden'));
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
    if (el['win-coins']) el['win-coins'].textContent = '+' + (data.coinsEarned || 0) + ' 💰';
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
        el['win-ranking'].textContent = '🏅 进入排行榜第 ' + data.rank + ' 名';
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
        el['seed-input'].value = MG.Maze.randomSeed();
        playClick();
      });
    }
    // 复制种子
    if (el['btn-seed-copy']) {
      el['btn-seed-copy'].addEventListener('click', function () {
        var v = el['seed-input'].value || '（空）';
        copyText(el['seed-input'].value || '');
        toast('已复制种子：' + v);
        playClick();
      });
    }
    // 每日挑战
    if (el['btn-daily']) {
      el['btn-daily'].addEventListener('click', function () {
        var seed = MG.Maze.dailySeed();
        el['seed-input'].value = seed;
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
        var seed = (el['seed-input'].value || '').trim();
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
        hide('ranking-screen');
        showMainMenu();
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
        hide('achievement-screen');
        showMainMenu();
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
      var autoTxt = r.auto ? '⚡ 自动寻路' : '徒步';
      var sub = autoTxt + ' · 种子 ' + (r.seed || '—') + ' · ' + (r.date || '');
      html += '<li><span class="rk-rank' + rankCls + '">' + (k + 1) + '</span>' +
        '<span class="rk-info"><b>' + formatTime(r.time) + ' · ' + r.steps + ' 步</b>' +
        '<em>' + escapeHtml(sub) + '</em></span></li>';
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
      el['btn-replay-pause'].textContent = playing ? '⏸ 暂停' : (atEnd ? '↻ 重播' : '▶ 继续');
    }
  }

  function setReplayViewLabel(isFollow) {
    if (el['btn-replay-view']) el['btn-replay-view'].textContent = isFollow ? '🎥 跟随' : '🗺 全景';
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
        hide('shop-screen');
        showMainMenu();
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
        '<div class="shop-icon">' + it.icon + '</div>' +
        '<div class="shop-info">' +
          '<div class="shop-name">' + it.name + '</div>' +
          '<div class="shop-desc">' + it.desc + '</div>' +
          '<div class="shop-meta">' + ownedText + '</div>' +
        '</div>' +
        '<div class="shop-buy">' +
          '<div class="shop-price">' + it.price + ' 💰</div>' +
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
    }
    refreshShop();
  }

  /* ------------------------------------------------------------
   * 隐藏彩蛋：长按"商店"按钮 / 商店界面标题 → 问答输入框（答案区分大小写）
   * - 短按商店：正常打开商店
   * - 长按约 0.5 秒：震动反馈并立即弹窗（无需等松开）
   * - 答对"deepseek"奖励 99,999 金币；答对"AdroitHare8579"奖励全道具 +99,999
   *   （两份奖励均可重复获取、可累积；道具不做上限截断）
   * ---------------------------------------------------------- */
  /** 彩蛋答案表（区分大小写）：每个答案对应一份奖励（可重复获取） */
  var SECRET_ANSWERS = {
    'deepseek': 'coins',        // 奖励①：+99,999 金币（可重复）
    'AdroitHare8579': 'items'   // 奖励②：各道具 +99,999（可累积；金币收益仅按一次买断）
  };
  var SECRET_HOLD_MS = 480;     // 长按阈值：达到即弹窗（低于浏览器原生长按手势，避免被抢占）
  var secretAwaitRelease = false; // 弹窗打开后按压尚未结束（等"松开"来吞掉合成点击）
  var secretAwaitTimer = null;  // 松开等待的兜底计时器
  var secretClickGuardUntil = 0; // 防护窗口：忽略"松开"瞬间合成的点击（时间戳）

  /** 是否处于"松开合成点击"防护窗口内 */
  function isSecretClickGuarded() {
    return Date.now() < secretClickGuardUntil;
  }

  /** 打开彩蛋输入框 */
  function openSecretDialog() {
    if (!el['secret-modal']) return;
    if (el['secret-input']) el['secret-input'].value = '';
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
    if (el['secret-input']) {
      setTimeout(function () {
        try { el['secret-input'].focus(); } catch (e) { /* 忽略 */ }
      }, 60);
    }
  }

  /** 关闭彩蛋输入框（不发放奖励） */
  function closeSecretDialog() {
    secretAwaitRelease = false;
    if (secretAwaitTimer) { clearTimeout(secretAwaitTimer); secretAwaitTimer = null; }
    if (el['secret-input']) {
      try { el['secret-input'].blur(); } catch (e) { /* 忽略 */ }
    }
    hide('secret-modal');
  }

  /** 提交答案：命中答案表即发放对应奖励（可重复获取，每次答对都发放） */
  function submitSecretAnswer() {
    if (!el['secret-input'] || !MG.Shop) return;
    var answer = (el['secret-input'].value || '').trim();
    if (!answer) return; // 空输入直接忽略（也避免"松开合成点击"误触确认按钮）
    // hasOwnProperty 校验，防止 'toString' 等原型链键被误判为正确
    var rewardKey = Object.prototype.hasOwnProperty.call(SECRET_ANSWERS, answer)
      ? SECRET_ANSWERS[answer] : null;
    if (rewardKey) {
      if (rewardKey === 'coins') {
        MG.Shop.claimSecretGift();
        if (MG.Audio && S.get().sfx) MG.Audio.purchase();
        toast('🎉 答对了！奖励 ' + formatNum(MG.Shop.SECRET_GIFT_COINS || 99999) + ' 金币已到账');
      } else if (rewardKey === 'items') {
        MG.Shop.claimSecretItemGift();
        if (MG.Audio && S.get().sfx) MG.Audio.purchase();
        toast('🎉 答对了！所有道具 +' + formatNum(MG.Shop.SECRET_GIFT_ITEM_COUNT || 99999) +
          ' 已到账（可累积，金币收益为一次买断）');
      }
      closeSecretDialog();
      refreshShop(); // 同步商店余额 / 道具显示
    } else {
      if (MG.Audio && S.get().sfx) MG.Audio.error();
      toast('答案不对，再想想～');
    }
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
      var n = MG.Shop.countOf(it.id);
      if (n <= 0) continue;
      html += '<li class="item-row">' +
        '<span class="item-icon">' + it.icon + '</span>' +
        '<span class="item-name">' + (it.short || it.name) + '</span>' +
        '<span class="item-count">×' + formatCompactNum(n) + '</span>' +
        '<button class="mini-btn item-use-btn" data-use-id="' + it.id + '">使用</button>' +
      '</li>';
    }
    if (!html) {
      html = '<li class="item-empty">暂无道具，去主菜单的「🏪 商店」看看吧</li>';
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

    // 下拉框
    bindSelect('set-quality-select', 'quality');
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

    setValue('set-quality-select', s.quality);
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
      el['stat-wallet'].textContent = (wc >= 1e8 ? formatCompactNum(wc) : formatNum(wc)) + ' 💰';
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
        btn.textContent = n > 0 ? '🎒道具 ×' + formatCompactNum(n) : '🎒道具';
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

    // 已探索通路
    ctx.fillStyle = 'rgba(60,110,160,0.45)';
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        if (maze.grid[y * size + x] === 0 && player.explored[y * size + x]) {
          ctx.fillRect(x * cellPx, y * cellPx, cellPx + 0.6, cellPx + 0.6);
        }
      }
    }

    // 探索到的墙体（用稍亮的颜色画出边界感）
    ctx.fillStyle = 'rgba(120,180,240,0.18)';
    for (var wy = 0; wy < size; wy++) {
      for (var wx = 0; wx < size; wx++) {
        if (maze.grid[wy * size + wx] === 1 && player.explored[wy * size + wx]) {
          ctx.fillRect(wx * cellPx, wy * cellPx, cellPx + 0.6, cellPx + 0.6);
        }
      }
    }

    // 金币：默认只显示已探索区域的实心点；
    // 开启「小地图显示全部金币」后，未探索区域的金币用半透明轮廓提示位置
    // （轮廓 vs 实心，明确区分"知道位置"与"亲自探索过"）
    var showAllCoins = !!(settings && settings.minimapCoins);
    if (mazeView && mazeView.coins) {
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
    // 未找到地图道具前不绘制内容（占位由 updateMinimapLock 负责）
    if (MG.game && !MG.game.mapFound) return;
    var cb = !!settings.colorblind; // 色盲友好模式：颜色 + 形状双编码
    var size = maze.size;
    var cellPx = mapSize / size;

    /* ---------- 1) 缓存失效判定 ---------- */
    var pgd = player.getGrid();
    var exploredCount = countExplored(player.explored, size * size);
    // 静态内容签名：难度（size）/ 主题配色 / 色盲模式 / 金币显示设置 任一变化都要重绘缓存
    var signature = size + '|' + (settings.theme || '') + '|' + (cb ? 1 : 0) + '|' +
      (settings.minimapCoins ? 1 : 0) + '|' + mapSize;
    if (signature !== mapCacheSignature) {
      mapCacheSignature = signature;
      mapCacheDirty = true;
    }
    // 玩家跨格移动 或 探索标记数量变化 → 缓存需要重绘
    if (pgd.x !== mapCacheCellX || pgd.y !== mapCacheCellY ||
        exploredCount !== mapCacheExploredCount) {
      mapCacheDirty = true;
    }

    /* ---------- 2) 必要时重绘缓存 ---------- */
    if (mapCacheDirty || !mapCacheCanvas) {
      drawMinimapStatic(player, maze, mazeView, settings);
      mapCacheDirty = false;
      mapCacheCellX = pgd.x;
      mapCacheCellY = pgd.y;
      mapCacheExploredCount = exploredCount;
    }

    /* ---------- 3) 缓存整张贴到主画布（一次 drawImage） ---------- */
    mapCtx.setTransform(1, 0, 0, 1, 0, 0);
    mapCtx.clearRect(0, 0, mapCacheCanvas.width, mapCacheCanvas.height);
    if (mapCacheCanvas) {
      mapCtx.drawImage(mapCacheCanvas, 0, 0);
    }
    // 之后的动态绘制回到逻辑像素坐标系
    mapCtx.setTransform(mapCacheDpr, 0, 0, mapCacheDpr, 0, 0);

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

    // 玩家（三角，指示朝向）—— 复用上面缓存失效判定时已算出的当前格
    var px = pgd.x * cellPx + cellPx / 2;
    var py = pgd.y * cellPx + cellPx / 2;
    mapCtx.save();
    mapCtx.translate(px, py);
    // yaw=0 时朝向 -Z（地图上方），换算成 canvas 角度
    mapCtx.rotate(-player.yaw);
    mapCtx.beginPath();
    mapCtx.moveTo(0, -cellPx * 0.55);
    mapCtx.lineTo(cellPx * 0.38, cellPx * 0.45);
    mapCtx.lineTo(-cellPx * 0.38, cellPx * 0.45);
    mapCtx.closePath();
    if (cb) {
      // 色盲：橙色三角 + 白色粗描边，尖端再补一个小箭头强调朝向
      mapCtx.fillStyle = '#ff9f40';
      mapCtx.fill();
      mapCtx.strokeStyle = '#ffffff';
      mapCtx.lineWidth = Math.max(1.5, cellPx * 0.16);
      mapCtx.stroke();
      mapCtx.beginPath();
      mapCtx.moveTo(0, -cellPx * 0.95);
      mapCtx.lineTo(-cellPx * 0.16, -cellPx * 0.66);
      mapCtx.lineTo(cellPx * 0.16, -cellPx * 0.66);
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
      if (r) {
        html += '<li><span>' + DIFF_NAMES[keys[i]] + '</span><b>' +
          formatTime(r.time) + ' · ' + r.steps + ' 步</b></li>';
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
        (has ? '✅ ' : '🔒 ') + a.name + '</span><b>' + a.desc + '</b></li>';
    }
    html += '<li><span>总进度</span><b>' + unlocked + ' / ' + list.length + '</b></li>';
    el['achievements-list'].innerHTML = html;
  }

  /* ------------------------------------------------------------
   * Toast 提示
   * ---------------------------------------------------------- */
  var toastTimer = null;
  function toast(msg, duration) {
    var node = el['toast'];
    if (!node) return;
    node.textContent = msg;
    node.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      node.classList.remove('show');
    }, duration || 1800);
  }

  /* ------------------------------------------------------------
   * 全屏
   * ---------------------------------------------------------- */
  function toggleFullscreen() {
    var doc = document;
    var elem = doc.documentElement;
    var isFull = doc.fullscreenElement || doc.webkitFullscreenElement;
    try {
      if (!isFull) {
        var p = (elem.requestFullscreen || elem.webkitRequestFullscreen || function () {}).call(elem);
        if (p && p.catch) p.catch(function () {});
        toast('已进入全屏');
      } else {
        (doc.exitFullscreen || doc.webkitExitFullscreen || function () {}).call(doc);
        toast('已退出全屏');
      }
    } catch (e) { /* 忽略 */ }
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
    init: init,
    show: show,
    hide: hide,
    showMainMenu: showMainMenu,
    showGame: showGame,
    showPause: showPause,
    hidePause: hidePause,
    showLoading: showLoading,
    setLoadingProgress: setLoadingProgress,
    showSettings: showSettings,
    closeSettings: closeSettings,
    isSettingsOpen: isSettingsOpen,
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
    // 小地图锁定 / 排行榜 / 回放
    updateMinimapLock: updateMinimapLock,
    resetMinimapCache: resetMinimapCache,
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