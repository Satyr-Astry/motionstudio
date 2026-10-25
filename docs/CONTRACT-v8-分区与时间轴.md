# CONTRACT v8 — 分区、对象栈与时间轴（2026-10）

> v7 定义了「三种工作区各做一件事」，v8 只做一件事：**把动作放回它该在的地方**。
> 顶栏 = 窗口级（文件 / 工作区），时间轴 = 时间，对象面板 = 内容层级，属性 = 选中对象的参数。
> 本文件是判定「这个控件该长在哪」的唯一依据，改界面之前先读它。

## 1. 三种工作区：谁有什么

| 工作区 | 区域树（默认） | 只做一件事 |
|---|---|---|
| 编排 animate | `col[ row[ col(232)[layers] , canvas , properties(292) ] , row(220)[ timeline , curve(560) ] ]` | 摆对象、调时间、看结果 |
| 画板 draw | `col` 左列 `row[ col(232)[ toolbar(44) , layers , palette(260) ] , canvas ]` | 画当前对象、当前纹理 |
| 设置 free | `col[ row(330)[ doc(300) , onion(300) , prefs(320) , info ] , help ]` | 文档参数、洋葱皮、偏好、帮助 |

- **画板不是独立缓冲区**：`board` 编辑器保留在注册表里，但默认布局不再使用它。绘图工作区就是主画布（引擎单例），
  画的永远是「选中对象的当前纹理」。老存档里的 `board` 区域经 `retargetDrawAreas` 就地处换回 `canvas`，
  老存档里被摘掉的 `toolbar` 由 `ensureToolbarArea` 补回。
- 画笔锁：`state.drawLocked = workspace === 'animate'`。进编排自动切回 `select` 并记住上一个绘画工具，离开时还原。
- `.cv-host` 在整个应用里**恒为 1 个**（引擎单例，跨工作区搬宿主，不重建）。

## 2. 对象管理 = 一个栈，两截

「对象管理」不是两个面板，是同一个面板上下两截（`editors/layers.mjs`）：

- 上截 `.lyr-list`：对象行（可见性圆点 / 缩略图 / 名字+副标题 / ⏱ 时间通道），拖拽可以移序或设父。
- 下截 `.lyr-cels`：**纹理栈**——当前对象有哪些纹理。
  - 头 `.lyr-cels-head`：`纹理 <数量>` + 五个动作 `add ＋ / dup 复 / prev ‹ / next › / del 删`。
  - 行 `.lyr-cel[data-t]`：34×24 缩略图 + `at.toFixed(2) s` + 「有内容 / 空白」；点一行 = 把播放头移到那一格。
  - `.lyr-cel.is-cur` = 播放头所在的那一格。切对象、加删纹理都走 `ctx`（`addCelAt / removeCelAt / goPrevCel / goNextCel / setTimeClamped`），
    面板里**不出现**第二套时间逻辑。

## 3. 时间轴：一个工具条，五组

`.tline-tools` 里按语义分五组（`.tline-grp[data-grp]`），组与组之间只隔一条竖线：

| 组 | 成员 | 语义 |
|---|---|---|
| transport | `first ⏮ / prev ‹ / play ▶ / next › / last ⏭` | 播放头按 **1/fps 帧**走（`ctx.stepFrames`），首末帧夹在 `[0, docDuration]` |
| time | `input.tline-now` / `input.tline-total` | 当前时刻与总时长；Enter 提交、Esc 回滚、失焦提交（`bindField`） |
| cel | `prevcel 上一格 / nextcel 下一格 / addcel 加纹理 / delcel 删纹理` | 按**纹理切换点**跳，不是按帧 |
| key | `addkey ◆` | 在当前时刻给活动对象打关键帧（值取 `stateAt`，画面不跳） |
| zoom | `zoomout − / zoomin ＋ / .tline-zoom` | 水平缩放，锚点在播放头 |

