# 契约 v3 —— 连续时间轴、跨帧保留（hold）与效果器

> 增量契约。v1（`CONTRACT.md`）与 v2（`CONTRACT-v2-元素动画.md`）继续有效，本文件只描述新增与变更的部分。

## 1. cel 继承（hold）：跨帧保留

### 1.1 数据

`cel` 新增一个字段：

```js
cel = {
    id, image, opacity, zIndex, group,   // v1/v2 已有
    hold: boolean,                       // v3 新增
};
```

- `hold: false` — 该 cel 拥有自己的位图（或本来就空）。
- `hold: true` — 该 cel **不存位图**，显示时间上更早的最近一张图。

`doc` 不新增字段；`layer.effects` 为 v3 新增（见 §3）。

### 1.2 语义

| 操作 | 结果 |
| --- | --- |
| `addFrame(doc, at)` | 新帧所有层的 cel 都为 `hold: true`（第一帧除外，没有可继承源） |
| 在继承帧上落笔 | 先 `materializeCel` 拷贝源图，`hold` 置 `false`，之后改的都是本帧独立位图 |
| 删除中间帧 | 后面的继承帧自动解析到更早的有效图（无需修补） |
| `cloneFrame(doc, i, cloneImage)` | 深拷贝位图，新帧 `hold: false`（复制 ≠ 继承） |
| `linkCels(doc, refs)` | 多个 cel 共享**同一 image 引用 + 同一 group**（改一处全变） |

`hold` 与 `group`（linked cel）是两种不同机制：前者是「隐式继承、写时复制」，后者是「显式共享、同步变化」。二者可叠加，但同一 cel 上 `hold` 优先判定（有 `image` 时 `hold` 无意义）。

### 1.3 API（`app/core/cel.mjs`）

```js
resolveCelImage(doc, frameIndex, layerId) -> Image|null   // 向前解析有效图
isHolding(doc, frameIndex, layerId)      -> boolean
setCelHold(doc, frameIndex, layerId, hold) -> doc
materializeCel(doc, frameIndex, layerId, cloneImage) -> { doc, image }
frameImageOf(doc, frameIndex, layerId)   -> Image|null    // 缩略图用
```

`sampleFrame()` 的行里新增 `holding` / `linked` 两个布尔字段，`image` 改为**解析后**的图，`empty` 表示解析后仍无图。

### 1.4 渲染约定

`composite.mjs` 的 `drawLayer` **不再**直接读 `cel.image`，一律走 `resolveCelImage`。任何新增的渲染路径（缩略图、洋葱皮、导出、精灵图）都必须遵守同一条规则，否则继承帧会显示空白。

## 2. 连续时间轴

时间轴的横轴是**秒**，不是帧格。

- `pxPerSec = FRAME_PX * doc.fps * zoomX`，`FRAME_PX = 28`，`zoomX ∈ [0.25, 4]`。
- 帧块：`left = frameStart(doc, i) * pxPerSec`，`width = frameSeconds(doc, i) * pxPerSec`。
- 关键帧菱形：`left = t * pxPerSec - 3.5`，`t` 是绝对秒数（不吸附帧，Shift 才吸附）。
- 播放头：`left = ctx.time() * pxPerSec`。
- 拖帧块右边缘改 `frame.duration`（浮点倍数，`0.05–20`），帧块的像素宽度随之变化 —— 这就是「时间轴连续」的可见证据。
- 点击刻度尺 / 轨道空白 → `ctx.setTime(x / pxPerSec)`。

`duration` 仍是 FPS 的倍数（Pixelorama 语义），但允许非整数倍，因此帧在时间轴上的宽度可以任意不同。

## 3. 效果器（渲染期滤镜）

### 3.1 数据

```js
layer.effects = [
    { type: 'blur', amount: 4 },
    { type: 'glow', amount: 8, color: '#4a7dff' },
];
```

