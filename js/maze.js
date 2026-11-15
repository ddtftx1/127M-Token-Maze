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

  /**
   * 布局版本（BUG-067，2026-11-14）。
   * 终点位置规则 / 关卡布局**一变就 +1**；回放与幽灵用它判断"同 seed 的旧记录是否还适用"
   * （见 js/replay.js 的 load / prune）。v1 = 终点固定右下角；v2 = 远端随机；
   * v3 = 难度体系重构（删掉 11×11 档、两档改名、新增 121×121 巨型迷宫，各档参数随之变化）。
   */
  var LAYOUT_VERSION = 3;

  /** 终点候选门槛的兜底值：路径步数 ≥ 0.8 × 本局最远路径步数（各难度可用 endFarRatio 覆盖） */
  var DEFAULT_END_FAR_RATIO = 0.8;

  /* ------------------------------------------------------------
   * 难度配置
   * ---------------------------------------------------------- */
  var DIFFICULTIES = {
    /* 2026-11-15 难度体系重构（用户口径）：
       删掉原「简单 11×11」，原「中等 21×21」升为**简单**，原「困难 31×31」升为**中等**，
       新「困难」= **121×121（60×60 单元格）巨型迷宫**。
       随之：难度相关的旧存档（最佳记录 / 排行榜 / 回放）按用户口径**全部清空**，
       见 js/settings.js 的 RECORD_SCHEMA、js/ranking.js 的 RANK_SCHEMA 与 LAYOUT_VERSION。 */
    simple: {
      key: 'simple', name: '简单',
      cells: 10,             // 10x10 单元格 → 21x21 网格（原「中等」）
      wallHeight: 3.0,
      fogDensity: 0.012,     // 轻微迷雾，视野好
      fogColorHex: 0x081018,
      autoPathMax: Infinity, // 预留，当前未使用
      autoPathCooldown: 30,  // 预留，当前未使用
      /* 终点候选门槛（BUG-067）：从起点出发的**路径步数** ≥ 0.8 × 本局最远路径步数，
         在这个候选区间里按种子随机取，不再固定右下角。数值越大终点越远、越难。 */
      endFarRatio: 0.8,
      coins: 6,
      ceiling: true,
      color: 0x2f5578
    },
    medium: {
      key: 'medium', name: '中等',
      cells: 15,             // 15x15 → 31x31（原「困难」）
      wallHeight: 3.5,
      fogDensity: 0.0252,    // 雾较浓
      fogColorHex: 0x040a12,
      autoPathMax: 1,        // 预留，当前未使用
      autoPathCooldown: 60,  // 预留，当前未使用
      endFarRatio: 0.8,
      coins: 10,
      ceiling: true,
      color: 0x35507a
    },
    hard: {
      key: 'hard', name: '困难',
      /* 60x60 单元格 → **121x121** 网格（242 米见方）。生成器是迭代式、无递归深度问题；
         实测：生成 7~43ms、BFS 1~17ms；墙体**裸迷宫 7442**、carveLoops 净开洞约 70 个，
         真正进入 InstancedMesh 的是 **约 7370 个**（独立验证者按 main.js 的
         generate → carveLoops → build 顺序复算，已订正我最初写的 7442）；
         最远路径：裸迷宫约 2394 步，**打通环路后约 915 步（≈915 米）**（游戏里走的是后者），
         即最短 4.2 分钟、含探索实际一局约 10~20 分钟。
         小地图在这种密度下（手机约 1.1px/格）已无法逐格阅读，ui.js 里配了降噪（≤2px/格 时按块聚合、
         不再画金币）。详见 README 的难度说明与 CHANGELOG 的难度体系重构一节。 */
      cells: 60,
      wallHeight: 4.0,
      fogDensity: 0.03,      // 略浓于原困难：242 米的场地里避免"一眼看到对面"
      fogColorHex: 0x03070e,
      autoPathMax: 1,        // 预留，当前未使用
      autoPathCooldown: 90,  // 预留，当前未使用
      endFarRatio: 0.8,
      coins: 60,             // 按面积/探索时长同比放大（原困难 10 枚 / 225 格 → 新困难 60 枚 / 3600 格）
      ceiling: true,
      color: 0x3f6088
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

  /** 两位补零（不用 String.prototype.padStart：Chrome 49 / Win7 没有这个 ES2017 方法） */
  function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  /** 每日挑战种子（按本地日期） */
  function dailySeed() {
    var d = new Date();
    return 'daily-' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
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
   * 从起点出发的 BFS 步数表（-1 = 不可达）。
   * 用于终点候选的"真实路径距离"判定 —— 旧实现用曼哈顿距离近似，在迷宫里并不成立
   * （两个格子可能只隔一堵墙、却要绕十几步）。
   * 自带一份最小实现而不是调 MG.Path.bfs：模块加载顺序是 maze.js → pathfinding.js，
   * maze.js 不能反向依赖后面的模块。31×31 也就 961 格，开销可忽略。
   */
  function bfsSteps(grid, size, start) {
    var dist = new Int32Array(size * size);
    var i;
    for (i = 0; i < dist.length; i++) dist[i] = -1;
    var queue = [start.y * size + start.x];
    dist[queue[0]] = 0;
    for (var h = 0; h < queue.length; h++) {
      var idx = queue[h];
      var cx = idx % size;
      var cy = (idx - cx) / size;
      var d = dist[idx];
      if (cx > 0 && grid[idx - 1] === 0 && dist[idx - 1] < 0) { dist[idx - 1] = d + 1; queue.push(idx - 1); }
      if (cx < size - 1 && grid[idx + 1] === 0 && dist[idx + 1] < 0) { dist[idx + 1] = d + 1; queue.push(idx + 1); }
      if (cy > 0 && grid[idx - size] === 0 && dist[idx - size] < 0) { dist[idx - size] = d + 1; queue.push(idx - size); }
      if (cy < size - 1 && grid[idx + size] === 0 && dist[idx + size] < 0) { dist[idx + size] = d + 1; queue.push(idx + size); }
    }
    return dist;
  }

  /* ------------------------------------------------------------
   * 起点与终点（BUG-067，2026-11-14 重做终点规则）
   * ------------------------------------------------------------
   * 旧实现的问题：end 默认 (size-2, size-2)，`farCell=true` 时"取曼哈顿距离最远的通路格"——
   * 而曼哈顿距离 |x-1|+|y-1| 在 (size-2, size-2) 取到**唯一最大值**，于是那个分支永远返回
   * 同一个角。实测三档各 200 局：终点 100% 是 (9,9) / (19,19) / (29,29)，farCell 是死逻辑。
   * 后果：玩家只要记住"终点永远在右下角"，就能一路往东南推算着走 —— 迷宫的探索意义被架空
   * （用户 2026-11-14 反馈：朋友试玩后说这样能轻松速通）。
   *
   * 新规则（用户拍板口径：随机于"路径距离 ≥ 80% 最远"的通路格）：
   *   ① BFS 算出每个通路格的**真实路径步数**；
   *   ② 候选 = 路径步数 ≥ ratio × 本局最远路径步数 的通路格（可达性由 BFS 天然保证）；
   *   ③ 用**由 seed 派生的独立随机流**挑选，从而：
   *      - 同一个 seed 恒得同一个终点 → 每日挑战世界同步、幽灵与回放可复现；
   *      - **不消费 maze.rng**：金币与地图卷轴是在 MazeView.build() 里接着 maze.rng 抽的，
   *        多抽几笔会让它们整体错位；用独立流后，同 seed 的差异只来自"终点格被排除出候选集合"
   *        这一格（见下方「与金币/卷轴的关系」）。
   *   ④ 先按该随机流选一个**象限**，再在象限内均匀挑 —— 远端格子天然集中在东南，
   *      直接全局均匀取会让东南占约 38%；按象限分层后四个象限大致均衡。
   *
   * ── 与金币 / 地图卷轴的关系（别误解）──
   * 独立随机流只保证"**随机序列**没有被这次改动多推进"，**不等于**同 seed 的金币位置完全不变：
   * pickCoinSpots / pickMapSpot 都会把终点格排除出候选集合，终点一变候选集合就差一格，
   * 而候选集合是要洗牌的 —— 差一格会让洗牌结果整体不同。实测同 seed 下会有 1~3 枚金币换位。
   * 这属于"关卡布局变化"的一部分，已由 LAYOUT_VERSION 统一作废旧回放（js/replay.js）。
   * 想要金币完全稳定就得让金币选择不再依赖终点（可能把金币放到传送门上），代价不值得。
   *
   * 刻意**不做**"不与上一局同象限"：那要记住上一局的落点，同 seed 的布局就会随玩家历史变化，
   * 直接破坏"同 seed 同布局"（每日挑战世界同步、幽灵/回放都依赖它）。
   * 用 seed 派生象限后，既不可预测、又完全确定。
   * ---------------------------------------------------------- */

  /**
   * 选取起点与终点
   * 起点固定左上角单元格（1,1）；终点在"远端候选格"里按 seed 派生的随机流挑选。
   * @param {Object} maze generate() 的返回值（用到 grid / size / seed）
   * @param {number} [farRatio] 候选门槛：路径步数 ≥ farRatio × 最远路径步数（默认 0.8）
   */
  function pickEndpoints(maze, farRatio) {
    var size = maze.size;
    var start = { x: 1, y: 1 };
    var corner = { x: size - 2, y: size - 2 };
    var ratio = (typeof farRatio === 'number' && isFinite(farRatio)) ? farRatio : DEFAULT_END_FAR_RATIO;
    if (ratio < 0) ratio = 0;
    if (ratio > 1) ratio = 1;

    var dist = bfsSteps(maze.grid, size, start);
    var maxD = 0, i;
    for (i = 0; i < dist.length; i++) if (dist[i] > maxD) maxD = dist[i];
    // 极端兜底：起点周围一个可达格都没有（生成器保证不会出现）
    if (maxD <= 0) return { start: start, end: corner };

    // 候选：仅"单元格中心"（奇数坐标，与旧的取格口径一致），且路径步数达门槛
    var pool = [];
    for (var y = 1; y < size - 1; y += 2) {
      for (var x = 1; x < size - 1; x += 2) {
        if (maze.grid[y * size + x] !== 0) continue;
        if (dist[y * size + x] < ratio * maxD) continue;   // 不可达格 dist = -1，天然被排除
        pool.push({ x: x, y: y });
      }
    }
    // 门槛过高导致候选为空（例如人为把 ratio 设成 1 而最远格恰好不可用）：退化为全局最远格
    if (pool.length === 0) {
      var best = null, bestD = -1;
      for (i = 0; i < dist.length; i++) {
        if (dist[i] > bestD) { bestD = dist[i]; best = i; }
      }
      if (best === null) return { start: start, end: corner };
      return { start: start, end: { x: best % size, y: (best - (best % size)) / size } };
    }

    var rng = mulberry32(hashString(String(maze.seed == null ? '' : maze.seed) + '#end'));
    var half = size / 2;
    var quads = [[], [], [], []];
    for (i = 0; i < pool.length; i++) {
      var qi = (pool[i].x < half ? 0 : 1) + (pool[i].y < half ? 0 : 2);
      quads[qi].push(pool[i]);
    }
    // 在**非空**象限里等概率挑一个，再在象限内均匀取一格。
    // 写成"洗牌后取第一个非空"会偏向候选格更多的象限（东南），等概率挑才是真正的分层。
    var nonEmpty = [];
    for (i = 0; i < quads.length; i++) if (quads[i].length > 0) nonEmpty.push(i);
    var end = null;
    if (nonEmpty.length > 0) {
      var bucket = quads[nonEmpty[Math.floor(rng() * nonEmpty.length)]];
      end = bucket[Math.floor(rng() * bucket.length)];
    }
    if (!end) end = pool[Math.floor(rng() * pool.length)];
    return { start: start, end: { x: end.x, y: end.y } };
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
    if (pool.length === 0) {
      // 终极兜底：三层都空时，遍历**所有**通路格（含边界），
      // 取离起点曼哈顿距离最远的那一个（排除起点/终点）。
      // 迷宫极小或通路极窄时也不会让这局缺少地图卷轴（否则玩家永远无法解锁小地图）。
      var best = null;
      var bestDist = -1;
      for (var fy = 0; fy < size; fy++) {
        for (var fx = 0; fx < size; fx++) {
          if (maze.grid[fy * size + fx] !== 0) continue;
          if (fx === start.x && fy === start.y) continue;
          if (end && fx === end.x && fy === end.y) continue;
          var fd = Math.abs(fx - start.x) + Math.abs(fy - start.y);
          if (fd > bestDist) { bestDist = fd; best = { x: fx, y: fy }; }
        }
      }
      // 迷宫除起点/终点外确实没有任何通路格时才为 null（生成器保证不会出现）
      return best;
    }
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
    /* 墙体合并（2026-11-15）：walls / caps 现在是 Group（每块一个 Mesh），
       材质、合并矩形与块元数据挂在这里 —— Group 上没有 material 属性。 */
    this.wallMaterial = null;
    this.wallTexture = null;
    this.wallChunks = null;        // 合并后的矩形（墙檐复用同一批）
    this.wallChunkMeshes = null;   // 块元数据（阴影 / 视距裁剪）
    this.capsMaterial = null;
    this.wallBoxCount = 0;
    // 视距裁剪状态（默认关；由 main.js 按设置切换，见 setViewCulling）
    this.viewCullEnabled = false;
    this.viewCullRadius = 0;       // 0 = 用默认半径（VIEW_CULL_RADIUS_CELLS）
    this._cullGx = null;
    this._cullGy = null;
    this._cullAnchorGx = null;
    this._cullAnchorGy = null;
    this.coins = [];       // {mesh, x, y, collected}
    // 迷宫地图道具 {group, board, glow, ring, x, y, world, collected}
    // 自转作用在整个 group 上：卷轴杆与地图板作为一体旋转（BUG-021，见 update()）
    this.mapItem = null;
    this.particles = null; // 终点粒子
    this.time = 0;
    this.build();
  }

  /** 网格坐标 → 世界坐标（格心） */
  function cellToWorld(gx, gy, maze) {
    var half = (maze.size * CELL) / 2;
    return { x: gx * CELL - half + CELL / 2, z: gy * CELL - half + CELL / 2 };
  }

  /* ============================================================
   * 墙体合并（2026-11-15，性能三件套之一）
   * ============================================================
   * 现状（改造前）：121×121 的困难档有 7370 个墙格，逐个塞进**一个** InstancedMesh，
   * 也就是 7370 个 BoxGeometry 实例 = 7370×12 = 88440 个三角形，全部要跑顶点着色。
   * 目标：把"相邻的墙格"合并成更大的长方体 → 盒体数量与三角形数一起降下来；
   * 并且按**区块（chunk）**分组，让引擎能按块做视锥剔除（相机后面 / 视野外的块整个不画），
   * 这也是下面"视距裁剪"能按块开关的前提。
   *
   * ⚠ 视觉等价的硬要求（用户点名）：墙材质带砖纹贴图（makeWallTexture，UV 是
   * BoxGeometry 默认的每面 0..1）。盒子一旦拉长，砖纹会被拉伸 ——
   * 所以合并时**必须按每个面跨了几格重算 UV**（见 buildMergedBoxGeometry 的注释），
   * 使砖纹密度与合并前逐格实例完全一致。
   * ========================================================== */

  /**
   * 每个合并区块的边长（单位：格）。**这个值是实测选出来的，不是拍的**。
   *
   * ── 为什么"降一个量级"做不到（如实记录，见 harness/perf-zoom-verify.js 的实测表）──
   * 这类迷宫的墙体密度是 50%（121×121 里 7383 个墙格），而且**墙只有 1 格厚** ——
   * 任何 2×2 以上的矩形都必然包含通路格。所以可合并出来的矩形只能是"长条"
   * （1×k 或 k×1），平均每个盒子只能吃掉约 3 个墙格。
   * 121×121 实测（合并后的盒子数 / 墙格数 = 压缩比）：
   *   chunk= 4 → 3128 盒（2.36×）   chunk= 8 → 2595 盒（2.85×）
   *   chunk=16 → 2360 盒（3.13×）   chunk=32 → 2214 盒（3.33×）
   *   chunk=121（整图一块）→ 2121 盒（3.48×，理论极限附近）
   * 即"盒体数降一个量级"在本结构下**数学上不可达**；实际收益来自三处：
   *   ① 三角形 / 顶点数：88596 → 28320（-68%）；
   *   ② 区块级视锥剔除 + 视距裁剪（2C）：远处被雾吃掉的墙整块不画；
   *   ③ uv/法线不再逐格重复（InstancedMesh 的 7370 个实例每个都要跑顶点着色）。
   * 代价是绘制对象从 1 个 InstancedMesh 变成"含墙的区块数"个 Mesh —— 这是
   * "可裁剪"换来的，取舍写在交付报告里。
   *
   * ── 为什么取 16 而不是任务书举例的 8 ──
   * 16 在"盒子数 / 绘制对象数"两个指标上都优于 8（2360 盒 / 64 块 vs 2595 盒 / 256 块），
   * 三角形只差 9%；代价是视距裁剪粒度变粗（块半对角 11.3 格），
   * 而 45 格半径减去 11.3 格 = 33.7 格，仍大于"95% 消光"的 29 格可见边界
   * （67m 处雾的透光率约 1.8%），所以不会出现"可见区里的墙被裁掉"。
   */
  var WALL_CHUNK = 16;

  /**
   * 把一个区块内的墙格合并成尽可能少的矩形（贪心：先按行取横向连续段，再把上下行
   * 完全相同的段纵向延长）。返回的是**格坐标闭区间** [x0,x1]×[y0,y1]。
   *
   * 为什么用这种贪心而不是"最大矩形"算法：迷宫墙体是长条（墙线），
   * 横向段 + 纵向延长已经能把整条墙线合成一个盒子；最大矩形算法（悬垂线法）
   * 在这种"1 格宽长条"上的收益一样，但实现复杂一个量级、更容易写错。
   *
   * @param {Uint8Array} grid 迷宫网格（1=墙）
   * @param {number} size 网格边长（2n+1）
   * @param {number} [chunkSize] 区块边长（默认 WALL_CHUNK）
   * @returns {Array} [{gx, gy, rects:[{x0,x1,y0,y1}]}] —— 只含有墙的区块
   */
  function mergeWallRects(grid, size, chunkSize) {
    var cs = (typeof chunkSize === 'number' && chunkSize > 0) ? Math.floor(chunkSize) : WALL_CHUNK;
    var chunks = [];
    for (var cy0 = 0; cy0 < size; cy0 += cs) {
      for (var cx0 = 0; cx0 < size; cx0 += cs) {
        var xEnd = Math.min(cx0 + cs, size);
        var yEnd = Math.min(cy0 + cs, size);
        /* open：本区块内"尚未封口"的矩形，键 = 本行的横向段 x0:x1。
           上一行有同样区间的段 → 纵向延长一行；本行没出现 → 封口成矩形。 */
        var open = {};
        var rects = [];
        for (var y = cy0; y < yEnd; y++) {
          var seen = {};
          var x = cx0;
          while (x < xEnd) {
            if (grid[y * size + x] !== 1) { x++; continue; }
            var xs = x;
            while (x < xEnd && grid[y * size + x] === 1) x++;
            var xe = x - 1;
            var key = xs + ':' + xe;
            seen[key] = true;
            if (open[key]) open[key].y1 = y;
            else open[key] = { x0: xs, x1: xe, y0: y, y1: y };
          }
          var keys = Object.keys(open);
          for (var ki = 0; ki < keys.length; ki++) {
            if (!seen[keys[ki]]) {
              rects.push(open[keys[ki]]);
              delete open[keys[ki]];
            }
          }
        }
        var rest = Object.keys(open);
        for (var ri = 0; ri < rest.length; ri++) rects.push(open[rest[ri]]);
        if (rects.length) chunks.push({ gx: cx0, gy: cy0, rects: rects });
      }
    }
    return chunks;
  }

  /** 单位盒模板（懒创建）：复用 three 自己的 BoxGeometry 顶点/法线/UV/索引顺序，避免手写 6 个面出错 */
  var unitBoxTpl = null;
  function getUnitBoxTemplate() {
    if (!unitBoxTpl) unitBoxTpl = new THREE.BoxGeometry(1, 1, 1);
    return unitBoxTpl;
  }

  /**
   * 把一组矩形（格坐标闭区间）合并成**一个** BufferGeometry（每个矩形 = 一个长方体）。
   *
   * ── UV 补偿（视觉等价的关键，改这里前先把下面读完）──
   * 模板 BoxGeometry(1,1,1) 每个面的 UV 都是 0..1。原始实现里每个墙格是一个 1×1 的盒，
   * 于是"一个面 = 一次砖纹"。合并后盒子在 X/Z 方向跨了 nx/nz 格，
   * 若 UV 仍是 0..1，砖纹就被拉伸 nx/nz 倍（用户明确不接受）。
   * 做法是**按面把 UV 乘上这个面跨的格数**：
   *   · 法线沿 ±X 的面：U 轴沿 Z → u ×= nz（V 轴沿 Y，高度没变，不动）
   *   · 法线沿 ±Y 的面：U 轴沿 X、V 轴沿 Z → u ×= nx，v ×= nz
   *   · 法线沿 ±Z 的面：U 轴沿 X → u ×= nx
   * 材质纹理是 RepeatWrapping（build() 里设的），u=3 就是平铺 3 次，
   * 于是"每格一次砖纹"的密度与合并前逐格实例**逐一对应**，砖缝也对齐格线。
   * 按法线判断是哪个面（而不是按顶点下标猜 BoxGeometry 的面顺序）是为了
   * three 换版本时依然成立。
   *
   * @param {Array} rects 矩形数组（格坐标闭区间）
   * @param {Object} maze 迷宫（提供 size，用于把格坐标换成世界坐标）
   * @param {number} boxH 盒高（世界单位）
   * @param {number} centerY 盒中心的世界高度
   * @returns {THREE.BufferGeometry}
   */
  function buildMergedBoxGeometry(rects, maze, boxH, centerY) {
    var tpl = getUnitBoxTemplate();
    var tplPos = tpl.getAttribute('position');
    var tplNor = tpl.getAttribute('normal');
    var tplUv = tpl.getAttribute('uv');
    var tplIdx = tpl.getIndex();
    var vCount = tplPos.count;                      // BoxGeometry(1,1,1) = 24
    var iCount = tplIdx ? tplIdx.count : 36;
    var total = rects.length;
    var positions = new Float32Array(total * vCount * 3);
    var normals = new Float32Array(total * vCount * 3);
    var uvs = new Float32Array(total * vCount * 2);
    /* 顶点数超过 65535 就必须用 32 位索引，否则索引会被截断成垃圾三角形。
       区块合并后单块远达不到这个量，但"上限判断"留着 —— 调大 WALL_CHUNK 时不会静默出错。 */
    var indices = (total * vCount > 65535)
      ? new Uint32Array(total * iCount)
      : new Uint16Array(total * iCount);
    var half = (maze.size * CELL) / 2;
    var pi = 0, ni = 0, ui = 0, ii = 0, vbase = 0;
    for (var r = 0; r < total; r++) {
      var rect = rects[r];
      var nx = rect.x1 - rect.x0 + 1;
      var nz = rect.y1 - rect.y0 + 1;
      var w = nx * CELL;
      var d = nz * CELL;
      var cx = ((rect.x0 + rect.x1) / 2) * CELL - half + CELL / 2;
      var cz = ((rect.y0 + rect.y1) / 2) * CELL - half + CELL / 2;
      for (var v = 0; v < vCount; v++) {
        positions[pi++] = tplPos.getX(v) * w + cx;
        positions[pi++] = tplPos.getY(v) * boxH + centerY;
        positions[pi++] = tplPos.getZ(v) * d + cz;
        var nrx = tplNor.getX(v), nry = tplNor.getY(v), nrz = tplNor.getZ(v);
        normals[ni++] = nrx; normals[ni++] = nry; normals[ni++] = nrz;
        var tu = tplUv.getX(v), tv = tplUv.getY(v);
        if (nrx !== 0) { tu *= nz; }
        else if (nry !== 0) { tu *= nx; tv *= nz; }
        else { tu *= nx; }
        uvs[ui++] = tu; uvs[ui++] = tv;
      }
      for (var k = 0; k < iCount; k++) indices[ii++] = tplIdx.getX(k) + vbase;
      vbase += vCount;
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    return geo;
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
      // 与地面 / 墙体同口径：build 时就要按当时的 shadows 设置好，
      // 否则"开了阴影之后新开的每一关"天花板都不接收阴影，
      // 只有再切一次画质或再拨一次阴影开关才被 applyQuality/onSettingChanged 补上
      ceil.receiveShadow = needShadows;
      this.group.add(ceil);
      this.ceiling = ceil;
    }

    /* ---------- 墙体：分块合并的长方体（2026-11-15 性能改造，原理见文件上方"墙体合并"） ---------- */
    // 砖纹"底部偏暗、顶部偏亮"的渐变靠 V 轴方向保持；Lambert 足够，另加一层砖纹纹理
    var wallTex = makeWallTexture(t, 128);
    wallTex.wrapS = wallTex.wrapT = THREE.RepeatWrapping;
    var wallMat = new THREE.MeshLambertMaterial({ map: wallTex, color: t.wall });

    var chunks = mergeWallRects(maze.grid, size);
    var wallGroup = new THREE.Group();
    wallGroup.name = 'mazeWalls';
    var chunkMeshes = [];
    /* 统计口径（报告里要用，别改）：
       - 改造前：盒体数 = 墙格数（121×121 ≈ 7370），三角形 = 盒体×12，绘制对象 = 1 个 InstancedMesh；
       - 改造后：盒体数 = 合并后的矩形数（降一个量级），三角形 = 盒体×12，
         绘制对象 = 含墙的区块数（变多，换的是"按块视锥剔除 + 视距裁剪"）。 */
    var boxCount = 0;
    for (var ci = 0; ci < chunks.length; ci++) {
      var chunk = chunks[ci];
      boxCount += chunk.rects.length;
      var chunkGeo = buildMergedBoxGeometry(chunk.rects, maze, diff.wallHeight, diff.wallHeight / 2);
      var chunkMesh = new THREE.Mesh(chunkGeo, wallMat);
      /* 阴影：合并后的 Mesh 仍要能投影 / 接收 —— main.js 的 onSettingChanged 与
         MazeView.applyQuality() 都通过 setWallShadow() 遍历子节点重新设置，三处口径必须一致。 */
      chunkMesh.castShadow = needShadows;
      chunkMesh.receiveShadow = needShadows;
      chunkMesh.frustumCulled = true;   // 区块级视锥剔除：相机背后的整块不参与绘制
      chunkMesh.name = 'mazeWallChunk_' + chunk.gx + '_' + chunk.gy;
      wallGroup.add(chunkMesh);
      // 视距裁剪 / 剔除用的块元数据（块中心的格坐标；距离比较全在格坐标系里做，省一次换算）
      chunkMeshes.push({
        mesh: chunkMesh,
        gx: chunk.gx, gy: chunk.gy,
        cgx: chunk.gx + (WALL_CHUNK - 1) / 2,
        cgy: chunk.gy + (WALL_CHUNK - 1) / 2,
        capMesh: null
      });
    }
    this.walls = wallGroup;
    this.wallMaterial = wallMat;       // applyTheme 换色 / 换纹理走这份引用（Group 上没有 material）
    this.wallTexture = wallTex;
    this.wallChunkMeshes = chunkMeshes;
    this.wallChunks = chunks;          // 墙檐复用同一批矩形（足迹完全一致，省一次合并计算）
    this.wallBoxCount = boxCount;
    this.group.add(wallGroup);

    // 外墙顶部的暖色边条（"墙檐"）：低画质不生成，中/高画质有；
    // 运行时可增删，见 buildCaps() / applyQuality()
    this.buildCaps();

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

    // 粒子（Points）：数量随画质变化，applyQuality() 会就地重建这一组（BUG-033）
    this.buildParticles(portalGroup);

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

    /* ---------- 迷宫地图道具（每局 1 个，拾取后 mapUnlock 进背包，由玩家在道具面板使用后解锁小地图） ---------- */
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

      // 两端卷轴杆（与平板同级；靠 update() 里的整体自转保持贴合，不要单独转 board）
      var rodGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.56, 10);
      var rodMat = new THREE.MeshLambertMaterial({ color: 0x9a6428, emissive: 0x3a2206 });
      var rodL = new THREE.Mesh(rodGeo, rodMat);
      rodL.position.set(-0.36, 1.12, 0);
      var rodR = new THREE.Mesh(rodGeo, rodMat);
      rodR.position.set(0.36, 1.12, 0);
      mapGroup.add(rodL);
      mapGroup.add(rodR);

      // 顶部微光小球（在中轴 x=0,z=0，整体绕 Y 自转时位置不变）
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
   * 释放一个 Group 下所有子对象的 BufferGeometry。
   * 为什么需要它：墙檐 / 墙体从"单个 InstancedMesh"改成了 Group + 每块一个 Mesh 之后，
   * Object3D 本身没有 dispose()，几何必须逐块释放，否则每换一次画质 / 每开一局
   * 都会漏掉一批 GPU 缓冲（这正是改造前注释里 warning 的那类泄漏）。
   * 材质不在这里释放：同组的 Mesh 共享同一份材质，由调用方释放一次即可。
   */
  function disposeGroupGeometries(group) {
    if (!group || !group.traverse) return;
    group.traverse(function (obj) {
      if (obj.geometry && typeof obj.geometry.dispose === 'function') obj.geometry.dispose();
    });
  }

  /**
   * 墙檐（外墙顶部的暖色边条）。低画质不生成。
   * 抽成独立方法是为了让 applyQuality() 能就地增删，不必重建整个迷宫（BUG-033）。
   * 2026-11-15：随墙体一起改成"按区块合并"——直接复用 mergeWallRects 的同一批矩形
   * （墙檐的足迹与墙体逐格一致，位置仍是 wallHeight − 0.04，观感与逐格实例等价）。
   */
  MazeView.prototype.buildCaps = function () {
    var old = this.caps;
    if (old) {
      if (old.parent) old.parent.remove(old);
      // 逐块释放几何；材质是共享的一份，单独释放（Group 上没有 material / dispose）
      disposeGroupGeometries(old);
      if (old.material && typeof old.material.dispose === 'function') old.material.dispose();
      this.caps = null;
    }
    if (this.quality === 'low') return;
    var chunks = this.wallChunks;
    if (!chunks || !chunks.length) return;
    var t = this.theme;
    var diff = this.diff;
    var capMat = new THREE.MeshBasicMaterial({
      color: t.accent, transparent: true, opacity: 0.10, depthWrite: false
    });
    var capH = 0.08;
    var capGroup = new THREE.Group();
    capGroup.name = 'mazeCaps';
    for (var ci = 0; ci < chunks.length; ci++) {
      var chunk = chunks[ci];
      var capGeo = buildMergedBoxGeometry(chunk.rects, this.maze, capH, diff.wallHeight - capH / 2);
      var capMesh = new THREE.Mesh(capGeo, capMat);
      capMesh.frustumCulled = true;
      capMesh.name = 'mazeCapChunk_' + chunk.gx + '_' + chunk.gy;
      capGroup.add(capMesh);
      // 把墙檐块挂到对应的墙体块元数据上：视距裁剪要"墙体与墙檐同时隐藏"，两套网格分不开
      if (this.wallChunkMeshes && this.wallChunkMeshes[ci]) this.wallChunkMeshes[ci].capMesh = capMesh;
    }
    this.group.add(capGroup);
    this.caps = capGroup;
    this.capsMaterial = capMat;
  };

  /**
   * 终点粒子。数量按画质分三档（低 60 / 中 140 / 高 220）。
   * 重建时同时换掉 pBaseY / pSpeed。update() 是用 pSpeed.length 驱动下标去写
   * position 数组的，所以这三者长度必须始终一致（pBaseY 目前只记录初始高度，未参与动画）。
   * @param {THREE.Object3D} [portalGroup] 挂载目标，默认用 this.portal
   */
  MazeView.prototype.buildParticles = function (portalGroup) {
    var host = portalGroup || this.portal;
    var old = this.particles;
    if (old) {
      if (old.parent) old.parent.remove(old);
      if (old.geometry) old.geometry.dispose();
      if (old.material) old.material.dispose();
      this.particles = null;
    }
    if (!host) return;
    var diff = this.diff;
    var endColor = 0xb27dff;
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
    host.add(points);
    this.particles = points;
  };

  /**
   * 运行时换画质（BUG-033）。
   *
   * 只换"与画质有关、且能安全就地替换"的三样：
   *   1. 墙檐   —— 低画质无、中/高画质有
   *   2. 终点粒子 —— 60 / 140 / 220
   *   3. 地面 / 墙体 / 天花板的 receiveShadow —— 低画质不接收阴影
   * 金币、地图卷轴、墙体实例、玩家位置等**一律不动**。
   * 特别说明：不能用"新建一个 MazeView"来换档——pickCoinSpots 会再消费一次
   * maze.rng，金币位置全变，等于中途换了一张地图，还会让玩家重复捡币。
   * 抗锯齿（antialias）与像素比属于渲染器参数，由 main.js 重建渲染器负责。
   *
   * @param {string} q low | mid | high
   * @returns {boolean} 是否真的换了档（同档直接返回 false）
   */
  MazeView.prototype.applyQuality = function (q) {
    q = (q === 'low' || q === 'high') ? q : 'mid';
    if (q === this.quality) return false;
    this.quality = q;
    this.buildCaps();
    this.buildParticles(this.portal);
    // 阴影接收/投射都跟"总开关 + 是否低画质"走，与 build() 里的 needShadows 同口径
    var receive = !!this.settings.shadows && q !== 'low';
    if (this.floor) this.floor.receiveShadow = receive;
    this.setWallShadow(receive);
    if (this.ceiling) this.ceiling.receiveShadow = receive;
    return true;
  };

  /**
   * 设置**所有墙体块**的投影 / 接收阴影。
   * 为什么必须收敛成一个方法：`walls` 从单个 InstancedMesh 改成 Group 之后，
   * 在 Group 上写 `walls.castShadow = true` 不会传到子 Mesh —— three 渲染时读的是每个
   * Mesh 自己的标记。main.js 里原来的两处直接赋值会**静默失效**（不报错、只是没影子），
   * 所以两处都改成了调用本方法（与 applyQuality 共用同一口径，避免第三处漂移）。
   * @param {boolean} receive
   */
  MazeView.prototype.setWallShadow = function (receive) {
    var on = !!receive;
    var list = this.wallChunkMeshes || [];
    for (var i = 0; i < list.length; i++) {
      var m = list[i].mesh;
      if (!m) continue;
      m.castShadow = on;
      m.receiveShadow = on;
    }
  };

  /* ------------------------------------------------------------
   * 视距裁剪（2026-11-15 性能三件套之一）
   * ------------------------------------------------------------
   * 只画玩家附近的墙体：与"逐块视锥剔除"是两件事 ——
   * 视锥剔除由 three 自己做（相机背后 / 视野外），这里按**到玩家的距离**隐藏整块，
   * 覆盖的是"在视野内、但远到被雾吃掉"的那部分（开阔区里最常见）。
   *
   * ── 半径怎么定（任务书要求写明依据）──
   * 困难档 fogDensity = 0.03（FogExp2），能见度因子 = exp(−(density×d)²)：
   *   d=40m → 24% 透光；d=58m → 5% 透光。取"95% 被雾吃掉"为实际可见边界：
   *   (0.03×d)² = 3 → d ≈ 58m ≈ 29 格（CELL=2m）。
   *   再乘 1.5 倍余量 → 45 格：余量用来吸收三件事
   *     ① 玩家跨格才检查一次（见下面的检查步长），边界是"滞后"的；
   *     ② 块中心的距离判据最多有半个块对角（≈5.7 格）的误差；
   *     ③ 雾是渐变而不是硬边，"刚好在边界上"的墙仍有 5% 亮度。
   *   于是"快速转身时墙突然出现"在数学上不会发生在可见区里。
   *   低难度雾更稀（0.012/0.0252）→ 可视距离更远，但那些关卡尺寸小（21×21/31×31），
   *   半径 45 格已经覆盖整张图，等于不裁剪（不可能出现远处墙被误隐藏）。
   * ---------------------------------------------------------- */
  /** 雾可见距离（格）：困难档 95% 消光处 ≈29 格，取整 30 作为基准 */
  var VIEW_CULL_BASE_CELLS = 30;
  /** 余量系数：见上面"半径怎么定"第 ①②③ 条 */
  var VIEW_CULL_MARGIN = 1.5;
  /** 实际使用的裁剪半径（格）：30 × 1.5 = 45 */
  var VIEW_CULL_RADIUS_CELLS = 45;
  /**
   * 玩家移动多少格才重算一次可见性。
   * 为什么不是每帧：块元数据有 ~250 条，每帧遍历纯属白干；而裁剪边界在 45 格外，
   * 玩家走 3 格（6m）只会让边界相对可见区（29 格）移动 3 格，离"切进可见区"还差十几格。
   * 3 格 × 2m = 6m，正常步速下约 1.5 秒一次，开销可以忽略。
   */
  var VIEW_CULL_CHECK_CELLS = 3;

  /**
   * 开关视距裁剪。关闭时**立即把所有块恢复可见**（性能模式关掉必须完全还原，
   * 不能留下上一次隐藏过的块 —— 那就是"附近没墙"的空洞 bug）。
   * @param {boolean} enabled
   * @param {number} [radiusCells] 自定义半径（不传用 VIEW_CULL_RADIUS_CELLS）
   * @returns {boolean} 生效后的开关状态
   */
  MazeView.prototype.setViewCulling = function (enabled, radiusCells) {
    this.viewCullEnabled = !!enabled;
    if (typeof radiusCells === 'number' && radiusCells > 0) this.viewCullRadius = radiusCells;
    else if (!(this.viewCullRadius > 0)) this.viewCullRadius = VIEW_CULL_RADIUS_CELLS;
    /* 立刻按最近一次已知玩家格重算（换档后不应等到玩家跨格才生效）。
       已知格由 updateViewCulling 记录；没有记录时不猜（等主循环第一次调用）。 */
    if (this._cullGx !== null && this._cullGx !== undefined) {
      this.updateViewCulling(this._cullGx, this._cullGy, true);
    } else if (this.maze && this.maze.start) {
      /* 还没有玩家格记录（刚建好关卡就切开关）：用**出生格**当锚点。
         绝不能拿 (0,0) 兜底 —— 出生点不在左上角时，玩家附近的墙会被当成"远处的墙"
         藏起来，表现就是开局眼前一片空（"附近没墙"的空洞 bug）。
         MazeView 的 maze.start 与玩家出生格在主游戏里是同一个格（buildLevel 里一致）。 */
      this.updateViewCulling(this.maze.start.x, this.maze.start.y, true);
    }
    return this.viewCullEnabled;
  };

  /**
   * 按玩家所在格刷新各区块的可见性。**不在每帧调用**：主循环里由
   * main.js 在"玩家格变化"时调用，内部再按 VIEW_CULL_CHECK_CELLS 节流。
   * @param {number} gx 玩家格 x
   * @param {number} gy 玩家格 y
   * @param {boolean} [force] 跳过节流（开关切换 / 换关时用）
   * @returns {boolean} 本次是否真的改变了某些块的可见性
   */
  MazeView.prototype.updateViewCulling = function (gx, gy, force) {
    var list = this.wallChunkMeshes;
    if (!list || !list.length) return false;
    if (typeof gx !== 'number' || !isFinite(gx) || typeof gy !== 'number' || !isFinite(gy)) return false;
    this._cullGx = gx;
    this._cullGy = gy;
    var i;
    if (!this.viewCullEnabled) {
      // 关闭态：确保全部可见（从"性能模式"切回来时把隐藏过的块放出来）
      var restored = false;
      for (i = 0; i < list.length; i++) {
        if (list[i].mesh && !list[i].mesh.visible) { list[i].mesh.visible = true; restored = true; }
        if (list[i].capMesh && !list[i].capMesh.visible) { list[i].capMesh.visible = true; restored = true; }
      }
      return restored;
    }
    // 节流：只在玩家跨过 VIEW_CULL_CHECK_CELLS 格（或 force）时重算
    if (!force && this._cullAnchorGx !== null && this._cullAnchorGx !== undefined) {
      var adx = gx - this._cullAnchorGx;
      var ady = gy - this._cullAnchorGy;
      if (adx * adx + ady * ady < VIEW_CULL_CHECK_CELLS * VIEW_CULL_CHECK_CELLS) return false;
    }
    this._cullAnchorGx = gx;
    this._cullAnchorGy = gy;
    var r = this.viewCullRadius > 0 ? this.viewCullRadius : VIEW_CULL_RADIUS_CELLS;
    var r2 = r * r;
    var changed = false;
    for (i = 0; i < list.length; i++) {
      var e = list[i];
      var dx = e.cgx - gx;
      var dy = e.cgy - gy;
      var hit = (dx * dx + dy * dy) <= r2;
      if (e.mesh && e.mesh.visible !== hit) { e.mesh.visible = hit; changed = true; }
      if (e.capMesh && e.capMesh.visible !== hit) { e.capMesh.visible = hit; changed = true; }
    }
    return changed;
  };

  /** 视距裁剪的观测快照（测试 / 排错用）：可见块数 / 隐藏块数 / 半径与开关 */
  MazeView.prototype.viewCullInfo = function () {
    var list = this.wallChunkMeshes || [];
    var visible = 0, hidden = 0;
    for (var i = 0; i < list.length; i++) {
      if (list[i].mesh && list[i].mesh.visible) visible++;
      else hidden++;
    }
    return {
      enabled: !!this.viewCullEnabled,
      radius: this.viewCullRadius > 0 ? this.viewCullRadius : VIEW_CULL_RADIUS_CELLS,
      checkCells: VIEW_CULL_CHECK_CELLS,
      chunks: list.length,
      visible: visible,
      hidden: hidden,
      anchorGx: (this._cullAnchorGx === undefined) ? null : this._cullAnchorGx,
      anchorGy: (this._cullAnchorGy === undefined) ? null : this._cullAnchorGy
    };
  };

  /**
   * 运行时切换主题：只刷新已建好场景的材质颜色 / 纹理，不重建关卡
   * （玩家位置、计时、步数、收集状态全部保持；配合 main.js 的雾 / 背景 / 灯光一起生效）
   * @param {string} themeName tech | dungeon | forest
   */
  MazeView.prototype.applyTheme = function (themeName) {
    var t = THEMES[themeName] || THEMES.tech;
    this.theme = t;

    /* 墙体：所有区块**共享同一份材质**，所以换主题只需改这一份（与逐格实例时完全一致）。
       引用存在 this.wallMaterial 上：walls 现在是 Group（Group.material 恒为 undefined），
       继续读 this.walls.material 会静默什么都不做 —— 那是"换主题墙体不变色"的经典假修。 */
    var wm = this.wallMaterial || (this.walls && this.walls.material);
    if (wm) {
      if (wm.color) wm.color.setHex(t.wall);
      if (wm.map) wm.map.dispose();
      var newWallTex = makeWallTexture(t, 128);
      newWallTex.wrapS = newWallTex.wrapT = THREE.RepeatWrapping;
      wm.map = newWallTex;
      wm.needsUpdate = true;
      this.wallTexture = newWallTex;
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

    // 墙檐（仅非低画质存在）：跟随主题强调色（同样是共享材质，Group 上没有 material）
    var cm = this.capsMaterial || (this.caps && this.caps.material);
    if (cm && cm.color) {
      cm.color.setHex(t.accent);
      cm.needsUpdate = true;
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
      // 上下浮动：position 在父空间平移，与下面的 rotation 互不覆盖
      mi.group.position.y = Math.sin(this.time * 2.2) * 0.08;
      /* 自转作用在 mapGroup 整体上，而不是只转 board（BUG-021）。
         只转 board 时：板绕自身几何中心转，两端在 X 方向的投影变成 ±0.31·cosθ，
         而两根杆固定在 ±0.36，θ 越大缝隙越明显（θ=60° 约 0.155，θ=90° 约 0.28），
         看起来就是"轴和地图分开了"。整体自转后杆与板的相对位置是常数，任何角度都贴合。
         对其它成员无副作用：mapRing 是水平圆环（绕 Y 轴对称，转了看不出来）、
         glow 与 mapLight 都在中轴 x=0,z=0 上（绕 Y 位置不变）、
         色盲 Sprite 也在中轴且始终面向相机（公告板，父级旋转不影响其朝向）。 */
      mi.group.rotation.y += dt * 1.2;
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
    /* 墙体 / 墙檐现在是 Group + 每块一个 Mesh：
       · 几何：由下面的 group.traverse 逐块释放（Object3D 没有 dispose()）；
       · instanceMatrix：旧实现（InstancedMesh）的缓冲区只有它自己的 dispose() 能释放，
         那两句旧调用保留为"万一"兜底 —— 对 Group 是 typeof 判定后跳过的空操作，
         不会误伤。 */
    if (this.walls && typeof this.walls.dispose === 'function') this.walls.dispose();
    if (this.caps && typeof this.caps.dispose === 'function') this.caps.dispose();
    this.group.traverse(function (obj) {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach(function (m) { disposeMat(m); });
        else disposeMat(obj.material);
      }
    });
    function disposeMat(m) {
      // 合并后同一份墙体材质挂在 N 个块上，traverse 会撞见 N 次；用标记保证只释放一次，
      // 否则纹理会被反复 dispose（虽然 three 容错，但每帧日志/事件都是白开销）
      if (!m || m.__mazeDisposed) return;
      m.__mazeDisposed = true;
      // 色盲文字纹理是模块级共享缓存，销毁关卡时保留，供下次复用
      if (m.map && !m.map.__cbShared) m.map.dispose();
      m.dispose();
    }
    if (this.scene) this.scene.remove(this.group);
    this.coins = [];
    this.mapItem = null;
    this.walls = null;
    this.caps = null;
    this.wallMaterial = null;
    this.wallTexture = null;
    this.wallChunks = null;
    this.wallChunkMeshes = null;
    this.capsMaterial = null;
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
    LAYOUT_VERSION: LAYOUT_VERSION,
    pickEndpoints: pickEndpoints,
    isOpen: isOpen,
    cellToWorld: cellToWorld,
    MazeView: MazeView,
    /* 墙体合并（2026-11-15）：mergeWallRects 是纯函数（不碰 THREE），
       供无头自证脚本对"合并前后盒体数 / 三角形数 / UV 密度"做断言；
       buildMergedBoxGeometry 需要 THREE，只在浏览器 / jsdom 环境里用。 */
    WALL_CHUNK: WALL_CHUNK,
    VIEW_CULL_RADIUS_CELLS: VIEW_CULL_RADIUS_CELLS,
    mergeWallRects: mergeWallRects,
    buildMergedBoxGeometry: buildMergedBoxGeometry,
    randomSeed: randomSeed,
    dailySeed: dailySeed,
    hashString: hashString,
    mulberry32: mulberry32
  };

})(window);
