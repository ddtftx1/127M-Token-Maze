# 3D迷宫探险 · 未修复 BUG

> 本文件只放**尚未修复**的条目，文件名不带日期。
> 修复完成后，把条目移到对应日期的 `BUG(YYYY.MM.DD).md` 归档文件里，
> 并在条目下补一行 `✅ 已修 / 日期`。

---

## 当前状态

**共有 4 条待修：BUG-013 ~ BUG-016。**

- BUG-013（P1，移动端）：触摸转视角手指失去接管，可能长时间无法转视角。
- BUG-014（P1，移动端）：中断恢复后摇杆输入不清零，角色自己往前走。
- BUG-015（P1）：难度卡片的自动寻路限程文案与代码实际执行值不一致。
- BUG-016（P2）：设置面板打开时 ESC 无法关闭，面板滞留且游戏在背后继续跑。

以上 4 条均由**静态审查 + 无头环境动态复现**确认（用 THREE.js / DOM / localStorage /
WebAudio 桩加载全部 11 个模块，真实构建关卡并逐帧驱动主循环，触摸事件按
`TouchEvent.identifier` 语义模拟）。复现结论见各条目「验证」段。

截至 2026-10-25，此前的 BUG-001 ~ BUG-012 均已修复并通过回归，
详见同目录归档文件 `BUG(2026.10.25).md`。

---

## 目录