- 刻度尺右端有 `.tline-durhandle`（9px 宽、`ew-resize`）：拖它改总时长，**松手才写文档**（一次撤销步）。
- 刻度尺擦洗必须走 `ctx.setTimeClamped`，**不许**用 `setTime`——后者内部 `wrapTime` 会把拖到末尾的播放头回绕成 0。
- 关键帧拖动同理：`pointermove` 只改 DOM（`.is-drag` + `dataset.preview`），`pointerup` 才 `setDoc` 一次。
- 多选：`Ctrl/Cmd+单击` 加减选、`Shift+单击` 区间、空白拖拽出 `.tline-marquee` 框选；
  主键 `.is-sel`（白心 + 光晕）、次级 `.is-sel2`（半透蓝）。`.is-ch`（通道独立轨菱形）不参与选择。

## 4. 顶部与底部：只放窗口级信息

- `#topbar`：`.top-brand` → `.top-file`（`new ＋ / save 保存 / open 打开 / import 导入 / export 导出 / undo ↶ / redo ↷`）
  → `.top-project`（脏数据带 `•`）→ `.top-back`（非编排时显示「← 编排」）→ `.top-ws`（三 tab）→ `.top-hint`（平时为空）。
- `#statusbar`：左 = `宽×高 · N 对象 · fps`（绘图工作区追加笔尖信息）；右 = `· t X.XX s · 帧 i/N · 对象名 · 工作区`。
  **右段必须自带 `· ` 前缀**：两段拼起来才是「A · B · C」的读数。左段不许以裸数字结尾并紧跟右段（曾经拼出 `12 fpst 2.50 s`）。
- 播放控制**不在**顶栏：位置即语义（AE / Aseprite / Animate 都在时间轴侧，VS Code 顶栏只放主区域显隐）。

## 5. 键位表（`app/shell/app.mjs:onKeyDown`）

| 键 | 动作 |
|---|---|
| 空格 | 播放 / 暂停 |
| `←` `→` | 逐帧（1/fps，`stepFrames(∓1)`） |
| `,` `.` | 上一个 / 下一个**关键帧**（`goToKey(∓1)`） |
| `Shift+,` `Shift+.`（或 `<` `>`） | 上一个 / 下一个**纹理** |
| `Home` `End` | 时间 0 / 文档末尾 |
| `Ctrl+Z` / `Ctrl+Shift+Z` | 撤销 / 重做 |
| `Ctrl+C` / `Ctrl+V` | 复制 / 粘贴关键帧（外壳派发 `ms:copy-keys` / `ms:paste-keys`，剪贴板归时间轴） |
| `Ctrl+S` / `Ctrl+O` / `Ctrl+Shift+E` | 保存 / 项目库 / 导出 PNG 序列 |
| `Ctrl+Shift+P` | 命令面板（`app/shell/command-palette.mjs`；**必须早于 `isTypingTarget` 判定**，否则焦点在面板输入框里时按不开/关不掉） |
| `[` `]` | 笔尖 −4 / +4 |
| `0` | 适配视图 |
| `Esc` | 输入框失焦；非编排工作区回编排 |
| `b e g i h` | 画笔 / 橡皮 / 填充 / 吸管 / 抓手 |

## 5b. 命令面板（v8 新增）

- 模块：`app/shell/command-palette.mjs`（只建 DOM 与交互，不绑全局键、不 import 任何模块）；样式 `app/styles/palette.css`（圆角只用 `--r-1` / `--r-pop`，颜色只用 tokens 里的 15 个变量）。
- 命令表归外壳：`app/shell/app.mjs:buildCommands()`，29 条 7 组（文件/编辑/播放/纹理/画布/工作区/工具）。工具组直接由 `paint/engine.mjs` 的 `TOOLS` 生成，避免两处维护。
- 命令对象形状：`{ id, title, hint, keys, group, run }`；`title` 里不放动态文案（打开瞬间的快照会过期）。
- 交互契约：`Ctrl+Shift+P` 开合、Esc 关、`↑↓`/`Tab` 换行、Enter 执行、面板打开时其它全局快捷键让位（`if (palette && palette.isOpen()) return;`）。

## 6. 导入（v8 新增）

