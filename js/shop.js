/* ============================================================
 * js/shop.js
 * 商店模块（钱包 + 商品）
 * - 钱包：跨局累积的金币、买断状态、道具剩余次数
 *   localStorage key: maze3d.wallet.v1
 * - 商品：小地图开局解锁 / 最佳路径 / 最快路径 / 金币收益 +25%
 * - 提供直购（不做套餐折扣）、消耗次数、收益倍率查询
 * - 数据缺失时初始化默认结构；数据损坏时重置不崩溃
 * ============================================================ */
(function (global) {
  'use strict';

  var MG = global.MG = global.MG || {};

  /** localStorage 存储键 */
  var STORAGE_KEY = 'maze3d.wallet.v1';
  /** 金币收益买断后的倍率 */
  var BOOST_MULTIPLIER = 1.25;

  /** 默认钱包结构 */
  var DEFAULT_WALLET = {
    coins: 0,            // 金币余额
    boostEarn: false,    // 是否已购买"金币收益 +25%"（买断）
    mapUnlock: 0,        // 小地图开局解锁剩余次数
    bestPath: 0,         // 最佳路径剩余次数
    fastPath: 0,         // 最快路径剩余次数
    streakShield: 0      // 签到护符剩余个数（漏签时自动消耗，无手动使用动作）
  };

  /** 商品表（数值定案，直购无折扣） */
  var ITEMS = [
    {
      id: 'mapUnlock', icon: 'map', name: '小地图开局解锁', short: '小地图解锁',
      desc: '本局使用后小地图立即解锁',
      price: 25, limit: 99, type: 'count'
    },
    {
      id: 'bestPath', icon: 'compass', name: '最佳路径', short: '最佳路径',
      desc: '启动「最佳路径」自动寻路：优先拾取沿途金币与地图卷轴（拾取阶段绕开终点，避免提前通关），中/困难难度单次限 60 / 50 格，可再次使用继续拾取',
      price: 30, limit: 99, type: 'count'
    },
    {
      id: 'fastPath', icon: 'bolt', name: '最快路径', short: '最快路径',
      desc: '启动"最快路径"自动寻路：不主动绕路去捡，但途经的金币与地图会顺手拾取',
      price: 20, limit: 99, type: 'count'
    },
    {
      id: 'streakShield', icon: 'shield', name: '签到护符', short: '签到护符',
      desc: '漏签时自动消耗 1 个，保住连签天数（仅对漏签 5 天以内有效，超过则连签清零）',
      price: 40, limit: 99, type: 'count',
      // passive：自动生效的道具。道具面板不给它"使用"按钮（见 js/ui.js renderItemPanel），
      // 数量显示在签到面板头部 —— 放在道具面板里只会让人点了没反应
      passive: true
    },
    {
      id: 'boostEarn', icon: 'money', name: '金币收益 +25%', short: '金币收益 +25%',
      desc: '之后所有局金币拾取量 ×1.25（一次性买断）',
      price: 150, limit: 1, type: 'buyout'
    }
  ];

  /** 内存缓存的钱包 */
  var wallet = null;

  /* ------------------------------------------------------------
   * localStorage 读写（失败时静默降级）
   * ---------------------------------------------------------- */
  function safeGet(key) {
    try { return global.localStorage.getItem(key); } catch (e) { return null; }
  }
  function safeSet(key, value) {
    try { global.localStorage.setItem(key, value); return true; } catch (e) { return false; }
  }

  /**
   * 规范化钱包数据（兼容旧数据 / 损坏数据）
   * 缺失字段补默认值，非法值被钳制，永不抛错
   */
  function normalizeWallet(data) {
    var w = {
      coins: DEFAULT_WALLET.coins,
      boostEarn: DEFAULT_WALLET.boostEarn,
      mapUnlock: DEFAULT_WALLET.mapUnlock,
      bestPath: DEFAULT_WALLET.bestPath,
      fastPath: DEFAULT_WALLET.fastPath,
      // 新增字段必须同时出现在这里与下面的 countKeys：normalizeWallet 是"按白名单重建"的，
      // 只写进 countKeys 而不初始化，老存档读进来时该字段仍是 undefined（随后被 JSON.stringify 丢掉）
      streakShield: DEFAULT_WALLET.streakShield
    };
    if (!data || typeof data !== 'object') return w;

    if (typeof data.coins === 'number' && isFinite(data.coins)) {
      w.coins = Math.max(0, Math.floor(data.coins));
    }
    if (typeof data.boostEarn === 'boolean') w.boostEarn = data.boostEarn;

    var countKeys = ['mapUnlock', 'bestPath', 'fastPath', 'streakShield'];
    for (var i = 0; i < countKeys.length; i++) {
      var k = countKeys[i];
      if (typeof data[k] === 'number' && isFinite(data[k])) {
        // 只保底不小于 0：彩蛋奖励可重复累加，不做 99 上限截断（避免超出部分丢失）
        w[k] = Math.max(0, Math.floor(data[k]));
      }
    }
    return w;
  }

  /**
   * 多标签页同步：别的标签页写过钱包时，把本标签的模块级缓存作废。
   *
   * 背景：钱包是"整份对象缓存 + 整份 JSON 回写"。两个标签页同时开着时，
   * A 标签的缓存是旧值，A 一写盘就把 B 的收益覆盖掉（实测另一标签 500 币被冲成 6）。
   * 这里只做**缓存失效**（下一次 getWallet 重新读盘），不广播状态、不改存档结构，
   * 也不引入任何跨标签副作用；storage 事件不会在本标签自己写入时触发。
   */
  var storageBound = false;
  function bindStorageSync() {
    if (storageBound) return;
    if (typeof global.addEventListener !== 'function') return;
    storageBound = true;
    global.addEventListener('storage', function (e) {
      // e.key === null 表示执行了 localStorage.clear()
      if (!e || e.key === null || e.key === STORAGE_KEY) wallet = null;
    }, false);
  }

  /** 读取钱包（带内存缓存） */
  function getWallet() {
    bindStorageSync();
    if (wallet) return wallet;
    var raw = safeGet(STORAGE_KEY);
    if (!raw) {
      wallet = normalizeWallet(null);
      return wallet;
    }
    try {
      wallet = normalizeWallet(JSON.parse(raw));
    } catch (e) {
      console.warn('[shop] 钱包数据损坏，已重置', e);
      wallet = normalizeWallet(null);
      saveWallet();
    }
    return wallet;
  }

  /** 保存钱包 */
  function saveWallet() {
    if (!wallet) return false;
    return safeSet(STORAGE_KEY, JSON.stringify(wallet));
  }

  /**
   * 作废内存缓存（下次 getWallet() 重新读盘）。
   *
   * 外部绕过 shop 直接改写 localStorage（开发者面板的删除 / 清空 / 导入存档）后必须调用：
   * 否则模块级缓存里的旧钱包会在下一次加币 / 购买时被整份回写，刚删除或刚导入的钱包静默失效。
   * 跨标签页场景由 bindStorageSync 的 storage 事件覆盖，与这里互补。
   */
  function invalidateCache() { wallet = null; }

  /* ------------------------------------------------------------
   * 写盘失败的如实反馈（2026-11-08 复查批次）
   * ------------------------------------------------------------
   * safeSet() 在隐私模式 / 配额已满 / 存储被禁用时会返回 false，原实现把它整个吞掉：
   * 玩家买了道具、扣了金币、界面弹「购买成功」，但磁盘上什么都没变 —— 下次启动道具与
   * 余额一起回退，像是"凭空消失"。
   *
   * 现在的口径：
   *   - buy / spendCoins / consumeItem 写盘失败时**回滚内存改动**再返回失败，
   *     不让"扣了钱没落盘"或"道具用了还能用"这种中间态留在内存里；
   *   - 失败原因记在 lastSaveError，调用方用 takeSaveError() 取（读取即清空），
   *     以便把"余额不足"和"存档不可写"两种失败区分开，给出不一样的提示；
   *   - addCoins 是唯一例外：通关奖励已经算给玩家了，回滚反而会吞掉奖励，
   *     故保持尽力而为（写盘失败时只是本局收益不落盘，不改内存与界面数字）。
   * ---------------------------------------------------------- */
  var lastSaveError = null;

  /** 取走最近一次写盘失败的操作名（'buy'/'spend'/'consume'/'addItem'），读取即清空 */
  function takeSaveError() {
    var e = lastSaveError;
    lastSaveError = null;
    return e;
  }

  /** 增加金币（返回最新余额） */
  function addCoins(n) {
    lastSaveError = null;            // 每次动作先清旧值：调用方读到的必须是本次的结果
    var w = getWallet();
    var add = Math.floor(Number(n) || 0);
    if (add <= 0) return w.coins;
    w.coins += add;
    // 通关奖励不回滚：见上方口径说明
    if (!saveWallet()) lastSaveError = 'addCoins';
    return w.coins;
  }

  /** 尝试扣除金币（余额不足返回 false） */
  function spendCoins(n) {
    lastSaveError = null;
    var w = getWallet();
    var cost = Math.floor(Number(n) || 0);
    if (cost <= 0) return true;
    if (w.coins < cost) return false;
    var prev = w.coins;
    w.coins -= cost;
    if (!saveWallet()) {
      w.coins = prev;                 // 写盘失败：回滚，不能让内存与磁盘分叉
      lastSaveError = 'spend';
      return false;
    }
    return true;
  }

  /** 查询商品定义 */
  function getItem(id) {
    for (var i = 0; i < ITEMS.length; i++) {
      if (ITEMS[i].id === id) return ITEMS[i];
    }
    return null;
  }

  /** 已拥有数量（买断类返回 0/1） */
  function countOf(id) {
    var w = getWallet();
    var item = getItem(id);
    if (!item) return 0;
    if (item.type === 'buyout') return w[id] ? 1 : 0;
    var v = w[id];
    return (typeof v === 'number' && isFinite(v)) ? v : 0;
  }

  /** 是否已达购买上限 */
  function isMaxed(id) {
    var item = getItem(id);
    if (!item) return true;
    return countOf(id) >= item.limit;
  }

  /**
   * 购买商品（直购）
   * @returns {{ok:boolean, reason?:string, item?:object}}
   *   reason: 'invalid' | 'max' | 'poor' | 'save'
   */
  function buy(id) {
    lastSaveError = null;
    var item = getItem(id);
    if (!item) return { ok: false, reason: 'invalid' };
    var w = getWallet();
    if (isMaxed(id)) return { ok: false, reason: 'max', item: item };
    if (w.coins < item.price) return { ok: false, reason: 'poor', item: item };

    var prevCoins = w.coins;
    var prevOwned = w[id];
    w.coins -= item.price;
    if (item.type === 'buyout') w[id] = true;
    else w[id] = countOf(id) + 1;
    if (!saveWallet()) {
      // 写盘失败：把内存里的金币与数量一起还原，并如实告诉调用方（不是"金币不足"）
      w.coins = prevCoins;
      if (prevOwned === undefined) delete w[id]; else w[id] = prevOwned;
      lastSaveError = 'buy';
      return { ok: false, reason: 'save', item: item };
    }
    return { ok: true, item: item };
  }

  /** 消耗一次道具（数量不足返回 false；买断类不可消耗） */
  function consumeItem(id) {
    lastSaveError = null;
    var item = getItem(id);
    if (!item || item.type === 'buyout') return false;
    var w = getWallet();
    var cur = countOf(id);
    if (cur <= 0) return false;
    var prevOwned = w[id];
    w[id] = cur - 1;
    if (!saveWallet()) {
      // 写盘失败：把次数还原，避免"用了但下次启动又回来"的假消耗
      if (prevOwned === undefined) delete w[id]; else w[id] = prevOwned;
      lastSaveError = 'consume';
      return false;
    }
    return true;
  }

  /**
   * 增加道具次数（"非商店来源"的获得途径，例如迷宫里拾取到地图卷轴）
   *
   * 设计约束：
   * - 只对 type === 'count' 的商品生效；买断类（boostEarn）与未知 id 直接返回 false，不写盘；
   * - n 取整，并保证至少为 1（传 0 / 负数 / NaN 都按 1 处理，避免"什么都没加还写了一次盘"）；
   * - 与商店购买共用同一份钱包（同一 localStorage key），所以道具面板里的数量
   *   天然是"购买 + 拾取"合并后的值，使用一次只扣一次；
   * - 不改动 buy / consumeItem / countOf / addCoins 的任何行为与签名。
   *
   * @param {string} id 商品 id（如 'mapUnlock'）
   * @param {number} [n] 增加数量，默认 1
   * @returns {boolean} 是否成功写入
   */
  function addItem(id, n) {
    lastSaveError = null;
    var item = getItem(id);
    // 只允许可计数的道具；买断类与未知 id 一律拒绝，且不触碰钱包
    if (!item || item.type !== 'count') return false;

    var add = Math.floor(Number(n));
    if (!isFinite(add) || add < 1) add = 1;

    var w = getWallet();
    // 用 countOf() 读取再写回：与 buy / consumeItem 保持同一口径（兼容旧数据与损坏修复后的值）
    w[id] = countOf(id) + add;
    var ok = saveWallet();
    if (!ok) lastSaveError = 'addItem';
    return ok;
  }

  /** 金币收益倍率（默认 1.0，买断后 1.25） */
  function coinMultiplier() {
    return getWallet().boostEarn ? BOOST_MULTIPLIER : 1.0;
  }

  /* ------------------------------------------------------------
   * 导出
   * ---------------------------------------------------------- */
  MG.Shop = {
    STORAGE_KEY: STORAGE_KEY,
    BOOST_MULTIPLIER: BOOST_MULTIPLIER,
    DEFAULT_WALLET: DEFAULT_WALLET,
    ITEMS: ITEMS,
    getWallet: getWallet,
    saveWallet: saveWallet,
    invalidateCache: invalidateCache,
    takeSaveError: takeSaveError,
    addCoins: addCoins,
    spendCoins: spendCoins,
    getItem: getItem,
    countOf: countOf,
    isMaxed: isMaxed,
    buy: buy,
    consumeItem: consumeItem,
    addItem: addItem,
    coinMultiplier: coinMultiplier
  };

})(window);