每项至少含 `type`，其余键由 `EFFECT_DEFS` 里对应定义的 `params` 决定。五种类型：`blur` / `glow` / `shadow` / `adjust` / `outline`。

### 3.2 管线

1. `paint/effects.mjs` 的 `filterString(effects)` 把数组拼成 canvas 2D `ctx.filter` 字符串；恒等值（`blur 0`、`brightness 1`、全 0 投影等）不输出，因此默认参数单独存在时返回 `'none'`。
2. 外壳创建引擎时注入 `filterFor(layer)`，引擎把它透传给 `compositeFrame(..., { filterFor })`。
3. `drawLayer` 在 `g.save()` 之后、绘制之前执行 `g.filter = filterFor(layer, t) || 'none'`，`g.restore()` 时自动复原。

效果器是**渲染期**的，不烘焙进位图：同一 cel 在不同帧、不同时间内始终是原始像素。

### 3.3 UI

属性面板的「元素效果」组读写 `layer.effects`，通过外壳的 `setLayerEffects(layerId, effects)` 提交。滑杆拖动时**不重建 DOM**（用 `layer.id + 效果 type 序列` 作签名判断），否则焦点会丢。

## 4. 外壳新增 API（`window.motionStudio` 与 ctx）

```js
linkFrameCel(frameIndex?, layerId?)      // 当前 cel 链接到上一帧
unlinkFrameCel(frameIndex?, layerId?)    // 断链，给独立位图
setFrameDurationAt(frameIndex, mult)     // 连续时长
setHoldAt(frameIndex, layerId, hold)     // 继承开关
setLayerEffects(layerId, effects)        // 效果链
isHoldingAt(frameIndex, layerId)
resolveCel(frameIndex, layerId)
effectDefs / makeEffect / normalizeEffect
```

快捷键：`Ctrl+D` 复制当前帧、`Ctrl+Shift+L` 链接到上一帧、`Ctrl+Shift+H` 切换继承。

## 5. 验收基线

- 模型层：`tests/hold.test.mjs`（15 例）覆盖继承、解析、materialize、断链、`sampleFrame` 标记、`cloneFrame`、多级继承、删除中间帧。
- 效果器：`tests/effects.test.mjs`（42 例）。
- 全仓：`node --test tests/*.test.mjs` → 205 例全绿。
- 真机：`verify-v3.js` 校验 hold 开关、链接、时长、帧块宽度比例、效果器面板与 `filterString` 输出。

---

## 6. 曲线编辑器（Graph Editor）

时间轴回答「这一格像素属于哪一帧」，曲线编辑器回答「元素在两帧之间怎么动」。两者并排放在 animate 工作区底部：`row[ timeline | curve(560) ]`。

### 6.1 编辑器契约

`app/editors/curve.mjs` 导出 `mount(el, ctx)` → `{ destroy, refresh, focusFrame }`，注册 id 为 `curve`（`app/shell/registry.mjs`）。外壳不需要为它加任何专属 ctx 方法，它只消费通用字段：`doc() / time() / setTime(t) / selection() / activeLayerId() / setDoc(doc) / requestRender() / subscribeDoc(fn) / notify(msg)`。

### 6.2 唯一的写入路径

```js
writeTrack(layerId, (trk) => nextTrack)   // patchLayer(doc, layerId, { transform: next }) → ctx.setDoc
```

任何交互（拖点、拖柄、右键改缓动、双击加点、Delete）都先算出新的 track 再走这一条，所以撤销/重绘/面板刷新只有一处触发。

### 6.3 单轨道语义（重要）

一个元素的 `layer.transform` 是**一条轨道**，每个 key 携带完整 state（`TRACK_FIELDS` 8 个标量 + `warp`）。因此：

- 曲线上每个通道的**关键帧时间点是共享**的；
- 拖 X 曲线的圆点 → 改该 key 的 `t`（所有通道一起移动）+ 只改 `state.x`；
- 不实现「每属性独立 F-Curve」：那需要把 `transform` 拆成 8 条独立轨道，会推翻 `stateAt` 与 composite 的整状态插值假设。