- 顶栏「导入」→ `onFileAct('import')` → `projectApi.importPsd/importImage/importObjects`。
- PSD：`app/core/psd.mjs`（零依赖，支持 PSB / RLE / zip / 组 / 图层名 / 不透明度 / 可见性）→
  `app/shell/import-file.mjs` 的 `psdToObjects`：**每个可见图层 → 一个对象**，`cels=[{at:0, image}]`，
  `transform.keys=[createKey(0,{x:left,y:top})]`，组名扁平化成「组名/图层名」。
- PNG/JPG/WebP：`imageToObject` 建单个图片对象，默认居中，不改变画布尺寸。
- 无桌面桥（纯浏览器打开）时返回中文原因并提示，不抛异常。

## 7. 验收基线（v8）

- 单元测试：`npm test`（= `node --test tests/*.test.mjs`）→ **tests 517 / pass 515 / fail 0 / skipped 2**。
- 真机（CDP 9334）：
  - 顶栏九个动作：`new,save,open,import,export,undo,redo,animate,draw,free`（不含播放）。
  - 时间轴十二个 act：`first,prev,play,next,last,prevcel,nextcel,addcel,delcel,addkey,zoomout,zoomin`；`.tline-now` / `.tline-total` 是 `INPUT`。
  - 绘图工作区区域：`toolbar / layers / palette / canvas`，`.cv-host` 恒为 1，`engine.tool === 'brush'`。
  - 对象面板的纹理栈行数随 `obj.cels` 变化，`.lyr-cel.is-cur` 跟随播放头。
  - `window.__errs` 为空。
- 模块行数上限沿用 v7 §4；新增：`timeline-keys.mjs ≤ 820`（多选 + 框选后当前 800）、`import-file.mjs ≤ 400`、`psd.mjs ≤ 650`。

## 8. 父子链的有效属性（v8 新增）

- 单一事实来源：`app/core/doc-model.mjs` 的 `parentChainOf(doc, obj)`（自身在首位，最多 64 层，遇环即停）、`effectiveVisible(doc, obj)`（**任一祖先 `visible === false` 就是不可见**，缺省视为可见）、`effectiveOpacity(doc, obj)`（自身与祖先 opacity 连乘，夹 0..1，非法值按 1）。
- 求值器 `app/core/evaluator.mjs`：`sample()` 的记录里 `visible` 用 `inheritedVisible(chainOf(layer))`；**`opacity` 只算本层**（`baseAlpha × 效果层 opacity`），祖先的部分交给合成器乘一次，避免双算。注意 `state()` 的返回面里**没有** `visible` 字段。
- 合成器 `app/paint/composite.mjs`：`drawLayer` 用 `effectiveVisible` 决定画不画、用 `effectiveOpacity` 作为 `globalAlpha` 的乘数；对象循环里同样用 `effectiveVisible` 跳过子树。
- 对象面板 `app/editors/layers.mjs`：父对象行显示折叠箭头 `.lyr-caret`（`▾/▸`，状态存 `localStorage['ms.layers.collapsed']`，只影响面板显示）；被折叠父对象的后代行 `display:none`。
- 导入：PSD 的 `lsct` 组会变成父对象（`parentId` 指向组对象、坐标是文档坐标、祖先隐藏会在导入期写进子对象 `visible`）。组不透明度与组可见性**现在由上面的有效属性在运行时保证**，不再依赖导入期快照。

## 9. ctx 的归属（v8 踩过的坑）

- `app/shell/app.mjs:buildCtx()` 是「基础面」（文档/时间/纹理/工具/撤销/项目），**时间通道与父子层级归 `app/shell/ctx-time.mjs`**：boot 里 `Object.assign(ctx, timeCtx({...}))` 会**覆盖**同名键，所以同一个方法别在 app.mjs 里再实现一遍（写重复实现等于写死代码，改了也不生效）。
- `ctx.isLayerTimeIdentity(id)` 是例外：ctx-time 没提供，只有 app.mjs 实现（对象面板的 ⏱ 徽章靠它）。
- `ctx.moveLayerTo(id, target)` 的 `target` 既接受下标也接受对象 id —— 面板拖拽时手里只有 id。
- 面板调用 ctx 方法要按「可能不存在」写（`typeof ctx.x === 'function'`），但**新加的 ctx 方法必须先在真机里确认真的被调到了**：被 view-host 吞掉的异常表现就是「点了没反应」，`window.__errs` 仍是空。定位手法：页面里 `await import('./editors/layers.mjs')` 手动 `mount` 拿真实堆栈，或直接 `ms.ctx.moveLayerTo(...)` 单点验证。