| 编号 | 简要说明 | 模块 | 优先级 |
|------|----------|------|--------|
| [BUG-013](#bug-013--触摸转视角的手指不会被接管抬指后相机长时间失控) | 转视角手指失去接管，可能长时间转不了头 | `js/input.js` | P1 |
| [BUG-014](#bug-014--中断恢复后摇杆输入未清零角色自己往前走) | 中断恢复后角色自己往前走 | `js/input.js` / `js/main.js` | P1 |
| [BUG-015](#bug-015--难度卡片的自动寻路限程文案与代码实际值不一致) | 难度卡片限程文案与代码不符 | `index.html` / `js/main.js` | P1 |
| [BUG-016](#bug-016--设置面板打开时-esc-无法关闭面板滞留且游戏在背后继续跑) | ESC 关不掉设置面板 | `js/main.js` / `js/ui.js` | P2 |

---

## BUG-013 · 触摸转视角的手指不会被接管，抬指后相机长时间失控

- **发现日期**：2026-10-25
- **状态**：待修
- **优先级**：P1
- **模块**：`js/input.js` → `_bind()` 内 `lookLayer` 的 `touchstart` / `touchmove` / `touchend` 处理
- **现象**：
  1. 两根手指先后落在空白区，先按下的手指抬起后，**仍留在屏幕上的那根手指无法转视角**，
     必须抬起再重按才能恢复；
  2. 手指按在空白区时被来电 / 通知 / 切后台打断，若浏览器没有补发 `touchcancel`，
     `_lookId` 会永久指向一个已经不存在的手指，之后所有新手指出于 identifier 不匹配**全被忽略**，
     表现为「能走但转不了头」，只能刷新页面。
- **复现**：
  1. 手机进入游戏；
  2. 手指 A 按在空白区拖动转视角；
  3. 手指 B 再落到空白区（此时 B 被忽略，行为正常）；
  4. 抬起手指 A，保持 B 按住不放；
  5. 移动手指 B → 视角完全不动（预期：接管转视角）。
  - 变体：步骤 2 后切后台再回来（未收到 `touchcancel`），用新手指转视角同样无效。
- **根因分析**：
  `js/input.js:126-132` 的 `touchstart` 只在 `_lookId === null` 时接管：

  ```js
  if (self._lookId === null) {
    self._lookId = t.identifier;
    self._lookLast.x = t.clientX;
    self._lookLast.y = t.clientY;
  }
  ```

  该循环遍历 `changedTouches`，但**不检查 `_lookId` 对应手指是否还按在屏幕上**
  （`e.touches` 里是否还存在该 identifier）。于是：

  - 场景 1：A 抬起后 `lookEnd` 把 `_lookId` 置 `null`，但此时 B 已经在屏幕上、
    不会再触发 `touchstart` → B 永远不会被接管；
  - 场景 2：中断时 `_lookId` 残留旧值，新手指数值不同 → 条件恒为 false，永久无法接管。

  另：`js/input.js:192` 的 `blur` 处理器清了 `keys` / `moveX` / `moveY` / `_joyId`，
  **唯独没有清 `_lookId`**，所以失焦也无法自愈。

  与摇杆的不对称是问题被放大的原因——摇杆 `touchstart`（`js/input.js:86-97`）
  **无条件覆盖** `_joyId`，因此摇杆能被下一次按下自动修复，视角不能。
- **修复**：（待修）建议让视角与摇杆对齐：`touchstart` 时若 `_lookId` 对应手指已不在
  `e.touches` 中（或为 `null`），则用本次触摸重新接管并重置 `_lookLast`；
  同时在 `blur` 处理器里一并清 `_lookId`。
- **验证**：（修完后填）用与本次审查相同的触摸模拟复现两条复现步骤，确认
  抬指后剩下那根手指能直接接管转视角，且中断恢复后新手指可正常转视角。
- **备注**：
  - 只影响触摸路径，键鼠 Pointer Lock 不受影响；
  - 修改点集中在 `js/input.js`，不要动 `TouchEvent` 的 `preventDefault` 逻辑
    （`{ passive: false }` 与全局 `touchmove` 拦截关系到页面不滚动，改动易回归）。

---

## BUG-014 · 中断恢复后摇杆输入未清零，角色自己往前走

- **发现日期**：2026-10-25
- **状态**：待修
- **优先级**：P1
- **模块**：`js/input.js` → `_bind()`（`touchstart` / `touchmove` / `touchend`）、
  `js/main.js` → `resumeGame()`
- **现象**：按住摇杆前进时被来电 / 通知 / 切前台打断，恢复游戏后**手指已经离开屏幕，
  角色仍持续朝原方向走**。实测恢复后约 2 秒内自行移动 0.93 米，且计时同步流失。
- **复现**：
  1. 手机进入游戏；
  2. 按住摇杆向前推并保持；
  3. 下拉通知栏 / 接来电 / 切到别的 App（`visibilitychange` 触发 `hidden`，
     由 `js/main.js:1377` 自动暂停）；
  4. 回到游戏并点「继续游戏」；
  5. 观察：角色在没有触碰屏幕的情况下继续前进。
- **根因分析**：
  - `moveX` / `moveY` 由 `touchmove` 写入、**只在 `touchend` / `touchcancel` 里清零**
    （`js/input.js:107-118` 的 `joyEnd`）；
  - 中断时若浏览器未补发 `touchcancel`，这两个值保持中断前的状态；
  - `js/main.js:743` 的 `resumeGame()` 只恢复 `state` 与 HUD，**不做任何输入状态重置**；
  - `Input` 原型上没有 `reset()` / `clear()` 之类的方法
    （实测可用方法仅 `_bind` / `_updateJoystick` / `_resetKnob` / `_notifyFirstInput` /
    `requestPointerLock` / `exitPointerLock` / `getMoveInput` / `consumeLook`），
    因此没有任何兜底路径会清理它。
- **修复**：（待修）建议新增 `Input.prototype.resetInputs()`，清空
  `keys` / `moveX` / `moveY` / `_joyId` / `_lookId` 并调用 `_resetKnob()` 归位手柄，
  在 `resumeGame()` 与 `visibilitychange` 恢复分支调用。
- **验证**：（修完后填）按上述步骤复现，恢复后角色应保持静止，HUD 计时应停止累计；
  并回归确认正常按住摇杆时移动不受影响。
- **备注**：
  - 与 BUG-013 同源（都是「中断后无输入重置」），建议合并为一次修复，但需分别验证；
  - 修复时注意不要在正常 `playing` 状态的每帧调用重置，否则会吃掉摇杆输入。

---

## BUG-015 · 难度卡片的自动寻路限程文案与代码实际值不一致

- **发现日期**：2026-10-25
- **状态**：待修
- **优先级**：P1
- **模块**：`index.html`（`#diff-list` 内中等 / 困难卡片文案）、
  `js/main.js` → `autoPathCellLimit()`
- **现象**：主菜单难度卡片写着「中等单次限 25 格 / 困难单次限 20 格」，
  而实际寻路按 **60 格 / 50 格** 才停下。同一份游戏内，商店里写的是 60 / 50、
  主菜单写的是 25 / 20，玩家会认为是其中一处出错。
- **复现**：打开主菜单 → 读「中等」「困难」两张难度的说明文字；再进入对应难度、
  使用「最佳路径」，观察实际行走距离明显超过卡片所写的格数。
- **根因分析**：
  BUG-003 修复时把限程改为按寻路类型分档（`js/main.js:504-509`）：

  ```js
  function autoPathCellLimit(kind) {
    if (kind === 'fast') return null;
    if (Game.diffKey === 'medium') return 60;
    if (Game.diffKey === 'hard') return 50;
    return null; // simple：完整走完
  }
  ```

  归档文件 `BUG(2026.10.25).md:100` 记录了改动，第 101 行也写明
  「文案同步（启动 toast、限程停止提示、商店描述）」——**商店描述已同步，
  但主菜单难度卡片漏改**，仍停留在旧的 25 / 20。
- **修复**：（待修）`index.html:53` 的「单次限 25 格」改为「单次限 60 格」，
  `index.html:57` 的「单次限 20 格」改为「单次限 50 格」，与 `autoPathCellLimit()`
  及 `js/shop.js` 的 bestPath 商品描述保持一致。
- **验证**：（修完后填）主菜单卡片、商店商品描述、实际限程行为三处数值一致（60 / 50）。
- **备注**：
  - 纯文案改动，无逻辑风险；
  - 手机端也能看到该文案（`.diff-card .diff-desc` 在小屏仅缩小字号到 11px，未隐藏）；
  - 若后续再调整限程，三处（`main.js` / `index.html` / `shop.js`）必须同时改，
    建议在同处加注释互相引用。

---

## BUG-016 · 设置面板打开时 ESC 无法关闭，面板滞留且游戏在背后继续跑

- **发现日期**：2026-10-25
- **状态**：待修
- **优先级**：P2（仅外接键盘 / 平板键盘可触发）
- **模块**：`js/main.js` → `Game.input.onPause` 回调、`js/ui.js` → `closeSettings()`
- **现象**：从 HUD 齿轮打开设置面板后按 ESC：
  设置面板**不会关闭**，但游戏状态已切回 `playing` 并在面板背后继续运行
  （角色可移动、计时继续累加）。实测面板滞留期间 120 帧内计时增长 1.92 秒、
  角色在面板后移动 0.63 米。再按 ESC 会在 `paused` / `playing` 之间反复切换，面板始终关不掉。
- **复现**：
  1. 桌面 / 平板接键盘进入游戏；
  2. 点 HUD 右上角 ⚙（齿轮）打开设置面板；
  3. 按 ESC；
  4. 观察：设置面板仍在屏幕上（预期：关闭并返回游戏或暂停菜单），且角色可移动、计时在走。
  - 变体：从暂停菜单点「设置」进入，再按 ESC，结果相同。
- **根因分析**：
  `js/main.js:1317-1323` 的 ESC / P 处理只覆盖了四种情况，**没有「设置面板打开」这一支**：

  ```js
  Game.input.onPause = function () {
    if (Game.itemPanelOpen) { closeItemPanel(); return; }
    if (Game.state === 'replay') exitReplay();
    else if (Game.state === 'playing') pauseGame();
    else if (Game.state === 'paused') resumeGame();
  };
  ```

  打开设置时 `state` 已经是 `'paused'`（由 `pauseGame(true)` 设置），
  所以 ESC 走 `resumeGame()` 分支：它只做 `hidePause()` + `show('hud')` + `state='playing'`，
  **从不隐藏 `settings-panel`**。

  全仓库 `hide('settings-panel')` 仅出现在 `js/ui.js:202` 的 `closeSettings()` 内部，
  而 `closeSettings()` 只被「返回」按钮（`js/ui.js:1108-1110`）调用；
  `js/main.js` 与 `js/input.js` 中**从未出现 `settings-panel`**，因此 ESC 没有任何关闭它的路径。
- **修复**：（待修）在 `onPause` 里补一支设置面板判断，优先关闭面板：

  ```js
  if (MG.UI.isSettingsOpen && MG.UI.isSettingsOpen()) { MG.UI.closeSettings(); return; }
  ```

  `MG.UI.closeSettings` 已导出（`js/ui.js:1698`），只需在 `js/ui.js` 补一个
  `isSettingsOpen()` 查询方法（读 `el['settings-panel']` 是否含 `hidden` 类）并导出。
- **验证**：（修完后填）按上述两条复现路径按 ESC，设置面板应关闭且状态正确
  （从 HUD 进入的应回到游戏、计时不跳变；从暂停菜单进入的应回到暂停菜单），
  再按 ESC 不应出现面板滞留。
- **备注**：
  - **纯触屏手机不受影响**：手机上唯一的正常退出方式是「返回」按钮，
    实测该路径状态干净（点 ⚙ → 点返回 → 面板关闭、`state` 回到 `playing`）；
    影响面为 iPad + 妙控键盘、安卓平板、蓝牙键盘等有 ESC 的设备；
  - 触屏设备的 ESC 语义可自行决定是否需要，但无论如何「面板开着时游戏在背后跑」
    这一状态组合都应消除。

---

## 已核实但判定为「非缺陷 / 不修」

| # | 项 | 状态 | 结论 |
|---|----|------|------|
| R4 | `js/main.js` `startGame()` 幽灵路径下 `_startPending` 提前释放 | 不修 | `.then()` 内在 `finally` 里调用 `releaseStartPending()`，导致约 60ms 加载窗口内守卫为 false。实测在该窗口内 `#main-menu` 已隐藏、`#loading-screen` 覆盖，**玩家无法点到「开始游戏」**，不具备用户可达路径，仅属守卫写法不严谨。如需洁癖式修复，将 `releaseStartPending()` 移入 `proceed()` 的 `setTimeout` 末尾即可。 |
| R5 | 双指同时在摇杆 + 空白区操作 | 已确认正常 | 实测两指可同时生效（`_joyId` / `_lookId` 各自独立），先抬任一指不影响另一指。 |
| R6 | 道具面板关闭依赖 ESC | 已确认正常 | 面板支持点击遮罩外部关闭（`js/ui.js:875-880`），触屏可用，不依赖键盘。 |

---

## 记录模板

新发现 BUG 时，复制下面的模板追加到"当前状态"上方：

```markdown
## BUG-XXX · 一句话标题

- **发现日期**：YYYY-MM-DD
- **状态**：待修
- **优先级**：P0 / P1 / P2
- **模块**：`js/xxx.js` → `functionName()`
- **现象**：用户能看到/感受到什么。
- **复现**：从哪个界面、做什么操作、观察什么。
- **根因分析**：为什么会这样。
- **修复**：改了什么（修完后填）。
- **验证**：怎么确认修好了（修完后填）。
- **备注**：修的时候要特别注意什么。

---
```

**编号规则**：接续归档文件的最大编号（当前最大为 BUG-016，下一个是 BUG-017）。
**状态取值**：`待修` / `待确认` / `观察中` / `已撤回` / `已修`
**优先级**：P0 立即修 / P1 版本内修 / P2 有空再修

---

*归档约定：条目修复后移入 `BUG(YYYY.MM.DD).md`，本文件保持只含未修复项。*
