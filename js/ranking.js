/* ============================================================
 * js/ranking.js
 * 本地排行榜模块
 * - localStorage 存储，按难度分区（simple / medium / hard）
 * - 每条记录：用时、步数、是否用自动寻路、种子、日期
 * - 每个难度保留前 10 名：用时升序 → 步数升序 → 提交序号 seq 升序（完全同分时先提交者在前，保证排序确定）
 * - 不联网，纯本地
 * ============================================================ */
(function (global) {
  'use strict';

  var MG = global.MG = global.MG || {};

  /** localStorage 存储键 */
  var STORAGE_KEY = 'maze3d.ranking.v1';
  /** 每个难度保留的最大条数 */
  var MAX_ENTRIES = 10;

  var DIFF_KEYS = ['simple', 'medium', 'hard'];

  function safeGet(key) {
    try { return global.localStorage.getItem(key); } catch (e) { return null; }
  }
  function safeSet(key, value) {
    try { global.localStorage.setItem(key, value); return true; } catch (e) { return false; }
  }

  /** 规范化数据结构，保证三个难度数组都存在 */
  function normalize(data) {
    var out = { simple: [], medium: [], hard: [] };
    if (data && typeof data === 'object') {
      for (var i = 0; i < DIFF_KEYS.length; i++) {
        var k = DIFF_KEYS[i];
        if (Object.prototype.toString.call(data[k]) === '[object Array]') {
          var arr = data[k].slice(0, MAX_ENTRIES);
          // 旧数据兼容：没有 seq 的记录按现有顺序补发提交序号（先来的序号小）
          for (var j = 0; j < arr.length; j++) {
            var it = arr[j];
            if (it && typeof it === 'object' && !(typeof it.seq === 'number' && isFinite(it.seq))) {
              it.seq = j;
            }
          }
          out[k] = arr;
        }
      }
    }
    return out;
  }

  /** 读取全部排行榜数据 */
  function loadAll() {
    var raw = safeGet(STORAGE_KEY);
    if (!raw) return normalize(null);
    try {
      return normalize(JSON.parse(raw));
    } catch (e) {
      console.warn('[ranking] 数据解析失败，已重置', e);
      return normalize(null);
    }
  }

  /** 保存全部排行榜数据 */
  function saveAll(data) {
    safeSet(STORAGE_KEY, JSON.stringify(data));
  }
  /** 排序比较：用时升序 → 步数升序 → 提交序号升序（完全同分时先提交者在前） */
  function compareEntries(a, b) {
    return (a.time - b.time) || (a.steps - b.steps) || ((Number(a.seq) || 0) - (Number(b.seq) || 0));
  }
  /** 计算下一个提交序号（跨所有难度取最大值 + 1） */
  function nextSeq(all) {
    var max = 0;
    for (var i = 0; i < DIFF_KEYS.length; i++) {
      var arr = all[DIFF_KEYS[i]] || [];
      for (var j = 0; j < arr.length; j++) {
        var s = Number(arr[j] && arr[j].seq) || 0;
        if (s > max) max = s;
      }
    }
    return max + 1;
  }
  /** 获取某难度的排行榜（副本，始终按统一规则排序） */
  function list(diffKey) {
    var all = loadAll();
    var arr = (all[diffKey] || []).slice();
    arr.sort(compareEntries);
    return arr;
  }

  /**
   * 提交一条成绩
   * @param {string} diffKey 难度 key
   * @param {Object} entry {time, steps, auto, seed, date}
   * @returns {{rank:number, list:Array}} rank 为 1..10；未进榜为 0；完全同分时新成绩排在已有同分成绩之后
   */
  function add(diffKey, entry) {
    entry = entry || {};
    var all = loadAll();
    var arr = all[diffKey] || (all[diffKey] = []);

    var record = {
      time: Math.round((Number(entry.time) || 0) * 100) / 100,
      steps: Math.max(0, Math.floor(Number(entry.steps) || 0)),
      auto: !!entry.auto,
      seed: String(entry.seed == null ? '' : entry.seed),
      date: entry.date || new Date().toISOString().slice(0, 10),
      seq: nextSeq(all) // 提交序号：完全同分时保证排序确定（先提交者在前）
    };
    arr.push(record);
    arr.sort(compareEntries);
    if (arr.length > MAX_ENTRIES) arr.length = MAX_ENTRIES;
    all[diffKey] = arr;
    saveAll(all);

    var idx = arr.indexOf(record);
    return {
      rank: idx >= 0 ? idx + 1 : 0,
      list: arr.slice()
    };
  }

  /** 清空某难度的排行榜 */
  function clear(diffKey) {
    var all = loadAll();
    all[diffKey] = [];
    saveAll(all);
  }

  /** 清空全部排行榜 */
  function clearAll() {
    saveAll(normalize(null));
  }

  MG.Ranking = {
    MAX_ENTRIES: MAX_ENTRIES,
    list: list,
    add: add,
    clear: clear,
    clearAll: clearAll,
    loadAll: loadAll
  };

})(window);
