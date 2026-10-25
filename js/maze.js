/* ============================================================
 * js/maze.js
 * 迷宫模块
 * - 难度参数表
 * - 可复现随机数（种子 / 每日挑战）
 * - DFS 递归回溯 与 Prim 两种生成算法
 * - 网格数据（2n+1 尺寸，1=墙 0=通路）
 * - Three.js 场景构建：地面 / 墙体(InstancedMesh) / 天花板 / 起点 / 终点传送门 / 粒子 / 金币
 * ============================================================ */
(function (global) {
  'use strict';

  var MG = global.MG = global.MG || {};
  var THREE = global.THREE;

  /** 单元格世界尺寸（米） */
  var CELL = 2.0;

  /* ------------------------------------------------------------
   * 难度配置
   * ---------------------------------------------------------- */
  var DIFFICULTIES = {
    simple: {
      key: 'simple', name: '简单',
      cells: 5,              // 5x5 单元格 → 11x11 网格
      wallHeight: 2.5,
      fogDensity: 0.00054,   // 很淡的雾（整体降低 40%，提升可见度）
      fogColorHex: 0x0a1420,
      autoPathMax: Infinity, // 预留，当前未使用（自动寻路无限次）
      autoPathCooldown: 5,   // 预留，当前未使用（冷却很短）
      farCell: false,        // 终点距离策略：false=对角，true=额外更远
      coins: 3,
      ceiling: true,
      color: 0x2a4a6b
    },
    medium: {
      key: 'medium', name: '中等',
      cells: 10,             // 10x10 → 21x21
      wallHeight: 3.0,
      fogDensity: 0.012,     // 降低 40%，提升可见度
      fogColorHex: 0x081018,
      autoPathMax: 3,        // 预留，当前未使用
      autoPathCooldown: 30,  // 预留，当前未使用
      farCell: true,
      coins: 6,
      ceiling: true,
      color: 0x2f5578
    },
    hard: {
      key: 'hard', name: '困难',
      cells: 15,             // 15x15 → 31x31（GPU 友好，墙体仅几百个实例）
      wallHeight: 3.5,
      fogDensity: 0.0252,    // 雾较浓（整体降低 40%）
      fogColorHex: 0x040a12,
      autoPathMax: 1,        // 预留，当前未使用
      autoPathCooldown: 60,  // 预留，当前未使用
      farCell: true,
      coins: 10,
      ceiling: true,
      color: 0x35507a
    }
  };

  /* ------------------------------------------------------------
   * 随机数：字符串种子 → 32 位整数 → mulberry32
   * ---------------------------------------------------------- */
  function hashString(str) {
    var h = 2166136261 >>> 0; // FNV-1a
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** 生成可读随机种子 */
  function randomSeed() {
    var chars = 'abcdefghijkmnpqrstuvwxyz23456789';
    var out = '';
    for (var i = 0; i < 8; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  }

  /** 每日挑战种子（按世界时区日期，全球一致） */
  function dailySeed() {
    var d = new Date();
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return 'daily-' + y + m + day;
  }

  /* ------------------------------------------------------------
   * 迷宫数据生成
   * ---------------------------------------------------------- */

  /**
   * 生成迷宫网格
   * @param {number} cellCount 单元格边长（如 10 → 网格 21x21）
   * @param {string} seedStr 种子字符串
   * @param {string} algorithm 'dfs' | 'prim'
   * @returns {{grid:Uint8Array, size:number, cells:number, seed:string, rng:Function}}
   */
  function generate(cellCount, seedStr, algorithm) {
    // 统一"有效种子"：空值回落为随机种子，并保证返回对象中的 seed 与实际使用的一致
    // （回放 / 幽灵 / 排行榜均按 seed 存储，返回空串会导致这些功能失效）
    var effective = (seedStr == null || seedStr === '') ? randomSeed() : String(seedStr);
    var seedNum = hashString(effective);
    var rng = mulberry32(seedNum);
    var cells = Math.max(2, Math.floor(cellCount));
    var size = cells * 2 + 1; // 网格尺寸
    var grid = new Uint8Array(size * size).fill(1); // 1 = 墙

    function idx(x, y) { return y * size + x; }

    // 单元格坐标 (cx, cy) 映射到网格坐标 (cx*2+1, cy*2+1)
    var visited = new Uint8Array(cells * cells);

    if (algorithm === 'prim') {
      primMaze(grid, size, cells, visited, rng, idx);
    } else {
      dfsMaze(grid, size, cells, visited, rng, idx);
    }

    return { grid: grid, size: size, cells: cells, seed: effective, rng: rng };
  }

  /** DFS 递归回溯（显式栈，避免深递归爆栈） */
  function dfsMaze(grid, size, cells, visited, rng, idx) {
    var stack = [];
    var startCx = Math.floor(rng() * cells);
    var startCy = Math.floor(rng() * cells);
    visited[startCy * cells + startCx] = 1;
    grid[idx(startCx * 2 + 1, startCy * 2 + 1)] = 0;
    stack.push([startCx, startCy]);

    var DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

    while (stack.length > 0) {
      var cur = stack[stack.length - 1];
      var cx = cur[0], cy = cur[1];

      // 收集未访问邻居
      var neighbors = [];
      for (var d = 0; d < 4; d++) {
        var nx = cx + DIRS[d][0];
        var ny = cy + DIRS[d][1];
        if (nx >= 0 && ny >= 0 && nx < cells && ny < cells && !visited[ny * cells + nx]) {
          neighbors.push([nx, ny, DIRS[d][0], DIRS[d][1]]);
        }
      }

      if (neighbors.length === 0) {
        stack.pop();
        continue;
      }

      var pick = neighbors[Math.floor(rng() * neighbors.length)];
      var nx2 = pick[0], ny2 = pick[1], dx = pick[2], dy = pick[3];
      visited[ny2 * cells + nx2] = 1;
      grid[idx(nx2 * 2 + 1, ny2 * 2 + 1)] = 0;
      // 打通中间墙
      grid[idx(cx * 2 + 1 + dx, cy * 2 + 1 + dy)] = 0;
      stack.push([nx2, ny2]);
    }
  }

  /** Prim 随机生成（随机化 Prim） */
  function primMaze(grid, size, cells, visited, rng, idx) {
    var DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    var front = [];

    var sx = Math.floor(rng() * cells), sy = Math.floor(rng() * cells);
    visited[sy * cells + sx] = 1;
    grid[idx(sx * 2 + 1, sy * 2 + 1)] = 0;
    pushFront(front, sx, sy);

    function pushFront(front, cx, cy) {
      for (var d = 0; d < 4; d++) {
        var nx = cx + DIRS[d][0], ny = cy + DIRS[d][1];
        if (nx >= 0 && ny >= 0 && nx < cells && ny < cells && !visited[ny * cells + nx]) {
          front.push([cx, cy, nx, ny]);
        }
      }
    }

    while (front.length > 0) {
      var i = Math.floor(rng() * front.length);
      var edge = front.splice(i, 1)[0];
      var cx = edge[0], cy = edge[1], nx = edge[2], ny = edge[3];
      if (visited[ny * cells + nx]) continue;

      visited[ny * cells + nx] = 1;
      grid[idx(nx * 2 + 1, ny * 2 + 1)] = 0;
      // 打通两格之间的墙
      var wx = cx * 2 + 1 + (nx - cx);
      var wy = cy * 2 + 1 + (ny - cy);
      grid[idx(wx, wy)] = 0;
      pushFront(front, nx, ny);
    }
  }

  /**
   * 在迷宫里额外打通一些墙，形成环路（减少死胡同，让玩法更顺畅）
   * 简单难度打得多一点，困难少一点
   */
  function carveLoops(maze, extraRatio) {
    var size = maze.size;
    var grid = maze.grid;
    var rng = maze.rng;
    var candidates = [];
    for (var y = 1; y < size - 1; y++) {
      for (var x = 1; x < size - 1; x++) {
        if (x % 2 === 0 && y % 2 === 1) candidates.push([x, y]); // 竖墙候选
        if (x % 2 === 1 && y % 2 === 0) candidates.push([x, y]); // 横墙候选
      }
    }
    var count = Math.floor(candidates.length * (extraRatio || 0.06));
    for (var i = 0; i < count && candidates.length; i++) {
      var k = Math.floor(rng() * candidates.length);
      var c = candidates.splice(k, 1)[0];
      grid[c[1] * size + c[0]] = 0;
    }
  }

  /**
   * 选取起点与终点
   * 起点固定左上角单元格（1,1），终点默认右下角；
   * farCell=true 时在若干候选点里挑一个曼哈顿距离最远的格子（更远）
   */
  function pickEndpoints(maze, farCell) {
    var size = maze.size;
    var start = { x: 1, y: 1 };
    var end = { x: size - 2, y: size - 2 };

if (farCell) {
  // 在通路格中挑离起点最远的（曼哈顿距离）
  // 约束 x + y > size * 0.5：只在"偏后半区"的通路格里挑，避免终点落在起点附近；
  // 用 size 的一半而不是更严格的值，保证小迷宫（cells=5 → size=11）里也有足够的候选格。
  var best = null, bestD = -1;
  var halfSum = size * 0.5;
        for (var y = 1; y < size - 1; y += 2) {
        for (var x = 1; x < size - 1; x += 2) {
          if (maze.grid[y * size + x] !== 0) continue;
          var d = Math.abs(x - start.x) + Math.abs(y - start.y);
          if (d > bestD && x + y > halfSum) { bestD = d; best = { x: x, y: y }; }
        }
      }
      if (best) end = best;
    }

    // 兜底：终点必须是 [1, size-2] 内的通路格；
    // 若默认角落不是通路，退化为"离起点最远的通路格"（仍在内部区域）
    if (!isOpen(maze, end.x, end.y)) {
      var alt = null, altD = -1;
      for (var ay = 1; ay < size - 1; ay += 2) {
        for (var ax = 1; ax < size - 1; ax += 2) {
          if (maze.grid[ay * size + ax] !== 0) continue;
          var ad = Math.abs(ax - start.x) + Math.abs(ay - start.y);
          if (ad > altD) { altD = ad; alt = { x: ax, y: ay }; }
        }
      }
      if (alt) end = alt;
    }
    return { start: start, end: end };
  }

  /** 检查通路（不越界且非墙） */
  function isOpen(maze, x, y) {
    if (x < 0 || y < 0 || x >= maze.size || y >= maze.size) return false;
    return maze.grid[y * maze.size + x] === 0;
  }

  /** 收集所有可选金币点位（通路，且不在起点/终点） */
  function pickCoinSpots(maze, start, end, count, rng) {
    var size = maze.size;
    var spots = [];
    for (var y = 1; y < size - 1; y++) {
      for (var x = 1; x < size - 1; x++) {
        if (maze.grid[y * size + x] !== 0) continue;
        if (x === start.x && y === start.y) continue;
        if (x === end.x && y === end.y) continue;
        // 撞击检测：距起点太近不放，避免无意义
        var dStart = Math.abs(x - start.x) + Math.abs(y - start.y);
        if (dStart < 4) continue;
        spots.push({ x: x, y: y });
      }
    }
    // 洗牌（Fisher–Yates）
    for (var i = spots.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = spots[i]; spots[i] = spots[j]; spots[j] = t;
    }
    return spots.slice(0, count);
  }

  /**
   * 选取"迷宫地图"道具位置（每局只生成 1 个）
   * 条件：通路格、曼哈顿距离起点 ≥8 格、避开起点/终点/金币格
   */
  function pickMapSpot(maze, start, end, coinSpots, rng) {
    var size = maze.size;
    var MIN_DIST = 8;
    var coinSet = {};
    if (coinSpots) {
      for (var ci = 0; ci < coinSpots.length; ci++) {
        coinSet[coinSpots[ci].y * size + coinSpots[ci].x] = 1;
      }
    }

    function collect(excludeCoins, minDist) {
      var out = [];
      for (var y = 1; y < size - 1; y++) {
        for (var x = 1; x < size - 1; x++) {
          if (maze.grid[y * size + x] !== 0) continue;
          if (x === start.x && y === start.y) continue;
          if (end && x === end.x && y === end.y) continue;
          if (excludeCoins && coinSet[y * size + x]) continue;
          if (Math.abs(x - start.x) + Math.abs(y - start.y) < minDist) continue;
          out.push({ x: x, y: y });
        }
      }
      return out;
    }

    var pool = collect(true, MIN_DIST);
    if (pool.length === 0) pool = collect(false, MIN_DIST);
    if (pool.length === 0) pool = collect(false, 4); // 极端兜底：仍尽量远离起点
    if (pool.length === 0) return null;
    return pool[Math.floor(rng() * pool.length)];
  }

  /* ============================================================
   * 三维场景构建
   * ========================================================== */

  /** 主题颜色配置（与 CSS 主题联动）；sky=无雾时的背景色，ground=半球光地面反射色 */
  var THEMES = {
    tech:    { wall: 0x345a82, wall2: 0x1d3450, floor: 0x121c2c, ceil: 0x0d151f, fog: 0x0a1420, light: 0x88ccff, accent: 0x35d0ff, sky: 0x0a1420, ground: 0x0a0a12 },
    dungeon: { wall: 0x5a4734, wall2: 0x352a1e, floor: 0x1e1610, ceil: 0x19120d, fog: 0x140e08, light: 0xffc07a, accent: 0xffb45c, sky: 0x140e08, ground: 0x1a120c },
    forest:  { wall: 0x3a643f, wall2: 0x22402a, floor: 0x152a14, ceil: 0x102211, fog: 0x0d1c10, light: 0xaaffa0, accent: 0x86e57a, sky: 0x0d1c10, ground: 0x0c1a0c }
  };

  /**
   * MazeView：负责把迷宫数据渲染为 Three.js 场景对象
   */
  function MazeView(scene, maze, diff, theme, quality, settings) {
    this.scene = scene;
    this.maze = maze;
    this.diff = diff;
    this.quality = quality || 'mid';
    this.settings = settings || {};
    this.theme = THEMES[theme] || THEMES.tech;
    this.group = new THREE.Group();
    this.group.name = 'mazeRoot';
    this.walls = null;
    this.coins = [];       // {mesh, x, y, collected}
    this.mapItem = null;   // 迷宫地图道具 {group, board, glow, ring, x, y, world, collected}
    this.particles = null; // 终点粒子
    this.time = 0;
    this.build();
  }

  /** 网格坐标 → 世界坐标（格心） */
  function cellToWorld(gx, gy, maze) {
    var half = (maze.size * CELL) / 2;
    return { x: gx * CELL - half + CELL / 2, z: gy * CELL - half + CELL / 2 };
  }

  MazeView.prototype.build = function () {
    var maze = this.maze;
    var diff = this.diff;
    var size = maze.size;
    var half = (size * CELL) / 2;
    var t = this.theme;
    var needShadows = !!this.settings.shadows && this.quality !== 'low';

    /* ---------- 地面 ---------- */
    var floorMat = new THREE.MeshLambertMaterial({ color: t.floor });
    var floorGeo = new THREE.PlaneGeometry(size * CELL, size * CELL);
    var floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0;
    floor.receiveShadow = needShadows;
    this.group.add(floor);
    this.floor = floor;

    /* ---------- 地板网格线（Canvas 动态纹理，增强纵深感） ---------- */
    var gridTex = makeGridTexture(t, 256);
    gridTex.wrapS = gridTex.wrapT = THREE.RepeatWrapping;
    gridTex.repeat.set(size * 0.5, size * 0.5);
    var gridMat = new THREE.MeshBasicMaterial({
      map: gridTex, transparent: true, opacity: 0.35, depthWrite: false
    });
    var gridPlane = new THREE.Mesh(floorGeo, gridMat);
    gridPlane.rotation.x = -Math.PI / 2;
    gridPlane.position.y = 0.01;
    this.group.add(gridPlane);
    this.gridPlane = gridPlane;

    /* ---------- 天花板（可选） ---------- */
    if (diff.ceiling) {
      // FrontSide：迷宫内部可见；俯视（回放全景视角）时不会遮挡视野（修复回放视角 bug）
      var ceilMat = new THREE.MeshLambertMaterial({ color: t.ceil, side: THREE.FrontSide });
      var ceil = new THREE.Mesh(floorGeo, ceilMat);
      ceil.rotation.x = Math.PI / 2;
      ceil.position.y = diff.wallHeight;
      this.group.add(ceil);
      this.ceiling = ceil;
    }

    /* ---------- 墙体：InstancedMesh ---------- */
    var wallPositions = [];
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        if (maze.grid[y * size + x] === 1) wallPositions.push([x, y]);
      }
    }

    var wallGeo = new THREE.BoxGeometry(CELL, diff.wallHeight, CELL);
    // 用顶面稍亮的自定义：Lambert 足够，另加一层"砖纹"纹理
    var wallTex = makeWallTexture(t, 128);
    wallTex.wrapS = wallTex.wrapT = THREE.RepeatWrapping;
    var wallMat = new THREE.MeshLambertMaterial({ map: wallTex, color: t.wall });

    var inst = new THREE.InstancedMesh(wallGeo, wallMat, wallPositions.length);
    inst.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    var m4 = new THREE.Matrix4();
    for (var i = 0; i < wallPositions.length; i++) {
      var p = wallPositions[i];
      var w = cellToWorld(p[0], p[1], maze);
      m4.makeTranslation(w.x, diff.wallHeight / 2, w.z);
      inst.setMatrixAt(i, m4);
      // 轻微色差（用 instanceColor）
      if (inst.instanceColor) { /* 占位：部分版本需手动开启 */ }
    }
    inst.instanceMatrix.needsUpdate = true;
    inst.castShadow = needShadows;
    inst.receiveShadow = needShadows;
    inst.frustumCulled = true;
    this.walls = inst;
    this.group.add(inst);

    // 外墙加高一点 + 暖色边缘光（用一层简单 Box 表示"墙檐"）
    // 出于性能考虑仅在非低画质时添加
    if (this.quality !== 'low') {
      var capMat = new THREE.MeshBasicMaterial({
        color: t.accent, transparent: true, opacity: 0.10, depthWrite: false
      });
      var capGeo = new THREE.BoxGeometry(CELL, 0.08, CELL);
      var cap = new THREE.InstancedMesh(capGeo, capMat, wallPositions.length);
      for (var k = 0; k < wallPositions.length; k++) {
        var pp = wallPositions[k];
        var ww = cellToWorld(pp[0], pp[1], maze);
        m4.makeTranslation(ww.x, diff.wallHeight - 0.04, ww.z);
        cap.setMatrixAt(k, m4);
      }
      cap.instanceMatrix.needsUpdate = true;
      this.group.add(cap);
      this.caps = cap;
    }

    /* ---------- 起点标记（绿色光点） ---------- */
    var sWorld = cellToWorld(maze.start.x, maze.start.y, maze);
    var startColor = 0x44ff88;
    var startRing = new THREE.Mesh(
      new THREE.RingGeometry(CELL * 0.30, CELL * 0.42, 32),
      new THREE.MeshBasicMaterial({ color: startColor, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false })
    );
    startRing.rotation.x = -Math.PI / 2;
    startRing.position.set(sWorld.x, 0.03, sWorld.z);
    this.group.add(startRing);

    var startOrb = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 16, 12),
      new THREE.MeshBasicMaterial({ color: startColor })
    );
    startOrb.position.set(sWorld.x, 0.9, sWorld.z);
    this.group.add(startOrb);
    this.startOrb = startOrb;
    this.startRing = startRing;
    this.startWorld = sWorld;

    var startLight = new THREE.PointLight(startColor, 1.1, CELL * 5, 2);
    startLight.position.set(sWorld.x, 1.4, sWorld.z);
    this.group.add(startLight);

    /* ---------- 终点：传送门 + 光柱 + 粒子 ---------- */
    var eWorld = cellToWorld(maze.end.x, maze.end.y, maze);
    this.endWorld = eWorld;
    var endColor = 0xb27dff;

    var portalGroup = new THREE.Group();
    portalGroup.position.set(eWorld.x, 0, eWorld.z);

    // 地面光圈
    var portalRing = new THREE.Mesh(
      new THREE.RingGeometry(CELL * 0.28, CELL * 0.46, 40),
      new THREE.MeshBasicMaterial({ color: endColor, transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false })
    );
    portalRing.rotation.x = -Math.PI / 2;
    portalRing.position.y = 0.04;
    portalGroup.add(portalRing);
    this.portalRing = portalRing;

    // 竖向光柱（半透明圆柱）
    var pillarGeo = new THREE.CylinderGeometry(0.55, 0.9, diff.wallHeight * 1.15, 24, 1, true);
    var pillarMat = new THREE.MeshBasicMaterial({
      color: endColor, transparent: true, opacity: 0.22,
      side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending
    });
    var pillar = new THREE.Mesh(pillarGeo, pillarMat);
    pillar.position.y = diff.wallHeight * 0.575;
    portalGroup.add(pillar);
    this.portalPillar = pillar;

    // 内核
    var core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.42, 1),
      new THREE.MeshBasicMaterial({ color: 0xffffff })
    );
    core.position.y = 1.1;
    portalGroup.add(core);
    this.portalCore = core;

    // 终点灯
    var endLight = new THREE.PointLight(endColor, 2.0, CELL * 8, 2);
    endLight.position.set(0, 1.6, 0);
    portalGroup.add(endLight);
    this.endLight = endLight;

    // 粒子（Points）
    var pCount = this.quality === 'low' ? 60 : (this.quality === 'high' ? 220 : 140);
    var pGeo = new THREE.BufferGeometry();
    var pos = new Float32Array(pCount * 3);
    this.pBaseY = new Float32Array(pCount);
    this.pSpeed = new Float32Array(pCount);
    for (var pi = 0; pi < pCount; pi++) {
      var ang = Math.random() * Math.PI * 2;
      var rad = Math.random() * CELL * 0.45;
      pos[pi * 3] = Math.cos(ang) * rad;
      pos[pi * 3 + 1] = Math.random() * diff.wallHeight;
      pos[pi * 3 + 2] = Math.sin(ang) * rad;
      this.pBaseY[pi] = pos[pi * 3 + 1];
      this.pSpeed[pi] = 0.3 + Math.random() * 0.9;
    }
    pGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    var pMat = new THREE.PointsMaterial({
      color: endColor, size: 0.13, transparent: true, opacity: 0.9,
      depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true
    });
    var points = new THREE.Points(pGeo, pMat);
    portalGroup.add(points);
    this.particles = points;

    this.group.add(portalGroup);
    this.portal = portalGroup;

    /* ---------- 金币（收集品） ---------- */
    var coinSpots = pickCoinSpots(maze, maze.start, maze.end, diff.coins, maze.rng);
    var coinGeo = new THREE.TorusGeometry(0.26, 0.09, 8, 20);
    var coinMat = new THREE.MeshLambertMaterial({ color: 0xffd24a, emissive: 0x4a3200 });
    for (var ci = 0; ci < coinSpots.length; ci++) {
      var cw = cellToWorld(coinSpots[ci].x, coinSpots[ci].y, maze);
      var coin = new THREE.Mesh(coinGeo, coinMat.clone());
      coin.position.set(cw.x, 1.0, cw.z);
      coin.rotation.x = Math.PI / 2;
      this.group.add(coin);
      this.coins.push({ mesh: coin, x: coinSpots[ci].x, y: coinSpots[ci].y, world: cw, collected: false });
    }
    this.totalCoins = this.coins.length;

    /* ---------- 迷宫地图道具（每局 1 个，拾取后解锁小地图） ---------- */
    var mapSpot = pickMapSpot(maze, maze.start, maze.end, coinSpots, maze.rng);
    this.mapItem = null;
    if (mapSpot) {
      var mw = cellToWorld(mapSpot.x, mapSpot.y, maze);
      var mapGroup = new THREE.Group();
      mapGroup.position.set(mw.x, 0, mw.z);

      // 主体：卷轴摊开的"地图"平板（扁盒）
      var board = new THREE.Mesh(
        new THREE.BoxGeometry(0.62, 0.46, 0.06),
        new THREE.MeshLambertMaterial({ color: 0xf2dda6, emissive: 0x7a5410 })
      );
      board.position.y = 1.12;
      mapGroup.add(board);

      // 两端卷轴杆
      var rodGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.56, 10);
      var rodMat = new THREE.MeshLambertMaterial({ color: 0x9a6428, emissive: 0x3a2206 });
      var rodL = new THREE.Mesh(rodGeo, rodMat);
      rodL.position.set(-0.36, 1.12, 0);
      var rodR = new THREE.Mesh(rodGeo, rodMat);
      rodR.position.set(0.36, 1.12, 0);
      mapGroup.add(rodL);
      mapGroup.add(rodR);

      // 顶部微光小球
      var glow = new THREE.Mesh(
        new THREE.SphereGeometry(0.09, 12, 10),
        new THREE.MeshBasicMaterial({ color: 0xffe9b0 })
      );
      glow.position.y = 1.62;
      mapGroup.add(glow);

      // 地面光环
      var mapRing = new THREE.Mesh(
        new THREE.RingGeometry(0.5, 0.72, 36),
        new THREE.MeshBasicMaterial({
          color: 0xffd980, transparent: true, opacity: 0.5,
          side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending
        })
      );
      mapRing.rotation.x = -Math.PI / 2;
      mapRing.position.y = 0.03;
      mapGroup.add(mapRing);

      // 小范围灯光（帮助在暗处被发现）
      var mapLight = new THREE.PointLight(0xffd980, 0.9, 7, 2);
      mapLight.position.set(0, 1.5, 0);
      mapGroup.add(mapLight);

      this.group.add(mapGroup);
      this.mapItem = {
        group: mapGroup, board: board, glow: glow, ring: mapRing,
        x: mapSpot.x, y: mapSpot.y, world: mw, collected: false
      };
    }

    /* ---------- 场景组装 ---------- */
    this.scene.add(this.group);

    // 世界尺寸信息
    this.worldHalf = half;
    this.worldSize = size * CELL;

    // 色盲友好模式：仅在开启时创建文字标识 Sprite（关闭时不产生任何额外开销）
    if (this.settings.colorblind) this.setColorblind(true);
  };

  /**
   * 运行时切换主题：只刷新已建好场景的材质颜色 / 纹理，不重建关卡
   * （玩家位置、计时、步数、收集状态全部保持；配合 main.js 的雾 / 背景 / 灯光一起生效）
   * @param {string} themeName tech | dungeon | forest
   */
  MazeView.prototype.applyTheme = function (themeName) {
    var t = THEMES[themeName] || THEMES.tech;
    this.theme = t;

    // 墙体（InstancedMesh，整体共用一份材质）：颜色 + 砖纹纹理都按新主题重建
    if (this.walls && this.walls.material) {
      var wm = this.walls.material;
      if (wm.color) wm.color.setHex(t.wall);
      if (wm.map) wm.map.dispose();
      var newWallTex = makeWallTexture(t, 128);
      newWallTex.wrapS = newWallTex.wrapT = THREE.RepeatWrapping;
      wm.map = newWallTex;
      wm.needsUpdate = true;
    }

    // 地板
    if (this.floor && this.floor.material && this.floor.material.color) {
      this.floor.material.color.setHex(t.floor);
      this.floor.material.needsUpdate = true;
    }

    // 天花板（部分难度没有天花板）
    if (this.ceiling && this.ceiling.material && this.ceiling.material.color) {
      this.ceiling.material.color.setHex(t.ceil);
      this.ceiling.material.needsUpdate = true;
    }

    // 墙檐（仅非低画质存在）：跟随主题强调色
    if (this.caps && this.caps.material && this.caps.material.color) {
      this.caps.material.color.setHex(t.accent);
      this.caps.material.needsUpdate = true;
    }
  };

  /** 当前主题名（tech / dungeon / forest），供外部查询 */
  MazeView.prototype.getThemeName = function () {
    var names = ['tech', 'dungeon', 'forest'];
    for (var i = 0; i < names.length; i++) {
      if (THEMES[names[i]] === this.theme) return names[i];
    }
    return 'tech';
  };

  /**
   * 启用 / 关闭色盲友好模式的 3D 文字标识（"币 / 图 / 起 / 终"）
   * - 只增删 Sprite，不重建关卡，玩家位置 / 计时 / 步数 / 收集状态全部不受影响
   * - 文字纹理共享缓存，反复切换不会重复绘制
   * @param {boolean} on 是否启用
   */
  MazeView.prototype.setColorblind = function (on) {
    var want = !!on;
    var i;

    // 金币："币"
    for (i = 0; i < this.coins.length; i++) {
      var c = this.coins[i];
      if (want && !c.sprite) {
        c.sprite = makeTextSprite('币', { size: 0.6 });
        c.sprite.position.set(c.world.x, c.mesh.position.y + 0.6, c.world.z);
        c.sprite.visible = !c.collected;
        this.group.add(c.sprite);
      } else if (!want && c.sprite) {
        disposeSprite(c.sprite);
        c.sprite = null;
      }
    }

    // 地图卷轴："图"（挂在 mapGroup 上，跟随上下漂浮）
    if (this.mapItem) {
      var mi = this.mapItem;
      if (want && !mi.sprite) {
        mi.sprite = makeTextSprite('图', { size: 0.6, y: 2.15 });
        mi.sprite.visible = !mi.collected;
        mi.group.add(mi.sprite);
      } else if (!want && mi.sprite) {
        disposeSprite(mi.sprite);
        mi.sprite = null;
      }
    }

    // 起点光球："起"
    if (want && !this.startSprite && this.startWorld) {
      this.startSprite = makeTextSprite('起', { size: 0.66, y: 1.55 });
      this.startSprite.position.x = this.startWorld.x;
      this.startSprite.position.z = this.startWorld.z;
      this.group.add(this.startSprite);
    } else if (!want && this.startSprite) {
      disposeSprite(this.startSprite);
      this.startSprite = null;
    }

    // 终点传送门："终"（放在光柱中上方）
    if (want && !this.endSprite && this.portal) {
      var h = this.diff && this.diff.wallHeight ? this.diff.wallHeight : 3;
      this.endSprite = makeTextSprite('终', { size: 0.72, y: h * 0.75 });
      this.portal.add(this.endSprite);
    } else if (!want && this.endSprite) {
      disposeSprite(this.endSprite);
      this.endSprite = null;
    }
  };

  /** 每帧更新（粒子 / 传送门旋转 / 金币旋转） */
  MazeView.prototype.update = function (dt, elapsed) {
    this.time += dt;
    // 传送门旋转
    if (this.portalRing) this.portalRing.rotation.z += dt * 0.6;
    if (this.portalCore) {
      this.portalCore.rotation.y += dt * 1.4;
      this.portalCore.rotation.x += dt * 0.8;
      var sc = 1 + Math.sin(this.time * 3.2) * 0.08;
      this.portalCore.scale.set(sc, sc, sc);
    }
    if (this.portalPillar) this.portalPillar.rotation.y += dt * 0.35;

    // 终点灯呼吸
    if (this.endLight) this.endLight.intensity = 1.7 + Math.sin(this.time * 2.4) * 0.6;

    // 粒子上升
    if (this.particles) {
      var attr = this.particles.geometry.getAttribute('position');
      var arr = attr.array;
      var h = this.diff.wallHeight;
      for (var i = 0; i < this.pSpeed.length; i++) {
        arr[i * 3 + 1] += this.pSpeed[i] * dt;
        if (arr[i * 3 + 1] > h) arr[i * 3 + 1] = 0;
      }
      attr.needsUpdate = true;
    }

    // 金币旋转 + 上下漂浮
    for (var c = 0; c < this.coins.length; c++) {
      var ci = this.coins[c];
      if (ci.collected) continue;
      ci.mesh.rotation.z += dt * 2.0;
      ci.mesh.position.y = 1.0 + Math.sin(this.time * 2.2 + c) * 0.12;
      // 色盲模式：文字标识跟随金币一起漂浮
      if (ci.sprite) ci.sprite.position.y = ci.mesh.position.y + 0.6;
    }

    // 地图道具：漂浮 / 自转 / 呼吸光
    if (this.mapItem && !this.mapItem.collected) {
      var mi = this.mapItem;
      mi.group.position.y = Math.sin(this.time * 2.2) * 0.08;
      mi.board.rotation.y += dt * 1.2;
      var gsc = 1 + Math.sin(this.time * 3.4) * 0.22;
      mi.glow.scale.set(gsc, gsc, gsc);
      if (mi.ring) mi.ring.rotation.z += dt * 0.7;
    }

    // 起点光点脉动
    if (this.startOrb) {
      var s = 1 + Math.sin(this.time * 3.0) * 0.15;
      this.startOrb.scale.set(s, s, s);
    }
  };

  /** 尝试收集金币，返回收集数量 */
  MazeView.prototype.tryCollect = function (worldX, worldZ, radius) {
    var got = 0;
    for (var i = 0; i < this.coins.length; i++) {
      var c = this.coins[i];
      if (c.collected) continue;
      var dx = worldX - c.world.x;
      var dz = worldZ - c.world.z;
      if (dx * dx + dz * dz < radius * radius) {
        c.collected = true;
        c.mesh.visible = false;
        if (c.sprite) c.sprite.visible = false; // 色盲标识同步隐藏
        got++;
      }
    }
    return got;
  };

  /** 尝试拾取地图道具，返回是否成功 */
  MazeView.prototype.tryCollectMap = function (worldX, worldZ, radius) {
    var it = this.mapItem;
    if (!it || it.collected) return false;
    var dx = worldX - it.world.x;
    var dz = worldZ - it.world.z;
    if (dx * dx + dz * dz < radius * radius) {
      it.collected = true;
      it.group.visible = false;
      return true;
    }
    return false;
  };

  /** 剩余金币数 */
  MazeView.prototype.remainCoins = function () {
    var n = 0;
    for (var i = 0; i < this.coins.length; i++) if (!this.coins[i].collected) n++;
    return n;
  };

  /** 销毁场景对象，释放 GPU 资源 */
  MazeView.prototype.dispose = function () {
    this.group.traverse(function (obj) {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach(function (m) { disposeMat(m); });
        else disposeMat(obj.material);
      }
    });
    function disposeMat(m) {
      // 色盲文字纹理是模块级共享缓存，销毁关卡时保留，供下次复用
      if (m.map && !m.map.__cbShared) m.map.dispose();
      m.dispose();
    }
    if (this.scene) this.scene.remove(this.group);
    this.coins = [];
    this.mapItem = null;
    this.walls = null;
    this.particles = null;
    this.startSprite = null;
    this.endSprite = null;
  };

  /* ------------------------------------------------------------
   * Canvas 动态纹理（不依赖外部图片）
   * ---------------------------------------------------------- */
  function makeGridTexture(theme, size) {
    var cv = document.createElement('canvas');
    cv.width = cv.height = size;
    var g = cv.getContext('2d');
    g.clearRect(0, 0, size, size);
    g.strokeStyle = 'rgba(255,255,255,0.5)';
    g.lineWidth = 2;
    g.strokeRect(1, 1, size - 2, size - 2);
    var tex = new THREE.CanvasTexture(cv);
    tex.anisotropy = 2;
    tex.needsUpdate = true;
    return tex;
  }

  function makeWallTexture(theme, size) {
    var cv = document.createElement('canvas');
    cv.width = cv.height = size;
    var g = cv.getContext('2d');
    // 基础渐变
    var grad = g.createLinearGradient(0, 0, 0, size);
    var c = intToRgb(theme.wall);
    grad.addColorStop(0, 'rgb(' + Math.min(255, c.r + 26) + ',' + Math.min(255, c.g + 26) + ',' + Math.min(255, c.b + 26) + ')');
    grad.addColorStop(1, 'rgb(' + Math.max(0, c.r - 34) + ',' + Math.max(0, c.g - 34) + ',' + Math.max(0, c.b - 34) + ')');
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    // 砖缝
    g.strokeStyle = 'rgba(0,0,0,0.32)';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(0, size / 2); g.lineTo(size, size / 2);
    g.moveTo(size / 2, 0); g.lineTo(size / 2, size / 2);
    g.moveTo(0, size / 2); g.lineTo(3, size / 2);
    g.stroke();
    // 噪点，模拟粗糙质感
    var img = g.getImageData(0, 0, size, size);
    var d = img.data;
    for (var i = 0; i < d.length; i += 4) {
      var n = (Math.random() - 0.5) * 22;
      d[i] += n; d[i + 1] += n; d[i + 2] += n;
    }
    g.putImageData(img, 0, 0);
    var tex = new THREE.CanvasTexture(cv);
    tex.needsUpdate = true;
    return tex;
  }

  function intToRgb(hex) {
    return { r: (hex >> 16) & 255, g: (hex >> 8) & 255, b: hex & 255 };
  }

  /* ------------------------------------------------------------
   * 色盲友好模式：中文文字标识 Sprite（颜色 + 文字双编码）
   * - 同一文案共用一份 CanvasTexture（模块级缓存，反复切换不重复绘制）
   * - 纹理标记 __cbShared，关卡销毁时跳过 dispose，避免缓存失效变空白
   * ---------------------------------------------------------- */
  var textTexCache = {};

  /** 取出（或首次绘制）某个字的中文纹理，白字 + 深色描边 */
  function getTextTexture(text) {
    if (textTexCache[text]) return textTexCache[text];
    var size = 128; // 纹理边长（2 的幂，兼容性好）
    var cv = document.createElement('canvas');
    cv.width = cv.height = size;
    var g = cv.getContext('2d');
    g.clearRect(0, 0, size, size);
    g.font = 'bold ' + Math.round(size * 0.66) + 'px "PingFang SC", "Microsoft YaHei", ' +
             '"Noto Sans CJK SC", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    // 深色描边保证在任何背景上都能看清
    g.lineWidth = Math.round(size * 0.12);
    g.strokeStyle = 'rgba(0,0,0,0.88)';
    g.strokeText(text, size / 2, size / 2 + size * 0.02);
    g.fillStyle = '#ffffff';
    g.fillText(text, size / 2, size / 2 + size * 0.02);
    var tex = new THREE.CanvasTexture(cv);
    tex.needsUpdate = true;
    tex.__cbShared = true; // 共享纹理：销毁关卡时不要 dispose
    textTexCache[text] = tex;
    return tex;
  }

  /**
   * 生成"文字标识" Sprite（始终朝向相机）
   * @param {string} text 文案（如 "币" "图" "起" "终"）
   * @param {{size?:number, y?:number}} opts size=世界尺寸（米），y=相对高度
   */
  function makeTextSprite(text, opts) {
    opts = opts || {};
    var s = opts.size || 0.66;
    var sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: getTextTexture(text),
      transparent: true,
      depthWrite: false
    }));
    sp.scale.set(s, s, 1);
    sp.name = 'cbLabel_' + text;
    if (typeof opts.y === 'number') sp.position.y = opts.y;
    return sp;
  }

  /** 释放 Sprite（只释放材质；中文纹理共享，不在这里 dispose） */
  function disposeSprite(sp) {
    if (!sp) return;
    if (sp.parent) sp.parent.remove(sp);
    if (sp.material) sp.material.dispose();
  }

  /* ------------------------------------------------------------
   * 导出
   * ---------------------------------------------------------- */
  MG.Maze = {
    CELL: CELL,
    DIFFICULTIES: DIFFICULTIES,
    THEMES: THEMES,
    generate: generate,
    carveLoops: carveLoops,
    pickEndpoints: pickEndpoints,
    isOpen: isOpen,
    cellToWorld: cellToWorld,
    MazeView: MazeView,
    randomSeed: randomSeed,
    dailySeed: dailySeed,
    hashString: hashString,
    mulberry32: mulberry32
  };

})(window);