### 6.4 几何与坐标

`PAD_L=46 PAD_R=14 PAD_T=12 PAD_B=16`；`t0 = 0`、`t1 = timeSpan || totalSeconds(doc)`；值域 `vMin/vMax` = 当前显示通道所有 key 值的 min/max 中值 ± 半宽 ×1.12 × `vView`（min==max 时按 |v| 的一半对称展开）。

关键帧绘制在 `(tToX(key.t), vToY(chValue(key.state, chId)))`；贝塞尔切线柄把段内归一化控制点换算成世界坐标：

```
hx_world = k0.t + (k1.t - k0.t) * k0.h1[0]
hy_world = v0 + (v1 - v0) * k0.h1[1]      // v0/v1 是「该通道」的值
```

反向（拖柄时）：`hx = clamp((t - k0.t)/(k1.t - k0.t), 0.001, 0.999)`、`hy = (v - v0)/(v1 - v0)`；`|v1 - v0| < 1e-9` 时保留原 `hy`。

### 6.5 交互表

| 操作 | 效果 |
| --- | --- |
| 拖圆点 | 改 t（Shift 吸附帧，阈值 0.12s）+ 改该通道值 |
| 点圆点 | 选中，若该段为贝塞尔则显示 h1/h2 切线柄 |
| 拖切线柄 | `setKeyEase(trk, i, 'bezier', h1, h2)` |
| 右键圆点 | `线性 / 贝塞尔 / 保持 / 删除关键帧` |
| 双击空白 | 在该 t `addKey(track, t, stateAt(track,t), 'bezier')` |
| 点空白 | `ctx.setTime(t)` |
| 滚轮 / Ctrl+滚轮 | 缩放时间窗（`timeSpan`，上限为总时长） |
| Shift+滚轮 | 缩放值域（`vView`，0.05–20） |
| Delete / Backspace | 删除选中关键帧 |
| Esc | 取消选中 + 关闭右键菜单 |

### 6.6 布局与持久化

- `defaultTree('animate')` 尾部：`{ type:'split', dir:'row', size:220, children:[areaNode('timeline'), areaNode('curve', 560)] }`。
- `app/shell/persist.mjs` 的 `LS_VER` 从 1 提到 **2**：老 localStorage 里的区域树没有 curve，必须整体失效回退默认布局。
- 16 个通道 chip 一行放不下，warp 的 8 个收进 `.curve-warp-chips`（默认 `display:none`），由 `变形` 按钮 `.is-group` 切换 `.is-open`；`.curve-chips` 为 `nowrap`。

### 6.7 真机验收

`verify-curve.js`（真实 PointerEvent / MouseEvent 打到 `.curve-plot`）：

- 拖 t=0.35 的点到 t≈0.5：`movedTime:true`、`movedValue:true`；
- 右键 → `menuShown:true`，四项菜单，点「贝塞尔」后 `easeAfterMenu[3]==='bezier'`；
- 双击空白：`keyCountAfterAdd:5`、`times:[0,0.149,0.5,0.7,1]`；
- `warpHidden:true`（折叠生效）、chips 共 17 个（8 标量 + 变形式 + 8 warp）。

区域尺寸实测：`canvas:848x476 / toolbar:1384x72 / layers:232x217 / palette:232x252 / properties:292x476 / timeline:818x213 / curve:560x213`。

---

## 7. 网格变形（lattice warp）

warp 从「四角 quad」升级成「mesh lattice」，`state.warp` 的形状随之改变。

### 7.1 数据

```js
warp = { cols: 1, rows: 1, pts: [[x,y], …] }   // 顶点数 = (cols+1)*(rows+1)
```

