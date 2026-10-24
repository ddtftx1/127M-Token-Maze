/* ============================================================
 * js/player.js
 * 玩家控制器
 * - 第一人称相机（yaw / pitch，pitch 限位防翻转）
 * - 圆形半径 + 网格 AABB 逐轴碰撞检测（不穿墙、不卡墙）
 * - 平滑移动、头部晃动、脚步音效触发
 * - 自动寻路跟随（沿世界路径匀速前进，可随时中断）
 * - 路径可视化：半透明光带 + 光点
 * - 已探索区域记录（供小地图使用）
 * ============================================================ */
(function (global) {
  'use strict';

  var MG = global.MG = global.MG || {};
  var THREE = global.THREE;

  var DEG = Math.PI / 180;

  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {Object} maze 迷宫数据 {grid,size,start,end}
   * @param {Object} diff 难度配置
   * @param {HTMLCanvasElement} canvas 用于鼠标锁定
   */
  function Player(camera, maze, diff, canvas) {
    this.camera = camera;
    this.maze = maze;
    this.diff = diff;
    this.canvas = canvas;

    this.cell = MG.Maze.CELL;
    this.half = (maze.size * this.cell) / 2;

    // 世界坐标（相机位置）
    var sw = MG.Maze.cellToWorld(maze.start.x, maze.start.y, maze);
    this.pos = new THREE.Vector3(sw.x, 0, sw.z);
    this.pos.y = 0;

    // 视角
    this.yaw = 0;                  // 水平朝向（弧度）
    this.pitch = 0;                // 垂直俯仰（弧度）
    this.maxPitch = 88 * DEG;      // pitch 限制

    // 眼高 & 玩家半径
    this.eyeHeight = 1.62;
    this.radius = 0.34;            // 圆柱碰撞半径

    // 运动参数
    this.baseSpeed = 3.6;          // 每秒米（会乘以设置倍率）
    this.bobPhase = 0;             // 头部晃动相位
    this.bobAmount = 0.045;        // 晃动幅度
    this._bobDamping = 1;          // 晃动衰减系数（静止时衰减到 0，避免站定盯墙时相机一直在抖）
    this.stepDistance = 0;         // 累计行走距离（用于脚步音效）

    // 到终点网格距离缓存（同一格内复用，避免每 100ms 全图 BFS）
    this._lastDistGridX = -1;
    this._lastDistGridY = -1;
    this._lastDistValue = -1;

    // 自动寻路状态
    this.autoPath = null;          // 世界路径 [{x,z}]
    this.autoIndex = 0;            // 当前目标点索引
    this.autoActive = false;
    this.autoSpeed = 4.4;          // 自动寻路速度
    this.onAutoFinish = null;      // 回调
    this.pathGroup = null;         // 路径可视化组
    this.autoKind = null;          // 本次寻路类型：'best' | 'fast' | null
    this.autoLimit = null;         // 本次寻路最大格数（null = 不限）
    this.autoCells = 0;            // 本次已走格数（相邻两格 = 1 步）
    this.autoStoppedByLimit = false; // 是否因距离限制停下（供回调区分提示）
    this.autoStoppedKind = null;   // 因距离限制停下时的寻路类型（供主程序判断是否"顺手拾取"）
    this.autoReachedEnd = false;   // 本次寻路是否正常走到终点（供回调区分提示）
    this._autoLastGrid = null;     // 上一次统计用的网格坐标
    this._stuckCount = 0;          // 连续卡住帧数（自动寻路防跳节点）
    this._stuckToastAt = 0;        // 上次"路径受阻"提示时间（节流）
    this._exploreAccum = 0;        // 已探索标记刷新计时（降频用）
    this._exploreLastGrid = null;  // 上次刷新探索标记时的网格坐标

    // 已探索格子（用于小地图）
    this.explored = new Uint8Array(maze.size * maze.size);

    // 步数统计
    this.steps = 0;
    this._stepAccumulator = 0;

    // 缓存当前朝向向量
    this.forward = new THREE.Vector3();
    this.rightVec = new THREE.Vector3();

    // 开始就标记起点周围已探索
    this.markExplored();
    this.syncCamera();
  }

  /* ------------------------------------------------------------
   * 视角控制
   * ---------------------------------------------------------- */

  /**
   * 旋转视角
   * @param {number} dx 水平增量（像素）
   * @param {number} dy 垂直增量（像素）
   * @param {number} sensitivity 灵敏度
   * @param {boolean} invertYaw
   * @param {boolean} invertPitch
   */
  Player.prototype.rotate = function (dx, dy, sensitivity, invertYaw, invertPitch) {
    var sens = (sensitivity || 1) * 0.0026;
    var yawDelta = dx * sens * (invertYaw ? -1 : 1);
    var pitchDelta = dy * sens * (invertPitch ? -1 : 1);
    // 触摸/鼠标向右滑动 → 视角向右转（yaw 减小），符合直觉
    this.yaw -= yawDelta;
    this.pitch -= pitchDelta;
    // 限位，防止翻转
    if (this.pitch > this.maxPitch) this.pitch = this.maxPitch;
    if (this.pitch < -this.maxPitch) this.pitch = -this.maxPitch;
  };

  /** 直接设置朝向（如自动寻路时平滑转向） */
  Player.prototype.setYaw = function (yaw) { this.yaw = yaw; };

  /** 把相机位置/朝向同步到 Three.js */
  Player.prototype.syncCamera = function () {
    var bob = Math.sin(this.bobPhase) * this.bobAmount * this._bobDamping;
    this.camera.position.set(this.pos.x, this.eyeHeight + bob, this.pos.z);
    // 使用 YXZ 顺序：先 yaw 后 pitch，避免翻滚
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
    this.camera.rotation.z = 0;

    // 同步朝向向量（水平面）
    this.forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.rightVec.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
  };

  /* ------------------------------------------------------------
   * 碰撞检测：圆形玩家 vs 网格墙 AABB，逐轴分离
   * ---------------------------------------------------------- */

  /** 某世界坐标是否与墙体重叠 */
  Player.prototype.collides = function (x, z) {
    var cell = this.cell;
    var r = this.radius;
    // 检查玩家包围盒覆盖的网格范围
    var minGx = Math.floor((x - r + this.half) / cell);
    var maxGx = Math.floor((x + r + this.half) / cell);
    var minGy = Math.floor((z - r + this.half) / cell);
    var maxGy = Math.floor((z + r + this.half) / cell);
    var size = this.maze.size;

    for (var gy = minGy; gy <= maxGy; gy++) {
      for (var gx = minGx; gx <= maxGx; gx++) {
        // 越界视为墙
        if (gx < 0 || gy < 0 || gx >= size || gy >= size) return true;
        if (this.maze.grid[gy * size + gx] !== 1) continue;
        // 该格的世界 AABB
        var cx = gx * cell - this.half + cell / 2;
        var cz = gy * cell - this.half + cell / 2;
        var hw = cell / 2;
        // 最近点距离检测（圆与矩形）
        var nearestX = Math.max(cx - hw, Math.min(x, cx + hw));
        var nearestZ = Math.max(cz - hw, Math.min(z, cz + hw));
        var dx = x - nearestX;
        var dz = z - nearestZ;
        if (dx * dx + dz * dz < r * r) return true;
      }
    }
    return false;
  };

  /**
   * 尝试按 (dx, dz) 移动，逐轴检测避免卡墙
   * @returns {boolean} 是否发生了移动
   */
  Player.prototype.tryMove = function (dx, dz) {
    var moved = false;
    var nx = this.pos.x + dx;
    // 先试 X 轴
    if (Math.abs(dx) > 1e-6 && !this.collides(nx, this.pos.z)) {
      this.pos.x = nx;
      moved = true;
    }
    var nz = this.pos.z + dz;
    // 再试 Z 轴
    if (Math.abs(dz) > 1e-6 && !this.collides(this.pos.x, nz)) {
      this.pos.z = nz;
      moved = true;
    }
    // 若两轴都被挡（贴墙滑行失败），改用"逐轴 + 递减步长"补偿，避免整步挤进墙角
    if (!moved && (Math.abs(dx) > 1e-6 || Math.abs(dz) > 1e-6)) {
      for (var k = 0.5; k > 0.05; k -= 0.15) {
        var sx = this.pos.x + dx * k;
        if (!this.collides(sx, this.pos.z)) { this.pos.x = sx; moved = true; break; }
        var sz = this.pos.z + dz * k;
        if (!this.collides(this.pos.x, sz)) { this.pos.z = sz; moved = true; break; }
      }
    }
    return moved;
  };

  /* ------------------------------------------------------------
   * 主更新
   * ---------------------------------------------------------- */

  /**
   * @param {number} dt 秒
   * @param {Object} input {moveX, moveY} 归一化输入（-1~1）
   * @param {Object} settings 当前设置
   */
  Player.prototype.update = function (dt, input, settings) {
    dt = Math.min(dt, 0.1); // 防止切标签页后瞬移

    if (this.autoActive) {
      this.updateAutoPath(dt, settings);
    } else {
      this.updateManual(dt, input, settings);
    }

    // 已探索区域：降频到每 100ms 或跨格时刷新一次（原为每帧 O(R²) 视线检测，开销大）
    this._exploreAccum += dt;
    var gNow = this.getGrid();
    var gMoved = !this._exploreLastGrid ||
      gNow.x !== this._exploreLastGrid.x || gNow.y !== this._exploreLastGrid.y;
    if (this._exploreAccum >= 0.1 || gMoved) {
      this._exploreAccum = 0;
      this._exploreLastGrid = gNow;
      this.markExplored();
    }
    this.syncCamera();
  };

  /** 手动移动 */
  Player.prototype.updateManual = function (dt, input, settings) {
    var mx = input.moveX || 0;
    var my = input.moveY || 0;
    if (mx === 0 && my === 0) {
      // 静止：相位继续自然演进，但晃动幅度快速衰减到 0（约 0.17 秒）
      this.bobPhase += dt * 2;
      this._bobDamping = Math.max(0, this._bobDamping - dt * 6);
      return;
    }
    // 移动：晃动幅度恢复到满值
    this._bobDamping = Math.min(1, this._bobDamping + dt * 4);

    // 输入向量长度限幅
    var len = Math.sqrt(mx * mx + my * my);
    if (len > 1) { mx /= len; my /= len; }

    var speed = this.baseSpeed * (settings.moveSpeed || 1);
    // 前进方向：my>0 表示向前
    var dirX = this.forward.x * my + this.rightVec.x * mx;
    var dirZ = this.forward.z * my + this.rightVec.z * mx;

    var nd = Math.sqrt(dirX * dirX + dirZ * dirZ) || 1;
    dirX /= nd; dirZ /= nd;

    var moved = this.tryMove(dirX * speed * dt, dirZ * speed * dt);
    if (moved) {
      // 头部晃动 + 脚步
      this.bobPhase += dt * (9.0 * (settings.moveSpeed || 1));
      this.accumulateSteps(speed * dt, settings);
    }
  };

  /** 步数累计 + 脚步音效 */
  Player.prototype.accumulateSteps = function (distance, settings) {
    this.stepDistance += distance;
    // 每走 1.6 米算一步
    var stepLen = 1.6;
    while (this.stepDistance >= stepLen) {
      this.stepDistance -= stepLen;
      this.steps++;
      if (MG.Audio && (!settings || settings.sfx)) {
        MG.Audio.step((settings && settings.moveSpeed || 1) > 1.3);
      }
    }
  };

  /* ------------------------------------------------------------
   * 自动寻路
   * ---------------------------------------------------------- */

  /**
   * 开始自动寻路
   * @param {Array<{x,z}>} worldPath
   * @param {Object} [opts] { kind: 'best'|'fast', limit: number|null, ribbon: boolean }
   *   - kind：寻路类型（best=最佳路径 / fast=最快路径）
   *   - limit：本次最大行走格数（null 或不传 = 不限制）
   *   - ribbon：是否显示路径光带（默认 true；最快路径传 false）
   * @returns {boolean}
   */
  Player.prototype.startAutoPath = function (worldPath, opts) {
    if (!worldPath || worldPath.length < 2) return false;
    opts = opts || {};
    this.autoPath = worldPath;
    this.autoIndex = 1;      // 目标点从第 1 个开始（第 0 个是当前位置）
    this.autoActive = true;
    this.autoKind = opts.kind || null;
    this.autoLimit = (typeof opts.limit === 'number' && opts.limit > 0)
      ? Math.floor(opts.limit) : null;
    this.autoCells = 0;
    this.autoStoppedByLimit = false;
    this.autoStoppedKind = null;
    this.autoReachedEnd = false;
    this._stuckCount = 0;
    this._autoLastGrid = this.getGrid();
    // 光带默认显示（ribbon === false 时跳过）
    if (opts.ribbon !== false) this.buildPathVisual(worldPath);
    return true;
  };

  /** 中断自动寻路 */
  Player.prototype.cancelAutoPath = function () {
    var was = this.autoActive;
    this.autoActive = false;
    this.autoPath = null;
    this.autoIndex = 0;
    this.autoKind = null;
    this.autoLimit = null;
    this.autoCells = 0;
    this.autoStoppedKind = null;
    this.autoReachedEnd = false;
    this._stuckCount = 0;
    this._autoLastGrid = null;
    this.clearPathVisual();
    return was;
  };

  Player.prototype.updateAutoPath = function (dt, settings) {
    var path = this.autoPath;
    if (!path) { this.autoActive = false; return; }

    var target = path[this.autoIndex];
    if (!target) {
      this.finishAutoPath();
      return;
    }

    var dx = target.x - this.pos.x;
    var dz = target.z - this.pos.z;
    var dist = Math.sqrt(dx * dx + dz * dz);

    // 到达当前节点 → 前进到下一个
    var arriveEps = 0.18;
    if (dist < arriveEps) {
      this.autoIndex++;
      if (this.autoIndex >= path.length) {
        this.finishAutoPath();
        return;
      }
      target = path[this.autoIndex];
      dx = target.x - this.pos.x;
      dz = target.z - this.pos.z;
      dist = Math.sqrt(dx * dx + dz * dz) || 1;
    }

    // 平滑转向：把 yaw 朝路径方向插值
    var desiredYaw = Math.atan2(-dx, -dz);
    this.yaw = lerpAngle(this.yaw, desiredYaw, Math.min(1, dt * 6));

    // 前进
    var speed = this.autoSpeed * (settings.moveSpeed || 1) * 1.05;
    var step = Math.min(speed * dt, dist);
    var nd = dist || 1;
    var moved = this.tryMove((dx / nd) * step, (dz / nd) * step);

    if (moved) {
      this._stuckCount = 0;
      this.bobPhase += dt * 10.5;
      this.accumulateSteps(step, settings);
      // 距离限制：按网格步数计量（相邻两格 = 1 步），到点即停
      if (this.autoLimit != null && this.trackAutoCells() >= this.autoLimit) {
        this.stopByLimit();
        return;
      }
    } else {
      // 被卡住：先累计卡住帧数，连续 8 帧仍无法移动才跳过一个节点
      // （避免连续瞬跳整段路径导致"瞬移到终点附近"）
      this._stuckCount++;
      if (this._stuckCount >= 8) {
        this._stuckCount = 0;
        // 提示节流：2 秒内最多提示一次，避免刷屏
        var nowT = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        if (nowT - this._stuckToastAt > 2000) {
          this._stuckToastAt = nowT;
          if (MG.UI && MG.UI.toast) MG.UI.toast('路径受阻，正在重规划…', 1500);
        }
        // 跳点：连续跳过路径点，直到下一个点离玩家超过 0.5 米（或路径结束）。
        // 拐角处 toWorldPath 插了多个贝塞尔采样点，一次只跳一格会一顿一顿地抽搐
        this.autoIndex++;
        while (this.autoIndex < path.length) {
          var nxt = path[this.autoIndex];
          var ndx = nxt.x - this.pos.x;
          var ndz = nxt.z - this.pos.z;
          if (ndx * ndx + ndz * ndz > 0.25) break; // 0.5 米之外才停下
          this.autoIndex++;
        }
        if (this.autoIndex >= path.length) this.finishAutoPath();
      }
    }
  };

  /** 统计本次自动寻路已走的网格步数（相邻两格 = 1 步） */
  Player.prototype.trackAutoCells = function () {
    var g = this.getGrid();
    var lg = this._autoLastGrid || g;
    var delta = Math.abs(g.x - lg.x) + Math.abs(g.y - lg.y);
    if (delta > 0) {
      this._autoLastGrid = g;
      this.autoCells += delta;
    }
    return this.autoCells;
  };

  /** 距离限制到点：停下并同步清除光带（不算到达终点） */
  Player.prototype.stopByLimit = function () {
    this.autoStoppedByLimit = true;
    this.autoStoppedKind = this.autoKind; // 先记录本次类型，供主程序区分提示/顺手拾取
    this.autoActive = false;
    this.autoPath = null;
    this.autoIndex = 0;
    this.autoKind = null;
    this.clearPathVisual();
    if (typeof this.onAutoFinish === 'function') this.onAutoFinish();
  };

  Player.prototype.finishAutoPath = function () {
    this.autoActive = false;
    this.autoPath = null;
    this.autoIndex = 0;
    this.autoKind = null;
    this._autoLastGrid = null;
    // 标记"是否正常走到终点"，供主程序区分提示（到达终点时由胜利界面接管，避免双 toast）
    this.autoReachedEnd = this.reachedEnd();
    this.clearPathVisual();
    if (typeof this.onAutoFinish === 'function') this.onAutoFinish();
  };

  /* ------------------------------------------------------------
   * 路径可视化：半透明光带 + 移动光点
   * ---------------------------------------------------------- */
  Player.prototype.buildPathVisual = function (worldPath) {
    this.clearPathVisual();
    if (!worldPath || worldPath.length < 2) return;

    var group = new THREE.Group();
    group.name = 'autoPathVisual';

    // 1) 沿路径的高亮光带（用一系列扁平圆角四边形/圆盘拼合）
    var y = 0.06;
    var ringGeo = new THREE.CircleGeometry(0.42, 16);
    var ringMat = new THREE.MeshBasicMaterial({
      color: 0x62e6ff, transparent: true, opacity: 0.34,
      depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending
    });
    var lineMat = new THREE.MeshBasicMaterial({
      color: 0x9ffcff, transparent: true, opacity: 0.22,
      depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending
    });

    // 采样点（避免点太密导致三角形过多）
    var step = 1;
    var count = Math.ceil(worldPath.length / step);
    var disc = new THREE.InstancedMesh(ringGeo, ringMat, count);
    var m4 = new THREE.Matrix4();
    var q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
    var scale = new THREE.Vector3(1, 1, 1);

    var n = 0;
    for (var i = 0; i < worldPath.length; i += step) {
      var p = worldPath[i];
      m4.compose(new THREE.Vector3(p.x, y, p.z), q, scale);
      disc.setMatrixAt(n++, m4);
    }
    disc.count = n;
    disc.instanceMatrix.needsUpdate = true;
    group.add(disc);

    // 2) 连接线段（细带）
    var positions = [];
    for (var k = 0; k < worldPath.length - 1; k++) {
      var a = worldPath[k], b = worldPath[k + 1];
      // 用细长四边形近似（宽 0.16）
      var ddx = b.x - a.x, ddz = b.z - a.z;
      var l = Math.sqrt(ddx * ddx + ddz * ddz) || 1;
      var nxv = -ddz / l * 0.09, nzv = ddx / l * 0.09;
      // 两个三角形
      positions.push(
        a.x + nxv, y, a.z + nzv,
        a.x - nxv, y, a.z - nzv,
        b.x - nxv, y, b.z - nzv,
        a.x + nxv, y, a.z + nzv,
        b.x - nxv, y, b.z - nzv,
        b.x + nxv, y, b.z + nzv
      );
    }
    var ribbonGeo = new THREE.BufferGeometry();
    ribbonGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    var ribbon = new THREE.Mesh(ribbonGeo, lineMat);
    group.add(ribbon);

    // 3) 终点标记光柱（蓝色）
    var last = worldPath[worldPath.length - 1];
    var endRing = new THREE.Mesh(
      new THREE.RingGeometry(0.4, 0.62, 28),
      new THREE.MeshBasicMaterial({
        color: 0x62e6ff, transparent: true, opacity: 0.5,
        depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending
      })
    );
    endRing.rotation.x = -Math.PI / 2;
    endRing.position.set(last.x, y + 0.01, last.z);
    group.add(endRing);
    this._endRing = endRing;

    this.pathGroup = group;
    if (MG.game && MG.game.scene) MG.game.scene.add(group);
  };

  Player.prototype.clearPathVisual = function () {
    if (this.pathGroup && MG.game && MG.game.scene) {
      MG.game.scene.remove(this.pathGroup);
    }
    if (this.pathGroup) {
      this.pathGroup.traverse(function (o) {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
    }
    this.pathGroup = null;
    this._endRing = null;
  };

  /** 每帧更新路径光带（呼吸） */
  Player.prototype.updatePathVisual = function (dt, elapsed) {
    if (!this.pathGroup) return;
    var opacity = 0.30 + Math.sin(elapsed * 3) * 0.08;
    this.pathGroup.traverse(function (o) {
      if (o.material && o.material.transparent && o.material.opacity !== undefined) {
        if (o.material.blending === THREE.AdditiveBlending) o.material.opacity = opacity;
      }
    });
    if (this._endRing) this._endRing.rotation.z += dt * 0.8;
  };

  /* ------------------------------------------------------------
   * 已探索区域
   * ---------------------------------------------------------- */
  Player.prototype.markExplored = function () {
    var cell = this.cell;
    var gx = Math.round((this.pos.x + this.half - cell / 2) / cell);
    var gy = Math.round((this.pos.z + this.half - cell / 2) / cell);
    var size = this.maze.size;
    // 视距内（约 6 格）并且有视线的格子标记为已探索
    var R = 6;
    for (var y = gy - R; y <= gy + R; y++) {
      for (var x = gx - R; x <= gx + R; x++) {
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        var dx = x - gx, dy = y - gy;
        if (dx * dx + dy * dy > R * R) continue;
        // 简单的视线判定，避免"透视"墙体太远
        if (MG.Path && MG.Path.lineOfSight &&
            !MG.Path.lineOfSight(this.maze, gx, gy, x, y)) continue;
        this.explored[y * size + x] = 1;
      }
    }
  };

  /* ------------------------------------------------------------
   * 状态查询
   * ---------------------------------------------------------- */

  /** 当前所在网格坐标 */
  Player.prototype.getGrid = function () {
    var cell = this.cell;
    var gx = Math.round((this.pos.x + this.half - cell / 2) / cell);
    var gy = Math.round((this.pos.z + this.half - cell / 2) / cell);
    return { x: gx, y: gy };
  };

  /** 到终点的最短步数（网格）；同一格内复用上次 BFS 结果，避免每 100ms 全图重算 */
  Player.prototype.distanceToEnd = function () {
    if (!MG.Path) return -1;
    var g = this.getGrid();
    if (g.x === this._lastDistGridX && g.y === this._lastDistGridY) {
      return this._lastDistValue;
    }
    var d = MG.Path.gridDistance(this.maze, g, this.maze.end);
    this._lastDistGridX = g.x;
    this._lastDistGridY = g.y;
    this._lastDistValue = d;
    return d;
  };

  /** 到终点的直线距离（米） */
  Player.prototype.euclidToEnd = function () {
    var ew = MG.Maze.cellToWorld(this.maze.end.x, this.maze.end.y, this.maze);
    var dx = this.pos.x - ew.x;
    var dz = this.pos.z - ew.z;
    return Math.sqrt(dx * dx + dz * dz);
  };

  /** 是否已到达终点 */
  Player.prototype.reachedEnd = function (threshold) {
    var ew = MG.Maze.cellToWorld(this.maze.end.x, this.maze.end.y, this.maze);
    var dx = this.pos.x - ew.x;
    var dz = this.pos.z - ew.z;
    var t = threshold || 0.85;
    return (dx * dx + dz * dz) < t * t;
  };

  /** 终点相对于玩家朝向的角度（用于指南针） */
  Player.prototype.angleToEnd = function () {
    var ew = MG.Maze.cellToWorld(this.maze.end.x, this.maze.end.y, this.maze);
    var dx = ew.x - this.pos.x;
    var dz = ew.z - this.pos.z;
    // 朝向终点时应该使用的 yaw（与 forward = (-sin yaw, 0, -cos yaw) 对应）
    var yawTarget = Math.atan2(-dx, -dz);
    // 相对当前朝向的偏差
    var rel = yawTarget - this.yaw;
    // 归一化到 -PI..PI
    while (rel > Math.PI) rel -= Math.PI * 2;
    while (rel < -Math.PI) rel += Math.PI * 2;
    return rel;
  };

  /** 重置到起点 */
  Player.prototype.reset = function () {
    var sw = MG.Maze.cellToWorld(this.maze.start.x, this.maze.start.y, this.maze);
    this.pos.set(sw.x, 0, sw.z);
    this.yaw = 0;
    this.pitch = 0;
    this.bobPhase = 0;
    this._bobDamping = 1;
    this._lastDistGridX = -1;
    this._lastDistGridY = -1;
    this._lastDistValue = -1;
    this.steps = 0;
    this.stepDistance = 0;
    this.cancelAutoPath();
    this.autoStoppedByLimit = false;
    this.explored = new Uint8Array(this.maze.size * this.maze.size);
    this.markExplored();
    this.syncCamera();
  };

  /** 角度插值（最短路径） */
  function lerpAngle(a, b, t) {
    var diff = b - a;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    return a + diff * t;
  }

  MG.Player = Player;

})(window);