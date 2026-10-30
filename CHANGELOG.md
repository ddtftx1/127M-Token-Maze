# 更新日志

> 归档约定：**本文件只放当前最新版本**。每次发新版前，把本文件整体移入
> `CHANGELOG/YYYY.MM.DD/`（连该版本的说明文件一起），根目录重新从空白开始写。
> 历史版本见 `CHANGELOG/2026.10.25/`。

## 2026-10-30 · 跨平台兼容与交互修复

> 纯前端改动，无新增依赖；`localStorage` key、存档格式、`MG.*` 公共 API 完全兼容。
> 本次新增 1 个脚本文件（`js/icons.js`）与 1 份声明文件（`THIRD_PARTY.md`）。
> 4 个问题的根因分析、修复细节与验证过程见 `BUG/BUG(2026.10.30).md`。

**范围**：`index.html` / `css/style.css` / `js/icons.js`（新增）/ `js/ui.js` / `js/main.js` / `js/input.js` / `js/shop.js`
**兼容性**：存档、回放帧格式、排行榜分区、公共 API 全部未变；`localStorage` 无需迁移。

---

### 布局与兼容

- 横屏紧凑布局的媒体查询补上设备判定
  `(hover: none) and (pointer: coarse)`：桌面端窗口高度 ≤640px（Win7 退出全屏后）
  不再被误判成手机横屏、页面不再被压成紧凑版，右侧整页白滚动条一并消失。
- 新增启动期**特性检测**（`applyLegacyClasses()`），按能力给 `body` 挂
  `legacy-env` / `legacy-inset` / `legacy-gap` / `legacy-dvh` 四个 class，
  老内核（Chrome 49 / Win7）自动降级，现代浏览器零影响。
- 全量展开 `inset` 简写为 `top / right / bottom / left` 四边声明（Chrome 87 之前不支持 `inset`）。
- 安全区在 `env()` 不支持时不再让整条 `calc()` 失效：`legacy-env` 下把
  `--safe-t/b/l/r` 统一按 `0px` 处理，`.hud-top` / `.toast` 另给显式兜底。

### Bug 修复

> 每条只写一句话结论，详细根因见 `BUG/BUG(2026.10.30).md`。

- **BUG-017** · Win7 缺彩色 Emoji 字体导致 UI 显示白框 / 单色，全部 Emoji 已替换为内联 Noto SVG 图标。
- **BUG-018** · 老内核退出全屏后误入手机横屏紧凑布局且右侧出现白滚动条，已修正媒体查询并按能力降级。
- **BUG-019** · 回放模式点击画面会误锁鼠标、按 P 会直接退出回放，已改为点击/P = 暂停继续、ESC = 退出。
- **BUG-020** · 通关后 1.2 秒内返回菜单或再玩一次会丢掉成就提示与音效，已改为挂起后补发。

### 新增

- `js/icons.js`：16 个 Noto Emoji 彩色 SVG 的内联字符串库，`MG.Icons.svg[key]`。
- `MG.UI.icon(name)`：返回原始 SVG 字符串；`MG.UI.iconHtml(name)`：返回可直接拼进
  `innerHTML` 的图标 HTML（自动加唯一 `id` 后缀）；`MG.UI.fillIcons(root)`：
  把 `<span data-icon="key">` 占位填充为真实图标（幂等）。
- `THIRD_PARTY.md`：第三方资源与许可证声明（Noto Emoji / Apache-2.0、Three.js / MIT）。
- `CHANGELOG/` 归档目录：历史版本按日期分文件夹保存，本文件只留最新版。

### 调整

- HTML 与 JS 里的 39 处 Emoji 全部改为 `<span class="svg-icon" data-icon="...">`
  或 `MG.UI.iconHtml()` 拼接；`⛶ ⚙ ✖ ▶ ↻` 等符号按要求保留不动。
- `shop.js` 的 `ITEMS[*].icon` 由 Emoji 字符改为 key 名（`map` / `compass` / `bolt` / `money`）。
- `MG.UI.toast(msg, duration, asHtml)` 增加第三个参数：默认仍走 `textContent`
  （种子等用户输入不会被当成标签），只有内部拼图标时才传 `true`。
