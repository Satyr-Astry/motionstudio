# CONTRACT v5 — 时间图（Time Graph）与对象层级

> 本契约是 v4 之后的一次**架构级重构**。目标不是「在时间轴里再加一种关键帧」，而是把时间本身变成一等公民：
> **时间是可组合、可微、可嵌套的变换，帧只是采样结果。**
>
> 兼容性：v2/v3/v4 的 `.msp` 文件必须能原样打开（缺省字段按 §7 补齐）；v3/v4 的所有公开 API 保留签名。

---

## 0. 一句话模型

```
全局时间 t
  └─ 对象时间通道（offset / scale / loop / pingpong / clamp / hold，可随父对象嵌套）
       └─ 局部时间 t'
            └─ 属性轨道（贝塞尔曲线）→ 状态
                 └─ 世界矩阵 = 父世界矩阵 · 自身矩阵
                      └─ 像素（cel / hold / 链接）
```

**帧（frame）降级为「像素容器」**：它仍然存在（Pixelorama 模型不变），但不再承担时间语义。
时间语义完全由时间通道 + 轨道曲线决定。

---

## 1. 时间通道（`layer.time`）

```js
layer.time = {
  offset: 0,      // 秒。局部时间 = 全局时间 - offset
  scale: 1,       // 倍率。>1 变快，<1 变慢，负值倒放
  mode: 'none',   // 'none' | 'loop' | 'pingpong' | 'clamp'
  from: 0,        // loop/pingpong/clamp 的区间起点（秒）
  to: 0,          // 区间终点；to <= from 时视为「用文档全长」
  hold: false,    // true = 冻结在 holdAt
  holdAt: 0,      // 冻结时的局部时间（秒）
}
```

求值规则（`core/timegraph.mjs`）：

```js
raw = (tGlobal - offset) * scale
if (hold) return holdAt
span = (to > from ? to : docTotal)
switch (mode):
  'loop'     → from + mod(raw - from, span)
  'pingpong' → from + 三角波(raw - from, span)
  'clamp'    → clamp(raw, from, from + span)
  default    → raw
```

- `mod` 必须是**非负**且对 `raw < from` 也正确（用 `((x % span) + span) % span`，但对恰好落在边界上的值保持原值，避免 0.1 变成 0.099999）。
- `scale = 0` 视为 `hold = true`。
- 时间通道对**父对象**同样适用：子对象的全局时间先经过父通道，再经过自己的通道。

---

## 2. 对象层级（`layer.parentId`）

- `layer.parentId: string | null`；`null` = 根对象。
- 禁止成环：`setParent(doc, id, parentId)` 必须做环检测，成环时返回原 doc 并标记 `ok: false`。
- 渲染顺序：先按 `layers` 数组顺序（`layers[0]` 最上），父对象**不改变**子对象的层序，只改变变换与时间。
- 世界矩阵：`worldMatrix(doc, el, tGlobal) = worldMatrix(parent) · elementMatrix(el, localTime(el, tGlobal), size)`。

```js
// core/evaluator.mjs
export function worldMatrixOf(doc, el, tGlobal)  // 返回 3x2 仿射矩阵（a,b,c,d,e,f）
export function localTimeOf(doc, el, tGlobal)    // 秒
```

---

## 3. 统一求值器（`core/evaluator.mjs`）

一切「取某一时刻的画面状态」都必须走这里，禁止各处自己拼 `stateAt + elementMatrix`。

```js
export function createEvaluator(doc, opts = {})   // opts: { frameAt(t) -> frameIndex, cache: true }
// 返回：
{
  doc,                          // 创建时的 doc 引用（不可变）
  localTime(el, t),
  worldMatrix(el, t),
  stateAt(el, t),               // 属性状态（含 opacity/warp）
  effectsAt(el, t),             // 效果器参数（按时间求值）
  frameAt(t),                   // 该时刻应显示的帧索引（像素容器）
  sample(t),                    // { layers: [...], frame, total }  一次性取整帧
  invalidate(),                 // 换 doc 后必须调用
}
```

- `sample(t)` 必须**纯函数、无副作用**，同一 t 多次调用结果全等（可用 `Object.is` 比对数值）。
- 允许内部缓存：以 `Math.round(t * 1e6)` 为 key 的 LRU（容量 64）。
- 求值器不认识 UI，不认识 canvas。

**改造要求**：`app/paint/composite.mjs`、`app/paint/engine.mjs`、`app/editors/canvas.mjs`、`app/shell/app.mjs` 里所有 `stateAt(trk, t)` / `elementMatrix(...)` / `elementLattice(...)` 的直接调用，全部改走 evaluator。