- 顶点**行优先**：`index = row * (cols + 1) + col`，`1×1` 时 `pts = [tl, tr, bl, br]`。
- `pts[i]` 是相对该顶点基准位置（`u*width, v*height`）的**像素偏移**，不是绝对坐标。
- 旧格式（`{tl,tr,br,bl}`）由 `normalizeLattice()` 自动升级成 `1×1`，读写两侧都兼容。
- `cols/rows` 上限 `MAX_DIV = 12`。

### 7.2 `app/core/lattice.mjs`（纯几何，无 DOM）

`vertexCount` / `createLattice(cols,rows)` / `normalizeLattice` / `latticeToQuad` / `latticeFromQuad` / `latticeIsZero` / `vertexUV`（返回**数组**） / `setVertex`（不可变） / `latticeOffset(lat,u,v)`（逐 cell 双线性） / `latticePoint(lat,w,h,u,v)` / `cellQuad` / `lerpLattice` / `resizeLattice`（保留四角 + 中间重采样） / `latticeBounds` / `latticeInverse(lat,w,h,p)`（逐 cell 牛顿迭代，返回 `[u,v]` 或 null） / `latticeWireframe(lat,w,h,samples)`（返回**折线数组**）。

### 7.3 渲染与命中

- `composite.drawLatticeImage(g, img, lat, w, h, seg=6)`：每个 cell 再切 `seg×seg`，每个小格两片三角贴图。
- `elementLattice(doc, el, t, frameIndex)` → `{ lattice, size, matrix, map(u,v) → [x,y] }`；**`map` 必须返回数组**，返回 `{x,y}` 会让 `elementQuad` 里 `p[0]` 变 `undefined`。
- `worldToLocal` 用 `latticeInverse`，返回值再转成 `{u, v}` 对象（`hitTest` 依赖 `.u/.v`）。

### 7.4 画布与面板

- `canvas.mjs`：warp 模式下 `pickHandle` 遍历全部 `(cols+1)*(rows+1)` 顶点，命中返回 `{ kind:'lattice', vertex }`；拖拽把世界位移用 `elementMatrix` 逆矩阵的线性部分换到局部空间，累加进 `pts[vertex]`；`drawGizmo` 画 `latticeWireframe` 网格线 + 全部顶点方块（选中顶点 `#ffd479`）。
- `xform.mjs`：「网格变形」按钮同时切 `selection.mode` 并显示密度行 `.xf-warp-div`（`1×1/2×2/3×3/4×4` + 重置）；四角数值输入通过 `cornerIndex(lat, ck)` 写到对应角顶点，不再假设四角格式。
- `app.mjs`：`setLatticeDiv(cols,rows)`（`resizeLattice` → `writeKeyAt` → `setDoc`）**必须保留 `cols>1||rows>1` 的结构**，否则全零网格会被当成空 warp 丢掉；`resetLattice()` 写 `{ warp: null }`；`latticeOf(layerId)` 给面板读。
- `curve.mjs`：warp 通道**按当前网格维度动态生成**（`buildWarpChannels(cols,rows)`，id = `warp.<顶点序号>.<x|y>`），网格变化时重建 chip 并自动摊开；`statePatch` 解析 `warp.<i>.<axis>` 后写回完整 `{cols, rows, pts}`。

### 7.5 验收

- `tests/lattice.test.mjs` 24 例 + `tests/transform.test.mjs` 的 lattice 断言 → 全仓 **229 pass / 0 fail**。
- 真机（`mesh-warp.mjs`，CDP `Input.dispatchMouseEvent`）：切 2×2 后画布出现 9 顶点网格；拖顶点 4 得 `pts[4] = [136.26, -90.84]`，zoom 0.6605 下屏幕位移 (90, −60) 换算误差 < 0.05px，其它顶点保持 0。
- 动态通道：`1×1 → 8` 个 warp chip、`3×3 → 32` 个、退回 `1×1 → 8` 个，标量通道恒 8。


