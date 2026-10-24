/* ============================================================
 * js/input.js
 * 输入模块（同时支持触屏与键鼠）
 * - 手机：左下虚拟摇杆（触摸拖动、松手回中）+ 空白区域滑动转视角
 * - 电脑：WASD / 方向键移动，Pointer Lock 鼠标转视角（点击画面锁定，ESC 退出）
 * - 阻止页面滚动、缩放、长按菜单
 * - 快捷键：R 重开 / M 小地图 / P·ESC 暂停 / F 自动寻路
 * ============================================================ */
(function (global) {
  'use strict';

  var MG = global.MG = global.MG || {};

  /**
   * @param {HTMLElement} joystickEl 摇杆容器
   * @param {HTMLElement} knobEl 摇杆手柄
   * @param {HTMLElement} lookLayer 视角触控层（全屏）
   * @param {HTMLElement} hud HUD 容器（用于判断是否点到了按钮）
   * @param {HTMLCanvasElement} canvas
   */
  function Input(joystickEl, knobEl, lookLayer, hud, canvas) {
    this.joystickEl = joystickEl;
    this.knobEl = knobEl;
    this.lookLayer = lookLayer;
    this.hud = hud;
    this.canvas = canvas;

    // 输出状态
    this.moveX = 0;      // 摇杆水平（-1 左 / 1 右）
    this.moveY = 0;      // 摇杆垂直（1 前 / -1 后）
    this.keys = {};      // 键盘按下状态

    // 视角增量累计（每帧由主循环取走）
    this.lookDX = 0;
    this.lookDY = 0;

    // 摇杆内部状态
    this._joyId = null;
    this._joyBase = { x: 0, y: 0 };
    this._joyRadius = 52;

    // 视角触摸状态
    this._lookId = null;
    this._lookLast = { x: 0, y: 0 };

    // 鼠标状态（只保留 Pointer Lock；不再有"按住拖动"模式）
    this.pointerLocked = false;

    // 回调（由主循环注入）
    this.onPause = null;
    this.onRestart = null;
    this.onToggleMinimap = null;
    this.onAutoPath = null;
    this.onToggleItems = null;  // F 键：道具面板开合（新语义）
    this.onFirstInput = null;   // 首次输入（用于解锁音频）
    this.onEsc = null;

    this._bind();
  }

  /* ------------------------------------------------------------
   * 事件绑定
   * ---------------------------------------------------------- */
  Input.prototype._bind = function () {
    var self = this;

    /* ---------- 阻止默认的滚动 / 缩放 / 长按菜单 ---------- */
    document.addEventListener('gesturestart', function (e) { e.preventDefault(); }, { passive: false });
    document.addEventListener('gesturechange', function (e) { e.preventDefault(); }, { passive: false });
    document.addEventListener('contextmenu', function (e) {
      // 允许输入框右键（基本用不到），其余屏蔽
      if (e.target && e.target.tagName === 'INPUT') return;
      e.preventDefault();
    }, { passive: false });
    document.addEventListener('touchmove', function (e) {
      // 只有当触摸目标不在可滚动面板内时才阻止
      var t = e.target;
      while (t && t !== document.body) {
        if (t.dataset && t.dataset.scrollable === '1') return;
        t = t.parentNode;
      }
      if (e.cancelable) e.preventDefault();
    }, { passive: false });

    /* ---------- 虚拟摇杆（触摸） ---------- */
    this.joystickEl.addEventListener('touchstart', function (e) {
      e.preventDefault();
      self._notifyFirstInput();
      var t = e.changedTouches[0];
      self._joyId = t.identifier;
      var rect = self.joystickEl.getBoundingClientRect();
      // 以摇杆中心为基点（也允许在容器内任意位置起手）
      self._joyBase.x = rect.left + rect.width / 2;
      self._joyBase.y = rect.top + rect.height / 2;
      self._joyRadius = rect.width * 0.42;
      self._updateJoystick(t.clientX, t.clientY);
    }, { passive: false });

    this.joystickEl.addEventListener('touchmove', function (e) {
      e.preventDefault();
      for (var i = 0; i < e.changedTouches.length; i++) {
        var t = e.changedTouches[i];
        if (t.identifier === self._joyId) self._updateJoystick(t.clientX, t.clientY);
      }
    }, { passive: false });

    function joyEnd(e) {
      for (var i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === self._joyId) {
          self._joyId = null;
          self.moveX = 0;
          self.moveY = 0;
          self._resetKnob();
        }
      }
    }
    this.joystickEl.addEventListener('touchend', joyEnd, { passive: false });
    this.joystickEl.addEventListener('touchcancel', joyEnd, { passive: false });

    /* ---------- 空白区域滑动转视角（触摸） ---------- */
    this.lookLayer.addEventListener('touchstart', function (e) {
      e.preventDefault();
      self._notifyFirstInput();
      // 取第一个未被摇杆占用的手指
      for (var i = 0; i < e.changedTouches.length; i++) {
        var t = e.changedTouches[i];
        if (self._lookId === null) {
          self._lookId = t.identifier;
          self._lookLast.x = t.clientX;
          self._lookLast.y = t.clientY;
        }
      }
    }, { passive: false });

    this.lookLayer.addEventListener('touchmove', function (e) {
      e.preventDefault();
      for (var i = 0; i < e.changedTouches.length; i++) {
        var t = e.changedTouches[i];
        if (t.identifier === self._lookId) {
          var dx = t.clientX - self._lookLast.x;
          var dy = t.clientY - self._lookLast.y;
          self._lookLast.x = t.clientX;
          self._lookLast.y = t.clientY;
          self.lookDX += dx;
          self.lookDY += dy;
        }
      }
    }, { passive: false });

    function lookEnd(e) {
      for (var i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === self._lookId) self._lookId = null;
      }
    }
    this.lookLayer.addEventListener('touchend', lookEnd, { passive: false });
    this.lookLayer.addEventListener('touchcancel', lookEnd, { passive: false });

    /* ---------- 键盘 ---------- */
    window.addEventListener('keydown', function (e) {
      // 输入控件聚焦时不触发游戏快捷键（含多行输入与富文本，避免以后加输入框踩坑）
      var tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' ||
          (e.target && e.target.isContentEditable)) return;
      self._notifyFirstInput();
      var k = e.key.toLowerCase();
      self.keys[k] = true;
      // 方向键 / 空格阻止页面滚动
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].indexOf(k) >= 0) e.preventDefault();

      if (k === 'r') { if (self.onRestart) self.onRestart(); }
      else if (k === 'm') { if (self.onToggleMinimap) self.onToggleMinimap(); }
      else if (k === 'p') { if (self.onPause) self.onPause(); }
      else if (k === 'f') {
        // F = 道具面板（新）；优先新回调，兼容旧 onAutoPath
        if (self.onToggleItems) self.onToggleItems();
        else if (self.onAutoPath) self.onAutoPath();
      }
      else if (k === 'escape') {
        if (self.pointerLocked) {
          // 浏览器会自动退出锁定，escape 用于暂停交给浏览器处理
        }
        if (self.onPause) self.onPause();
      }
    });

    window.addEventListener('keyup', function (e) {
      var k = e.key.toLowerCase();
      self.keys[k] = false;
    });

    // 窗口失焦时清空按键，避免"卡住不动"
    window.addEventListener('blur', function () {
      self.keys = {};
      self.moveX = 0;
      self.moveY = 0;
      self._joyId = null;
      self._resetKnob();
    });

    /* ---------- 鼠标：Pointer Lock（标准第一人称交互） ----------
       注意：#look-layer 覆盖在 canvas 之上，因此鼠标事件必须绑定在它上面，
       否则"点击锁定指针"不会触发。
       锁定后光标隐藏，移动鼠标即转视角；按 ESC 或窗口失焦时由浏览器自动退出并恢复光标。
       不再保留"按住左键拖动转视角"：那种写法在鼠标拖出窗口后松开时会卡住视角自转。 */
    var mouseTargets = [this.lookLayer, this.canvas];
    for (var mi = 0; mi < mouseTargets.length; mi++) {
      (function (node) {
        if (!node) return;
        node.addEventListener('mousedown', function (e) {
          if (e.button !== 0) return;
          self._notifyFirstInput();
        });
        // 点击画面即尝试进入 Pointer Lock（不按设备类型判断，触屏笔记本 / iPad + 键鼠同样可用）
        node.addEventListener('click', function () {
          if (!self.pointerLocked && !document.hidden) {
            self.requestPointerLock();
          }
        });
        // 双击只在游戏画面区域阻止默认行为；输入框 / 面板等保留浏览器默认（可正常双击选词）
        node.addEventListener('dblclick', function (e) { e.preventDefault(); }, { passive: false });
      })(mouseTargets[mi]);
    }

    window.addEventListener('mousemove', function (e) {
      // 只有锁定状态才转视角：movementX/Y 是原始位移，鼠标可无限移动，不会撞到窗口边缘
      if (!self.pointerLocked) return;
      self.lookDX += e.movementX || 0;
      self.lookDY += e.movementY || 0;
    });

    document.addEventListener('pointerlockchange', function () {
      self.pointerLocked = (document.pointerLockElement === self.canvas);
      // 清空切换瞬间可能产生的一次性大位移，避免退出锁定时"视角跳一下"
      self.lookDX = 0;
      self.lookDY = 0;
    });

    /* ---------- 窗口尺寸变化（摇杆半径需要重算） ---------- */
    window.addEventListener('resize', function () {
      var rect = self.joystickEl.getBoundingClientRect();
      self._joyRadius = rect.width * 0.42;
    });

    /* ---------- 设置面板滚动（标记可滚动区域） ---------- */
    var scrollables = document.querySelectorAll('.settings-scroll, .panel, .screen');
    for (var i = 0; i < scrollables.length; i++) {
      scrollables[i].dataset.scrollable = '1';
    }
  };

  /** 摇杆拖动更新 */
  Input.prototype._updateJoystick = function (cx, cy) {
    var dx = cx - this._joyBase.x;
    var dy = cy - this._joyBase.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var maxR = this._joyRadius;

    var nx, ny;
    if (dist > maxR) {
      nx = dx / dist * maxR;
      ny = dy / dist * maxR;
    } else {
      nx = dx;
      ny = dy;
    }

    // 归一化输出
    this.moveX = nx / maxR;
    this.moveY = -ny / maxR;   // 屏幕向上 → 前进（正）
    // 死区 + 线性重映射：让轻微推动也能得到连续、可预期的响应（而不是死区内直接归零）
    var m = Math.sqrt(this.moveX * this.moveX + this.moveY * this.moveY);
    var dead = 0.12;
    if (m < dead) {
      this.moveX = 0;
      this.moveY = 0;
    } else {
      var m2 = (m - dead) / (1 - dead);
      this.moveX = this.moveX / m * m2;
      this.moveY = this.moveY / m * m2;
    }

    // 手柄位移
    if (this.knobEl) {
      this.knobEl.style.transform = 'translate(' + nx + 'px,' + ny + 'px)';
    }
  };

  /** 手柄回中 */
  Input.prototype._resetKnob = function () {
    if (this.knobEl) this.knobEl.style.transform = 'translate(0px,0px)';
  };

  /** 首次用户输入（用于音频解锁等） */
  Input.prototype._notifyFirstInput = function () {
    if (!this._firstInputDone) {
      this._firstInputDone = true;
      if (this.onFirstInput) this.onFirstInput();
    }
  };

  /* ------------------------------------------------------------
   * 指针锁定
   * ---------------------------------------------------------- */
  Input.prototype.requestPointerLock = function () {
    var self = this;
    try {
      if (self.canvas && self.canvas.requestPointerLock) {
        // 优先请求 unadjustedMovement（禁用系统鼠标加速，FPS 手感更跟手）
        // 必须在用户手势（click）的调用栈里同步发起，不能包 setTimeout
        var p;
        try {
          p = self.canvas.requestPointerLock({ unadjustedMovement: true });
        } catch (e) {
          // 旧浏览器 / Safari 不支持该选项 → 降级为普通请求
          p = self.canvas.requestPointerLock();
        }
        // Chrome 可能返回 rejected Promise（比如权限被拒），降级重试一次，失败静默
        if (p && p.catch) {
          p.catch(function () {
            try { self.canvas.requestPointerLock(); } catch (e2) { /* 忽略 */ }
          });
        }
      }
    } catch (e) { /* 静默忽略：iOS / iPadOS Safari 无此 API */ }
  };

  Input.prototype.exitPointerLock = function () {
    try { if (document.exitPointerLock) document.exitPointerLock(); } catch (e) {}
  };

  /* ------------------------------------------------------------
   * 每帧读取移动输入（合并摇杆与键盘）
   * ---------------------------------------------------------- */
  Input.prototype.getMoveInput = function () {
    var mx = this.moveX;
    var my = this.moveY;
    var k = this.keys;

    // 键盘：W/↑ 前进，S/↓ 后退，A/← 左移，D/→ 右移
    var kx = 0, ky = 0;
    if (k['w'] || k['arrowup']) ky += 1;
    if (k['s'] || k['arrowdown']) ky -= 1;
    if (k['a'] || k['arrowleft']) kx -= 1;
    if (k['d'] || k['arrowright']) kx += 1;

    mx += kx;
    my += ky;

    // 归一化（避免斜向加速）
    var len = Math.sqrt(mx * mx + my * my);
    if (len > 1) { mx /= len; my /= len; }
    return { moveX: mx, moveY: my };
  };

  /** 取走并清空视角增量 */
  Input.prototype.consumeLook = function () {
    var dx = this.lookDX;
    var dy = this.lookDY;
    this.lookDX = 0;
    this.lookDY = 0;
    return { dx: dx, dy: dy };
  };

  /** 是否触屏设备 */
  function isTouchDevice() {
    return ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
  }

  MG.Input = Input;
  MG.isTouchDevice = isTouchDevice;

})(window);