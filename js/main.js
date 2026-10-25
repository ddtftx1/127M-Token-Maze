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
    state: 'menu',        // menu | loading | playing | paused | win
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
    mapFound: false,      // 本局是否已找到小地图道具
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
    _renderStopped: false // 渲染致命错误后停止循环
  };

  /** 暴露给 player.js 使用（路径可视化需要 scene） */
  MG.game = Game;

  /* ------------------------------------------------------------
   * 渲染器 / 场景 / 灯光 初始化
   * ---------------------------------------------------------- */
  function initThree() {
    var canvas = MG.UI.el['game-canvas'];
    var settings = MG.Settings.get();

    // 像素比：移动端限制，避免过热掉帧
    var maxDPR = settings.quality === 'high' ? 2 : (settings.quality === 'low' ? 1 : 1.5);
    var dpr = Math.min(window.devicePixelRatio || 1, maxDPR);

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

    renderer.setPixelRatio(dpr);
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    renderer.shadowMap.enabled = !!settings.shadows;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // 颜色/色调映射：让暗部细节更自然
    if ('outputColorSpace' in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;

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

  function startGame(diffKey, seed, isDaily) {
    if (Game._startPending) return;
    Game._startPending = true;

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
      // 重新置位：进入加载流程后，重复点"开始游戏"仍会被守卫拦下（防止连点双开）
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
      // 弹窗询问：玩家必须主动选择后才继续
      //（点击背景遮罩 / 按 ESC 视为"独自探险"，都属于明确的用户意志，不再做超时自动选择）
      var meta = MG.Replay.loadFull(diffKey, Game.seed);
      var ghostPrompt = MG.UI.showGhostDialog({
        diffName: Game.diff.name,
        time: (meta && typeof meta.time === 'number' && meta.time > 0)
          ? meta.time
          : (ghostFrames[ghostFrames.length - 1][3] || 0)
      });
      // 先注册"释放守卫"：弹窗无论以何种方式结束（玩家选择 / 被其它流程关闭），
      // 都不能让 _startPending 永久为 true，否则之后所有 startGame 会被静默吞掉
      ghostPrompt.then(releaseStartPending, releaseStartPending);
      ghostPrompt.then(function (res) {
        if (res.remember) {
          // 记住选择：写入设置（总是启用 / 从不启用）
          MG.Settings.set('ghostMode', res.choice === 'ghost' ? 'always' : 'never');
        }
        proceed(res.choice === 'ghost');
      });
      return;
    }

    proceed(hasGhost && ghostMode === 'always');
  }

  /** 生成并构建关卡 */
  function buildLevel(seed) {
    var settings = MG.Settings.get();
    var diff = Game.diff;

    MG.UI.setLoadingProgress(0.2, '生成迷宫结构…');

    // 1) 生成迷宫数据
    var maze = MG.Maze.generate(diff.cells, seed, 'dfs');
    // 打通部分环路（简单难度多一些，减少死路）
    var loopRatio = diff.key === 'simple' ? 0.10 : (diff.key === 'medium' ? 0.06 : 0.03);
    MG.Maze.carveLoops(maze, loopRatio);

    // 2) 起点终点
    var ep = MG.Maze.pickEndpoints(maze, diff.farCell);
    maze.start = ep.start;
    maze.end = ep.end;

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
    Game.player.onAutoFinish = function () {
      var p = Game.player;
      if (p && p.autoStoppedByLimit) {
        p.autoStoppedByLimit = false;
        // 限程停下的瞬间：若本次是"最佳路径"，顺手拾取所在格附近的金币
        // （避免"停在金币格上却没捡到"——拾取半径 1.5 覆盖整格，且不会隔墙误拾）
        var picked = 0;
        if (p.autoStoppedKind === 'best' && Game.mazeView) {
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

    // 7.1) 小地图道具：每局重新寻找（拾取后才可使用小地图）
    Game.mapFound = false;
    Game.mapHint = '';
    var mItem = Game.mazeView.mapItem;
    if (mItem && diff.key === 'simple') {
      var mdx = mItem.x - maze.start.x;
      var mdy = mItem.y - maze.start.y;
      var mdir = Math.abs(mdx) >= Math.abs(mdy) ? (mdx > 0 ? '东' : '西') : (mdy > 0 ? '南' : '北');
      Game.mapHint = '提示：地图在' + mdir + '侧';
    }
    MG.UI.updateMinimapLock(true, Game.mapHint);

    // 7.2) 回放记录器：记录本局路径（每 100ms 一帧）
    if (MG.Replay) Game.recorder = MG.Replay.createRecorder();

    // 7.3) 幽灵：按 ghostMode 分支加载（弹窗确认已在 loading 界面之前完成）
    disposeGhost();
    if (Game._pendingGhost && Game._pendingGhost.length > 1) {
      Game.ghostFrames = Game._pendingGhost;
      if (MG.Replay) Game.ghost = MG.Replay.createGhost(Game.scene);
      MG.UI.toast('👻 幽灵已就位，和它比一比吧', 2400);
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
    Game.clock.getDelta(); // 丢弃加载期间累积的时间

    MG.UI.toast('种子：' + Game.seed + '  难度：' + diff.name, 2200);
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
    if (Game.diffKey === 'medium') return 60;
    if (Game.diffKey === 'hard') return 50;
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
    var name = kind === 'best' ? '🧭 最佳路径' : '⚡ 最快路径';
    MG.UI.toast(name + '启动' + (limit && kind === 'best' ? '（本次限 ' + limit + ' 格）' : ''), 2200);
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
      if (view.mapItem && !view.mapItem.collected && !Game.mapFound) {
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
   * 使用道具（道具面板触发）
   * @param {string} itemId 'mapUnlock' | 'bestPath' | 'fastPath'
   */
  function useItem(itemId) {
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
        MG.UI.toast('道具不足');
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
      var ok = triggerAutoPath(kind);
      if (!ok) return;
      if (!MG.Shop.consumeItem(itemId)) {
        // 异常兜底：扣费失败则取消寻路，避免白嫖
        if (player) player.cancelAutoPath();
        MG.UI.toast('道具不足');
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
    MG.UI.hidePause();
    // 兜底：任何恢复路径都必须让 HUD 可见（避免经设置面板返回后 HUD 丢失）
    MG.UI.show('hud');
    Game.state = 'playing';
    Game.clock.getDelta(); // 丢弃暂停期间累积时间
  }

  function restartGame() {
    clearAchieveToastTimer();
    MG.UI.hidePause();
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
  }

  /* ------------------------------------------------------------
   * 胜利处理
   * ---------------------------------------------------------- */
  function onVictory() {
    if (Game.state === 'win') return;
    Game.state = 'win';

    var diff = Game.diff;
    var player = Game.player;
    if (player) player.cancelAutoPath();
    if (Game.input) Game.input.exitPointerLock();

    // 金币汇入钱包：× 收益倍率结算，但保证不低于原始拾取数
    // （避免小数被向下取整后，玩家买了 +25% 加成却感知不到，例如 3×1.25=3.75 → 3）
    var coinsEarned = 0;
    if (MG.Shop) {
      var rawEarn = Game.collectedCoins * MG.Shop.coinMultiplier();
      coinsEarned = Math.max(Game.collectedCoins, Math.round(rawEarn));
      if (coinsEarned > 0) MG.Shop.addCoins(coinsEarned);
    }

    // 提交记录
    var res = MG.Settings.submitRecord(diff.key, Game.elapsed, player ? player.steps : 0);

    // 提交本地排行榜（按难度分区，仅保留前 10 名）
    var rankRes = { rank: 0 };
    if (MG.Ranking) {
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
    if (MG.Replay && Game.recorder && player) {
      var recFrames = Game.recorder.finish(player.pos.x, player.pos.z, player.yaw);
      hasReplay = MG.Replay.save(diff.key, Game.seed, recFrames, {
        time: Game.elapsed,
        steps: player.steps,
        auto: Game.usedAutoPath
      });
    }

    // 成就判定
    var newAchievements = [];
    if (MG.Settings.unlockAchievement('first_win')) newAchievements.push('初次通关');
    if (!Game.usedAutoPath && MG.Settings.unlockAchievement('no_autopath')) newAchievements.push('自力更生');
    if (diff.key === 'hard' && MG.Settings.unlockAchievement('hard_win')) newAchievements.push('勇者无畏');
    if (diff.key === 'simple' && Game.elapsed <= 40 && MG.Settings.unlockAchievement('fast_simple')) newAchievements.push('疾风步');

    var wins = MG.Settings.bumpCounter('wins');
    if (wins >= 5 && MG.Settings.unlockAchievement('explorer')) newAchievements.push('探险家');

    if (Game.mazeView && Game.mazeView.totalCoins > 0 &&
        Game.collectedCoins >= Game.mazeView.totalCoins) {
      if (MG.Settings.unlockAchievement('collector')) newAchievements.push('收藏家');
    }

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
      // 记住定时器 id：若玩家在 1.2 秒内返回菜单 / 重开 / 再玩一次，要能取消掉
      if (Game._achieveToastTimer) clearTimeout(Game._achieveToastTimer);
      Game._achieveToastTimer = setTimeout(function () {
        Game._achieveToastTimer = null;
        MG.UI.toast('🏆 解锁成就：' + newAchievements.join('、'), 3000);
        if (MG.Audio) MG.Audio.achieve();
      }, 1200);
    }
  }

  /** 取消通关后延迟弹出的成就提示（避免 toast 掉到菜单 / 新一局里） */
  function clearAchieveToastTimer() {
    if (Game._achieveToastTimer) {
      clearTimeout(Game._achieveToastTimer);
      Game._achieveToastTimer = null;
    }
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

      var raycaster = new THREE.Raycaster(origin, toCam, 0, maxDist);
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

  function loop() {
    if (Game._renderStopped) return; // 渲染致命错误后停止循环（不再调度下一帧）
    requestAnimationFrame(loop);

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

      // 6) 金币收集（"最快路径"忽略沿途收集；"最佳路径"拾取半径略放宽，留出路径圆角的误差余量）
      var autoKind = Game.player.autoActive ? Game.player.autoKind : null;
      if (autoKind !== 'fast') {
        var collectRadius = autoKind === 'best' ? 1.1 : 0.85;
        var got = Game.mazeView.tryCollect(Game.player.pos.x, Game.player.pos.z, collectRadius);
        if (got > 0) {
          Game.collectedCoins += got;
          if (MG.Audio) MG.Audio.coin();
          MG.UI.toast('+' + got + ' 金币（' + Game.collectedCoins + '/' + Game.mazeView.totalCoins + '）', 1000);
        }

        // 6.5) 地图道具拾取（解锁小地图）
        if (!Game.mapFound && Game.mazeView.tryCollectMap(Game.player.pos.x, Game.player.pos.z, 1.2)) {
          Game.mapFound = true;
          if (MG.Audio) MG.Audio.mapFound();
          MG.UI.toast('已找到迷宫地图，小地图已解锁', 2600);
          MG.UI.updateMinimapLock(false, Game.mapHint);
          updateHudData(); // 距离信息立即恢复显示
        }
      }

      // 7) 终点判定
      if (Game.player.reachedEnd()) {
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

    // 渲染
    if (Game.renderer && Game.scene && Game.camera) {
      try {
        Game.renderer.render(Game.scene, Game.camera);
      } catch (e) {
        // 渲染异常：只提示一次，并停止渲染循环 + 给出可见错误界面（避免用户一直黑屏无感知）
        if (!Game._renderErrLogged) {
          Game._renderErrLogged = true;
          console.error('[game] 渲染异常', e);
          Game._renderStopped = true;
          fatal('渲染异常', '请尝试刷新页面或更换浏览器。');
        }
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
      if (Game.renderer) {
        Game.renderer.shadowMap.enabled = shadowsOn;
      }
      if (Game.sun) Game.sun.castShadow = shadowsOn;
      if (Game.mazeView && Game.mazeView.walls) {
        Game.mazeView.walls.castShadow = shadowsOn;
        Game.mazeView.walls.receiveShadow = shadowsOn;
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

    // 画质（像素比）
    if (evt.key === 'quality' || evt.reset) {
      applyPixelRatio();
      onResize();
      // 抗锯齿等渲染器参数在创建时固定，运行时切换画质无法完全生效（明确提示）
      if (evt.key === 'quality' && Game.state === 'playing') {
        MG.UI.toast('画质切换后建议重开一局以完全生效', 2500);
      }
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
  function boot() {
    // 1) 先加载设置（localStorage）
    MG.Settings.load();

    // 2) 初始化 UI（绑定按钮）
    MG.UI.init();

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
      // 道具面板开启时：ESC / P 键优先关闭面板（不弹暂停菜单、不恢复）
      if (Game.itemPanelOpen) { closeItemPanel(); return; }
      if (Game.state === 'replay') exitReplay();
      else if (Game.state === 'playing') pauseGame();
      else if (Game.state === 'paused') resumeGame();
    };
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

    // 6) 页面可见性变化自动暂停（移动端体验）
    document.addEventListener('visibilitychange', function () {
      if (document.hidden && Game.state === 'playing') {
        pauseGame();
      }
    });

    // 7) 启动循环
    loop();

    // 8) 全局错误捕获（便于排查，不影响体验）
    window.addEventListener('error', function (e) {
      console.error('[game] 运行错误', e.message, e.filename, e.lineno);
    });

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