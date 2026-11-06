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
    while (i < path.length - 1) {
      var j = path.length - 1;
      // 从最远处往回找第一个"直线可达且不越过保护点"的位置
      while (j > i + 1) {
        if (protectedSet && hasProtectedBetween(path, i, j, protectedSet, maze.size)) { j--; continue; }
        if (lineOfSight(maze, path[i].x, path[i].y, path[j].x, path[j].y)) break;
        j--;
      }
      out.push(path[j]);
      i = j;
    }
    return out;
  }

  /** 区间 (i, j) 内（不含两端）是否存在"必须经过"的保护格 */
  function hasProtectedBetween(path, i, j, protectedSet, size) {
    for (var k = i + 1; k < j; k++) {
      var c = path[k];
      if (protectedSet[c.y * size + c.x]) return true;
    }
    return false;
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

    var gridPath = (algorithm === 'bfs')
      ? bfs(maze, { x: gx, y: gy }, maze.end)
      : aStar(maze, { x: gx, y: gy }, maze.end);
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
   * 贪心最近邻拾取：从 start 出发，依次 A* 到最近的未拾取目标，直到走完全部可达目标
   * 调用方需保证：调用时终点格已被临时封为墙（grid=1），A* 天然绕开终点
   * @param {Object} maze 迷宫数据
   * @param {{x:number,y:number}} start 起点网格坐标
   * @param {Array<{x:number,y:number}>} targets 待拾取目标网格坐标
   * @returns {Array<{x,y}>|null} 网格路径（含起点、不含终点），全不可达返回 null
   */
  function buildGreedyCollectPath(maze, start, targets) {
    if (!targets || targets.length === 0) return null;
    var remaining = targets.slice();
    var current = { x: start.x, y: start.y };
    var fullPath = [{ x: current.x, y: current.y }];
    var guard = targets.length + 1;

    while (remaining.length > 0 && guard-- > 0) {
      var best = null, bestLen = Infinity, bestPath = null;
      for (var i = 0; i < remaining.length; i++) {
        var t = remaining[i];
        var p = aStar(maze, current, t);
        if (!p) continue;
        if (p.length < bestLen) {
          bestLen = p.length;
          best = t;
          bestPath = p;
        }
      }
      if (!best) break;
      fullPath = fullPath.concat(bestPath.slice(1));
      current = { x: best.x, y: best.y };
      remaining.splice(remaining.indexOf(best), 1);
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
    buildGreedyCollectPath: buildGreedyCollectPath
  };

})(window);
