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
    var total = size * size;

    if (!isWalkable(maze, start.x, start.y) || !isWalkable(maze, goal.x, goal.y)) return null;

    var gScore = new Float32Array(total).fill(Infinity);
    var cameFrom = new Int32Array(total).fill(-1);
    var closed = new Uint8Array(total);

    var si = start.y * size + start.x;
    var gi = goal.y * size + goal.x;
    gScore[si] = 0;

    // 开放集：二叉最小堆（懒删除）——避免数组"线性找最小 + indexOf"的开销
    var open = new MinHeap();
    open.push(si, heuristic(start.x, start.y, goal.x, goal.y));

    var DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

    while (open.size > 0) {
      var current = open.pop();
      if (closed[current]) continue; // 懒删除：跳过已确定的过期条目
      if (current === gi) {
        return reconstruct(cameFrom, current, size);
      }
      closed[current] = 1;
      var cx = current % size;
      var cy = (current - cx) / size;

      for (var d = 0; d < 4; d++) {
        var nx = cx + DIRS[d][0];
        var ny = cy + DIRS[d][1];
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        if (!isWalkable(maze, nx, ny)) continue;

        var ni = ny * size + nx;
        if (closed[ni]) continue;

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
   * 顺路收集路径：为"最佳路径"在最短路径附近的目标（金币/地图）处插入绕行段
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
   * 筛选"顺路可收集"的目标：与路径的**真实行走距离**（BFS 步数）不超过 maxDetour
   * 注意：不能用曼哈顿距离——墙体会让"看着近"的格子实际绕很远
   * @param {Object} maze
   * @param {Array<{x,y}>} basePath 基础网格路径
   * @param {Array<{x,y}>} targets 目标网格坐标
   * @param {Object} [opts] { maxDetour:number } 真实步数阈值，默认 6
   * @returns {Array<{x,y,entry,dist}>} 被接受的目标（dist=与路径的真实距离；dist=0 表示路径正好穿过）
   */
  function findCollectTargets(maze, basePath, targets, opts) {
    var out = [];
    if (!basePath || basePath.length === 0 || !targets || targets.length === 0) return out;
    var maxDetour = (opts && typeof opts.maxDetour === 'number') ? opts.maxDetour : 6;
    var size = maze.size;

    for (var k = 0; k < targets.length; k++) {
      var item = targets[k];
      if (!item || !isWalkable(maze, item.x, item.y)) continue;

      // 真实可行走距离（BFS）：从目标格出发，找路径上最近的可达格
      var distMap = bfsDistMap(maze, item.x, item.y);
      var bestI = -1, bestD = Infinity;
      for (var i = 0; i < basePath.length; i++) {
        var d = distMap[basePath[i].y * size + basePath[i].x];
        if (d < 0) continue; // 不可达
        if (d < bestD) { bestD = d; bestI = i; }
        if (d === 0) break;
      }
      if (bestI < 0) continue;            // 不可达
      if (bestD > maxDetour) continue;    // 绕行太远：不顺路
      out.push({ x: item.x, y: item.y, entry: bestI, dist: bestD });
    }
    return out;
  }

  /**
   * 生成"顺路收集"路径：沿最短路径前进，并对路径附近的目标插入绕行
   * - 目标与路径的**真实行走距离**超过 maxDetour 时视为"不顺路"，直接忽略
   * - 绕行后会在路径前方寻找代价最小的回归点，避免回头路太长
   * - 绕行回归时不允许"跳过"未拾取目标所在的路段，避免漏拾
   * @param {Object} maze 迷宫数据
   * @param {Array<{x,y}>} basePath 基础网格路径（A* 输出，含起终点）
   * @param {Array<{x,y}>} targets 需要顺路拾取的目标网格坐标
   * @param {Object} [opts] { maxDetour: number, maxSkip: number }
   *        maxDetour=顺路真实步数阈值（默认 6）；maxSkip=回归点最多向前跳过的路径点数（默认 20）
   * @returns {Array<{x,y}>} 新路径（含绕行段）
   */
  function buildCollectPath(maze, basePath, targets, opts) {
    if (!basePath || basePath.length < 2) return basePath ? basePath.slice() : [];
    if (!targets || targets.length === 0) return basePath.slice();
    var size = maze.size;
    var result = basePath.slice();

    // 目标格集合（用于防止绕行回归时"跳过"未拾取目标所在路段）
    var targetSet = {};
    for (var t = 0; t < targets.length; t++) {
      var tg = targets[t];
      if (!tg || !isWalkable(maze, tg.x, tg.y)) continue;
      targetSet[tg.y * size + tg.x] = 1;
    }

    // 筛选顺路目标（真实距离）；"路径正好穿过"的无需绕行
    var accepted = findCollectTargets(maze, basePath, targets, opts);
    var plans = [];
    for (var k = 0; k < accepted.length; k++) {
      if (accepted[k].dist === 0) continue; // 路径正好穿过：无需绕行
      plans.push({ x: accepted[k].x, y: accepted[k].y, entry: accepted[k].entry });
    }
    plans.sort(function (a, b) { return a.entry - b.entry; });

    // 从后往前插入，保证前面计划的索引不失效
    for (var p = plans.length - 1; p >= 0; p--) {
      result = spliceDetour(maze, result, plans[p], targetSet, size, opts);
    }
    return result;
  }

  /**
   * 在路径中插入一段"前往目标并回归"的绕行（内部函数）
   * @param {Object} maze 迷宫数据
   * @param {Array<{x,y}>} result 当前路径
   * @param {{x:number,y:number,entry:number}} plan 目标与插入位置
   * @param {Object} targetSet 目标格集合（防止回归时越过未拾取目标）
   * @param {number} size 迷宫边长
   * @param {Object} [opts] { maxSkip:number } 最多向前跳过多少个路径点寻找回归点（默认 20）
   */
  function spliceDetour(maze, result, plan, targetSet, size, opts) {
    var entry = plan.entry;
    var entryCell = result[entry];
    if (!entryCell) return result;
    var maxSkip = (opts && typeof opts.maxSkip === 'number') ? opts.maxSkip : 20;

    var distMap = bfsDistMap(maze, plan.x, plan.y);
    if (distMap[entryCell.y * size + entryCell.x] < 0) return result; // 不可达

    // 在路径前方寻找"回归点"：
    // 代价 = 目标到回归点的真实距离 + 跳过路径点数的折半惩罚，
    // 兼顾"离目标近"和"少跳路"。
    // （原公式 distMap[j] - j 只偏向"离目标远"，容易绕出大回环）
    var bestJ = entry;
    var bestVal = distMap[entryCell.y * size + entryCell.x];
    var scanEnd = Math.min(result.length - 1, entry + maxSkip);
    for (var j = entry + 1; j <= scanEnd; j++) {
      // 被跳过的路段（entry+1 .. j-1）中若有未拾取目标 → 不能越过
      if (j >= entry + 2) {
        var prev = result[j - 1];
        if (targetSet[prev.y * size + prev.x]) break;
      }
      var dm = distMap[result[j].y * size + result[j].x];
      if (dm < 0) continue;
      var val = dm + (j - entry) * 0.5;
      if (val < bestVal - 1e-9) { bestVal = val; bestJ = j; }
    }

    var leg1 = aStar(maze, entryCell, { x: plan.x, y: plan.y });
    var leg2 = aStar(maze, { x: plan.x, y: plan.y }, result[bestJ]);
    if (!leg1 || !leg2) return result;

    var segment = leg1.concat(leg2.slice(1));
    return result.slice(0, entry).concat(segment, result.slice(bestJ + 1));
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
    buildCollectPath: buildCollectPath,
    findCollectTargets: findCollectTargets,
    buildGreedyCollectPath: buildGreedyCollectPath
  };

})(window);