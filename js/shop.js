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
    fastPath: 0          // 最快路径剩余次数
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
      desc: '启动"最快路径"自动寻路：忽略沿途金币与地图，径直冲向终点',
      price: 20, limit: 99, type: 'count'
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
      fastPath: DEFAULT_WALLET.fastPath
    };
    if (!data || typeof data !== 'object') return w;

    if (typeof data.coins === 'number' && isFinite(data.coins)) {
      w.coins = Math.max(0, Math.floor(data.coins));
    }
    if (typeof data.boostEarn === 'boolean') w.boostEarn = data.boostEarn;

    var countKeys = ['mapUnlock', 'bestPath', 'fastPath'];
    for (var i = 0; i < countKeys.length; i++) {
      var k = countKeys[i];
      if (typeof data[k] === 'number' && isFinite(data[k])) {
        // 只保底不小于 0：彩蛋奖励可重复累加，不做 99 上限截断（避免超出部分丢失）
        w[k] = Math.max(0, Math.floor(data[k]));
      }
    }
    return w;
  }

  /** 读取钱包（带内存缓存） */
  function getWallet() {
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

  /** 增加金币（返回最新余额） */
  function addCoins(n) {
    var w = getWallet();
    var add = Math.floor(Number(n) || 0);
    if (add <= 0) return w.coins;
    w.coins += add;
    saveWallet();
    return w.coins;
  }

  /** 尝试扣除金币（余额不足返回 false） */
  function spendCoins(n) {
    var w = getWallet();
    var cost = Math.floor(Number(n) || 0);
    if (cost <= 0) return true;
    if (w.coins < cost) return false;
    w.coins -= cost;
    saveWallet();
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
   *   reason: 'invalid' | 'max' | 'poor'
   */
  function buy(id) {
    var item = getItem(id);
    if (!item) return { ok: false, reason: 'invalid' };
    var w = getWallet();
    if (isMaxed(id)) return { ok: false, reason: 'max', item: item };
    if (w.coins < item.price) return { ok: false, reason: 'poor', item: item };

    w.coins -= item.price;
    if (item.type === 'buyout') w[id] = true;
    else w[id] = countOf(id) + 1;
    saveWallet();
    return { ok: true, item: item };
  }

  /** 消耗一次道具（数量不足返回 false；买断类不可消耗） */
  function consumeItem(id) {
    var item = getItem(id);
    if (!item || item.type === 'buyout') return false;
    var w = getWallet();
    var cur = countOf(id);
    if (cur <= 0) return false;
    w[id] = cur - 1;
    saveWallet();
    return true;
  }

  /** 金币收益倍率（默认 1.0，买断后 1.25） */
  function coinMultiplier() {
    return getWallet().boostEarn ? BOOST_MULTIPLIER : 1.0;
  }

  /** 隐藏彩蛋奖励①：金币数（长按商店 → 答对问题） */
  var SECRET_GIFT_COINS = 99999;
  /** 隐藏彩蛋奖励②：道具数量（金币收益按一次性买断处理） */
  var SECRET_GIFT_ITEM_COUNT = 99999;

  /**
   * 领取隐藏彩蛋奖励①（答对"deepseek"专用）：+99,999 金币
   * 可重复获取：每次答对都会发放
   * @returns {boolean} 是否发放成功
   */
  function claimSecretGift() {
    var w = getWallet();
    w.coins += SECRET_GIFT_COINS;
    saveWallet();
    return true;
  }

  /**
   * 领取隐藏彩蛋奖励②（答对"AdroitHare8579"专用）：各道具 +99,999（可累积，不做 99 上限截断）
   * - 可重复获取：每次答对都会发放（例：已有 80 → 179 → 278 …）
   * - 金币收益为买断类道具：只相当于一次购买（boostEarn = true，不叠加）
   * @returns {boolean} 是否发放成功
   */
  function claimSecretItemGift() {
    var w = getWallet();
    w.mapUnlock = countOf('mapUnlock') + SECRET_GIFT_ITEM_COUNT;
    w.bestPath = countOf('bestPath') + SECRET_GIFT_ITEM_COUNT;
    w.fastPath = countOf('fastPath') + SECRET_GIFT_ITEM_COUNT;
    w.boostEarn = true; // 买断类：只相当于一次购买
    saveWallet();
    return true;
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
    addCoins: addCoins,
    spendCoins: spendCoins,
    getItem: getItem,
    countOf: countOf,
    isMaxed: isMaxed,
    buy: buy,
    consumeItem: consumeItem,
    coinMultiplier: coinMultiplier,
    SECRET_GIFT_COINS: SECRET_GIFT_COINS,
    SECRET_GIFT_ITEM_COUNT: SECRET_GIFT_ITEM_COUNT,
    claimSecretGift: claimSecretGift,
    claimSecretItemGift: claimSecretItemGift
  };

})(window);
