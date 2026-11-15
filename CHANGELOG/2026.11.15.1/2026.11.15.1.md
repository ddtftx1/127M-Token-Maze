# 更新日志 · 2026-11-15.1

> 本文件只放**当前最新版本**；历史版本按日期归档在 `CHANGELOG/YYYY.MM.DD/`
> （现有 `2026.10.25`、`2026.10.30`、`2026.10.31`、`2026.11.01`、`2026.11.07`、`2026.11.08`、
> `2026.11.09`、`2026.11.14`、`2026.11.14.1`、`2026.11.15`）。
> 下次发新版前，把本文件整体移入新建的版本目录，根目录重新从空白开始写。
> 上一版见 `CHANGELOG/2026.11.15/`（难度体系重构）。本版是 **2026-11-15 的补版**（同日第二个版本）。

## 版本主题

**把"大迷宫"这件事做完整** —— 上一版把困难档推到 121×121（60×60 单元格）之后，
本版补齐了它需要的三块地基，并落地了用户 2026-11-09 就定稿的「地图点击最大化」：

1. **地图点击最大化（M2/M3）** —— 小地图点一下变全屏内接正方形，**不暂停**、
   留白区仍能滑视角、关闭靠专用按钮；`M` 保持"小地图开/关"语义，新增 `V` 键控制最大化。
2. **BUG-069**：设置里调「小地图大小」时徽标数值不实时刷新（用户 2026-11-15 反馈）→ 已修。
3. **大迷宫性能三件套**：终点距离场缓存、最快路径改用距离场梯度下降、
   回放采样间隔按迷宫大小自适应（否则 15 分钟后被静默截断）；
   另外收窄了小地图静态层的失效条件（跨格不再整层重绘）。

**范围**：`index.html`、`css/style.css`、`js/ui.js`、`js/input.js`、`js/main.js`、
`js/pathfinding.js`、`js/player.js`、`js/replay.js`；文档 `BUG/BUG(2026.11.15).md`、`BUG/BUG.md`、`README.md`。
**兼容性**：**无存档格式变化**（`localStorage` key、记录/排行榜 schema、回放 payload 结构都没动）；
回放/幽灵的**采样间隔**在巨型迷宫上由 100ms 变 200ms（老回放仍可读，只是新录的更粗）。

---

## 新增：地图「点击最大化」（M2/M3，用户 2026-11-09 定稿口径）

设计文档 `新难度-地图可读性设计.md` §4 的方案 M2/M3 落地。用户口径（逐条满足）：

| 口径 | 实现 |
|---|---|
| ① 留白区**不关闭**地图、继续可滑视角；关闭靠**专用按钮** | 容器 `#map-full` `pointer-events:none`，只给地图本体与 `#btn-map-full-close` `auto` → 留白事件穿透到 `#look-layer`；点留白不关 |
| ② `M` 保持"小地图开/关"，另加新键 | `M` 语义**一字未动**；新增 **`V`** 键（`input.js` 的 `onToggleMapFull`） |
| ③ **不暂停**、不允许界面互顶 | 全程不改 `state`、不暂停计时、不动输入；`#map-full` 在 `#app` 下与 `#hud` **平级**（不在 `#hud` 内 —— 开道具面板会 `hide('hud')`），`z-index:10`：视角层 5 < **地图 10** < `#hud` 20/摇杆 22 < `.screen` 40 < 回放条 45 < toast 60 |

- 入口：点 HUD 小地图（`.minimap-wrap`）；尺寸 = `min(vw,vh) − 2×(12px+安全区)` 的内接正方形，
  dpr 上限 **1.5**（收起时画布归零释放 + 失效缓存）；**未解锁小地图不允许最大化**（不泄露终点/距离）。
- 绘制**复用**同一套 `drawMinimapStatic`/`drawMinimap`（只切主画布/离屏缓存/尺寸/dpr 四个目标，
  `withMapFullTarget` 成对存取并 try/finally 还原），**ui.js 不开定时器** —— 由 main.js 既有的
  120ms 小地图节流驱动。
- 生命周期（main.js 接线）：`buildLevel` / `backToMenu` / `onVictory` / `startReplay` 自动收起；
  `onResize` 重算尺寸；ESC/P 链在**签到之后、道具面板之前**收起（**不暂停**）。
- 导出：`MG.UI.openMapFull()` / `closeMapFull()` / `toggleMapFull()` / `isMapFullOpen()` /
  `resizeMapFull()` / `drawMinimapFull(player,maze,mazeView,settings)`。
- 2026-11-15 追加收紧：`canOpenMapFull()` 只允许 **playing** ——
  paused/win/replay 已被 `.screen` 盖满，开了也是看不见的地图；"最大化期间被暂停"（开道具面板）
  不受影响，仍保持打开且 `V` 可收起。

> **一个如实备案的取舍**：最大化开着时点"留白"会穿透到 `#look-layer`，而它的 click 语义是
> "重新锁定指针" —— **鼠标用户**点完留白后光标被锁，专用关闭按钮就点不到（`V` 仍可用，
> ESC 通常也能收）。当前按口径 ①"留白继续滑视角"保留穿透（对鼠标用户来说正是这次锁定让"滑视角"生效）；
> 触屏设备没有指针锁定，关闭按钮不受影响。若要"关闭按钮始终可点"，在 `js/input.js` 的 `onClick`
> 里加 3 行 `if (MG.UI.isMapFullOpen()) return;` 即可（其余不用动）。