---

## 4. 可微（切线）

```js
// core/transform.mjs 新增
export function slopeAt(track, t, eps = 1e-4)   // 数值中心差分，返回 { x, y, scaleX, ..., rotate, opacity }
```

用途：
- 「自动切线」：把某关键帧的 `h1/h2` 按相邻关键帧的斜率设为 Catmull-Rom 风格（`h1 = [1/3, 1 - s0/3]` 归一化写法需换算到段内坐标）。
- 曲线编辑器显示切线斜率。

---

## 5. 关键帧功能补齐

| 功能 | 入口 | 语义 |
| --- | --- | --- |
| 自动切线 | 曲线工具条 `自动` 按钮 / 右键菜单 | 选中的 key 按相邻斜率生成 h1/h2，`ease='bezier'` |
| 复制 / 粘贴 | `Ctrl+C` / `Ctrl+V`（曲线或时间轴焦点内） | 复制选中 key 的 `{t, state, ease, h1, h2}`；粘贴到当前时间 |
| 时间缩放 | 时间轴工具条 `⇤⇥` 或框选后拖 | 把 [a,b] 内的所有 key 的 t 线性映射到 [a',b'] |
| 跳到上/下关键帧 | `,` / `.` | 沿当前对象轨道跳转 |
| 批量改缓动 | 多选 key + 预设 | 对所有选中 key 生效 |

多选：`selKeys: Array<{layerId, t}>`（替代现有单个 `selKey`），`Shift+点击` 追加。

---

## 6. 文件格式 v3

`format: 'motionstudio-project'`，`version: 3`。

新增字段（全部可选，缺省见 §7）：

```jsonc
{
  "layers": [{
    "id": "layer_x",
    "parentId": null,
    "time": { "offset": 0, "scale": 1, "mode": "none", "from": 0, "to": 0, "hold": false, "holdAt": 0 }
  }]
}
```

读入规则：
- `version <= 2` → 每个 layer 补 `parentId: null`、`time: TIME_IDENTITY`。
- `time` 字段缺失或非法值 → 用 `TIME_IDENTITY`（不抛异常）。
- 写出永远是 v3。

---

## 7. 缺省与钳制（防炸）

| 字段 | 缺省 | 钳制 |
| --- | --- | --- |
| `parentId` | `null` | 必须指向存在的 layer id，否则 `null` |
| `time.offset` | `0` | `[-1e6, 1e6]` |
| `time.scale` | `1` | `[-100, 100]`，`0` 视作 hold |
| `time.mode` | `'none'` | 枚举外的值 → `'none'` |
| `time.from` / `to` | `0` | `>= 0`；`to <= from` → 用 doc 总时长 |
| `time.holdAt` | `0` | `>= 0` |

**所有求值函数对非法输入必须返回恒等值，绝不抛异常**（这是硬要求：任何一条坏数据不能让整个画布空白）。

---

## 8. 文件结构精简（硬指标）

`app/shell/app.mjs` 当前 2474 行、90+ 顶层函数，必须拆成：

```
app/shell/
  app.mjs            编排 + ctx + facade + 快捷键     目标 ≤ 700 行
  doc-state.mjs      state / setDoc / emitDoc / subscribe / 时间与播放
  view-host.mjs      区域树渲染、slot 挂载、canvas 搬迁、分隔条
  commands.mjs       帧操作、图层操作、效果器操作、关键帧操作
  project-io.mjs     保存/加载/导入/导出/项目库
```

- 拆分后**公开行为不变**：`window.motionStudio` 的全部键、快捷键、`ctx` 的全部键必须逐个存在且语义不变。
- 删除所有 `probe-*.mjs` 调试残留。
- `app/styles/panels.css` 从 1794 行降到 ≤ 1500 行：合并同族规则、删 `!important`（当前 0 处）、删未被任何 `.mjs` 引用的类名（用 grep 校验）。

---

## 9. UI 精简与新增

**新增（必须有）**
1. 时间轴每个对象行的左侧加「⏱」徽章：`is-off`（恒等）/ `is-on`（有非恒等时间通道）。点击弹出 popover：offset / scale / mode / from-to / hold 五个控件，实时预览。
2. 对象面板支持**拖拽成父子**：拖到另一个对象行右半区 → 成为子对象；拖到空白 → 回根。子对象行缩进 12px。
3. 曲线工具条加「自动」按钮（§5）。

