/* ============================================================
 * js/main.js
 * 主程序
 * - Three.js 渲染器 / 场景 / 相机 / 灯光 初始化
 * - 游戏状态机（菜单 → 加载 → 游戏中 → 暂停 → 胜利）
 * - requestAnimationFrame + Clock(deltaTime) 驱动游戏循环
 * - 自动寻路次数 / 冷却管理
 * - 胜利判定、记录提交、成就解锁
 * - 设置实时生效（FOV / 雾 / 阴影 / 画质 / 主题 / 音量）
 * - 移动端像素比限制、自动性能适配
 * ============================================================ */
(function (global) {
  'use strict';

  var MG = global.MG = global.MG || {};
  var THREE = global.THREE;

  /* ------------------------------------------------------------
   * 游戏全局对象
   * ---------------------------------------------------------- */
  var Game = {
    state: 'menu',        // menu | loading | playing | paused | win | replay
    renderer: null,
    scene: null,
    camera: null,
    clock: null,
    player: null,
    maze: null,           // 迷宫数据 {grid,size,start,end,...}
    mazeView: null,       // 3D 视图
    input: null,
    diff: null,           // 当前难度配置
    diffKey: 'simple',
    seed: '',
    elapsed: 0,           // 本局用时（秒）
    usedAutoPath: false,  // 本局是否用过自动寻路
    collectedCoins: 0,
    isDaily: false,
    // 本局小地图是否已解锁。注意：拾取地图卷轴只把 mapUnlock 放进背包，
    // 必须由玩家在道具面板里主动使用后才置 true（2026-10-30 设计变更）
    mapFound: false,
    mapHint: '',          // 简单难度的地图方位提示（其他难度为空）
    recorder: null,       // 回放记录器
    ghost: null,          // 幽灵模型（上一次同难度+同种子的挑战）
    ghostFrames: null,    // 幽灵路径帧
    _pendingGhost: null,  // 幽灵弹窗确认后暂存的待加载帧
    itemPanelOpen: false, // 道具面板是否打开（打开时游戏暂停）
    replayData: null,     // 当前回放帧
    replayGhost: null,    // 回放幽灵模型
    replayT: 0,           // 回放进度（秒）
    replayPlaying: false, // 回放是否播放中
    replayView: 'follow', // 回放视角：follow | top
    ambient: null,
    sun: null,
    _hudAccum: 0,
    _portalAccum: 0,      // 传送门环境音触发节流
    _startPending: false,
    _achieveToastTimer: null, // 通关后延迟弹出成就提示的定时器（离开本局时清理）
    _pendingAchieveToast: null, // 待播报的成就名（定时器被取消时由 backToMenu / buildLevel 补发）
    _renderStopped: false, // 渲染致命错误后停止循环
    _ctxLost: false,      // WebGL 上下文是否已丢失（恢复流程见 bindContextLoss / handleContextLost）
    /* BUG-066（2026-11-14）：菜单态"脏标记按需渲染"的开关。
       初值 true —— 开机后第一帧必须真的画一次，否则画布是黑的（此时还没人置过脏标记）。
       之后只有"画面真的需要变"的地方才会置 true，见 markSceneDirty() 的调用点。 */
    _sceneDirty: true,
    /* 长帧探针（只读诊断，见 loop() 里 PERF_WINDOW_MS 那段）。
       给玩家一个"真机上到底卡不卡"的可观测数字：滑完菜单开开发者面板「环境」页就能看到。 */
    perf: { frames: 0, longFrames: 0, lastFrames: 0, lastLongFrames: 0, windowStart: 0 }
  };

  /** 暴露给 player.js 使用（路径可视化需要 scene） */
  MG.game = Game;

  /**
   * 回放"跟随视角"复用的射线检测器。
   * 原实现每帧 new THREE.Raycaster，回放期间会持续产生可回收对象（GC 抖动），
   * 这里只保留一个实例，每帧用 set() 换射线、重置 near/far（BUG-027）。
   */
  var replayRaycaster = null;

  /* ------------------------------------------------------------
   * 渲染器 / 场景 / 灯光 初始化
   * ---------------------------------------------------------- */
  function initThree() {
    var canvas = MG.UI.el['game-canvas'];
    var settings = MG.Settings.get();

    var renderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas: canvas,
        antialias: settings.quality === 'high',
        powerPreference: 'high-performance',
        alpha: false,
        stencil: false
      });
    } catch (e) {
      fatal('WebGL 初始化失败', '您的浏览器或设备可能不支持 WebGL，请更换浏览器后重试。');
      return false;
    }

    setupRenderer(renderer, settings);
    // 记录"当前渲染器实际是用哪一档画质建的"，供 onSettingChanged 判断是否需要重建
    Game._appliedQuality = settings.quality;
    // WebGL 上下文丢失 / 恢复：切后台被系统回收、GPU 进程重启等场景的兜底（BUG-029）
    bindContextLoss(canvas);

    var scene = new THREE.Scene();
    scene.background = new THREE.Color(MG.Maze.THEMES[settings.theme].sky);

    var camera = new THREE.PerspectiveCamera(
      settings.fov,
      window.innerWidth / window.innerHeight,
      0.05,
      400
    );
    camera.rotation.order = 'YXZ';

    Game.renderer = renderer;
    Game.scene = scene;
    Game.camera = camera;
    Game.clock = new THREE.Clock();

    // 光源：半球光 + 平行光（阴影）
    setupLights(scene, settings);

    // 窗口尺寸变化
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', function () {
      setTimeout(onResize, 260);
    });

    return true;
  }

  /** 套用渲染器设置（初始化、上下文恢复、换画布重建三处共用，避免逻辑漂移） */
  function setupRenderer(renderer, settings) {
    // 像素比：移动端限制，避免过热掉帧
    var maxDPR = settings.quality === 'high' ? 2 : (settings.quality === 'low' ? 1 : 1.5);
    var dpr = Math.min(window.devicePixelRatio || 1, maxDPR);
    renderer.setPixelRatio(dpr);
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.shadowMap.enabled = !!settings.shadows;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // 颜色/色调映射：让暗部细节更自然
    if ('outputColorSpace' in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
  }

  /** 画质档位的中文名（提示文案用） */
  function qualityLabel(q) {
    return q === 'low' ? '低' : (q === 'high' ? '高' : '中');
  }

  /**
   * 画质相关的光照档位（BUG-033）。
   * setupLights() 只在初始化时跑一次，切画质时太阳强度与阴影贴图尺寸要在这里补。
   * 阴影贴图一旦分配，尺寸就固定了：必须丢弃 map，让下一次渲染按新尺寸重新分配。
   */
  function applyQualityToSun(settings) {
    if (!Game.sun) return;
    var low = settings.quality === 'low';
    Game.sun.intensity = low ? 0.7 : 1.1;
    var size = low ? 512 : 1024;
    if (Game.sun.shadow.mapSize.width !== size || Game.sun.shadow.mapSize.height !== size) {
      Game.sun.shadow.mapSize.width = size;
      Game.sun.shadow.mapSize.height = size;
      if (Game.sun.shadow.map) {
        if (Game.sun.shadow.map.dispose) Game.sun.shadow.map.dispose();
        Game.sun.shadow.map = null;
      }
    }
  }

  /**
   * 按当前设置重建渲染器（BUG-033）。
   *
   * antialias 是 WebGL 上下文创建参数，**创建之后无法修改**；桌面端
   * devicePixelRatio 恒为 1，maxDPR 三档又完全等价。所以"低 / 中 / 高"
   * 想在桌面上真正看出来，就必须换一张画布 + 新渲染器。
   * 场景 / 相机 / 迷宫 / 玩家位置都与渲染器无关，直接复用 → 本局进度不丢。
   *
   * 与 recreateRenderer() 的分工：那个是 WebGL 上下文丢失后的救援流程
   * （带 _ctxLost 守卫、走 overlay 提示层）；这里是设置变更触发的主动重建，
   * 两者互不干扰。
   *
   * @returns {boolean} 是否重建成功
   */
  function rebuildRenderer() {
    if (!Game.scene || !Game.camera) return false;
    var oldCanvas = MG.UI.el['game-canvas'];
    var parent = oldCanvas && oldCanvas.parentNode;
    if (!parent) return false;

    var settings = MG.Settings.get();
    var newCanvas = document.createElement('canvas');
    newCanvas.id = 'game-canvas';
    var renderer = null;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas: newCanvas,
        antialias: settings.quality === 'high',
        powerPreference: 'high-performance',
        alpha: false,
        stencil: false
      });
      setupRenderer(renderer, settings);
    } catch (e) {
      console.error('[game] 画质切换重建渲染器失败', e);
      return false;
    }

    try { parent.replaceChild(newCanvas, oldCanvas); } catch (e) { parent.appendChild(newCanvas); }
    MG.UI.el['game-canvas'] = newCanvas;
    /* 新画布要交给输入层换绑：Input._bind() 把 mousedown / click / dblclick 与指针锁定
       直接挂在构造时那张 canvas 上（js/input.js），只改 .canvas 引用不会把监听迁过去。
       有 setCanvas 就交给它（解绑旧节点 + 绑新节点）；没有（跨版本漂移）时退回原写法，
       此时 #look-layer 覆盖在画布之上，点击仍能到达输入层，行为与改动前一致。 */
    if (Game.input) {
      if (typeof Game.input.setCanvas === 'function') Game.input.setCanvas(newCanvas);
      else Game.input.canvas = newCanvas;
    }
    if (Game.player) Game.player.canvas = newCanvas;

    var oldRenderer = Game.renderer;
    Game.renderer = renderer;
    if (oldRenderer && oldRenderer.dispose) {
      try { oldRenderer.dispose(); } catch (e) { /* 旧上下文释放失败无所谓 */ }
    }

    resetShadowMaps();
    bindContextLoss(newCanvas);
    Game._renderErrLogged = false;
    try {
      renderer.render(Game.scene, Game.camera);
    } catch (e) {
      console.error('[game] 画质切换后首帧渲染失败', e);
    }
    return true;
  }

  /* ------------------------------------------------------------
   * WebGL 上下文丢失 / 恢复（BUG-029）
   * ------------------------------------------------------------
   * 现象：切到后台放一段时间再回来，点「继续游戏」后 3D 画面永久白屏，但游戏逻辑照跑
   * （能靠小地图盲走、GUI 完全正常、重开本局或回主菜单都救不回来）。
   *
   * 原因：系统回收了 WebGL 上下文（安卓后台内存紧张时常见）。渲染器一旦丢了上下文，
   * three.js 会跳过 render（不抛错，所以不会走到 fatal 那套），而本模块此前没有任何
   * 感知：既不暂停、也不提示、也没有兜底 —— 浏览器如果始终不派发 restored，
   * 画布就永远是空的，玩家只能看着"加载失败的方块"干瞪眼。
   *
   * 四段兜底（①丢失 / ②恢复 / ③催一次+重建 / ④给出口）：
   *   ① 丢失瞬间：preventDefault（允许恢复）+ 暂停游戏（禁止盲走）+ 显示恢复中提示；
   *   ② 收到 restored：重新套用渲染器设置并强制渲染一帧；
   *   ③ 等不到 restored：主动 restoreContext() 催一次；仍不行就换一张画布 + 新渲染器 ——
   *      场景 / 摄像机 / 迷宫 / 玩家位置都在内存里且与渲染器无关，复用即可，本局进度不丢；
   *   ④ 重建也失败：给明确的「重新加载页面」出口，不再白屏无提示。
   * ---------------------------------------------------------- */
  var ctxTimers = [];

  function clearCtxTimers() {
    for (var i = 0; i < ctxTimers.length; i++) clearTimeout(ctxTimers[i]);
    ctxTimers = [];
  }

  /** 当前 WebGL 上下文是否已丢失 */
  function isContextLostNow() {
    try {
      var gl = Game.renderer && Game.renderer.getContext && Game.renderer.getContext();
      return !!(gl && gl.isContextLost && gl.isContextLost());
    } catch (e) {
      return false;
    }
  }

  /** 给画布挂上下文事件（初始化一次；重建画布后要对新画布再挂一次） */
  function bindContextLoss(canvas) {
    if (!canvas || !canvas.addEventListener) return;
    canvas.addEventListener('webglcontextlost', function (e) {
      // 必须 preventDefault，浏览器才会尝试恢复（three.js 内部也做了，这里显式保证）
      if (e && e.preventDefault) e.preventDefault();
      // 旧画布被换掉后仍可能派发迟到事件：只认当前画布，别让它干扰健康的新上下文
      if (canvas !== MG.UI.el['game-canvas']) return;
      handleContextLost();
    }, false);
    canvas.addEventListener('webglcontextrestored', function () {
      if (canvas !== MG.UI.el['game-canvas']) return;
      handleContextRestored();
    }, false);
  }

  /** 上下文丢失：暂停 + 提示 + 安排恢复尝试 */
  function handleContextLost() {
    if (Game._ctxLost) return;
    Game._ctxLost = true;
    // 恢复期挂起逐帧逻辑（loopBody 首行判断）：loading 期丢失时 buildLevel 仍会把 state
    // 置 playing，只靠暂停拦不住键盘盲走
    Game._ctxRecovering = true;
    console.warn('[game] WebGL 上下文丢失，暂停游戏并尝试恢复');
    // 画都画不出来的时候不能让玩家接着盲走
    if (Game.state === 'playing') pauseGame();
    else if (Game.state === 'replay') {
      // 只在"正在播放"时暂停：toggleReplayPause 对"已播完"的回放会重新开播
      if (Game.replayPlaying) toggleReplayPause();
    }
    showContextOverlay('lost');
    clearCtxTimers();
    ctxTimers.push(setTimeout(nudgeContextRestore, 1200));
    ctxTimers.push(setTimeout(recreateRenderer, 3500));
  }

  /** 主动请求浏览器恢复上下文（部分内核对"后台期间被回收"的上下文不会自动触发 restored） */
  function nudgeContextRestore() {
    if (!Game._ctxLost) return;
    try {
      var gl = Game.renderer && Game.renderer.getContext && Game.renderer.getContext();
      var ext = gl && gl.getExtension && gl.getExtension('WEBGL_lose_context');
      if (ext && ext.restoreContext) ext.restoreContext();
    } catch (e) { /* 不支持就交给后面的重建兜底 */ }
  }

  /** 上下文恢复：重新套用渲染器设置并强制渲染一帧 */
  function handleContextRestored() {
    if (!Game._ctxLost) return;
    console.info('[game] WebGL 上下文已恢复');
    clearCtxTimers();
    Game._ctxLost = false;
    Game._ctxRecovering = false;
    try {
      setupRenderer(Game.renderer, MG.Settings.get());
      if (Game.scene && Game.camera) Game.renderer.render(Game.scene, Game.camera);
    } catch (e) {
      console.error('[game] 上下文恢复后重绘失败，改为重建渲染器', e);
      Game._ctxLost = true;
      Game._ctxRecovering = true;   // 重建期间保持"恢复中"，别让别的分支把 overlay 收掉
      recreateRenderer(true);       // 上下文是好的，必须强制重建，否则这行等于白调
      return;
    }
    hideContextOverlay();
    if (MG.UI && MG.UI.toast) MG.UI.toast('画面已恢复', 1600);
  }

  /** 旧渲染器的阴影贴图属于已废弃的上下文：清空让新渲染器重新分配 */
  function resetShadowMaps() {
    if (!Game.scene) return;
    Game.scene.traverse(function (obj) {
      if (obj && obj.isLight && obj.shadow && obj.shadow.map) obj.shadow.map = null;
    });
  }

  /**
   * 彻底重建渲染器：换一张新画布 + 新 WebGLRenderer。
   * 场景 / 摄像机 / 迷宫 / 玩家位置都在内存里且与渲染器无关，复用即可保住本局进度。
   *
   * @param {boolean} [force] 强制重建：跳过"上下文其实没丢"的提前返回。
   *   handleContextRestored() 重绘失败时会带着 true 调进来 —— 那时 gl.isContextLost()
   *   已经是 false（restored 事件都派发过了），不加这个开关就会走进下面"已自行恢复"的
   *   分支、什么也不做，最后退化成一帧一帧地 render 抛错、变成 fatal。
   */
  function recreateRenderer(force) {
    clearCtxTimers();
    if (!Game._ctxLost) return;                          // 期间已经被浏览器恢复了
    if (Game._renderStopped) {                           // 已经 fatal：不要再用 toast 覆盖错误界面
      Game._ctxLost = false;
      Game._ctxRecovering = false;
      hideContextOverlay();
      return;
    }
    // 有些内核只恢复上下文、不派发 webglcontextrestored：这种情况不需要换画布，
    // 否则会无谓重建渲染器、dispose 旧对象、还弹一条误导性的"画面已恢复"
    if (!force && !isContextLostNow()) {
      Game._ctxLost = false;
      Game._ctxRecovering = false;
      hideContextOverlay();
      forceRedraw();
      return;
    }
    // 下面两条 dead 出口故意**不复位** _ctxRecovering：它会让主循环继续挂起
    // （loopBody 开头那个早退），避免拿着一个救不回来的渲染器每帧刷错误。
    // 玩家看到的是带「重新加载页面」按钮的提示层。
    if (!Game.scene || !Game.camera) { showContextOverlay('dead'); return; }
    var oldCanvas = MG.UI.el['game-canvas'];
    var parent = oldCanvas && oldCanvas.parentNode;
    if (!parent) { showContextOverlay('dead'); return; }

    var settings = MG.Settings.get();
    var newCanvas = document.createElement('canvas');
    newCanvas.id = 'game-canvas';
    var renderer = null;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas: newCanvas,
        antialias: settings.quality === 'high',
        powerPreference: 'high-performance',
        alpha: false,
        stencil: false
      });
      setupRenderer(renderer, settings);
    } catch (e) {
      console.error('[game] 重建渲染器失败', e);
      renderer = null;
    }
    if (!renderer) { showContextOverlay('dead'); return; }

    // 先让新画布就位再移除旧画布，避免中间出现空档
    try { parent.replaceChild(newCanvas, oldCanvas); } catch (e) { parent.appendChild(newCanvas); }
    MG.UI.el['game-canvas'] = newCanvas;
    // 与 rebuildRenderer() 同一处理：Pointer Lock 要打到新画布上，输入层的画布监听也要换绑
    if (Game.input) {
      if (typeof Game.input.setCanvas === 'function') Game.input.setCanvas(newCanvas);
      else Game.input.canvas = newCanvas;
    }
    if (Game.player) Game.player.canvas = newCanvas;

    var oldRenderer = Game.renderer;
    Game.renderer = renderer;
    if (oldRenderer && oldRenderer.dispose) {
      try { oldRenderer.dispose(); } catch (e) { /* 旧上下文已废弃，释放失败无所谓 */ }
    }

    resetShadowMaps();
    bindContextLoss(newCanvas);
    Game._ctxLost = false;
    Game._ctxRecovering = false;
    // 注：_renderStopped 一旦置 true 不会复位（loop 已停）；这里只复位"渲染异常已提示"标记
    Game._renderErrLogged = false;
    try {
      renderer.render(Game.scene, Game.camera);
    } catch (e) {
      console.error('[game] 重建后首帧渲染失败', e);
      showContextOverlay('dead');
      return;
    }
    hideContextOverlay();
    if (MG.UI && MG.UI.toast) MG.UI.toast('画面已恢复（本局进度保留）', 2200);
  }

  /** 上下文提示层：既用于"恢复中"，也用于"救不回来"的兜底出口（沿用现有 .screen/.panel 样式） */
  function showContextOverlay(mode) {
    var app = MG.UI.el['app'];
    if (!app) return;
    var node = document.getElementById('ctx-overlay');
    if (!node) {
      node = document.createElement('div');
      node.id = 'ctx-overlay';
      node.className = 'screen';
      node.style.zIndex = '98';   // 高于暂停菜单（40）与 toast（60），低于 fatal（99）
      app.appendChild(node);
    }
    var dead = (mode === 'dead');
    node.innerHTML =
      '<div class="panel panel-narrow" style="text-align:center">' +
      '<h2 class="panel-title">' + (dead ? '画面无法恢复' : '正在恢复画面…') + '</h2>' +
      '<p class="muted" style="line-height:1.7">' +
      '系统回收了本页的图形上下文（切到后台后内存紧张时常见）。' +
      (dead
        ? '自动恢复已失败，请点击下方按钮重新加载页面；本局进度会丢失，重载后从主菜单重新开始。'
        : '正在尝试自动恢复，场景与本局进度都还在，请稍候；若长时间无响应，可手动重新加载。') +
      '</p>' +
      '<div class="btn-row"><button class="primary-btn" id="ctx-reload">重新加载页面</button></div>' +
      '</div>';
    var btn = document.getElementById('ctx-reload');
    if (btn) btn.addEventListener('click', function () { location.reload(); });
  }

  function hideContextOverlay() {
    var node = document.getElementById('ctx-overlay');
    if (node && node.parentNode) node.parentNode.removeChild(node);
  }

  /** 回到前台强制重绘一帧：部分内核对"后台回来"的画布不再合成（白屏但逻辑正常） */
  function forceRedraw() {
    if (!Game.renderer || !Game.scene || !Game.camera) return;
    try {
      setupRenderer(Game.renderer, MG.Settings.get());
      Game.renderer.render(Game.scene, Game.camera);
    } catch (e) {
      console.warn('[game] 回到前台重绘失败', e);
    }
  }

  /** 灯光 */
  function setupLights(scene, settings) {
    var theme = MG.Maze.THEMES[settings.theme];

    // 环境/半球光（保证整体可见）—— 地面反射色随主题变化（theme.ground）
    var hemi = new THREE.HemisphereLight(theme.light, theme.ground, 1.2);
    hemi.position.set(0, 50, 0);
    scene.add(hemi);
    Game.hemi = hemi;

    // 平行光：提供方向感与阴影（强度提升，配合整体亮度）
    var sun = new THREE.DirectionalLight(0xffffff, settings.quality === 'low' ? 0.7 : 1.1);
    sun.position.set(30, 60, 20);
    sun.castShadow = !!settings.shadows;
    var s = 60;
    sun.shadow.camera.left = -s;
    sun.shadow.camera.right = s;
    sun.shadow.camera.top = s;
    sun.shadow.camera.bottom = -s;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 200;
    sun.shadow.mapSize.width = settings.quality === 'low' ? 512 : 1024;
    sun.shadow.mapSize.height = settings.quality === 'low' ? 512 : 1024;
    scene.add(sun);
    sun.target.position.set(0, 0, 0);
    scene.add(sun.target);
    Game.sun = sun;

    // 玩家随身小灯（强度与范围加大，起到实际照明作用）
    var torch = new THREE.PointLight(theme.light, 1.4, 25, 2);
    scene.add(torch);
    Game.torch = torch;

    // 雾
    applyFog(scene, settings);
  }

  /** 应用雾效（跟随难度浓度 + 设置开关） */
  function applyFog(scene, settings) {
    if (!Game.diff) {
      // 菜单状态：不显示雾，但背景要用当前主题的 sky 色
      // （否则在主菜单切主题时背景永远停在初始主题色）
      scene.fog = null;
      var menuTheme = MG.Maze.THEMES[settings.theme];
      if (menuTheme && scene.background && scene.background.setHex) {
        scene.background.setHex(menuTheme.sky);
      }
      return;
    }
    if (settings.fog) {
      var color = MG.Maze.THEMES[settings.theme].fog;
      scene.fog = new THREE.FogExp2(color, Game.diff.fogDensity);
      if (scene.background && scene.background.setHex) scene.background.setHex(color);
    } else {
      scene.fog = null;
    }
  }

  /** 窗口尺寸变化处理 */
  function onResize() {
    if (!Game.renderer || !Game.camera) return;
    var w = window.innerWidth;
    var h = window.innerHeight;
    Game.camera.aspect = w / h;
    Game.camera.updateProjectionMatrix();
    // 限制像素比
    applyPixelRatio();
    Game.renderer.setSize(w, h, false);
    /* BUG-066：setSize 会把画布内容重设（不同实现下可能被清空），而菜单态默认不再逐帧渲染，
       所以这里必须显式要求一次重画，否则"在菜单里转屏/拉窗口"会留下黑画布或拉伸的旧画面。 */
    markSceneDirty();
  }

  function applyPixelRatio() {
    var settings = MG.Settings.get();
    var maxDPR = settings.quality === 'high' ? 2 : (settings.quality === 'low' ? 1 : 1.5);
    Game.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxDPR));
  }

  /* ------------------------------------------------------------
   * 开始新一局
   * ---------------------------------------------------------- */
  /** 释放"正在启动"守卫（幽灵弹窗路径的兜底，避免 _startPending 永久为 true） */
  function releaseStartPending() {
    Game._startPending = false;
  }

  /**
   * 开局入口：守卫 + 难度校验 + 同步异常兜底。
   * 真正的流程在 startGameInner()（原函数主体）。拆开的原因：_startPending 一旦置 true
   * 却因同步异常没机会释放，之后所有「开始游戏」都会被静默吞掉，只能刷新页面。
   */
  function startGame(diffKey, seed, isDaily) {
    if (Game._startPending) {
      // 静默 return 会让玩家以为"点了没反应"，这里给一次轻提示
      if (MG.UI && MG.UI.toast) MG.UI.toast('正在加载，请稍候', 1200);
      return;
    }
    // 难度 key 非法时直接拦住：否则 Game.diff 变 undefined，buildLevel 里 diff.cells 抛错 → fatal
    if (!MG.Maze.DIFFICULTIES[diffKey]) {
      console.error('[game] 未知难度：' + diffKey);
      if (MG.UI && MG.UI.toast) MG.UI.toast('难度参数不正确');
      return;
    }
    Game._startPending = true;
    try {
      startGameInner(diffKey, seed, isDaily);
    } catch (e) {
      console.error('[game] 开始游戏失败', e);
      releaseStartPending();
      if (MG.UI && MG.UI.showMainMenu) MG.UI.showMainMenu();
      fatal('开始游戏失败', String((e && e.message) || e));
    }
  }

  function startGameInner(diffKey, seed, isDaily) {
    // 清掉上一局残留的道具面板状态：R 键重开等路径不经过 closeItemPanel / backToMenu，
    // 若不清零会让 pauseGame 的 itemPanelOpen 守卫永久拦截 HUD 暂停 / 设置按钮
    Game.itemPanelOpen = false;

    var settings = MG.Settings.get();
    Game.diffKey = diffKey;
    Game.diff = MG.Maze.DIFFICULTIES[diffKey];
    Game.seed = seed || MG.Maze.randomSeed();
    Game.isDaily = !!isDaily;

    // 幽灵：检查「同难度 + 同种子」的历史回放（弹窗需在 loading 界面之前）
    var ghostFrames = MG.Replay ? MG.Replay.load(diffKey, Game.seed) : null;
    var hasGhost = !!(ghostFrames && ghostFrames.length > 1);
    var ghostMode = settings.ghostMode || 'ask';
    Game._pendingGhost = null;

    /** 进入加载流程（useGhost 为 true 且存在回放时才启用幽灵） */
    function proceed(useGhost) {
      // 重新置位：从这里到"弹窗已决定"之间保持守卫；进入加载后由 loading 屏挡住重复点击，
      // finally 会在 proceed 返回后立即释放守卫（见下方 then/finally）
      Game._startPending = true;
      if (useGhost && hasGhost) Game._pendingGhost = ghostFrames;
      MG.UI.showLoading('准备生成迷宫…', 0.05);
      Game.state = 'loading';
      // 用 setTimeout 让加载界面先绘制出来（避免长任务阻塞首帧）
      setTimeout(function () {
        try {
          buildLevel(Game.seed);
        } catch (e) {
          console.error('[game] 构建关卡失败', e);
          fatal('关卡生成失败', String(e && e.message || e));
        } finally {
          Game._startPending = false;
        }
      }, 60);
    }

    if (hasGhost && ghostMode === 'ask') {
      // 弹窗询问：玩家主动选择后继续
      //（点击背景遮罩 / 按 ESC / 15 秒无操作超时，均视为"独自探险"）
      var meta = MG.Replay.loadFull(diffKey, Game.seed);
      var ghostPrompt = MG.UI.showGhostDialog({
        diffName: Game.diff.name,
        time: (meta && typeof meta.time === 'number' && meta.time > 0)
          ? meta.time
          : (ghostFrames[ghostFrames.length - 1][3] || 0)
      });
      // finally 语义：无论 resolve / reject / 回调内部抛错，都必须先释放守卫，
      // 否则 _startPending 永久为 true，之后所有 startGame 会被静默吞掉
      ghostPrompt.then(
        function (res) {
          try {
            if (res.remember) {
              // 记住选择：写入设置（总是启用 / 从不启用）
              MG.Settings.set('ghostMode', res.choice === 'ghost' ? 'always' : 'never');
            }
            proceed(res.choice === 'ghost');
          } finally {
            releaseStartPending();
          }
        },
        function () {
          // reject 分支：按"独自探险"继续，保证主流程不卡死
          try {
            proceed(false);
          } finally {
            releaseStartPending();
          }
        }
      );
      return;
    }

    proceed(hasGhost && ghostMode === 'always');
  }

  /** 生成并构建关卡 */
  function buildLevel(seed) {
    var settings = MG.Settings.get();
    var diff = Game.diff;

    // 沙盒测试局（js/dev.js）：换一份"无金币 / 无天花板"的难度副本。
    // 逐项判方法存在：旧副本 / 半截 dev.js（副本漂移）缺一个方法就会抛 TypeError，
    // 被 startGame 的 catch 变成 fatal，整局不可玩
    var isSandbox = !!(MG.Dev &&
      ((typeof MG.Dev.takeSandboxFlag === 'function' && MG.Dev.takeSandboxFlag()) ||
       (typeof MG.Dev.isSandbox === 'function' && MG.Dev.isSandbox())));
    /* 上面那句只保证了 takeSandboxFlag / isSandbox 存在，真正干活的两个方法
       （patchDiff / prepareMaze）必须**逐个再判一次**才符合这里注释的承诺：
       否则遇到"新的 main.js + 旧的 dev.js"（缓存/副本漂移，BUG-035 记过这种现象），
       第 657 行直接抛 TypeError → 被 startGame 的 catch 变成 fatal，
       而且 _renderStopped 一旦置位就只能刷新页面。
       缺方法时退化成普通难度，让玩家至少能玩。 */
    if (isSandbox &&
        (typeof MG.Dev.patchDiff !== 'function' || typeof MG.Dev.prepareMaze !== 'function')) {
      console.warn('[game] 沙盒方法缺失（dev.js 版本不一致？），本局按普通难度进行');
      isSandbox = false;
    }
    if (isSandbox) {
      diff = MG.Dev.patchDiff(diff);
      // HUD 与胜利结算读的都是 Game.diff（onVictory / updateHudData），
      // 只替换局部变量会让沙盒局按原难度结算、显示成"困难"（BUG-025）
      Game.diff = diff;
    }

    MG.UI.setLoadingProgress(0.2, '生成迷宫结构…');

    // 1) 生成迷宫数据
    var maze = MG.Maze.generate(diff.cells, seed, 'dfs');
    // 打通部分环路（简单难度多一些，减少死路）
    /* 环路打通比例（2026-11-15 难度重构后重定）：迷宫越大越少打环路 —— 少环路=多死路=更要真探索。
       简单 21×21 → 0.06、中等 31×31 → 0.03、困难 121×121 → 0.02。 */
    var loopRatio = diff.key === 'simple' ? 0.06 : (diff.key === 'medium' ? 0.03 : 0.02);
    MG.Maze.carveLoops(maze, loopRatio);

    // 2) 起点终点
    var ep = MG.Maze.pickEndpoints(maze, diff.endFarRatio);
    maze.start = ep.start;
    maze.end = ep.end;

    // 2.5) 沙盒：放在 pickEndpoints 之后 —— 它会重设 start/end，先设就白设了。
    //      打通整张网格后得到"只有地面"的空场（墙体一个都不会生成，边界即隐形墙）
    if (isSandbox) MG.Dev.prepareMaze(maze);

    // 3) 确保终点可达（极端情况下通过 BFS 校验）
    var reachable = MG.Path.bfs(maze, maze.start, maze.end);
    if (!reachable) {
      // 兜底：直接把终点移到起点对角线上的第一个通路格
      maze.end = { x: maze.size - 2, y: maze.size - 2 };
      if (!MG.Path.bfs(maze, maze.start, maze.end)) {
        maze.end = { x: maze.start.x, y: maze.start.y };
      }
    }

    Game.maze = maze;
    MG.UI.setLoadingProgress(0.5, '构建 3D 场景…');

    // 4) 清理旧场景对象
    disposeLevel();

    // 5) 构建 3D 视图
    Game.mazeView = new MG.Maze.MazeView(
      Game.scene, maze, diff, settings.theme, settings.quality, settings
    );

    MG.UI.setLoadingProgress(0.75, '初始化玩家…');

    // 6) 玩家（相机位于起点）
    Game.player = new MG.Player(Game.camera, maze, diff, MG.UI.el['game-canvas']);
    // 沙盒收尾（隐藏传送门 / 光点 / 粒子 / 卷轴 + 按开关自动解锁小地图）放在 7.1 之后：
    // 它会置 mapFound=true 并解锁小地图，若在这里调用，会被后面"mapFound=false + 重新上锁"覆盖
    Game.player.onAutoFinish = function () {
      var p = Game.player;
      if (p && p.autoStoppedByLimit) {
        p.autoStoppedByLimit = false;
        // 限程停下的瞬间：若本次是"最佳路径"，顺手拾取所在格附近的金币
        // （避免"停在金币格上却没捡到"——拾取半径 1.5 覆盖整格，且不会隔墙误拾）
        var picked = 0;
        // BUG-031：最快路径同样要"路过就捡"，限程停下时也顺手拾取所在格附近的金币
        if ((p.autoStoppedKind === 'best' || p.autoStoppedKind === 'fast') && Game.mazeView) {
          picked = Game.mazeView.tryCollect(p.pos.x, p.pos.z, 1.5);
          if (picked > 0) {
            Game.collectedCoins += picked;
            if (MG.Audio) MG.Audio.coin();
          }
        }
        var kindAtStop = p.autoStoppedKind;
        p.autoStoppedKind = null;
        // 距离限制到点：光带已同步消失，仅轻提示（非阻塞）
        // best → 提示可再用道具继续拾取；fast → 提示寻路结束（fast 现已不限程，保留兜底文案）
        var stopMsg = (kindAtStop === 'fast')
          ? '自动寻路结束'
          : '最佳路径已走完本次距离上限，可再次使用道具继续' +
            (picked > 0 ? '（顺手拾取 +' + picked + ' 金币）' : '');
        MG.UI.toast(stopMsg, 2600);
      } else if (p && p.autoReachedEnd) {
        // 正常到达终点：静默处理，由胜利界面接管提示（避免双 toast 叠加）
        p.autoReachedEnd = false;
      } else {
        MG.UI.toast('自动寻路结束');
      }
    };

    // 7) 计时/状态重置
    Game.elapsed = 0;
    Game.usedAutoPath = false;
    Game.collectedCoins = 0;
    Game._portalAccum = 0;
    Game._hudAccum = 0;

    // 7.1) 小地图道具：每局重新寻找（拾取只进背包，玩家在道具面板主动使用后才解锁小地图）
    Game.mapFound = false;
    Game.mapHint = '';
    // 小地图离屏缓存按局重置（探索标记 / 玩家格 / 签名全部作废）
    MG.UI.resetMinimapCache();
    var mItem = Game.mazeView.mapItem;
    if (mItem && diff.key === 'simple') {
      var mdx = mItem.x - maze.start.x;
      var mdy = mItem.y - maze.start.y;
      var mdir = Math.abs(mdx) >= Math.abs(mdy) ? (mdx > 0 ? '东' : '西') : (mdy > 0 ? '南' : '北');
      Game.mapHint = '提示：地图在' + mdir + '侧';
    }
    MG.UI.updateMinimapLock(true, Game.mapHint);

    // 7.1.1) 沙盒收尾放在这里：afterBuild 会按开关自动解锁小地图，
    //        必须晚于上面的 mapFound=false 与重新上锁，否则开关等于无效
    if (isSandbox && MG.Dev && typeof MG.Dev.afterBuild === 'function') MG.Dev.afterBuild();

    // 7.2) 回放记录器：记录本局路径（每 100ms 一帧）
    if (MG.Replay) Game.recorder = MG.Replay.createRecorder();

    // 7.3) 幽灵：按 ghostMode 分支加载（弹窗确认已在 loading 界面之前完成）
    disposeGhost();
    if (Game._pendingGhost && Game._pendingGhost.length > 1) {
      Game.ghostFrames = Game._pendingGhost;
      if (MG.Replay) Game.ghost = MG.Replay.createGhost(Game.scene);
      MG.UI.toast(MG.UI.iconHtml('ghost') + ' 幽灵已就位，和它比一比吧', 2400, true);
    }
    Game._pendingGhost = null;

    // 8) 雾效/背景跟随主题与难度
    applyFog(Game.scene, settings);
    applyLightsForTheme(settings);

    // 9) 相机 FOV
    Game.camera.fov = settings.fov;
    Game.camera.updateProjectionMatrix();

    MG.UI.setLoadingProgress(1, '完成！');
    MG.UI.showGame();
    MG.UI.el['stat-diff'].textContent = diff.name;

    Game.state = 'playing';
    // 纵深防御：与 startGame 入口层的清理成对，保证"进入游戏状态"时
    // itemPanelOpen 与 state 的不变量（面板打开 ⇔ state === 'paused'）成立
    Game.itemPanelOpen = false;
    Game.clock.getDelta(); // 丢弃加载期间累积的时间

    MG.UI.toast('种子：' + Game.seed + '  难度：' + diff.name, 2200);

    // 上一局通关解锁、但玩家抢在 1.2 秒内点了「再玩一次」的成就，等开局种子 toast
    // 消失（2200ms）后再补发，避免两条 toast 互相覆盖（BUG-020）
    if (Game._pendingAchieveToast) {
      // 登记到同一个 _achieveToastTimer 上：否则它是一个"游离"的定时器，
      // clearAchieveToastTimer() 管不到它 —— 玩家在这 2.2 秒内退出本局的话，
      // 成就提示会在主菜单上迟一拍弹出来。
      if (Game._achieveToastTimer) clearTimeout(Game._achieveToastTimer);
      Game._achieveToastTimer = setTimeout(function () {
        Game._achieveToastTimer = null;
        flushAchieveToast();
      }, 2200);
    }
  }

  /** 各主题的平行光（太阳）颜色：科技冷白 / 地牢暖黄 / 森林偏绿白 */
  var SUN_COLORS = {
    tech: 0xffffff,
    dungeon: 0xffe8c0,
    forest: 0xe0ffd8
  };

  /** 按主题刷新灯光颜色 */
  function applyLightsForTheme(settings) {
    var theme = MG.Maze.THEMES[settings.theme];
    if (Game.hemi) {
      Game.hemi.color.setHex(theme.light);
      // 半球光的地面反射色随主题更新，避免地牢/森林下地面反射仍偏蓝黑
      if (theme.ground !== undefined) Game.hemi.groundColor.setHex(theme.ground);
    }
    if (Game.torch) {
      Game.torch.color.setHex(theme.light);
    }
    // 太阳光颜色跟随主题（首次仍是白色，切换主题后更新）
    if (Game.sun) {
      Game.sun.color.setHex(SUN_COLORS[settings.theme] || SUN_COLORS.tech);
    }
    // 背景同步：菜单状态（无雾）与关闭雾效时都跟随主题 sky 色
    if (Game.scene && Game.scene.background && Game.scene.background.setHex &&
        (!Game.diff || !settings.fog)) {
      Game.scene.background.setHex(theme.sky);
    }
  }

  /** 释放当前关卡资源 */
  function disposeLevel() {
    disposeGhost();
    if (Game.replayGhost) {
      Game.replayGhost.dispose();
      Game.replayGhost = null;
    }
    Game.replayData = null;
    Game.recorder = null;
    if (Game.player) {
      Game.player.clearPathVisual();
      Game.player = null;
    }
    if (Game.mazeView) {
      Game.mazeView.dispose();
      Game.mazeView = null;
    }
    // 清理场景中残留的路径可视化（兜底）
    // 注意：这里必须递归 dispose，否则 InstancedMesh / ribbon / RingGeometry 的
    // GPU 资源会随"进出游戏"次数单调增长（此前的只 remove 是泄漏点）
    if (Game.scene) {
      var leftovers = [];
      Game.scene.traverse(function (o) {
        if (o.name === 'autoPathVisual') leftovers.push(o);
      });
      for (var i = 0; i < leftovers.length; i++) {
        var g = leftovers[i];
        g.traverse(function (o) {
          // InstancedMesh 的 instanceMatrix 挂在网格自己身上，geometry.dispose() 清不掉它，
          // 必须让网格自己派发 dispose 事件才会被 WebGLAttributes 摘掉（与 BUG-040 同一回事）
          if (o.isInstancedMesh && typeof o.dispose === 'function') o.dispose();
          if (o.geometry) o.geometry.dispose();
          if (o.material) {
            if (Array.isArray(o.material)) {
              for (var m = 0; m < o.material.length; m++) {
                if (o.material[m]) o.material[m].dispose();
              }
            } else {
              o.material.dispose();
            }
          }
        });
        Game.scene.remove(g);
      }
    }
  }

  /** 移除幽灵模型（关卡切换时调用） */
  function disposeGhost() {
    if (Game.ghost && Game.ghost.dispose) Game.ghost.dispose();
    Game.ghost = null;
    Game.ghostFrames = null;
  }

  /* ------------------------------------------------------------
   * 自动寻路（由道具触发：最佳路径 / 最快路径）
   * ---------------------------------------------------------- */

  /**
   * 难度 / 寻路类型对应的单次寻路距离限制（格）；null = 不限制
   * - 最快路径（fast）：不限（本来就是直奔终点）
   * - 最佳路径（best）：中途要绕去捡金币，中/困难限程，可多次使用道具续走
   * @param {'best'|'fast'} kind 寻路类型
   */
  function autoPathCellLimit(kind) {
    if (kind === 'fast') return null;
    /* 2026-11-15 难度重构后重定（用户口径）：简单 21×21 不限、中等 31×31 单次 60 格、困难 121×121 单次 80 格。
       困难档这个 80 格约占其最短路径（打通环路后约 915 步）的 8.7% —— 刻意保留"道具帮助有限"；
       若要按旧困难的比例（50/145 ≈ 34%）同比放大，应改成约 300，说一声即可调。 */
    if (Game.diffKey === 'medium') return 60;
    if (Game.diffKey === 'hard') return 80;
    return null; // simple：完整走完
  }

  /**
   * 启动自动寻路（"最佳路径 / 最快路径"道具使用入口）
   * @param {'best'|'fast'} kind
   * @returns {boolean} 是否成功启动
   */
  function triggerAutoPath(kind) {
    var inPanel = (Game.state === 'paused' && Game.itemPanelOpen);
    if (Game.state !== 'playing' && !inPanel) return false;
    var player = Game.player;
    if (!player) return false;

    // 正在寻路 → 提示用取消按钮
    if (player.autoActive) {
      MG.UI.toast('已经在自动寻路中，可点击"取消寻路"中断');
      return false;
    }

    // 计算路径（最佳路径 = 顺路收集版本；最快路径 = 纯最短路径）
    var path = (kind === 'best')
      ? buildBestPath(player)
      : MG.Path.findWorldPath(Game.maze, player.pos, MG.Maze.CELL, 'astar');
    if (!path || path.length < 2) {
      MG.UI.toast('未找到通往终点的路径');
      if (MG.Audio) MG.Audio.error();
      return false;
    }

    var limit = autoPathCellLimit(kind);
    var ok = player.startAutoPath(path, {
      kind: kind,
      limit: limit,
      ribbon: true // 最佳路径 / 最快路径都显示地面光带（便于查看行进路线）
    });
    if (!ok) return false;

    Game.usedAutoPath = true;
    if (MG.Audio) MG.Audio.pathStart();
    var name = kind === 'best'
      ? MG.UI.iconHtml('compass') + ' 最佳路径'
      : MG.UI.iconHtml('bolt') + ' 最快路径';
    MG.UI.toast(name + '启动' + (limit && kind === 'best' ? '（本次限 ' + limit + ' 格）' : ''), 2200, true);
    return true;
  }

  /**
   * 生成"最佳路径"：先捡完本局所有未拾取目标（金币 + 地图卷轴），最后才冲终点
   * 核心技巧：拾取阶段把终点格临时封为墙，A* 天然绕开终点（避免提前通关）
   * - 某金币必须踩过终点才能捡 → 不可达，自动放弃（踩终点就赢了，实际也捡不到）
   * - 绕开终点也能到 → A* 走那条更长的绕路
   */
  function buildBestPath(player) {
    var maze = Game.maze;
    var cell = MG.Maze.CELL;
    var half = (maze.size * cell) / 2;

    // 世界坐标 → 网格坐标（与 Path.findWorldPath 的换算保持一致）
    var gx = Math.round((player.pos.x + half - cell / 2) / cell);
    var gy = Math.round((player.pos.z + half - cell / 2) / cell);
    gx = Math.max(0, Math.min(maze.size - 1, gx));
    gy = Math.max(0, Math.min(maze.size - 1, gy));
    if (!MG.Path.isWalkable(maze, gx, gy)) {
      var near = MG.Path.nearestWalkable(maze, gx, gy);
      if (!near) return null;
      gx = near.x; gy = near.y;
    }

    // 1) 收集目标：未拾取的金币 + 未发现的地图卷轴
    var targets = [];
    var view = Game.mazeView;
    if (view) {
      if (view.coins) {
        for (var i = 0; i < view.coins.length; i++) {
          var c = view.coins[i];
          if (!c.collected) targets.push({ x: c.x, y: c.y });
        }
      }
      // BUG-022：不再用 !Game.mapFound 过滤 —— 小地图已解锁时卷轴依然可拾取（进背包留给下一局），
      // 若继续过滤，「最佳路径」就不会绕路去捡它，与本局实际可拾取的行为不一致。
      if (view.mapItem && !view.mapItem.collected) {
        targets.push({ x: view.mapItem.x, y: view.mapItem.y });
      }
    }

    // 2) 无目标 → 退化为直接去终点（保持旧行为）
    var startCell = { x: gx, y: gy };
    if (targets.length === 0) {
      return MG.Path.findWorldPath(maze, player.pos, cell, 'astar');
    }

    // 3) 拾取阶段：临时把终点封为墙，让 A* 绕开终点
    var size = maze.size;
    var endIdx = maze.end.y * size + maze.end.x;
    var savedEnd = maze.grid[endIdx];
    var collectPath = null;
    try {
      maze.grid[endIdx] = 1;
      collectPath = MG.Path.buildGreedyCollectPath(maze, startCell, targets);
    } finally {
      maze.grid[endIdx] = savedEnd; // 无论如何都要还原，避免污染迷宫数据
    }

    // 4) 全部不可达 → 退化为直接去终点
    if (!collectPath || collectPath.length === 0) {
      return MG.Path.findWorldPath(maze, player.pos, cell, 'astar');
    }

    // 5) 拾取结束后从最后一个目标冲终点
    var last = collectPath[collectPath.length - 1];
    var full;
    if (last.x === maze.end.x && last.y === maze.end.y) {
      full = collectPath; // 最后一个目标就是终点格（极端情况），无需拼接
    } else {
      var tail = MG.Path.aStar(maze, { x: last.x, y: last.y }, maze.end);
      if (!tail) {
        // 尾部不可达（异常情况）：退化为直接去终点
        return MG.Path.findWorldPath(maze, player.pos, cell, 'astar');
      }
      full = collectPath.concat(tail.slice(1));
    }

    // 6) 终点必须保留为途经点，防止被简化裁掉
    var protectedSet = {};
    protectedSet[endIdx] = 1;
    // 各拾取目标同样保护，保证光带真的穿过它们
    for (var t = 0; t < targets.length; t++) {
      protectedSet[targets[t].y * size + targets[t].x] = 1;
    }

    var simple = MG.Path.simplify(maze, full, protectedSet);
    var world = MG.Path.toWorldPath(simple, maze, cell, cell * 0.34);
    if (world.length > 0) world[0] = { x: player.pos.x, z: player.pos.z };
    return world;
  }

  function cancelAutoPath() {
    if (!Game.player) return;
    if (Game.player.cancelAutoPath()) {
      if (MG.Audio) MG.Audio.pathCancel();
      MG.UI.toast('已取消自动寻路');
    }
  }

  /* ------------------------------------------------------------
   * 道具面板（打开时暂停游戏，关闭后恢复）
   * ---------------------------------------------------------- */
  function openItemPanel() {
    // 画面恢复期间不接受开面板：上下文提示层（#ctx-overlay，z-index 98）只挡指针、挡不住键盘，
    // 而 loopBody 已挂起，按 F 会在恢复后留下一个"凭空打开"的道具面板（state 也被改成 paused）
    if (Game._ctxRecovering) return;
    if (Game.state !== 'playing' || !Game.player) return;
    Game.itemPanelOpen = true;
    Game.state = 'paused'; // 暂停游戏逻辑（计时停止）
    if (Game.input) Game.input.exitPointerLock();
    // 道具面板遮罩覆盖全屏，HUD 一起隐藏：否则 HUD 上的暂停按钮仍可点，
    // 但 pauseGame 因 state 已是 paused 直接返回，点了没反应
    MG.UI.hide('hud');
    MG.UI.showItemPanel();
  }

  function closeItemPanel() {
    if (!Game.itemPanelOpen) return;
    Game.itemPanelOpen = false;
    MG.UI.hideItemPanel();
    if (Game.state === 'paused') {
      Game.state = 'playing';
      MG.UI.show('hud'); // 与 openItemPanel 的隐藏成对，恢复 HUD
      Game.clock.getDelta(); // 丢弃暂停期间累积时间
    }
  }

  /**
   * 扣道具失败时的提示文案。
   * consumeItem() 返回 false 有两种原因：数量不足，或钱包写盘失败（shop 会把次数回滚）。
   * 后者若还提示"道具不足"，玩家会以为是自己没道具 —— 这里按 shop 记录的失败原因区分。
   */
  function consumeFailMsg() {
    var err = (MG.Shop && MG.Shop.takeSaveError) ? MG.Shop.takeSaveError() : null;
    return err === 'consume' ? '本地存档无法写入，道具未使用' : '道具不足';
  }

  /**
   * 使用道具（道具面板触发）
   * @param {string} itemId 'mapUnlock' | 'bestPath' | 'fastPath'
   */
  function useItem(itemId) {
    // 沙盒生成器等开发者专用道具入口（id 形如 dev:spawnCoin）
    if (itemId && itemId.indexOf('dev:') === 0) {
      if (MG.Dev && MG.Dev.handleItemUse) MG.Dev.handleItemUse(itemId);
      return;
    }

    if (!MG.Shop) return;
    var player = Game.player;

    // 小地图开局解锁：本局永久生效；已解锁时提示且不消耗
    if (itemId === 'mapUnlock') {
      if (Game.mapFound) {
        MG.UI.toast('本局已解锁，无需重复使用');
        if (MG.Audio) MG.Audio.error();
        return;
      }
      if (!MG.Shop.consumeItem('mapUnlock')) {
        MG.UI.toast(consumeFailMsg());
        if (MG.Audio) MG.Audio.error();
        return;
      }
      Game.mapFound = true;
      if (MG.Audio) MG.Audio.mapFound();
      MG.UI.toast('小地图已解锁（消耗 1 个道具）', 2200);
      MG.UI.updateMinimapLock(false, Game.mapHint);
      updateHudData(); // 距离信息立即显示
      MG.UI.renderItemPanel();
      return;
    }

    // 最佳路径 / 最快路径：启动一次寻路（走完限制距离自动停下）
    if (itemId === 'bestPath' || itemId === 'fastPath') {
      var kind = itemId === 'bestPath' ? 'best' : 'fast';
      if (player && player.autoActive) {
        MG.UI.toast('正在自动寻路中');
        return;
      }
      // 顺序按用户拍板保留："先启动寻路、再扣道具" —— 宁可先跑起来再扣费，
      // 也不接受"扣了没启动"这种玩家吃亏的方向；扣费失败时在这里完整回滚。
      var wasAuto = Game.usedAutoPath;
      var ok = triggerAutoPath(kind);
      if (!ok) return;
      if (!MG.Shop.consumeItem(itemId)) {
        // 异常兜底：扣费失败则取消寻路，避免白嫖
        if (player) player.cancelAutoPath();
        // 关键：triggerAutoPath 内部会置 usedAutoPath=true，扣费失败必须回滚，
        // 否则玩家没用掉道具却被记成"用过自动寻路"，「自力更生」成就从此拿不到
        Game.usedAutoPath = wasAuto;
        MG.UI.toast(consumeFailMsg());
        if (MG.Audio) MG.Audio.error();
        return;
      }
      MG.UI.renderItemPanel();
      closeItemPanel(); // 使用后自动关闭面板并恢复游戏
    }
  }

  /* ------------------------------------------------------------
   * 暂停 / 继续 / 重开 / 返回菜单
   * ---------------------------------------------------------- */
  function pauseGame(openSettings) {
    if (Game.state !== 'playing') {
      // 若已在暂停且只是要打开设置，忽略
      return;
    }
    if (Game.itemPanelOpen) return;
    Game.state = 'paused';
    if (Game.input) Game.input.exitPointerLock();
    /* BUG-066：暂停后画面就静止了，主循环不再逐帧渲染；这里补一次脏标记，
       保证画布上留下的是"按下暂停那一刻"的准确画面，而不是上上帧。 */
    markSceneDirty();
    if (openSettings) {
      // HUD 设置按钮一步到位：直接进入设置界面（关闭时按 hud 来源恢复游戏）
      MG.UI.showSettings('hud');
    } else {
      MG.UI.showPause();
    }
  }

  function resumeGame() {
    if (Game.state !== 'paused') return;
    if (Game.itemPanelOpen) return; // 道具面板打开期间不恢复
    // 画面已丢失（切后台被系统回收）：不要进入"看得见 HUD、看不见场景"的盲走状态，
    // 先走上下文恢复流程；恢复成功后玩家再点一次继续即可（BUG-029）
    if (isContextLostNow()) {
      handleContextLost();
      return;
    }
    MG.UI.hidePause();
    // 兜底：任何恢复路径都必须让 HUD 可见（避免经设置面板返回后 HUD 丢失）
    MG.UI.show('hud');
    Game.state = 'playing';
    // 清空残留输入：中断（来电/切后台）时浏览器可能不补发 touchend，
    // 摇杆的 moveX/moveY 会保持中断前的值，导致恢复后角色自己往前走（BUG-014）
    if (Game.input && Game.input.resetInputs) Game.input.resetInputs();
    Game.clock.getDelta(); // 丢弃暂停期间累积时间
  }

  function restartGame() {
    // 画面恢复期间不接受重开：会在一个救不回来的渲染器上再建整关，
    // 且幽灵询问弹窗被提示层盖住点不到，只能等 15 秒超时（与 openItemPanel 同一处理）
    if (Game._ctxRecovering) return;
    clearAchieveToastTimer();
    MG.UI.hidePause();
    // 退出指针锁定：否则光标隐藏，若本局存在回放会弹幽灵询问框，玩家点不到按钮（只能 ESC / 等 15s）
    if (Game.input && Game.input.exitPointerLock) Game.input.exitPointerLock();
    // 把状态从 playing 移开：否则幽灵询问弹窗显示期间旧局仍在背后推进（计时 / 按键 / 终点判定）
    if (Game.state === 'playing' || Game.state === 'paused') Game.state = 'menu';
    // 用同一难度与种子重新生成（同一迷宫再挑战）
    startGame(Game.diffKey, Game.seed, Game.isDaily);
  }

  /**
   * 通关后"再玩一次"：生成一个新的随机种子游戏继续
   * （每日挑战也切换为新的随机迷宫；想复玩当日挑战可回主菜单点"每日挑战"）
   */
  function playAgain() {
    clearAchieveToastTimer();
    startGame(Game.diffKey, '', false); // 空种子 → startGame 内部生成新的随机种子
  }

  function backToMenu() {
    clearAchieveToastTimer();
    // 回到菜单后不再有"下一局开局 toast"可用，挂起的成就必须在这里补发
    flushAchieveToast();
    if (Game.itemPanelOpen) {
      Game.itemPanelOpen = false;
      MG.UI.hideItemPanel();
    }
    Game.state = 'menu';
    if (Game.input) Game.input.exitPointerLock();
    disposeLevel();
    // 清空关卡遗留的雾效与背景，避免旧关卡雾色透出到菜单（背景还原为当前主题 sky 色）
    if (Game.scene) {
      Game.scene.fog = null;
      var menuTheme = MG.Maze.THEMES[MG.Settings.get().theme];
      if (menuTheme && Game.scene.background && Game.scene.background.setHex) {
        Game.scene.background.setHex(menuTheme.sky);
      }
    }
    MG.UI.showMainMenu();
    MG.UI.refreshRecords();
    MG.UI.refreshAchievements();
    /* BUG-066：上面把关卡整个 dispose 掉、又把场景背景色换成了当前主题的 sky，
       画布上现在还是上一秒那张迷宫画面 —— 必须补一次渲染把它刷成纯背景色，
       否则玩家会看到"回主菜单了，底下还留着刚才那局的迷宫"。 */
    markSceneDirty();
    // 签到入口的角标/文案（跨天或刚领取后回到菜单时保持一致）
    if (MG.Checkin && typeof MG.Checkin.refreshBadge === 'function') MG.Checkin.refreshBadge();
    // 沙盒测试局结束：复位标记，避免下一次正常开局还按沙盒处理
    if (MG.Dev && MG.Dev.resetSandbox) MG.Dev.resetSandbox();
  }

  /* ------------------------------------------------------------
   * 胜利处理
   * ---------------------------------------------------------- */
  function onVictory() {
    if (Game.state === 'win') return;
    Game.state = 'win';
    /* BUG-066：通关后画面静止（win 态不推进 3D 动画），主循环不再逐帧渲染；
       补一次脏标记，让胜利界面背后那张画面停在"刚抵达终点"的准确一帧。 */
    markSceneDirty();

    var diff = Game.diff;
    var player = Game.player;
    if (player) player.cancelAutoPath();
    if (Game.input) Game.input.exitPointerLock();

    // 沙盒测试局：不写任何"正式存档"（钱包 / 记录 / 排行榜 / 回放 / 成就），避免测试数据污染玩家档案。
    // 必须先算：原先金币 addCoins 写在守卫之前，沙盒里捡的金币会真的进钱包
    var isSandboxWin = !!(MG.Dev && MG.Dev.isSandbox && MG.Dev.isSandbox());

    // 金币汇入钱包：× 收益倍率结算，但保证不低于原始拾取数
    // （避免小数被向下取整后，玩家买了 +25% 加成却感知不到，例如 3×1.25=3.75 → 3）
    var coinsEarned = 0;
    if (!isSandboxWin && MG.Shop) {
      var rawEarn = Game.collectedCoins * MG.Shop.coinMultiplier();
      coinsEarned = Math.max(Game.collectedCoins, Math.round(rawEarn));
      if (coinsEarned > 0) MG.Shop.addCoins(coinsEarned);
    }

    // 提交记录
    var res = isSandboxWin
      ? { isBest: false, best: null, all: null }
      : MG.Settings.submitRecord(diff.key, Game.elapsed, player ? player.steps : 0);

    // 提交本地排行榜（按难度分区，仅保留前 10 名）
    var rankRes = { rank: 0 };
    if (!isSandboxWin && MG.Ranking) {
      rankRes = MG.Ranking.add(diff.key, {
        time: Game.elapsed,
        steps: player ? player.steps : 0,
        auto: Game.usedAutoPath,
        seed: Game.seed,
        date: new Date().toISOString().slice(0, 10)
      });
    }

    // 保存本局回放数据（按难度+种子为 key，供回放 / 幽灵使用）
    var hasReplay = false;
    if (!isSandboxWin && MG.Replay && Game.recorder && player) {
      var recFrames = Game.recorder.finish(player.pos.x, player.pos.z, player.yaw);
      hasReplay = MG.Replay.save(diff.key, Game.seed, recFrames, {
        time: Game.elapsed,
        steps: player.steps,
        auto: Game.usedAutoPath
      });
    }

    // 成就判定（沙盒局跳过）
    var newAchievements = [];
    if (!isSandboxWin) {
    if (MG.Settings.unlockAchievement('first_win')) newAchievements.push('初次通关');
    if (!Game.usedAutoPath && MG.Settings.unlockAchievement('no_autopath')) newAchievements.push('自力更生');
    if (diff.key === 'hard' && MG.Settings.unlockAchievement('hard_win')) newAchievements.push('勇者无畏');
    /* 疾风步阈值 40s → 90s（2026-11-15）：简单档从 11×11 升成 21×21，最短路径约 72 米 ≈ 20 秒
       （打通环路后实测），正常人首次跑完约 30~60 秒；阈值随档位一起上调。成就 id 不变。 */
    if (diff.key === 'simple' && Game.elapsed <= 90 && MG.Settings.unlockAchievement('fast_simple')) newAchievements.push('疾风步');

    var wins = MG.Settings.bumpCounter('wins');
    if (wins >= 5 && MG.Settings.unlockAchievement('explorer')) newAchievements.push('探险家');

    if (Game.mazeView && Game.mazeView.totalCoins > 0 &&
        Game.collectedCoins >= Game.mazeView.totalCoins) {
      if (MG.Settings.unlockAchievement('collector')) newAchievements.push('收藏家');
    }
    } // end if (!isSandboxWin)

    // 展示胜利界面
    MG.UI.showWin({
      time: Game.elapsed,
      steps: player ? player.steps : 0,
      diffName: diff.name,
      usedAutoPath: Game.usedAutoPath,
      coinsEarned: coinsEarned,
      best: res.best,
      isBest: res.isBest,
      rank: rankRes.rank,
      hasReplay: hasReplay
    });

    if (MG.Audio) MG.Audio.win();

    if (newAchievements.length > 0) {
      // 先挂起：玩家可能在 1.2 秒内就点「再玩一次 / 返回主菜单」，定时器会被 clearAchieveToastTimer()
      // 取消，原先会连成就音效和提示一起丢掉（BUG-020）。挂起后由 backToMenu() 或下一局
      // buildLevel() 在合适时机补发。
      Game._pendingAchieveToast = newAchievements.slice();
      if (Game._achieveToastTimer) clearTimeout(Game._achieveToastTimer);
      Game._achieveToastTimer = setTimeout(function () {
        Game._achieveToastTimer = null;
        flushAchieveToast();
      }, 1200);
    }
  }

  /**
   * 取消通关后延迟弹出的成就提示定时器。
   * 只清定时器，**不清** Game._pendingAchieveToast —— 成就确实解锁了，
   * 只是还没播报；清掉挂起数据等于把提示和音效永久丢失（BUG-020）。
   */
  function clearAchieveToastTimer() {
    if (Game._achieveToastTimer) {
      clearTimeout(Game._achieveToastTimer);
      Game._achieveToastTimer = null;
    }
  }

  /** 立刻播报挂起的成就（toast + 音效），并清空挂起状态；无挂起时什么都不做 */
  function flushAchieveToast() {
    var list = Game._pendingAchieveToast;
    if (!list || !list.length) return;
    Game._pendingAchieveToast = null;
    MG.UI.toast(MG.UI.iconHtml('trophy') + ' 解锁成就：' + list.join('、'), 3000, true);
    if (MG.Audio) MG.Audio.achieve();
  }

  /* ------------------------------------------------------------
   * 回放 / 幽灵回放
   * ---------------------------------------------------------- */
  function startReplay() {
    if (!MG.Replay || !Game.maze) return;
    clearAchieveToastTimer();
    var frames = MG.Replay.load(Game.diffKey, Game.seed);
    if (!frames || frames.length < 2) {
      MG.UI.toast('没有可用的回放数据');
      return;
    }

    Game.replayData = frames;
    Game.replayT = 0;
    Game.replayPlaying = true;
    Game.replayView = 'follow';
    Game.state = 'replay';

    // 回放期间暂时关闭雾，保证能看清幽灵
    if (Game.scene) Game.scene.fog = null;

    // 创建半透明幽灵（沿路径重放）
    if (Game.replayGhost) Game.replayGhost.dispose();
    Game.replayGhost = MG.Replay.createGhost(Game.scene);

    var total = frames[frames.length - 1][3] || 0;
    MG.UI.showReplayBar(total);
    MG.UI.setReplayViewLabel(true);
  }

  function exitReplay() {
    if (Game.state !== 'replay') return;
    Game.state = 'win';
    if (Game.replayGhost) {
      Game.replayGhost.dispose();
      Game.replayGhost = null;
    }
    Game.replayData = null;
    Game.replayPlaying = false;
    MG.UI.hideReplayBar();
    MG.UI.show('win-screen');
    // 相机还原到玩家第一人称视角
    if (Game.player) Game.player.syncCamera();
    // 恢复雾效
    applyFog(Game.scene, MG.Settings.get());
  }

  function toggleReplayPause() {
    if (Game.state !== 'replay' || !Game.replayData) return;
    var frames = Game.replayData;
    var total = frames[frames.length - 1][3] || 0;
    if (!Game.replayPlaying && Game.replayT >= total) {
      // 已播完 → 重播
      Game.replayT = 0;
      Game.replayPlaying = true;
    } else {
      Game.replayPlaying = !Game.replayPlaying;
    }
    MG.UI.updateReplayBar(Game.replayT, total, Game.replayPlaying);
  }

  function toggleReplayView() {
    if (Game.state !== 'replay') return;
    Game.replayView = Game.replayView === 'follow' ? 'top' : 'follow';
    MG.UI.setReplayViewLabel(Game.replayView === 'follow');
  }

  function updateReplay(dt) {
    var frames = Game.replayData;
    if (!frames || !Game.replayGhost) return;
    var total = frames[frames.length - 1][3] || 0;

    if (Game.replayPlaying) {
      Game.replayT += dt;
      if (Game.replayT >= total) {
        Game.replayT = total;
        Game.replayPlaying = false;
      }
      MG.UI.updateReplayBar(Game.replayT, total, Game.replayPlaying);
    }

    var pose = MG.Replay.sample(frames, Game.replayT);
    if (!pose) return;
    Game.replayGhost.setPose(pose.x, pose.z, pose.yaw);
    Game.replayGhost.update(dt);

    // 场景动画继续（传送门 / 粒子等）
    if (Game.mazeView) Game.mazeView.update(dt, Game.replayT);

    // 相机：跟随幽灵（第三人称）或全景俯视
    var cam = Game.camera;
    if (Game.replayView === 'follow') {
      // 参数：固定高度 4.5m（高于所有难度墙高，困难 3.5m），距离 5.0m，
      // 注视点 1.6m（幽灵上半身），避免幽灵跑出画面下缘
      var camDist = 5.0;
      var camHeight = 4.5;
      var lookHeight = 1.6;
      // 从幽灵胸口（1.5m）朝相机位置的射线：若被墙体挡住，沿射线拉近相机作为兜底，
      // 防止困难难度窄巷道里相机埋进 3.5m 高的墙（画面变黑）
      var origin = new THREE.Vector3(pose.x, 1.5, pose.z);
      var targetCam = new THREE.Vector3(
        pose.x + Math.sin(pose.yaw) * camDist,
        camHeight,
        pose.z + Math.cos(pose.yaw) * camDist
      );
      var toCam = targetCam.clone().sub(origin);
      var maxDist = toCam.length();
      toCam.normalize();

      // 复用同一个 Raycaster：three.js 的 set() 只写射线，near/far 需要每帧按需重置
      if (!replayRaycaster) replayRaycaster = new THREE.Raycaster();
      replayRaycaster.set(origin, toCam);
      replayRaycaster.near = 0;
      replayRaycaster.far = maxDist;
      var raycaster = replayRaycaster;
      if (Game.mazeView && Game.mazeView.walls) {
        var hits = raycaster.intersectObject(Game.mazeView.walls);
        if (hits.length > 0) {
          var safeDist = Math.max(1.0, hits[0].distance - 0.3);
          cam.position.copy(origin).addScaledVector(toCam, safeDist);
          cam.lookAt(pose.x, lookHeight, pose.z);
          return; // 提前结束本次跟随相机的定位
        }
      }
      cam.position.copy(targetCam);
      cam.lookAt(pose.x, lookHeight, pose.z);
    } else {
      var half = Game.mazeView ? Game.mazeView.worldHalf : 30;
      var h = Math.max(20, half * 1.7);
      cam.position.set(pose.x * 0.25, h, pose.z * 0.25 + half * 1.3);
      cam.lookAt(pose.x, 1, pose.z);
    }
  }

  /* ------------------------------------------------------------
   * 主循环
   * ---------------------------------------------------------- */
  var lastMapDraw = 0;

  /* ------------------------------------------------------------
   * 菜单态"脏标记按需渲染"（BUG-066，2026-11-14）
   * ------------------------------------------------------------
   * 背景：用户反馈"进游戏探索迷宫不卡，但主界面和各种 UI 面板滑动卡顿"。
   * 根因（不是设备性能不够，是我们在白烧）：
   *   ① 主菜单 / 商店 / 排行榜 / 成就 / 签到 全是 .screen 全屏层，把它们下面的 3D 画布
   *      完全盖住（只透出一层 0.55~0.94 alpha 的渐变底色），可 loopBody() 结尾仍然
   *      **每帧无条件 renderer.render()** —— 玩家看不见的东西，60 次/秒画一遍；
   *   ② 画布每帧都在变，于是画布上那层全屏 backdrop-filter（毛玻璃）也跟着每帧失效、
   *      每帧重算整屏模糊；玩家一滑动，滚动帧和这个重算撞在一起 → 就是"滑动卡顿"。
   *      而游戏内毛玻璃只挂在 .stat / .icon-btn 这类几十像素的小芯片上，代价可以忽略，
   *      所以**只有菜单卡、游戏内不卡**。
   *
   * 做法：把"要不要渲染"从"每帧都画"改成"画面真的需要变才画"。
   * 跳过的状态见 isSceneCovered()：menu / paused / win（这三种状态下 loopBody 不推进任何
   * 3D 动画，画面是静止的，前面又必然盖着一张全屏 .screen），外加开发者面板打开时。
   * playing / replay / loading **保持每帧渲染**，一点没动。
   *
   * 代价与风险：任何"在覆盖状态下改变了 3D 画面"的代码路径都必须置脏，否则画面会停在旧的。
   * 目前这类路径有五条（回菜单 / 窗口尺寸 / 设置变更 / 进入暂停 / 通关），
   * 见 markSceneDirty() 的各调用点；新增同类路径时**务必**跟着补一次。
   * ---------------------------------------------------------- */

  /** 把"下一帧需要真的渲染一次"标脏（幂等，可以重复调） */
  function markSceneDirty() {
    Game._sceneDirty = true;
  }

  /**
   * 画布当前是否被某个全屏 DOM 层完全盖住（盖住即可跳过渲染）。
   * 判据只有两条，故意写死：
   *  - Game.state 是 menu / paused / win：这三种状态下主循环**不推进任何 3D 动画**
   *    （见 loopBody 的分支：playing 才 update、replay 才 updateReplay），
   *    画面是静止的；而这三种状态的正前方必然盖着一张全屏 .screen
   *    （主菜单 / 商店 / 排行榜 / 成就 / 签到 / 暂停菜单 / 设置 / 胜利界面）；
   *  - 开发者面板打开：它是全屏调试层，打开前会强制暂停（js/dev.js 的 open()，BUG-036）。
   * 为什么 paused 也算：暂停时画布上是"按下暂停那一刻"的画面，之后不会再变 ——
   *    每帧重画同一张图，玩家一点也看不出来，却让画布上的全屏毛玻璃每帧重算一遍。
   * 为什么**不**把 loading 算进来：加载期间正在建关卡，渲染与否不该节外生枝。
   * 为什么**不**按"某个 screen 元素是否可见"判断：那要枚举十几个 id，漏一个就是黑屏级错误，
   *    而状态机的取值是单一、可枚举的。
   */
  function isSceneCovered() {
    var st = Game.state;
    if (st === 'menu' || st === 'paused' || st === 'win') return true;
    if (MG.Dev && MG.Dev.isOpen && MG.Dev.isOpen()) return true;
    return false;
  }

  /** 渲染一帧（含异常兜底：渲染出错就停循环并给出可见错误界面，避免玩家一直黑屏无感知） */
  function renderScene() {
    try {
      Game.renderer.render(Game.scene, Game.camera);
    } catch (e) {
      // 渲染异常：只提示一次，并停止渲染循环 + 给出可见错误界面
      if (!Game._renderErrLogged) {
        Game._renderErrLogged = true;
        console.error('[game] 渲染异常', e);
        Game._renderStopped = true;
        fatal('渲染异常', '请尝试刷新页面或更换浏览器。');
      }
    }
  }

  /** 长帧探针的统计窗口（毫秒）：窗口滚动，取最近一个窗口的结果给开发者面板显示 */
  var PERF_WINDOW_MS = 10000;
  /** 单帧超过这个毫秒数算"长帧"（60fps 的预算是 16.7ms，25ms 已经能感知到顿一下） */
  var PERF_LONG_FRAME_MS = 25;

  /**
   * 记录一帧的间隔，维护"最近一个窗口内的长帧数"。
   * 搭在已有的 rAF 循环里，成本是每帧一次 Date.now() 加两个整数运算，可忽略。
   * 用途：无头测试量不到真机帧率，这是唯一能让玩家自己复核"UI 到底还卡不卡"的手段
   * （滑一遍菜单 → 开开发者面板「环境」页看数字）。
   */
  function noteFrameGap() {
    var now = Date.now();
    var p = Game.perf;
    if (!p.windowStart) p.windowStart = now;
    if (now - p.windowStart >= PERF_WINDOW_MS) {
      // 上一个窗口结算：留一份给面板读取，然后开新窗口
      p.lastFrames = p.frames;
      p.lastLongFrames = p.longFrames;
      p.frames = 0;
      p.longFrames = 0;
      p.windowStart = now;
    }
    p.frames++;
    if (p._lastTs && now - p._lastTs > PERF_LONG_FRAME_MS) p.longFrames++;
    p._lastTs = now;
  }

  /**
   * 主循环外层：只负责 rAF 调度与异常兜底；逐帧逻辑在 loopBody()。
   * 原实现只有 renderer.render 在 try 里 —— playing 分支任何一处抛错都会每帧刷屏，
   * 而且循环不会停、玩家停在被更新到一半的状态。
   */
  function loop() {
    if (Game._renderStopped) return; // 渲染致命错误后停止循环（不再调度下一帧）
    requestAnimationFrame(loop);
    noteFrameGap();
    try {
      loopBody();
    } catch (e) {
      Game._renderStopped = true;
      console.error('[game] 主循环异常，已停止渲染循环', e);
      fatal('运行异常', '本局已停止，请刷新页面重试。');
    }
  }

  function loopBody() {
    // 上下文丢失 / 恢复期间挂起全部逐帧逻辑：loading 期丢失后 buildLevel 仍会把 state 置
    // playing，覆盖层只挡指针事件、挡不住 window 键盘监听 → 否则玩家能在"正在恢复画面…"
    // 下面用键盘盲走、计时照跑，与"禁止盲走"的意图相悖
    if (Game._ctxRecovering) return;

    var dt = Game.clock ? Game.clock.getDelta() : 0.016;
    dt = Math.min(dt, 0.1); // 保护：限制单帧最大步进，避免切后台回来跳帧/穿墙

    if (Game.state === 'playing' && Game.player && Game.mazeView) {
      var settings = MG.Settings.get();

      // 1) 视角：取出触摸/鼠标累计的位移
      var look = Game.input.consumeLook();
      if (look.dx !== 0 || look.dy !== 0) {
        Game.player.rotate(look.dx, look.dy, settings.sensitivity, settings.invertYaw, settings.invertPitch);
      }

      // 2) 移动输入
      var mv = Game.input.getMoveInput();
      // 手动操作时中断自动寻路（给玩家最高控制权）
      if (Game.player.autoActive && (Math.abs(mv.moveX) > 0.25 || Math.abs(mv.moveY) > 0.25)) {
        Game.player.cancelAutoPath();
        MG.UI.toast('已接手手动控制，自动寻路中断');
      }

      Game.player.update(dt, mv, settings);

      // 3) 计时
      Game.elapsed += dt;

      // 4) 场景动画
      Game.mazeView.update(dt, Game.elapsed);
      Game.player.updatePathVisual(dt, Game.elapsed);

      // 4.1) 回放记录（每 100ms 一帧，供通关后回放 / 幽灵对战）
      if (Game.recorder) {
        Game.recorder.update(dt, Game.player.pos.x, Game.player.pos.z, Game.player.yaw);
      }

      // 4.2) 幽灵：上一次同难度+同种子的挑战沿历史路径前进
      if (Game.ghost && Game.ghostFrames && MG.Replay) {
        var gPose = MG.Replay.sample(Game.ghostFrames, Game.elapsed);
        if (gPose) Game.ghost.setPose(gPose.x, gPose.z, gPose.yaw);
        Game.ghost.update(dt);
      }

      // 5) 玩家随身灯跟随
      if (Game.torch) {
        Game.torch.position.set(Game.player.pos.x, Game.player.eyeHeight, Game.player.pos.z);
      }

      // 5.5) 接近终点：传送门低鸣环境音（节流触发，音量随距离增强）
      var endDist = Game.player.euclidToEnd();
      if (endDist >= 0 && endDist < 12) {
        Game._portalAccum += dt;
        if (Game._portalAccum >= 1.6) {
          Game._portalAccum = 0;
          if (MG.Audio) MG.Audio.portal(1 - endDist / 12);
        }
      }

      /* 6) 金币收集
       * 拾取半径：最佳路径略放宽（留出路径圆角的误差余量），其余用常规值。
       *
       * BUG-031（2026-11-07）：原实现是 if (autoKind !== 'fast') { ... }，把"最快路径"
       * 整段收集逻辑跳过，于是最快路径**路过**金币与地图卷轴时什么都不发生，
       * 看起来像"直接穿过两张贴图"。用户明确要求：路过了就该捡。
       *
       * 这里把"推进"与"收集"解耦 —— "最快"只表示**不主动绕路**去捡目标
       * （目标收集见 buildBestPath 分支），不表示"路过也不捡"。
       * 半径仍沿用常规 0.85，不因为快而放大，避免把隔壁格的东西吸过来。
       */
      var autoKind = Game.player.autoActive ? Game.player.autoKind : null;
      var collectRadius = autoKind === 'best' ? 1.1 : 0.85;
      var got = Game.mazeView.tryCollect(Game.player.pos.x, Game.player.pos.z, collectRadius);
      if (got > 0) {
        Game.collectedCoins += got;
        if (MG.Audio) MG.Audio.coin();
        MG.UI.toast('+' + got + ' 金币（' + Game.collectedCoins + '/' + Game.mazeView.totalCoins + '）', 1000);
      }

      /* 6.5) 地图道具拾取：入库；小地图是否已解锁，只影响"要不要刷新小地图状态"
       *
       * 设计变更（2026-10-30）：拾取 = mapUnlock 库存 +1，解锁动作交给玩家在道具面板里主动执行，
       * 走 useItem('mapUnlock') 那条既有分支，因此拾取本身**不设置** Game.mapFound。
       *
       * BUG-022（2026-10-31）：这里原先写成
       *     if (!Game.mapFound && Game.mazeView.tryCollectMap(...))
       * 那个 && 短路导致"先用道具解锁小地图、再走到卷轴处"时整个分支不执行：
       * 卷轴既不消失也不入库，看起来像一张只会转圈的贴图。
       * A 改造前 mapFound 只在拾取那一刻才置 true，这条路径不可达；改造后可达了，守卫就成了死条件。
       * 现在把 mapFound 的角色从"是否进入分支"降级为"是否刷新小地图状态"。
       *
       * 注意：本局已解锁时**绝不能**调用 updateMinimapLock(true, …)，
       * 那会把已解锁的小地图重新锁上（HUD 距离信息与指南针距离一起消失），比原 bug 更严重。
       *
       * 库存与商店购买的 mapUnlock 共用同一份钱包，面板数量是合并后的值。 */
      if (Game.mazeView.tryCollectMap(Game.player.pos.x, Game.player.pos.z, 1.2)) {
        var mapItemAdded = !!(MG.Shop && MG.Shop.addItem && MG.Shop.addItem('mapUnlock', 1));
        if (!mapItemAdded) console.warn('[game] 地图道具入库失败（钱包不可写），本局仍按已拾取处理');

        if (MG.Audio) MG.Audio.mapFound();

        if (Game.mapFound) {
          // 本局已经解锁（玩家先用道具开了小地图）：只入库，小地图状态一个字都不动。
          // 道具留到下一局用 —— 本局再用会走 useItem 的"本局已解锁，无需重复使用"分支。
          MG.UI.toast('已获得地图道具（库存 +1）', 2600);
        } else {
          MG.UI.toast('已获得地图道具，可在道具面板中使用', 2600);
          // 方位提示已失效：道具被拿走了，留着"地图在东侧"只会误导玩家。
          // 小地图仍是锁定状态，这里只把提示行清空（中等/困难本来就没有提示，不受影响）。
          Game.mapHint = '';
          MG.UI.updateMinimapLock(true, Game.mapHint);
        }

        updateHudData(); // 库存数变了：刷新 HUD 的道具数量与钱包
      }

      // 7) 终点判定（沙盒空场没有终点：prepareMaze 仍会设 maze.end，走到对角会误判通关）
      if (!(MG.Dev && MG.Dev.isSandbox && MG.Dev.isSandbox()) && Game.player.reachedEnd()) {
        onVictory();
      }

      // 8) HUD（每 100ms 更新一次，减少 DOM 开销）
      Game._hudAccum += dt;
      if (Game._hudAccum >= 0.1) {
        Game._hudAccum = 0;
        updateHudData();
      }

      // 9) 小地图（每 120ms 重绘一次；找到地图道具后才绘制）
      lastMapDraw += dt;
      if (lastMapDraw >= 0.12) {
        lastMapDraw = 0;
        if (Game.mapFound) MG.UI.drawMinimap(Game.player, Game.maze, Game.mazeView, settings);
      }
    } else if (Game.state === 'paused' || Game.state === 'win') {
      // 暂停/胜利时仍渲染静态画面（可看到身后场景）
    } else if (Game.state === 'replay') {
      updateReplay(dt);
    }

    /* 渲染（BUG-066：菜单态改为"脏标记按需渲染"，根因与风险见本文件 renderScene 上方那段）
       —— 被全屏层盖住且没人置脏时不画：玩家看不见、场景又是静止的，画了纯属白烧 GPU，
       而且画布每帧变化会让画布上的全屏毛玻璃每帧重算，正是菜单滑动卡顿的来源。 */
    if (Game.renderer && Game.scene && Game.camera) {
      if (isSceneCovered() && !Game._sceneDirty) {
        // 本帧跳过渲染。注意这里**不能** return：上面的状态逻辑已经跑完，只有"画"这一步省掉
      } else {
        Game._sceneDirty = false;
        renderScene();
      }
    }
  }

  /** 汇总 HUD 数据并交给 UI 层 */
  function updateHudData() {
    var p = Game.player;
    if (!p) return;
    MG.UI.updateHud({
      time: Game.elapsed,
      steps: p.steps,
      diffName: Game.diff.name,
      diff: Game.diff,
      euclidDist: p.euclidToEnd(),
      gridDist: p.distanceToEnd(),
      compassAngle: p.angleToEnd(),
      autoActive: p.autoActive,
      collectedCoins: Game.collectedCoins,
      walletCoins: MG.Shop ? MG.Shop.getWallet().coins : 0,
      itemTotal: MG.Shop
        ? (MG.Shop.countOf('mapUnlock') + MG.Shop.countOf('bestPath') + MG.Shop.countOf('fastPath'))
        : 0
    });
  }

  /* ------------------------------------------------------------
   * 设置变更实时生效
   * ---------------------------------------------------------- */
  /**
   * 色盲友好模式：即时增删 3D 场景里的文字标识 Sprite
   * - 不重建关卡：玩家位置 / 计时 / 步数 / 已收集金币与道具状态全部保持
   * - 文字纹理由 maze.js 内部缓存共享，反复切换只有 Sprite 增删的开销
   */
  function refreshColorblindVisuals() {
    var settings = MG.Settings.get();
    if (Game.mazeView && typeof Game.mazeView.setColorblind === 'function') {
      Game.mazeView.setColorblind(!!settings.colorblind);
    }
    // 小地图下一次重绘自动跟随（drawMinimap 读取 settings.colorblind），这里顺手加速一帧
    lastMapDraw = 999;
  }

  function onSettingChanged(evt) {
    var settings = MG.Settings.get();
    if (!Game.camera) return;
    /* BUG-066：菜单态默认不逐帧渲染，而这里的主题 / 雾 / 阴影 / 画质 / 色盲都会改 3D 画面
       （场景背景色、灯光、雾色、材质需要重编译）。设置面板又是从菜单里打开的，
       所以**每个**设置变更都要置一次脏，让下一帧重画。放在最前面统一置，
       比在每个分支里补一遍可靠 —— 漏一个分支就是"改了设置但画面没反应"。 */
    markSceneDirty();

    // FOV
    if (evt.key === 'fov' || evt.reset) {
      Game.camera.fov = settings.fov;
      Game.camera.updateProjectionMatrix();
    }

    // 雾效 / 主题
    if (evt.key === 'fog' || evt.key === 'theme' || evt.reset) {
      applyFog(Game.scene, settings);
      applyLightsForTheme(settings);
    }

    // 主题：3D 场景的墙体 / 地板 / 天花板材质颜色也要跟着换（否则会一半科技风一半地牢风）
    if (evt.key === 'theme' || evt.reset) {
      if (Game.mazeView && typeof Game.mazeView.applyTheme === 'function') {
        Game.mazeView.applyTheme(settings.theme);
      }
    }

    // 阴影
    if (evt.key === 'shadows' || evt.reset) {
      var shadowsOn = !!settings.shadows;
      /* 阴影的最终口径是"总开关 && 不是低画质"，必须与 build() 里的 needShadows
         以及 MazeView.applyQuality() 保持一致：只按总开关走的话，
         低画质下把阴影开关拨开，地面/墙体/天花板又会被设成接收阴影，
         与"低画质不接收阴影"自相矛盾。 */
      var shadowsRecv = shadowsOn && settings.quality !== 'low';
      if (Game.renderer) {
        Game.renderer.shadowMap.enabled = shadowsOn;
      }
      if (Game.sun) Game.sun.castShadow = shadowsOn;
      if (Game.mazeView && Game.mazeView.walls) {
        Game.mazeView.walls.castShadow = shadowsRecv;
        Game.mazeView.walls.receiveShadow = shadowsRecv;
      }
      // 地面 / 天花板在 build() 时按当时的 shadows 写死 receiveShadow；
      // 运行时再拨开关要同步一次，否则表现为"开了阴影但没有影子"
      if (Game.mazeView && Game.mazeView.floor) {
        Game.mazeView.floor.receiveShadow = shadowsRecv;
      }
      if (Game.mazeView && Game.mazeView.ceiling) {
        Game.mazeView.ceiling.receiveShadow = shadowsRecv;
      }
      // 只标记"与阴影相关"的网格材质需要重编译（限定在迷宫组内的受光材质），
      // 避免全场景 traverse needsUpdate 触发全量着色器重编译导致卡顿
      if (Game.mazeView && Game.mazeView.group) {
        Game.mazeView.group.traverse(function (o) {
          if (!o.material) return;
          var mats = Array.isArray(o.material) ? o.material : [o.material];
          for (var i = 0; i < mats.length; i++) {
            // 跳过不参与光照的材质（Basic 等），只重编译受阴影影响的材质
            if (mats[i] && mats[i].isMeshBasicMaterial) continue;
            mats[i].needsUpdate = true;
          }
        });
      }
    }

    /* 画质（BUG-033）
     * 原实现只调 applyPixelRatio() + onResize()，可这两样在桌面上都没有可感知差异：
     * 桌面 devicePixelRatio 恒为 1 → maxDPR 1 / 1.5 / 2 三档算出来都是 1；
     * 抗锯齿又是创建期参数，改不了。于是"怎么调都是同一个高画质"。
     * 现在切档时：① 换画布重建渲染器（抗锯齿真正换掉）；② 太阳强度与阴影贴图尺寸换档；
     * ③ MazeView 就地换墙檐 / 粒子 / 阴影接收。三档在桌面上都立刻可见。 */
    if (evt.key === 'quality' || evt.reset) {
      /* 只有"档位真的变了"才重建渲染器。
       * 原因：MG.Settings.set() 无论值有没有变都会广播（js/settings.js 的 setSetting 末尾
       * 无条件 emit），而「恢复默认」走的是 reset 广播 —— 不判断的话，重复点同一档画质、
       * 或每次点恢复默认，都会白白丢掉一次 WebGL 上下文再建一个，白白卡顿一下。 */
      if (Game._appliedQuality !== settings.quality) {
        var rebuilt = rebuildRenderer();
        // 重建成功才记账：失败时保持旧值，等玩家下次再切档（或内存腾出来）时有重试机会
        if (rebuilt) Game._appliedQuality = settings.quality;
        if (evt.key === 'quality') {
          var qname = qualityLabel(settings.quality);
          MG.UI.toast(rebuilt
            ? ('画质已切换为「' + qname + '」，立即生效')
            : ('画质已切换为「' + qname + '」，但渲染器重建失败，请刷新页面'), 2400);
        }
      }
      /* 下面三项与"渲染器要不要重建"是两件事，必须每次都按 MazeView 自己的档位比对：
         重建失败时 _appliedQuality 保持旧值，而 MazeView 已经在上一轮换到了新档位；
         玩家再切回旧档时会走进上面"档位没变"的跳过分支，MazeView 就永久停在新档位
         （墙檐 / 粒子 / 阴影接收与设置、渲染器不一致）。
         applyQualityToSun 与 applyQuality 都是幂等的（同档直接早退），重复调用无副作用。 */
      applyQualityToSun(settings);
      if (Game.mazeView && typeof Game.mazeView.applyQuality === 'function') {
        Game.mazeView.applyQuality(settings.quality);
      }
      // 阴影与画质同口径：低画质既不接收也不投射；切回中/高档时恢复
      if (Game.mazeView && Game.mazeView.walls) {
        var wallsShadow = !!settings.shadows && settings.quality !== 'low';
        Game.mazeView.walls.castShadow = wallsShadow;
        Game.mazeView.walls.receiveShadow = wallsShadow;
      }
      applyPixelRatio();
      onResize();
    }

    // 音量 / 音效
    if (evt.key === 'volume' || evt.key === 'sfx' || evt.reset) {
      if (MG.Audio) MG.Audio.syncVolume();
    }

    // 主题（DOM）
    if (evt.key === 'theme' || evt.key === 'colorblind' || evt.reset) {
      MG.UI.applyThemeToBody();
    }

    // 色盲友好模式：3D 文字标识即时增删（不重建关卡、不丢进度）
    if (evt.key === 'colorblind' || evt.reset) {
      refreshColorblindVisuals();
    }

    // 小地图开关 → 立刻刷新 HUD 显示
    if (evt.key === 'minimap' || evt.reset) {
      updateHudData();
    }

    // 小地图大小（BUG-062）→ 立刻重新测量并按新尺寸重设画布分辨率
    if (evt.key === 'minimapSize' || evt.reset) {
      if (MG.UI.refreshMinimapSize) MG.UI.refreshMinimapSize();
    }

    // 「小地图显示全部金币」→ 强制下一次主循环立即重绘小地图，切换即时生效
    if (evt.key === 'minimapCoins') {
      lastMapDraw = 999;
    }
  }

  /* ------------------------------------------------------------
   * 致命错误界面
   * ---------------------------------------------------------- */
  function fatal(title, msg) {
    Game.state = 'menu';
    // 停止渲染循环：否则 WebGL 初始化失败等场景下每帧仍会尝试 render 并反复抛异常
    Game._renderStopped = true;
    // 与上下文恢复流程互斥：3500ms 的重建定时器若照常触发，会出现
    // "致命错误层 + 画面已恢复 toast"的矛盾提示
    clearCtxTimers();
    Game._ctxLost = false;
    Game._ctxRecovering = false;
    hideContextOverlay();
    var app = MG.UI.el['app'];
    if (!app) { alert(title + '\n' + msg); return; }
    var overlay = document.createElement('div');
    overlay.className = 'screen';
    overlay.style.zIndex = '99';
    overlay.innerHTML =
      '<div class="panel panel-narrow" style="text-align:center">' +
      '<h2 class="panel-title">' + title + '</h2>' +
      '<p class="muted" style="line-height:1.7">' + msg + '</p>' +
      '<div class="btn-row"><button class="primary-btn" id="fatal-reload">重新加载</button></div>' +
      '</div>';
    app.appendChild(overlay);
    var btn = document.getElementById('fatal-reload');
    if (btn) btn.addEventListener('click', function () { location.reload(); });
  }

  /* ------------------------------------------------------------
   * 启动
   * ---------------------------------------------------------- */
  /* ------------------------------------------------------------
   * 老内核降级（Win7 上最后能装的 Chrome 是 109；109 已原生支持下列全部特性，
   * 故这 4 个能力补偿类在 109 上一个都不会触发 —— 口径见 BUG/BUG.md 的「兼容口径订正」）
   * ---------------------------------------------------------- */
  /**
   * 特性检测 → 给 body 挂 legacy-* class，配合 css/style.css 末尾的降级规则。
   * 只做能力检测（CSS.supports），不猜 UA：Win7 上的浏览器版本差异很大，
   * UA 判定一旦猜错就是"布局全乱"，而能力检测不会。
   *
   * 注意 legacy-gap 的精度限制：CSS.supports 只能验证"属性是否存在"，
   * Chrome 57~83 的 grid 已支持 gap、flex 还没支持，这里会误判为支持。
   * 那种环境下 flex 子元素只是贴在一起（无间距），不会错位，属于可接受降级。
   */
  function applyLegacyClasses() {
    if (!document.body) return;
    var supports = (window.CSS && window.CSS.supports) ? window.CSS.supports : null;
    function ok(a, b) {
      if (!supports) return false; // 连 CSS.supports 都没有：一律按"不支持"降级
      try { return b === undefined ? supports(a) : supports(a, b); }
      catch (e) { return false; }
    }
    var flags = {
      // env(safe-area-inset-*)：不支持时 --safe-* 代入会让整条 calc() 失效
      'legacy-env': !ok('(padding: env(safe-area-inset-top))'),
      // inset 简写：Chrome 87+
      'legacy-inset': !ok('inset', '0'),
      // flex gap：Chrome 84+
      'legacy-gap': !ok('gap', '1px'),
      // 100dvh：Chrome 108+
      'legacy-dvh': !ok('height', '100dvh')
    };
    var classes = [];
    for (var cls in flags) {
      if (!Object.prototype.hasOwnProperty.call(flags, cls)) continue;
      if (flags[cls]) classes.push(cls);
    }
    for (var i = 0; i < classes.length; i++) {
      document.body.classList.add(classes[i]);
    }
  }

  function boot() {
    // 幂等守卫：boot 通过 MG.boot 对外导出（调试用），重复调用会重复建 renderer、
    // 重复挂 resize / visibilitychange、重复绑按钮 → 一次点击触发两次
    if (Game._booted) return;
    Game._booted = true;

    // 0.0) 全局错误捕获放到最前面：boot 早期（设置加载 / UI 初始化 / 签到角标）抛错
    //      也要能记录下来。原实现注册在 loop() 之后，那段代码跑不到时就什么都抓不到。
    window.addEventListener('error', function (e) {
      console.error('[game] 运行错误', e.message, e.filename, e.lineno);
    });

    // 0) 先在 body 上落降级 class：早于任何面板渲染，避免先按现代样式画一遍再跳变
    applyLegacyClasses();

    // 1) 先加载设置（localStorage）
    MG.Settings.load();

    // 2) 初始化 UI（绑定按钮）
    MG.UI.init();

    // 2.1) 填充静态标记里的内联图标：<span data-icon="trophy"></span> → 真实 svg
    //      动态生成的列表（排行榜 / 商店 / 成就）在各自渲染函数里用 MG.UI.iconHtml() 直接拼
    if (MG.UI.fillIcons) MG.UI.fillIcons();

    // 3) Three.js
    if (!initThree()) return;

    // 4) 输入系统
    Game.input = new MG.Input(
      MG.UI.el['joystick'],
      MG.UI.el['joystick-knob'],
      MG.UI.el['look-layer'],
      MG.UI.el['hud'],
      MG.UI.el['game-canvas']
    );

    // 输入回调注入
    Game.input.onFirstInput = function () {
      if (MG.Audio) {
        MG.Audio.unlock();
        MG.Audio.syncVolume();
      }
    };
    Game.input.onPause = function () {
      // 签到面板开启时：ESC / P 先关面板（与道具面板、设置面板一致的手感）
      if (MG.Checkin && MG.Checkin.isPanelOpen && MG.Checkin.isPanelOpen()) { MG.Checkin.closePanel(); return; }
      // 道具面板开启时：ESC / P 键优先关闭面板（不弹暂停菜单、不恢复）
      if (Game.itemPanelOpen) { closeItemPanel(); return; }
      // 设置面板开启时：优先关闭它。否则 ESC 会走进下面的 resumeGame() 分支，
      // 只把 state 切回 playing 而不隐藏面板，游戏会在面板背后继续跑（BUG-016）
      if (MG.UI.isSettingsOpen && MG.UI.isSettingsOpen()) { MG.UI.closeSettings(); return; }
      /* 商店 / 排行榜 / 成就 覆盖层开启时（BUG-064）：优先关面板，落点与鼠标点「返回」一致
         （暂停局 → 暂停菜单，否则 → 主菜单）。没有这一分支时 ESC / P 会落到下面的
         resumeGame()：把 state 变回 playing 而面板还开着 —— 与 BUG-016 同一类问题；
         更糟的是玩家随后点「返回」时 Game.state 已是 playing，返回落点会算成主菜单，
         对局就在主菜单背后继续跑，甚至后台走到终点触发结算，
         凭空写入排行榜 / 回放 / 钱包（正是 js/dev.js 打开面板前必须暂停那段注释警告过的情形）。 */
      if (MG.UI.isOverlayOpen && MG.UI.isOverlayOpen()) { MG.UI.backFromOverlay(); return; }
      if (Game.state === 'replay') exitReplay();
      else if (Game.state === 'playing') pauseGame();
      else if (Game.state === 'paused') resumeGame();
    };
    // 回放模式：点击画面 / 按 P = 暂停继续（不请求指针锁定）
    // 状态判断留在 main 侧，input.js 只负责回调，保持"模块顺序即依赖顺序"，不反向依赖 Game
    Game.input.onToggleReplayPause = function () {
      if (Game.state === 'replay') toggleReplayPause();
    };
    // 供 input.js 只读查询当前状态（决定点击是否该请求 Pointer Lock）
    Game.input.getState = function () { return Game.state; };

    Game.input.onRestart = function () {
      if (Game.state === 'playing' || Game.state === 'paused' || Game.state === 'win') restartGame();
    };
    Game.input.onToggleMinimap = function () {
      if ((Game.state === 'playing' || Game.state === 'paused') && !Game.mapFound) {
        MG.UI.toast('尚未找到迷宫地图');
        if (MG.Audio) MG.Audio.error();
        return;
      }
      var v = !MG.Settings.get().minimap;
      MG.Settings.set('minimap', v);
      MG.UI.toast(v ? '小地图：开' : '小地图：关');
    };
    Game.input.onToggleItems = function () {
      // F 键：开合道具面板（新语义，替代旧的 F = 自动寻路）
      if (Game.itemPanelOpen) closeItemPanel();
      else openItemPanel();
    };

    // UI 回调注入
    MG.UI.menuCallbacks.onStart = function (diffKey, seed, isDaily) {
      if (MG.Audio) MG.Audio.unlock();
      startGame(diffKey, seed, isDaily);
    };
    MG.UI.hudCallbacks.onPause = function (forSettings) {
      pauseGame(forSettings);
    };
    MG.UI.hudCallbacks.onOpenItems = function () { openItemPanel(); };
    MG.UI.hudCallbacks.onCancelPath = function () { cancelAutoPath(); };
    MG.UI.itemCallbacks.onUse = function (itemId) { useItem(itemId); };
    MG.UI.itemCallbacks.onClose = function () { closeItemPanel(); };
    MG.UI.pauseCallbacks.onResume = function () { resumeGame(); };
    MG.UI.pauseCallbacks.onRestart = function () { restartGame(); };
    MG.UI.pauseCallbacks.onMenu = function () { backToMenu(); };
    MG.UI.winCallbacks.onPlayAgain = function () { playAgain(); };
    MG.UI.winCallbacks.onMenu = function () { backToMenu(); };
    MG.UI.winCallbacks.onReplay = function () { startReplay(); };
    // 回放控制条
    MG.UI.replayCallbacks.onExit = function () { exitReplay(); };
    MG.UI.replayCallbacks.onTogglePause = function () { toggleReplayPause(); };
    MG.UI.replayCallbacks.onToggleView = function () { toggleReplayView(); };
    // 从游戏内设置返回 → 恢复游戏
    MG.UI.settingsCallbacks.onCloseFromHud = function () { resumeGame(); };

    // 设置变更监听
    MG.Settings.onSettingChange(onSettingChanged);

    // 5) 初始界面
    MG.UI.showMainMenu();
    // 恢复上次选择的难度（可选）
    MG.UI.setSeed('');

    // 5.1) 每日签到：缓存 DOM、摆放入口按钮、刷角标，并安排 boot 后 700ms 自动弹一次
    //      （放在 showMainMenu 之后：入口按钮要依当前屏幕方向落到正确位置）
    if (MG.Checkin && typeof MG.Checkin.init === 'function') MG.Checkin.init();

    // 5.2) 开发者选项：挂 console/error 捕获、绑定面板事件（入口在长按商店的验证门之后）
    if (MG.Dev) MG.Dev.init();

    // 6) 页面可见性变化：切后台自动暂停；回前台主动探测上下文并强制重绘（BUG-029）
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        if (Game.state === 'playing') {
          // 切到后台的瞬间就清空输入状态：此时浏览器多半不会补发 touchend，
          // 提前清理比等恢复时再清更可靠（BUG-013 / BUG-014）
          if (Game.input && Game.input.resetInputs) Game.input.resetInputs();
          pauseGame();
        }
        return;
      }
      // 回到前台：有些内核对后台回收的上下文不派发 contextlost，但画布其实已经失效
      if (isContextLostNow()) {
        handleContextLost();
        return;
      }
      // 正常情况也主动画一帧：修复"回到前台画布不再参与合成"导致的空白
      forceRedraw();
    });

    // 7) 启动循环
    loop();

    console.info('%c3D迷宫探险 已启动', 'color:#35d0ff;font-weight:bold');
    console.info('Three.js 版本：', THREE.REVISION);
  }

  // DOM 就绪后启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // 导出（调试用）
  MG.boot = boot;
  MG.Game = Game;

})(window);