## Bug 修复：BUG-069

- **BUG-069** · 设置里调节「小地图大小」后，徽标数值**不实时刷新**（要退出设置再进才刷新）。
  根因：设置面板会 `hide('hud')` → 容器不可见 → `resizeMinimap()` 量到 `clientWidth === 0`，
  只能更新档位文字。已新增 `readMinimapSizePx()` 四级回退：量容器 → 读 CSS 变量 `--minimap-size`
  （唯一事实源）→ 挂探针让**浏览器自己求值** `clamp/min/vmin` → 都测不到就**只显示档位、不显示假数字**。
  实测基线"大 · 168px" → 修后"大 · 261px"。归档见 `BUG/BUG(2026.11.15).md`。

## 性能（大迷宫的第三批优化）

- **终点距离场缓存**（`js/pathfinding.js` 新增 `endDistance()` / `fieldPath()`）：
  旧实现每跨一格都要 `gridDistance()` 从零跑整张图 BFS（121×121 实测 2.3ms 平均 / 8ms 最差），
  现在整局只算一次距离场（loading 阶段预热）、查询 O(1)：
  **每跨格取距离 2.3ms → 0.2ms**、`player.distanceToEnd()` **0.005ms**，**返回值逐格一致（0 处不一致）**。
- **"最快路径"改用距离场梯度下降**：与 A\* **路径长度完全一致**（905/789/859 三组对比），
  纯 Node 下 0.2~0.6ms vs A\* 11~22ms。
- **回放不再被静默截断**（长单局缺陷）：`MAX_FRAMES=9000` 在 100ms 采样下只覆盖 15 分钟，
  而 121×121 一局 10~20 分钟 → 巨型迷宫改用 **200ms** 采样（`MG.Replay.pickSampleInterval`），
  30 分钟可完整覆盖；帧数上限未动、配额压力不增，代价是幽灵动作 10Hz→5Hz。
- **小地图静态层失效条件收窄**：去掉"玩家跨格"（玩家标记画在动态层），
  121×121 跨格 60 次：**基线 59 次整层重绘 / 759.7ms → 改后 0 次 / 10.3ms**；
  新探索的格子仍**立刻出现**（已断言像素矩形出现）。

## 过程记录（自己踩的坑，写下来免得下次再犯）

- **`git add -A` 误合并**：提交 `ccc539f`（"修长单局缺陷"）时用了 `git add -A`，
  把并行 teammate 当时**未完成**的 `css/style.css` / `index.html` / `js/input.js` / `js/ui.js`
  改动一起扫了进去，提交信息与内容不符。事后单独拉出该提交跑冒烟确认 **9/9 PASS**（没推坏修订），
  并把 M2/M3 的最终实现与 main.js 接线另提交为 `616b310`。**今后只 `git add <具体路径>`**。

## 验证（本批）

| 项目 | 结果 |
|---|---|
| `node --check` / ES5 扫描 | **14/14** / **0 命中** |
| 无头冒烟 | **9/9 PASS** |
| 回归 | `bug064-repro` 264/0 · `bug065-repro` 45/0 · `bug066-render` 41/0 · `bug067-end` 24/0 |
| M2/M3 + BUG-069 自查（实现者脚本） | **70/70 PASS** |
| M2/M3 的 main.js 接线端到端（Lead） | **14/14 PASS**（未解锁不可开 / 点小地图打开 / 非模态计时继续 / 120ms 节流确实在驱动 `drawMinimapFull` / `V` 开合 / **ESC 收起且不暂停** / 回菜单收起 / 菜单态不可开） |
| 独立验证 | 见 `harness/bug069-verification.md`（另一个 AI 独立复核，**本版发布时仍在进行中**；
报告到位后会在后续提交里补记，不改写本节已记录的内容）。另有 `harness/bug068-mutation.sh` 的
变异测试证明冒烟断言没有被放宽 |

## 改动文件汇总（本批）

| 文件 | 改动 |
|---|---|
| `index.html` | 新增 `#map-full` 层（`#app` 下、与 `#hud` 平级，含内层 canvas 与专用关闭按钮） |
| `css/style.css` | `.map-full` / `.map-full-inner` / 关闭按钮 / `.minimap-wrap{pointer-events:auto}` |
| `js/ui.js` | M2/M3 全部逻辑与 6 个导出；BUG-069 的 `readMinimapSizePx()`；静态层失效条件收窄 |
| `js/input.js` | 新增 `V` 键 → `onToggleMapFull`（`M` 语义不变） |
| `js/main.js` | M2/M3 的 5 处接线；`onSettingChanged` 未改 |
| `js/pathfinding.js` | 新增 `endDistance()` / `fieldPath()`；`findWorldPath` 支持 `algorithm='field'` |
| `js/player.js` | `distanceToEnd()` 改走距离场（带回退） |
| `js/replay.js` | 采样间隔可注入 + `pickSampleInterval()`（巨型迷宫 200ms） |
| `BUG/BUG(2026.11.15).md` | 新增：BUG-069 归档 |
| `BUG/BUG.md` | BUG-069 登记后移入归档；编号推进到 BUG-070 |
| `CHANGELOG.md` | 本文件（累加批次） |