**删除（冗余）**
- 画布浮动工具条里的 `1×1 / 2×2 / 3×3 / 4×4` 四个按钮：属性面板已有七档 + 自定义，工具条只保留「网格」开关按钮。
- 顶栏「导出」与「项目库」里重复的导出入口只留一处。
- 属性面板「帧」组里的「时长倍数」与时间轴拖帧块右边缘重复 → 帧组只读显示，编辑统一走时间轴。

---

## 10. 验收标准（真机 + 单测）

单测（`node --test tests/*.test.mjs`）必须新增：

- `tests/timegraph.test.mjs`：offset/scale/loop/pingpong/clamp/hold 各自正确；`scale=0` 视作 hold；`to<=from` 用全长；负 scale 倒放；嵌套两级时间通道；非法输入全部回落恒等且不抛。
- `tests/evaluator.test.mjs`：`sample(t)` 纯函数（同 t 两次调用数值全等）、缓存命中后 `invalidate()` 失效、父子世界矩阵合成正确（父平移 100，子在父内平移 50 → 世界 150）、父旋转 90° 后子位移方向跟着转。
- `tests/parent.test.mjs`：`setParent` 环检测、`removeLayer` 时子对象提升为根、`cloneDocument` 保留 parentId。

真机（CDP 9334，`E:\HERMES\cache\scratch\kleks104\`）：

- 给某对象设 `scale=2` 后，同一关键帧动画在时间轴上**播放速度翻倍**，且曲线编辑器横轴读数仍是秒。
- 设 `mode='loop'` 且 `from=0,to=0.5` 后，0–0.5s 的动作在整片重复。
- 父子：父对象旋转 90° 后，子对象的位移沿旋转后的轴走。
- 时间通道 popover 打开后改任一项，画布立即变化（不刷新页面）。
- `window.motionStudio` 键数与拆分前逐个比对，一个不少。

---

## 11. 踩坑约束（沿用并新增）

1. **不可变更新**：`doc` 一律走 `setDoc(updater)`，返回新对象；禁止原地改。
2. **求值器不持有 UI 引用**，也不做 DOM 操作。
3. **rAF 在后台窗口会被暂停**：任何「必须刷新」的路径都要有 `setInterval` 兜底（见 v3 教训）。
4. **Electron 渲染进程没有 `window.prompt`**，一律内联输入。
5. **合成 PointerEvent 会失真**，坐标验证只认 CDP `Input.dispatchMouseEvent`。
6. 新增 CSS 一律写具体类名 + tokens 变量，禁止 `!important`。
7. 拆文件时**不要顺手改逻辑**：先移动 + 补 import/export，跑通测试，再单独提交行为变更。

## 十二、实现回填约定（约束 §1 / §2 / §7）

单测跑出来后回填的五条，避免后来者按直觉推断。

1. **`modSpan(x, n)` 在边界处返回 `x` 本身。** 当 `x` 恰为 `n` 的整数倍，或与边界相差 `< 1e-9` 时，返回值是 `x` 而不是 `0`（`n - x` 同理）。**调用方不得假设返回值恒在 `[0, span)` 内。** 直接后果：`loop` 模式下恰好整圈时，局部时间取 `from + span` 而不是 `from`。
2. **`totalSec <= 0` 时不做区间折算。** `loop` / `pingpong` / `clamp` 三种模式一律退化为 `raw = (t - offset) * scale`。这一条同时覆盖 `to <= from && totalSec <= 0` 的组合。
3. **父链深度上限 `MAX_DEPTH = 64`。** `timeDepth` 在超限时记 64；`localTimeOf` 只施加最近 64 个祖先的通道；**`isDescendant` 在超限时 fail-closed 返回 `true`** —— 宁可拒绝一次合法设父，也不能放行会造环的操作。
4. **`childrenOf(doc, null)` 返回 `[]`**（根不是父）。要拿顶层对象用 `rootLayers(doc)`，两者不等价。
5. **钳制范围**：`offset` / `scale` 是双侧钳制（见 `normalizeTime`）；`from` / `to` / `holdAt` 只有下界 `>= 0`，**没有上界**。

### 另一处口径修正

`isIdentityTime(time)` 在 `mode === 'none'` 时**不把 `from` / `to` 计入判定**（它们是惰性字段）。这样它与 `describeTime` 对同样输入的口径一致，也保证层行 ⏱ 徽章不会「亮着但悬浮说明写『无时间变换』」。对应测试已改为断言「`mode=none` 时 `from`/`to` 惰性」。
