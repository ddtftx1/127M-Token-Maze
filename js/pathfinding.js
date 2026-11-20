/* ============================================================
 * js/pathfinding.js
 * 寻路模块
 * - A*（带曼哈顿启发式）与 BFS 两种算法
 * - 路径平滑（视线可达性检验 + 拐角修圆）
 * - 网格 → 世界坐标路径生成
 * ============================================================ */
(function (global) {
  'use strict';

  var MG = global.MG = global.MG || {};

  /* ------------------------------------------------------------
   * 二叉最小堆（A* 开放集用；懒删除模式：允许重复入堆，弹出时校验）
   * ---------------------------------------------------------- */
  function MinHeap() {
    this._items = []; // 元素：{ i:节点索引, f:优先级 }
  }
  MinHeap.prototype.push = function (i, f) {
    var items = this._items;
    items.push({ i: i, f: f });
    var n = items.length - 1;
    while (n > 0) {
      var parent = (n - 1) >> 1;
      if (items[parent].f <= items[n].f) break;
      var tmp = items[parent]; items[parent] = items[n]; items[n] = tmp;
      n = parent;
    }
  };
  MinHeap.prototype.pop = function () {
    var items = this._items;
    // 空堆直接返回哨兵：调用方虽都先判 size，但这是数据结构本身该有的防护
    if (items.length === 0) return -1;
    var top = items[0];
    var last = items.pop();
    if (items.length > 0) {
      items[0] = last;
      var n = 0;
      var len = items.length;
      while (true) {
        var l = n * 2 + 1, r = l + 1, small = n;
        if (l < len && items[l].f < items[small].f) small = l;
        if (r < len && items[r].f < items[small].f) small = r;
        if (small === n) break;
        var tmp = items[small]; items[small] = items[n]; items[n] = tmp;
        n = small;
      }
    }
    return top.i;
  };
  Object.defineProperty(MinHeap.prototype, 'size', {
    get: function () { return this._items.length; }
  });
  /** 清空堆（供 A* 工作区复用时重置开放集，避免每次 new MinHeap） */
  MinHeap.prototype.clear = function () {
    this._items.length = 0;
  };

  /* ------------------------------------------------------------
   * A* 工作区复用
   * 困难难度"最佳路径"会连续做 ~66 次 A*，每次都重新分配 3 个
   * size×size 的 TypedArray + 一个 MinHeap（合计约 800KB 临时垃圾），
   * 极易触发 GC 造成 100~300ms 卡顿。
   * 这里在模块级复用这批数组，用 generation（版本号）代替 fill() 清零：
   *   - _gen++ 后，凡是 _genMap[i] !== _gen 的格子都视为"未访问"
   *   - 逻辑清零是 O(1)，不再每次遍历整张表
   * ---------------------------------------------------------- */
  var _astarGen = 0;        // 当前 generation（版本号）
  var _astarSize = -1;      // 工作区对应的迷宫边长（size 变化时重建一次）
  var _genMap = null;       // Uint32Array：每格最后一次被清零时的 generation
  var _gScore = null;       // Float32Array：g 值（有效前提：_genMap[i] === _astarGen）
  var _cameFrom = null;     // Int32Array：来源格索引
  var _closed = null;       // Uint8Array：是否已确定（有效前提同上）
  var _openHeap = null;     // 复用的最小堆

  /** 确保 A* 工作区与迷宫 size 匹配（仅在 size 变化时重建一次） */
  function ensureAStarPool(size) {
    if (_astarSize === size && _genMap && _gScore && _cameFrom && _closed && _openHeap) return;
    var total = size * size;
    _genMap = new Uint32Array(total);
    _gScore = new Float32Array(total);
    _cameFrom = new Int32Array(total);
    _closed = new Uint8Array(total);
    _openHeap = new MinHeap();
    _astarGen = 0;
    _astarSize = size;
  }

  /** 取下一个 generation；极端溢出时整体重置一次（实际不会发生） */
  function nextAStarGen() {
    _astarGen++;
    if (_astarGen > 0xFFFFFFF0) {
      _genMap.fill(0);
      _astarGen = 1;
    }
    return _astarGen;
  }

  /* ------------------------------------------------------------
   * A*（A-Star）寻路
   * 开放集使用二叉最小堆（懒删除），困难难度 31×31 下相比线性扫描明显提速
   * @param {Object} maze {grid, size}
   * @param {{x:number,y:number}} start 网格坐标
   * @param {{x:number,y:number}} goal  网格坐标
   * @returns {Array<{x,y}>|null} 网格坐标路径（含起点终点），不可达返回 null
   * ---------------------------------------------------------- */
  function aStar(maze, start, goal) {
    var size = maze.size;

    if (!isWalkable(maze, start.x, start.y) || !isWalkable(maze, goal.x, goal.y)) return null;

    // 复用模块级工作区（只在 size 变化时重建）；用 generation 做 O(1) 逻辑清零
    ensureAStarPool(size);
    var gen = nextAStarGen();
    var genMap = _genMap, gScore = _gScore, cameFrom = _cameFrom, closed = _closed;
    var open = _openHeap;
    open.clear();

    var si = start.y * size + start.x;
    var gi = goal.y * size + goal.x;
    // 起点的"有效化"：标 generation 并赋 g=0（无需 fill(Infinity)）
    genMap[si] = gen;
    gScore[si] = 0;
    cameFrom[si] = -1;
    closed[si] = 0;

    // 开放集：二叉最小堆（懒删除）——避免数组"线性找最小 + indexOf"的开销
    open.push(si, heuristic(start.x, start.y, goal.x, goal.y));

    var DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

    while (open.size > 0) {
      var current = open.pop();
      // 懒删除：跳过已确定的过期条目（closed 仅在 genMap 有效时才可靠）
      if (genMap[current] === gen && closed[current]) continue;
      if (current === gi) {
        return reconstruct(cameFrom, current, size);
      }
      genMap[current] = gen;
      closed[current] = 1;
      var cx = current % size;
      var cy = (current - cx) / size;

      for (var d = 0; d < 4; d++) {
        var nx = cx + DIRS[d][0];
        var ny = cy + DIRS[d][1];
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        if (!isWalkable(maze, nx, ny)) continue;

        var ni = ny * size + nx;
        // 已在本 generation 确定过的格子跳过；未在本 generation 出现过的格子
        // 视为"未访问"，其 closed / gScore 都是上一轮的陈旧值，必须先重置
        if (genMap[ni] === gen && closed[ni]) continue;
        if (genMap[ni] !== gen) {
          genMap[ni] = gen;
          closed[ni] = 0;
          gScore[ni] = Infinity;
          cameFrom[ni] = -1;
        }

        var tentative = gScore[current] + 1;
        if (tentative < gScore[ni]) {
          cameFrom[ni] = current;
          gScore[ni] = tentative;
          open.push(ni, tentative + heuristic(nx, ny, goal.x, goal.y));
        }
      }
    }
    return null; // 不可达
  }

  /** 曼哈顿距离启发式 */
  function heuristic(ax, ay, bx, by) {
    return Math.abs(ax - bx) + Math.abs(ay - by);
  }

  /** 回溯路径 */
  function reconstruct(cameFrom, current, size) {
    var path = [];
    var node = current;
    while (node !== -1) {
      var x = node % size;
      var y = (node - x) / size;
      path.push({ x: x, y: y });
      node = cameFrom[node];
    }
    path.reverse();
    return path;
  }

  /* ------------------------------------------------------------
   * BFS（作为备选/校验算法）
   * ---------------------------------------------------------- */
  function bfs(maze, start, goal) {
    var size = maze.size;
    var total = size * size;
    var prev = new Int32Array(total).fill(-1);
    var visited = new Uint8Array(total);
    var queue = [start.y * size + start.x];
    visited[start.y * size + start.x] = 1;
    var gi = goal.y * size + goal.x;
    var DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

    while (queue.length > 0) {
      var cur = queue.shift();
      if (cur === gi) return reconstruct(prev, cur, size);
      var cx = cur % size, cy = (cur - cx) / size;
      for (var d = 0; d < 4; d++) {
        var nx = cx + DIRS[d][0], ny = cy + DIRS[d][1];
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        if (!isWalkable(maze, nx, ny)) continue;
        var ni = ny * size + nx;
        if (visited[ni]) continue;
        visited[ni] = 1;
        prev[ni] = cur;
        queue.push(ni);
      }
    }
    return null;
  }

  /** 是否可通行 */
  function isWalkable(maze, x, y) {
    if (x < 0 || y < 0 || x >= maze.size || y >= maze.size) return false;
    return maze.grid[y * maze.size + x] === 0;
  }

  /* ------------------------------------------------------------
   * 路径平滑
   * 1) 视线检测（Bresenham 式网格射线）删除多余拐点
   * 2) 世界坐标输出时对拐角做圆角插值
   * ---------------------------------------------------------- */

  /** 两格之间是否直线可达（经过的所有格子均为通路） */
  function lineOfSight(maze, x0, y0, x1, y1) {
    // 网格上只允许 8 向视线；但迷宫墙体是"格"占位，斜穿墙角要额外检查
    var dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    var sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    var err = dx - dy;
    var cx = x0, cy = y0;
    var guard = 0;
    while (guard++ < 4096) {
      if (cx === x1 && cy === y1) return true;
      if (!isWalkable(maze, cx, cy)) return false;
      var e2 = 2 * err;
      var px = cx, py = cy;
      if (e2 > -dy) { err -= dy; cx += sx; }
      if (e2 < dx) { err += dx; cy += sy; }
      // 斜向移动时不允许穿越两个正交方向的墙（避免切角）
      if (px !== cx && py !== cy) {
        if (!isWalkable(maze, cx, py) || !isWalkable(maze, px, cy)) return false;
      }
    }
    return false;
  }

  /**
   * 简化路径：贪心地尝试用直线连接更远的点
   * @param {Object} maze
   * @param {Array<{x,y}>} path 网格路径
   * @param {Object} [protectedSet] 必须作为途经点的格子集合（key = y*size+x）。
   *   简化时不允许"越过"这些格子（用于保证"最佳路径"的收集点不被裁掉）
   * @returns {Array<{x,y}>} 简化后路径
   */
  function simplify(maze, path, protectedSet) {
    if (!path || path.length <= 2) return path ? path.slice() : [];
    var out = [path[0]];
    var i = 0;
    /* 2026-11-20（BUG-070）：把"从最远端往回线性回退"改成"从 i+2 起前向扩张、首次失败即停"。
     * 旧实现的目标是"找从 i 出发能直线到达的最远点"，但它是从路径末尾往回试的 ——
     * 蛇形迷宫里最远可见点通常就在 i+2 / i+3，于是每个 i 都要把整条剩余路径扫一遍，
     * 每次还要跑一次 Bresenham 视线检测，困难档（121×121、约 4900 点收集路径）实测
     * 21~31 秒，玩家点一下「最佳路径」整页冻结十几秒。
     *
     * 为什么前向扫描是对的：我们要的本来就是"从 i 直线可达的最远点"，
     * 从近往远逐格试，第一次失败处的前一格就是答案；而"沿路径可见"在整格墙体下
     * 基本是前缀性质（近处被墙挡住时更远处只会更被挡住）。
     * 万一出现"近处不可见、更远处反而可见"的非单调情形，前向扫描也只是**少跳一段**
     * （多保留一个拐点），不会破坏正确性 —— 每条被采用的段都经过 lineOfSight 逐格校验，
     * 而且 protectedSet 的保护格仍然会被强制保留为途经点（见下面的 break 分支）。
     * 复杂度从 O(n²·L) 降到 O(Σ可见跨度·L)，实测困难档简化耗时降到毫秒级。 */
    while (i < path.length - 1) {
      var j = i + 1;
      while (j + 1 < path.length) {
        // path[j] 会成为"被跳过的中间点"：若它是必须途经的保护格，就不能跳过它
        if (protectedSet) {
          var mid = path[j];
          if (protectedSet[mid.y * maze.size + mid.x]) break;
        }
        var to = path[j + 1];
        if (!lineOfSight(maze, path[i].x, path[i].y, to.x, to.y)) break;
        j++;
      }
      out.push(path[j]);
      i = j;
    }
    return out;
  }

  /**
   * 把网格路径转成世界坐标路径（格心），并对拐角处做平滑点插值
   * @param {Array<{x,y}>} gridPath 简化后的网格路径
   * @param {Object} maze
   * @param {number} cell 单元格世界尺寸
   * @param {number} cornerRadius 拐角圆角半径（世界单位）
   * @returns {Array<{x:number,z:number}>}
   */
  function toWorldPath(gridPath, maze, cell, cornerRadius) {
    if (!gridPath || gridPath.length === 0) return [];
    var half = (maze.size * cell) / 2;
    var pts = [];
    for (var i = 0; i < gridPath.length; i++) {
      pts.push({
        x: gridPath[i].x * cell - half + cell / 2,
        z: gridPath[i].y * cell - half + cell / 2
      });
    }
    if (pts.length <= 2) return pts;

    // 在拐点附近插入圆角采样点，让自动行走更顺滑
    var r = Math.min(cornerRadius || cell * 0.35, cell * 0.5);
    var smooth = [pts[0]];
    for (var k = 1; k < pts.length - 1; k++) {
      var p0 = pts[k - 1], p1 = pts[k], p2 = pts[k + 1];
      // 方向向量
      var v1 = norm(p1.x - p0.x, p1.z - p0.z);
      var v2 = norm(p2.x - p1.x, p2.z - p1.z);
      // 判断是否拐弯（方向不同）
      if (Math.abs(v1.x - v2.x) > 1e-6 || Math.abs(v1.z - v2.z) > 1e-6) {
        var a = { x: p1.x - v1.x * r, z: p1.z - v1.z * r }; // 拐点前
        var b = { x: p1.x + v2.x * r, z: p1.z + v2.z * r }; // 拐点后
        // 二次贝塞尔插值
        var steps = 5;
        smooth.push(a);
        for (var s = 1; s <= steps; s++) {
          var t = s / (steps + 1);
          var mt = 1 - t;
          smooth.push({
            x: mt * mt * a.x + 2 * mt * t * p1.x + t * t * b.x,
            z: mt * mt * a.z + 2 * mt * t * p1.z + t * t * b.z
          });
        }
        smooth.push(b);
      } else {
        smooth.push(p1);
      }
    }
    smooth.push(pts[pts.length - 1]);
    return smooth;
  }

  function norm(dx, dz) {
    var len = Math.sqrt(dx * dx + dz * dz) || 1;
    return { x: dx / len, z: dz / len };
  }

  /**
   * 统一入口：从当前世界坐标找一条到终点的世界路径
   * @returns {Array<{x,z}>|null}
   */
  function findWorldPath(maze, fromWorld, cell, algorithm) {
    var half = (maze.size * cell) / 2;
    // 世界坐标 → 网格坐标
    var gx = Math.round((fromWorld.x + half - cell / 2) / cell);
    var gy = Math.round((fromWorld.z + half - cell / 2) / cell);
    gx = Math.max(0, Math.min(maze.size - 1, gx));
    gy = Math.max(0, Math.min(maze.size - 1, gy));

    // 若玩家当前正好卡在墙格里（异常情况），就近找一个通路格
    if (!isWalkable(maze, gx, gy)) {
      var found = nearestWalkable(maze, gx, gy);
      if (!found) return null;
      gx = found.x; gy = found.y;
    }

    /* algorithm: 'bfs' | 'astar'（默认）| 'field'
       'field' = 走终点距离场的梯度下降（O(路径长度)，见 fieldPath 的注释）——
       "最快路径"用它替掉 A*，省掉堆操作与节点分配；失败会返回 null，调用方回退 'astar'。 */
    var gridPath;
    if (algorithm === 'bfs') gridPath = bfs(maze, { x: gx, y: gy }, maze.end);
    else if (algorithm === 'field') gridPath = fieldPath(maze, { x: gx, y: gy }, maze.end);
    else gridPath = aStar(maze, { x: gx, y: gy }, maze.end);
    if (!gridPath && algorithm === 'field') gridPath = aStar(maze, { x: gx, y: gy }, maze.end);
    if (!gridPath) return null;

    var simple = simplify(maze, gridPath);
    var world = toWorldPath(simple, maze, cell, cell * 0.34);
    // 让路径起点精确落在玩家当前位置（避免起步瞬移）
    if (world.length > 0) {
      world[0] = { x: fromWorld.x, z: fromWorld.z };
    }
    return world;
  }

  /** 就近寻找可通行格（螺旋搜索） */
  function nearestWalkable(maze, x, y) {
    for (var r = 1; r < maze.size; r++) {
      for (var dy = -r; dy <= r; dy++) {
        for (var dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          var nx = x + dx, ny = y + dy;
          if (isWalkable(maze, nx, ny)) return { x: nx, y: ny };
        }
      }
    }
    return null;
  }

  /** 网格路径长度（步数），用于距离估算 */
  /* ------------------------------------------------------------
   * 终点距离场（2026-11-15 性能优化，配合 121×121 巨型难度）
   * ------------------------------------------------------------
   * 问题：旧实现里 player.distanceToEnd() 每次调用都走 gridDistance() —— 那是**从零跑一整张图的 BFS**。
   * 121×121 实测单次 3.4~10ms（Node；低端手机放大数倍），而 HUD 每 100ms 要一次距离、
   * 玩家在 2 米/格的迷宫里几乎每 0.5 秒跨一格 → 巨型迷宫里"每跨一格卡一下"。
   * 做法：整局只算一次"从终点出发的距离场"（bfsDistMap 就是现成的积木，之前是个没人用的死导出），
   * 缓存在 maze 对象上（用 goal 坐标 + grid 长度做键，关卡一换自动失效），之后查询是 **O(1)**。
   * 每关只多花一次 BFS（9~17ms），而且安排在 loading 阶段预热（见 main.js 的 buildLevel）。
   * ---------------------------------------------------------- */

  /**
   * 取"到 goal 的最短步数"距离场（首次调用时构建并缓存；O(1) 查询）
   * @param {Object} maze 迷宫数据（会挂 `_distField` 缓存）
   * @param {{x:number,y:number}} goal 目标格
   * @returns {Int32Array} 逐格步数，-1 = 不可达
   */
  function endDistance(maze, goal) {
    var key = goal.x + ',' + goal.y;
    var cache = maze._distField;
    if (cache && cache.key === key && cache.field && cache.gridLen === maze.grid.length) {
      return cache.field;
    }
    var field = bfsDistMap(maze, goal.x, goal.y);
    maze._distField = { key: key, field: field, gridLen: maze.grid.length };
    return field;
  }

  /**
   * 用终点距离场做"梯度下降"求一条最短网格路径。
   * 为什么能替代 A*：BFS 距离场上**每一格到终点的步数都是精确最短值**，
   * 沿"四邻中步数恰小 1"的方向走必然是一条最短路径 —— 复杂度 O(路径长度)，
   * 不用堆、不分配节点对象。实测 121×121：A* 约 66ms → 本函数约 0.1ms（距离场已预热）。
   * 方向顺序固定，保证同一 seed/局面下路径可复现（回放与幽灵需要确定性）。
   * @returns {Array<{x,y}>|null} 含起点与终点的路径；不可达/异常时 null（调用方应回退 A*）
   */
  function fieldPath(maze, from, goal) {
    var size = maze.size;
    var DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];   // 与其它函数同序：上/右/下/左
    var field = endDistance(maze, goal);
    if (!isWalkable(maze, from.x, from.y)) return null;
    if (field[from.y * size + from.x] < 0) return null;
    var cur = { x: from.x, y: from.y };
    var path = [cur];
    // 防御：步数不可能超过总格数，超出即视为数据异常（避免死循环）
    var guard = size * size + 4;
    while ((cur.x !== goal.x || cur.y !== goal.y) && guard-- > 0) {
      var best = null;
      var bestD = field[cur.y * size + cur.x];
      for (var k = 0; k < DIRS.length; k++) {
        var nx = cur.x + DIRS[k][0];
        var ny = cur.y + DIRS[k][1];
        if (!isWalkable(maze, nx, ny)) continue;
        var nd = field[ny * size + nx];
        if (nd >= 0 && nd < bestD) { bestD = nd; best = { x: nx, y: ny }; }
      }
      if (!best) return null;   // 距离场保证有下降方向；走到这里说明数据异常
      cur = best;
      path.push(cur);
    }
    return (cur.x === goal.x && cur.y === goal.y) ? path : null;
  }

  function gridDistance(maze, from, to) {
    // 用 BFS 计算真实最短步数（迷宫规模不大，性能可接受）
    var size = maze.size;
    var dist = new Int32Array(size * size).fill(-1);
    var start = from.y * size + from.x;
    var goal = to.y * size + to.x;
    if (!isWalkable(maze, from.x, from.y)) return -1;
    var queue = [start];
    dist[start] = 0;
    var DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    var head = 0;
    while (head < queue.length) {
      var cur = queue[head++];
      if (cur === goal) return dist[cur];
      var cx = cur % size, cy = (cur - cx) / size;
      for (var d = 0; d < 4; d++) {
        var nx = cx + DIRS[d][0], ny = cy + DIRS[d][1];
        if (!isWalkable(maze, nx, ny)) continue;
        var ni = ny * size + nx;
        if (dist[ni] !== -1) continue;
        dist[ni] = dist[cur] + 1;
        queue.push(ni);
      }
    }
    return -1;
  }

  /* ------------------------------------------------------------
   * 顺路收集（贪心）：沿最短路径推进时优先吃掉可顺路到达的目标（金币/地图），
   * 即"最佳路径"的实现。原先在路径序列里"插入绕行段"的旧实现已删除（BUG-026）。
   * ---------------------------------------------------------- */

  /** 从 (x, y) 出发的全图 BFS 距离图（-1 表示不可达） */
  function bfsDistMap(maze, x, y) {
    var size = maze.size;
    var dist = new Int32Array(size * size).fill(-1);
    if (!isWalkable(maze, x, y)) return dist;
    var start = y * size + x;
    var queue = [start];
    dist[start] = 0;
    var head = 0;
    var DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    while (head < queue.length) {
      var cur = queue[head++];
      var cx = cur % size, cy = (cur - cx) / size;
      for (var d = 0; d < 4; d++) {
        var nx = cx + DIRS[d][0], ny = cy + DIRS[d][1];
        if (!isWalkable(maze, nx, ny)) continue;
        var ni = ny * size + nx;
        if (dist[ni] !== -1) continue;
        dist[ni] = dist[cur] + 1;
        queue.push(ni);
      }
    }
    return dist;
  }

  /**
   * 在"从 from 出发的 BFS 距离场"上回溯 from → to 的网格路径。
   * 只沿"距离恰好小 1"的邻格走，所以得到的一定是一条**最短路径**（与 A\* 等长）；
   * 距离场里墙体格子是 -1，天然被排除，不需要再拿 maze 判可通行。
   * 方向顺序固定为 上/右/下/左（与 fieldPath 一致），保证同一 seed/局面可复现。
   * @param {Int32Array} field bfsDistMap() 的返回值
   * @param {{x,y}} from 起点（field[from] 必须为 0）
   * @param {{x,y}} to 终点
   * @param {number} size 网格边长
   * @returns {Array<{x,y}>|null} 含起点与终点；数据异常时 null
   */
  function tracePathOnField(field, from, to, size) {
    var DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    var rev = [];
    var cur = { x: to.x, y: to.y };
    rev.push(cur);
    // 防御：路径步数不可能超过总格数，超出即视为数据异常（避免死循环）
    var guard = size * size + 4;
    while ((cur.x !== from.x || cur.y !== from.y) && guard-- > 0) {
      var d = field[cur.y * size + cur.x];
      if (d <= 0) return null;   // 到不了 / to 本身不可达
      var next = null;
      for (var k = 0; k < DIRS.length; k++) {
        var nx = cur.x + DIRS[k][0];
        var ny = cur.y + DIRS[k][1];
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        if (field[ny * size + nx] === d - 1) { next = { x: nx, y: ny }; break; }
      }
      if (!next) return null;    // 距离场保证有下降方向；走到这里说明数据异常
      cur = next;
      rev.push(cur);
    }
    if (cur.x !== from.x || cur.y !== from.y) return null;
    // rev 是 to→from（回溯方向），翻转成 from→to
    var path = [];
    for (var i = rev.length - 1; i >= 0; i--) path.push(rev[i]);
    return path;
  }

  /**
   * 贪心最近邻拾取：从 start 出发，依次去最近的未拾取目标，直到走完全部可达目标
   * 调用方需保证：调用时终点格已被临时封为墙（grid=1），A* 天然绕开终点
   *
   * 2026-11-20（BUG-070）性能重写：旧实现对"每一轮剩余的每个目标"各跑一次全图 A*，
   * 困难档 61 个目标 → 61+60+…+1 = **1891 次**全图 A*（实测 1.9~5.8 秒）。
   * 现在每一轮只跑**一次**全图 BFS 距离场（O(V)），用它同时完成两件事：
   *   ① 挑"距离最近的剩余目标"—— BFS 步数就是真实最短步数，与旧实现比 `p.length` 选出来的
   *      目标完全一致（并列时同样取 remaining 里靠前的那个）；
   *   ② 在距离场上直接回溯出到该目标的最短路径（tracePathOnField），不必再跑 A*。
   * 于是 1891 次 A* → 61 次 BFS，困难档实测降到几十毫秒。
   * 注意：多条等长最短路时的具体走法可能与旧 A* 实现不同（两者都是最短路），
   * 这属于"同一条最佳路径的等价解"，不影响功能。
   *
   * @param {Object} maze 迷宫数据
   * @param {{x:number,y:number}} start 起点网格坐标
   * @param {Array<{x:number,y:number}>} targets 待拾取目标网格坐标
   * @returns {Array<{x,y}>|null} 网格路径（含起点、不含终点），全不可达返回 null
   */
  function buildGreedyCollectPath(maze, start, targets) {
    if (!targets || targets.length === 0) return null;
    var size = maze.size;
    var remaining = targets.slice();
    var current = { x: start.x, y: start.y };
    var fullPath = [{ x: current.x, y: current.y }];
    var guard = targets.length + 1;

    while (remaining.length > 0 && guard-- > 0) {
      var field = bfsDistMap(maze, current.x, current.y);
      var bestIdx = -1, bestDist = Infinity;
      for (var i = 0; i < remaining.length; i++) {
        var t = remaining[i];
        var d = field[t.y * size + t.x];
        if (d < 0) continue;             // 不可达（例如被临时封为墙的终点格）
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
      if (bestIdx < 0) break;            // 剩余目标全不可达：与旧实现同样结束
      var target = remaining[bestIdx];
      var seg = tracePathOnField(field, current, target, size);
      if (!seg) break;                   // 防御：距离场与网格不一致（不应发生）
      fullPath = fullPath.concat(seg.slice(1));
      current = { x: target.x, y: target.y };
      remaining.splice(bestIdx, 1);
    }
    return fullPath.length > 1 ? fullPath : null;
  }

  MG.Path = {
    aStar: aStar,
    bfs: bfs,
    simplify: simplify,
    lineOfSight: lineOfSight,
    toWorldPath: toWorldPath,
    findWorldPath: findWorldPath,
    gridDistance: gridDistance,
    isWalkable: isWalkable,
    nearestWalkable: nearestWalkable,
    bfsDistMap: bfsDistMap,
    endDistance: endDistance,
    fieldPath: fieldPath,
    buildGreedyCollectPath: buildGreedyCollectPath
  };

})(window);