## 10. 视频导出（v8 新增）

- 分两层：**计划层是纯函数** `app/shell/video-plan.mjs`（`pickVideoMime` / `videoFps` / `videoSeconds` / `videoFrameCount` / `videoCanvasSize` / `videoBitrate`，零依赖，`tests/video-plan.test.mjs` 8 例钉死边界）；**执行层**在 `app/shell/project-io.mjs` 的 `recordVideo()` / `exportVideo()`，只能在真机跑。
- 取文档必须走 `CTX.doc()`：project-io 只有 boot 时 `setCtx` 注入的 `CTX`，没有模块级 `ctx`。
- 录制流程：离屏 canvas（尺寸 = 文档尺寸）→ `compositeFrame(cv, doc, t, { clear:true, time:t })` 逐帧 → `cv.captureStream(0)` → `MediaRecorder({ mimeType, videoBitsPerSecond })` → 每帧 `track.requestFrame()` → `await setTimeout(1000/fps)`（MediaRecorder 的时间轴是墙上时钟）→ 末帧再等 `max(120, stepMs*2)` → `stop()` → `Blob` → `arrayBuffer()`。
- 保存：主进程 `ms:save-binary`（对话框 + `fs.writeFileSync`），preload 与 `app/shell/ipc.mjs` 各有 `saveBinary(name, bytes, ext, label)`；无桌面壳时返回 null（纯浏览器调试不炸）。
- 已知限制：窗口在后台时 Chromium 节流计时器（导出前要提示保持前台）；未开 VP9 alpha，透明背景会变黑；无音轨。

## 11. 区域折叠

- 双击任意区域标题栏 = 折起 / 展开（点按钮或下拉框不触发）。
- 折叠不是「最小化」：layout.mjs 的 distribute 把 collapsed: true 的节点钉成 COLLAPSED_AREA = 24（正好是 .area-head 的高度），既不参与剩余空间分配，也不会被 MIN_AREA 抬起来，归一化时同样不放大。
- 状态存在区域树上（areas.mjs 的 withLayout 会带上 collapsed），所以随布局存档一起保存；computeRects 的区域条目标记 collapsed，view-host.mjs 的 syncAreas 据此隐藏 .area-body。
- 折叠区里 select.area-type 仍在，展开前就能换编辑器。

## 12. 纹理库（drawing library）

- 实体划分：**纹理（drawing）是可以被复用的图**；时间轴上的是「曝光」——某段时刻显示哪张纹理。同一张纹理可以出现在多个时刻，改它所有时刻一起变；要脱钩就用「独特化」。
- 身份：位图对象上挂不可枚举的 `__msDrawing`（`stampDrawing` 首次访问时生成，不会写进 JSON）。于是「同一个位图引用」天然就是「同一张纹理」，存档格式不需要为身份加字段。
- 核心 API（`app/core/doc-model.mjs`）：`drawingIdOf(image)`、`drawingsOf(obj)`（返回 `[{id,image,times}]`，含未使用的纹理，顺序按 `obj.drawings` 再按首次曝光）、`drawingIdAt(obj,t)`、`placeDrawing(obj,t,drawingId)`（有曝光就换图、没有就建格）、`makeUnique(obj,t,makeImage)`、`removeDrawing(obj,id)`、`syncLibrary(obj)`。
- 对象形状新增**可选**字段 `drawings: [{image}]`：只为容纳「当前没被任何时刻用到」的纹理。老文档没有这个字段，靠 `drawingsOf` 从 cels 里推导，行为不变。
- 存档（`app/shell/project-store.mjs`）：`elements[i].drawings = [{ref,w,h}]`，与 cels 共用同一套 `assets` 去重（同一个位图只会存一次）；读盘时按 `ref` 复用同一个位图实例。`makeObject` 必须保留 `drawings`，否则往返会把未使用的纹理丢掉。
- 外壳：`ctx.drawingsOf/currentDrawingId/placeDrawing/makeUniqueCel/removeDrawing`；命令面板有「切换纹理：上一张/下一张」「纹理独特化」。
- 时间轴表现：`.tline-cel` 的方块按纹理分配色相（内联 `--cel-hue`，第 n 张是 `n*47°`），同一张纹理在所有曝光时刻同色；`title` 里写「纹理 #n（共 m 处用到这张）」。