- HUD 钱包、道具按钮由 `textContent` 改 `innerHTML`（需要渲染图标），并加"值没变就不动 DOM"的判断。
- `svg/摄像头.svg` 素材修正：去掉重复的第二个 SVG 根节点与自带的白色背景矩形，
  重新生成 `js/icons.js`（真机测试后发现）。

### 性能

- 图标 HTML 按元素缓存（`iconHtmlFor()`）：HUD 每 100ms 刷新一次钱包与道具按钮，
  原先每次都要重新拼一遍最大 5KB 的 SVG 字符串并重建 DOM 节点，现在只在数值变化时写一次。
- `js/icons.js` 为 101KB（内联图形 94KB），一次性解析、无网络请求，`file://` 与
  本地服务器下行为一致；不引入任何构建步骤。

### 保持不变

- `input.js` 的全局 `touchmove` 拦截与 `{ passive: false }` 写法（页面不滚动/不缩放的关键）；
- `maze.js` 天花板 `side: THREE.FrontSide`、色盲友好配色的全部绘制细节、`minimapCoins` 实心/轮廓区分；
- 回放压缩帧格式、`MAX_FRAMES` / `SAMPLE_INTERVAL`、A\* 启发式与贪心拾取策略；
- 所有 `localStorage` key 与数据格式、`MG.*` 既有方法签名、彩蛋逻辑。

### 验证

- **静态**：11 个原有 JS + 新增 `icons.js` 全部 `node --check` 通过；
  `index.html` 用 HTML 解析器验证无未闭合/不匹配标签，109 个 `id` 无重复，
  `ui.js` 缓存的 109 个元素与 HTML 一一对应。
- **逻辑（无头环境实跑）**：76 项断言全通过 —— 16 个图标的 `id` 唯一性与
  `url(#id)` / `xlink:href` 引用自洽、`fillIcons` 幂等、回放点击与 P 键的状态机
  （replay / playing / menu / paused / win / loading 六态）、触摸合成点击过滤、
  成就挂起与补发（清定时器不丢挂起数据、`flush` 只播一次、调用点顺序）。
- **回归**：3 难度 × 2 算法 × 6 种子 = 36/36 组迷宫生成 + A\* 路径合法（相邻、不穿墙）。
- **待人工验收（真机/浏览器，无头环境给不出结论）**：
  1. Win7 + Chrome 49 实际打开，确认 16 个图标不再白框、退出全屏后布局正常、无白条；
  2. 手机横屏（矮屏）与竖屏各走一遍，确认图标尺寸/基线与原 Emoji 视觉一致；
  3. 鼠标设备下回放点击暂停、按 P 暂停、ESC 退出；触屏设备滑动转视角不误暂停。

### 改动文件汇总

| 文件 | 改动 |
|------|------|
| `js/icons.js` | **新增**。16 个内联 SVG + `MG.Icons` |
| `index.html` | 加 `js/icons.js`（在 `settings.js` 之前）；20 处图标占位替换 Emoji |
| `js/ui.js` | 新增 `icon()` / `iconHtml()` / `iconHtmlFor()` / `fillIcons()`；14 处 Emoji 替换；`toast` 支持 HTML 模式 |
| `js/main.js` | `boot()` 先跑特性检测并填充图标；注入 `getState` / `onToggleReplayPause`；成就 toast 改为挂起补发；4 处 Emoji 替换 |
| `js/input.js` | 回放点击 / P 键语义；触摸合成点击过滤；`matchMedia` 设备判定 |
| `js/shop.js` | `ITEMS[*].icon` 改 key |
| `css/style.css` | `.svg-icon` 规则；媒体查询补设备判定；`inset` 展开；4 类老内核降级块；`100dvh` 兜底 |
| `THIRD_PARTY.md` | **新增**。第三方资源与许可证声明 |
| `BUG/BUG(2026.10.30).md` | **新增**。BUG-017 ~ BUG-020 |
| `README.md` | 文件结构表补 `js/icons.js` / `THIRD_PARTY.md` / `svg/` / `CHANGELOG/`；补兼容性说明 |
