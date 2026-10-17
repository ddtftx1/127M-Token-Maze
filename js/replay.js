/* ============================================================
 * js/replay.js
 * 回放 / 幽灵模块
 * - 记录玩家路径帧（默认每 100ms 一帧）
 * - 压缩存储：位置保留 2 位小数、朝向 3 位小数、时间戳用相对时间（2 位小数）
 * - localStorage 按「难度 + 种子」为 key 存储
 * - 帧插值采样：供通关后回放与"幽灵实时对战"共用
 * - 幽灵模型：半透明胶囊体（简单几何体）
 * ============================================================ */
(function (global) {
  'use strict';

  var MG = global.MG = global.MG || {};
  var THREE = global.THREE;

  /** localStorage key 前缀 */
  var PREFIX = 'maze3d.replay.v1.';
  /** 全局最多保留的回放条数（防止 localStorage 膨胀） */
  var MAX_REPLAYS = 24;
  /** 采样间隔（秒） */
  var SAMPLE_INTERVAL = 0.1;
  /** 单局最大帧数保护（约 20 分钟） */
  var MAX_FRAMES = 12000;
  /** prune 节流计数：全量扫描 localStorage 开销大，每 5 次保存执行一次 */
  var pruneTick = 0;

  function safeGet(key) {
    try { return global.localStorage.getItem(key); } catch (e) { return null; }
  }
  function safeSet(key, value) {
    try { global.localStorage.setItem(key, value); return true; } catch (e) { return false; }
  }

  /** 生成存储 key（种子可能含特殊字符，做 URI 编码） */
  function makeKey(diffKey, seed) {
    return PREFIX + String(diffKey) + '.' + encodeURIComponent(String(seed == null ? '' : seed));
  }

  /** 单帧压缩：[x, z, yaw, t] */
  function compressFrame(x, z, yaw, t) {
    return [
      Math.round(x * 100) / 100,
      Math.round(z * 100) / 100,
      Math.round(yaw * 1000) / 1000,
      Math.round(t * 100) / 100
    ];
  }

  /* ------------------------------------------------------------
   * 记录器
   * ---------------------------------------------------------- */
  function createRecorder() {
    return {
      frames: [],
      acc: 0,
      time: 0,
      done: false,

      /**
       * 每帧推进
       * @param {number} dt 帧间隔（秒）
       * @param {number} x 玩家世界 x
       * @param {number} z 玩家世界 z
       * @param {number} yaw 玩家朝向（弧度）
       */
      update: function (dt, x, z, yaw) {
        if (this.done) return;
        this.time += dt;
        this.acc += dt;
        // 第一帧立即记录（起点）
        if (this.frames.length === 0) {
          this.frames.push(compressFrame(x, z, yaw, 0));
          this.acc = 0;
          return;
        }
        while (this.acc >= SAMPLE_INTERVAL && this.frames.length < MAX_FRAMES) {
          this.acc -= SAMPLE_INTERVAL;
          this.frames.push(compressFrame(x, z, yaw, this.time));
        }
        if (this.frames.length >= MAX_FRAMES) this.acc = 0;
      },

      /** 结束并返回帧序列（可补录终点帧） */
      finish: function (x, z, yaw) {
        this.done = true;
        if (typeof x === 'number' && typeof z === 'number') {
          this.frames.push(compressFrame(x, z, yaw || 0, this.time));
        }
        return this.frames;
      }
    };
  }

  /* ------------------------------------------------------------
   * 存储
   * ---------------------------------------------------------- */

  /**
   * 保存一局回放
   * @param {string} diffKey 难度
   * @param {string} seed 种子
   * @param {Array} frames 帧序列
   * @param {Object} [meta] {time, steps, auto}
   * @returns {boolean}
   */
  function save(diffKey, seed, frames, meta) {
    if (!frames || frames.length < 2) return false;
    meta = meta || {};
    var payload = {
      v: 1,
      diff: String(diffKey),
      seed: String(seed == null ? '' : seed),
      date: new Date().toISOString().slice(0, 10),
      savedAt: Date.now(),
      time: meta.time || frames[frames.length - 1][3] || 0,
      steps: meta.steps || 0,
      auto: !!meta.auto,
      frames: frames
    };
    var ok = safeSet(makeKey(diffKey, seed), JSON.stringify(payload));
    // 节流：每 5 次保存才全量扫描一次（prune 开销与 localStorage 规模相关）
    if (ok) {
      pruneTick++;
      if (pruneTick % 5 === 0) prune();
    }
    return ok;
  }

  /** 读取一局回放的帧序列（不存在返回 null） */
  function load(diffKey, seed) {
    var raw = safeGet(makeKey(diffKey, seed));
    if (!raw) return null;
    try {
      var data = JSON.parse(raw);
      if (!data || !data.frames || !data.frames.length) return null;
      return data.frames;
    } catch (e) {
      return null;
    }
  }

  /** 读取完整回放数据（含 meta） */
  function loadFull(diffKey, seed) {
    var raw = safeGet(makeKey(diffKey, seed));
    if (!raw) return null;
    try {
      var data = JSON.parse(raw);
      if (!data || !data.frames || !data.frames.length) return null;
      return data;
    } catch (e) {
      return null;
    }
  }

  /** 清理最旧的回放，保持总条数不超过上限 */
  function prune() {
    try {
      var keys = [];
      var i;
      for (i = 0; i < global.localStorage.length; i++) {
        var k = global.localStorage.key(i);
        if (k && k.indexOf(PREFIX) === 0) keys.push(k);
      }
      if (keys.length <= MAX_REPLAYS) return;
      var items = [];
      for (i = 0; i < keys.length; i++) {
        var savedAt = 0;
        try {
          var d = JSON.parse(global.localStorage.getItem(keys[i]) || '{}');
          savedAt = d.savedAt || 0;
        } catch (e) { /* 损坏数据视为最旧 */ }
        items.push({ key: keys[i], savedAt: savedAt });
      }
      items.sort(function (a, b) { return a.savedAt - b.savedAt; });
      var removeCount = items.length - MAX_REPLAYS;
      for (i = 0; i < removeCount; i++) {
        try { global.localStorage.removeItem(items[i].key); } catch (e) { /* 忽略 */ }
      }
    } catch (e) { /* 忽略 */ }
  }

  /* ------------------------------------------------------------
   * 采样（回放 / 幽灵共用）
   * ---------------------------------------------------------- */

  /** 最短角插值 */
  function lerpAngle(a, b, t) {
    var diff = b - a;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    return a + diff * t;
  }

  /**
   * 按时间 t 在帧序列中采样（线性插值）
   * @returns {{x:number, z:number, yaw:number}|null}
   */
  function sample(frames, t) {
    if (!frames || frames.length === 0) return null;
    if (t <= frames[0][3]) {
      return { x: frames[0][0], z: frames[0][1], yaw: frames[0][2] };
    }
    var last = frames[frames.length - 1];
    if (t >= last[3]) {
      return { x: last[0], z: last[1], yaw: last[2] };
    }
    // 二分查找区间
    var lo = 0, hi = frames.length - 1;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (frames[mid][3] <= t) lo = mid; else hi = mid;
    }
    var a = frames[lo], b = frames[hi];
    var span = (b[3] - a[3]) || SAMPLE_INTERVAL;
    var u = Math.max(0, Math.min(1, (t - a[3]) / span));
    return {
      x: a[0] + (b[0] - a[0]) * u,
      z: a[1] + (b[1] - a[1]) * u,
      yaw: lerpAngle(a[2], b[2], u)
    };
  }

  /* ------------------------------------------------------------
   * 幽灵模型（半透明胶囊体 + 光环 + 朝向标记）
   * ---------------------------------------------------------- */
  function createGhost(scene) {
    var group = new THREE.Group();
    group.name = 'replayGhost';

    var ghostMat = new THREE.MeshLambertMaterial({
      color: 0x7dffb0, transparent: true, opacity: 0.42,
      emissive: 0x123c26, depthWrite: false
    });

    var bodyGeo = THREE.CapsuleGeometry
      ? new THREE.CapsuleGeometry(0.34, 0.95, 6, 14)
      : new THREE.CylinderGeometry(0.34, 0.34, 1.35, 14);
    var body = new THREE.Mesh(bodyGeo, ghostMat);
    body.position.y = 1.05;
    group.add(body);

    // 朝向标记（小圆锥，指向 -Z，与玩家 forward 一致）
    var nose = new THREE.Mesh(
      new THREE.ConeGeometry(0.11, 0.24, 10),
      ghostMat
    );
    nose.rotation.x = -Math.PI / 2;
    nose.position.set(0, 1.28, -0.42);
    group.add(nose);

    // 脚下光环
    var ring = new THREE.Mesh(
      new THREE.RingGeometry(0.34, 0.5, 28),
      new THREE.MeshBasicMaterial({
        color: 0x7dffb0, transparent: true, opacity: 0.32,
        side: THREE.DoubleSide, depthWrite: false
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.04;
    group.add(ring);

    scene.add(group);

    var ghost = {
      group: group,
      body: body,
      ring: ring,
      _t: 0,

      /** 设置幽灵姿态（世界坐标 + 朝向） */
      setPose: function (x, z, yaw) {
        group.position.x = x;
        group.position.z = z;
        group.rotation.y = yaw || 0;
      },

      /** 每帧动画（上下漂浮 / 光环呼吸） */
      update: function (dt) {
        this._t += dt;
        body.position.y = 1.05 + Math.sin(this._t * 2.6) * 0.07;
        var s = 1 + Math.sin(this._t * 3.2) * 0.12;
        ring.scale.set(s, s, s);
      },

      dispose: function () {
        if (scene) scene.remove(group);
        group.traverse(function (o) {
          if (o.geometry) o.geometry.dispose();
          if (o.material) o.material.dispose();
        });
      }
    };
    return ghost;
  }

  /* ------------------------------------------------------------
   * 导出
   * ---------------------------------------------------------- */
  MG.Replay = {
    SAMPLE_INTERVAL: SAMPLE_INTERVAL,
    MAX_REPLAYS: MAX_REPLAYS,
    makeKey: makeKey,
    createRecorder: createRecorder,
    save: save,
    load: load,
    loadFull: loadFull,
    sample: sample,
    createGhost: createGhost
  };

})(window);