### 12.1 库与曝光是两层

- **新建纹理（库）**：`ctx.newDrawing(objId, { clone })` → `doc-model.addDrawing` 只往 `obj.drawings` 里加一张图，**不动 cels**，所以时间轴上不会出现新方块。
- **放到时间轴（曝光）**：点库里的行 → `ctx.placeDrawing(objId, t, drawingId)`（有曝光就换图、没有就建格）。
- **加曝光**：`ctx.addExposure(objId, t)` —— 用 `findFreeCelTime` 找下一个空帧（注意它返回 `{ at, moved }`，不是数字），把当前纹理再曝光一次，**不新建图**。时间轴工具条的「加曝光」和右键「在此加曝光」都走它。
- **改曝光时刻**：在时间轴拖纹理块（`moveCel`）；**删曝光**：按 delcel / 双击纹理块；**删纹理**：库里的「删」= `removeDrawing`（图与所有曝光一起消失）。

### 12.2 纹理挂在关键帧上（v8 最终形态）

- `transform.keys[i].drawing`：这条关键帧从 `t` 起显示哪张纹理（纹理 id，图在 `obj.drawings` 里）。**`drawing: null` = 显式空白**（这一帧起什么都不画）；没有 `drawing` 字段 = 沿用上一张。求值是步进的，不插值。
- 只有一个时间轴：`key.drawing` 与 `key.state` 同属一条关键帧，`celTimes()` 等价于「带纹理的关键帧的时间点」。时间轴上纹理块是这条轴的**派生显示**，不是第二条轴。
- 写入必须走 `setKeyDrawing(obj, t, drawingId|null)` / `placeDrawing` / `makeUnique` / `removeDrawing`；`obj.cels` 是 `projectCels()` 生成的只读投影，只给老代码看，不要直接写。
- 迁移：`makeObject()` 与 `migrateCelsToKeys()` 会把旧存档/旧构造的 `cels` 就地搬成「每条 cel 一条带 drawing 的关键帧」，画面零变化；搬完 `cels` 为空。
- UI：库面板点一行 = 把这张纹理设为**当前时刻的关键帧纹理**（没有关键帧就新建一条）；时间轴菱形用 `.has-drawing` / `.is-blank` 区分「换图」与「空白」。

### 12.3 时间轴只有一行（v8 定稿）

- .tline-row 的泳道里只有关键帧菱形：.tline-kf（可带 .has-drawing / .is-blank 小点标记这一帧换图或空白）、.tline-kf.is-ch（通道关键帧）、播放头。
- 纹理块那行（.tline-cel）已删除：纹理挂在关键帧上，改纹理时刻＝拖关键帧，删纹理＝删关键帧或去掉它的 drawing 字段。
- 菱形 left 钳到 0（Math.max(0, x - KF_SIZE/2)），0 秒那颗不会被泳道左边界切掉。

### 12.4 纹理画布（绘图工作区）

- 绘图工作区不是「看合成结果」，而是**把当前纹理当一张独立画布**：引擎注入 `isDrawingBoard()` 与 `boardImage()`，为真时 `docSize()` 取纹理位图尺寸、渲染直接把位图 1:1 画出来，跳过洋葱皮 / 求值器 / 效果 / 变换手柄 / 对象浮动条。
- 好处是坐标恒等：指针 → 位图像素是纯缩放关系，对象有位移或缩放都不会把笔甩到别处。
- 编排工作区仍然是合成视图（对象变换、父子层级、效果都在那里看），两边通过「当前时刻的纹理」这一条线连接：绘图区改的是 `key.drawing` 指向的那张位图。
- 关掉纹理画布：`state.drawBoard = false`（绘图区退回合成预览，便于对位）。
