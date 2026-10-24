# MotionStudio 契约（冻结版 v1）

> 本文件是并行开发的唯一依据。**改动契约必须先通知 Lead**，任何人不得单方面修改接口、类名、文件名。

---

## 1 定位

MotionStudio 是一个 **2D 逐帧动画编辑器**，桌面端（Electron），完全自研：

- 动画模型借鉴 Pixelorama：`帧 × 图层 = 塞尔(cel)`，可逐帧设置时长倍数，支持洋葱皮、播放、循环模式。
- 图层可做变换（位移/缩放/旋转/斜切/四角变形），变换用**关键帧 + 贝塞尔缓动**记录，与逐帧 cel 共存。
- 界面借鉴 Blender：区域（Area）可分割、可互换、可拖动调整比例，每个面板都是一个可替换的编辑器组件。

**不继承**旧工程 `E:\dev\klecks-desktop`、`E:\dev\klecks` 的任何代码，只允许阅读参考。

---

## 2 目录与写作用域

```
E:\dev\motionstudio\
  package.json              Lead
  main.js                   Lead        主进程
  app\index.html            Lead        薄壳
  app\core\                 ✅ 已完成（cel / transform / history）
  app\paint\                ✅ 已完成（engine / brush / stroke / surface / patch / composite / onion / thumb / ops）
  app\shell\areas.mjs       ✅ 已完成（纯函数区域树）
  app\shell\layout.mjs      ✅ 已完成（布局计算）
  app\shell\registry.mjs    T1
  app\shell\app.mjs         T1
  app\shell\chrome.mjs      T1
  app\shell\persist.mjs     T1
  app\shell\ipc.mjs         T1          主进程调用封装
  app\editors\canvas.mjs    T2
  app\editors\toolbar.mjs   T2
  app\editors\palette.mjs   T2
  app\editors\layers.mjs    T3
  app\editors\timeline.mjs  T3
  app\editors\properties.mjs T3
  app\editors\xform.mjs     T3
  app\editors\help.mjs      T3
  app\styles\tokens.css     T4
  app\styles\shell.css      T4
  app\styles\panels.css     T4
  tests\                    ✅ 已完成（110 用例，禁止修改）
  docs\                     Lead
```

**写作用域互斥**：只能写自己那一栏的文件。需要别人配合时，找 Lead，不要改别人的文件。

---

## 3 文档数据结构（`doc`，只读理解）

由 `app/core/cel.mjs` 的 `createDocument()` 产生，**全部是不可变更新**（每次操作返回新对象）：

```js
{
  width: 900, height: 640, fps: 12,
  loopMode: 'cycle' | 'pingpong' | 'none',
  layers: [                       // layers[0] 是最上层
    { id:'layer1', name:'图层 1', visible:true, locked:false,
      opacity:1, mixMode:'source-over', linkNewCels:false, onionIgnore:false,
      transform: { keys:[ {t:0, state:{...}, ease:'linear', h1, h2} ] } }
  ],
  frames: [                       // 每帧图层数相同（不变量）
    { duration: 1, tag: null, cels: { layer1: { id:'cel1', image:HTMLCanvasElement|null, opacity:1, zIndex:0, group:null } } }
  ],
  tags: [],
  onion: { enabled:false, before:1, after:1, mode:'tint', past:'#c8555a', next:'#3f9a63', opacity:0.4 }
}
```

`transform.keys[].state` 形状（`core/transform.mjs` 的 `DEFAULT_STATE`）：

```js
{ x:0, y:0, scaleX:1, scaleY:1, rotate:0, skewX:0, skewY:0, opacity:1, warp:null }
// warp 为 null 或 { tl:[dx,dy], tr:[dx,dy], br:[dx,dy], bl:[dx,dy] }
```

---

## 4 ctx：所有编辑器共享的唯一接口

`app/shell/app.mjs` 构造，传给每个编辑器的 `mount(el, ctx)`：

```js
{
  doc(),                      // → doc | null
  setDoc(updater),            // updater(doc) → newDoc；外壳负责广播、持久化、重绘画布
  subscribeDoc(fn),           // → unsubscribe()；doc 变化时回调

  frame(), setFrame(i),       // 当前帧号（0 基）
  time(), setTime(t),         // 当前时间（秒）
  playing(), setPlaying(v),

  engine,                     // paint/engine.mjs 实例（唯一持有像素的地方）
  tool(), setTool(id),        // 'brush' | 'eraser' | 'bucket' | 'picker' | 'pan'
  color(), setColor(hex),     // '#rrggbb'

  undo(), redo(),

  activeLayerId(),            // → 当前操作图层 id
  setActiveLayer(id),

  notify(msg),                // 状态栏短消息
  requestRender(),            // 请求画布重绘（不是重排布局）

  addFrame(at, duplicate), removeFrame(i), moveFrame(from, to),
  exportFrames(),             // 调主进程导出当前动画的逐帧 PNG
}
```

**硬规则**：`ctx` 可能在任何时刻返回 `null`（冷启动）。所有 `paint()`/`refresh()` 第一行必须守卫 `doc` 为空的情况，渲染空态而不是抛异常。

---

## 5 编辑器模块契约

每个 `app/editors/*.mjs` 只导出：

```js
export function mount(el, ctx) {
  // el 是一个空的 .area-body 元素，已清空
  return {
    destroy?(),     // 可选，卸载时清理监听
    refresh?(),     // 可选，doc/frame 变化时被调用
    focusFrame?(),  // 可选，时间轴/画布切帧时补一次局部刷新
  };
}
```

`el` 的 `className` 由外壳统一为 `area-body ed ed-<editorId>`；**编辑器自己不要改 `el.className`**，只往里 append 子节点。

---

## 6 DOM 结构与类名（强制，CSS 由 T4 按此编写）

### T1 · shell（`#topbar` / `.area` / `#statusbar`）

```
#topbar
  .top-brand            文字 "MotionStudio"
  .top-ws               > button.top-ws-tab[data-ws]  （is-on 表示当前工作区）
  .top-transport        > button.top-tr-btn[data-act=first|prev|play|next|last]
  .top-time             例如 "0.00 / 1.00 s"
  .top-hint             右侧提示文字

#ws-host
  .area[data-id]
    .area-head
      .area-grip        （拖动手柄，光标 move）
      select.area-type  （编辑器下拉）
      .area-gap         （flex:1 占位）
      button.area-btn[data-act=split-h|split-v|close]
    .area-body          （编辑器挂载点）
  .splitter.splitter--row | .splitter--col

#statusbar
  .stb-left   .stb-right
```

### T2 · canvas

```
.ed-canvas（= el 自身，由外壳加的 class）
  div.cv-host            （引擎 canvas 的挂载点，engine.attach(el) 用它）
  .cv-hud
    button.cv-hud-btn[data-act=fit]      "适配"
    button.cv-hud-btn[data-act=zoom]     "70%"
```

### T2 · toolbar

```
.tbar
  .tbar-tools   > button.tbar-tool[data-tool]  （is-on 表示选中）
  .tbar-sep
  .tbar-brushes > button.tbar-brush[data-brush]（is-on 表示选中）
  .tbar-sep
  .tbar-field   > span.tbar-lbl "笔尖" + input.tbar-size[type=range] + output.tbar-size-val
  .tbar-field   > span.tbar-lbl "不透明" + input.tbar-alpha[type=range] + output.tbar-alpha-val
  .tbar-sep
  .tbar-history > button.tbar-btn[data-act=undo|redo]
```

### T2 · palette

```
.pal
  .pal-top   > span.pal-chip + input.pal-hex[type=text]
  .pal-sv    > canvas.pal-sv-canvas + span.pal-cursor
  input.pal-hue[type=range]
  .pal-swatch[data-color]（v8 已删除，改由 .pal-recent 承载最近色）
  .pal-recent > span.pal-label "最近" + span.pal-recents > button.pal-dot
```

### T3 · layers

```
.lyr
  .lyr-bar  > button.lyr-btn[data-act=add|dup|up|down|merge|del]
  .lyr-alpha > input.lyr-alpha-range[type=range] + span.lyr-alpha-val
  .lyr-list > .lyr-row[data-id]        （is-active 表示当前层）
      button.lyr-vis                    （is-off 表示隐藏）
      canvas.lyr-thumb
      .lyr-meta > .lyr-name + .lyr-sub
  .lyr-foot > span.lyr-count
```

### T3 · timeline

```
.tline
  .tline-bar > button.tline-btn[data-act=prev|play|next|addframe|dupframe|delframe|moveleft|moveright]
             + span.tline-time
  .tline-scroll
    .tline-head > .tline-corner + .tline-cols > .tline-col[data-i]（is-cur 当前帧，is-onion-past/next 洋葱范围）
    .tline-rows > .tline-row > .tline-label + .tline-cells > .tline-cell[data-i][data-layer]（has-ink / is-cur）
```

### T3 · properties

```
.prop
  .prop-group
    .prop-title
    .prop-body[data-k=frames|doc|onion|info|xform]
      .prop-row > .prop-label + .prop-field
          .prop-field 里可用：input.prop-num、button.prop-seg[data-val]（is-on）、button.prop-toggle（is-on）
```

`data-k="xform"` 的 `.prop-body` 由 `properties.mjs` 调用 `xform.mjs` 的 `createXformPanel(ctx)` 填充。

### T3 · xform（被 properties 内嵌，不是独立区域）

```
.xf
  .xf-head   > select.xf-layer + span.xf-keys
  .xf-grid   > .xf-row > span.xf-label + input.xf-num[data-field]
  button.xf-warp-btn（is-on 表示展开四角）
  .xf-corners[hidden] > .xf-corner > span.xf-label + input.xf-num[data-corner][data-axis]
  .xf-seg    > button.xf-segbtn[data-ease=linear|bezier|hold]（is-on）
  .xf-actions > button.xf-btn[data-act=prev|next|del|reset]
```

### T3 · help

```
.hlp
  .hlp-title
  .hlp-list > .hlp-item > kbd.hlp-key + span.hlp-desc
```

---

## 7 CSS（T4）

三个文件，全部使用 `@layer` 无关的普通级联，**按下面顺序被 `index.html` 引入**：

```html
<link rel="stylesheet" href="./styles/tokens.css">
<link rel="stylesheet" href="./styles/shell.css">
<link rel="stylesheet" href="./styles/panels.css">
```

`tokens.css` 必须定义这些变量（其它两个文件只许用，不许重定义）：

```css
--bg:#141518  --bg-2:#191a1d  --panel:#212328  --panel-2:#26282d  --surface:#2b2e34
--line:#33363d  --line-2:#3d4048  --ink:#e6e8ec  --ink-dim:#9aa1ac  --ink-faint:#6b7280
--accent:#4a7dff  --accent-2:#2f5fd0  --danger:#e05a5a  --ok:#3fa46a
--head-h:27px  --radius:5px  --row-h:26px
```

同时定义：`box-sizing:border-box` 全局、`html,body` 铺满无滚动、细滚动条、`:focus-visible` 描边、`.area-body` 的 `min-height:0`/`overflow:hidden`、通用按钮基座。

**布局硬约束**：`.area` 是 `position:absolute`（`left/top/width/height` 由 JS 写），`.splitter` 也是绝对定位。`.area-body` 是 `flex:1 1 auto; min-height:0; overflow:hidden; position:relative`。

---

## 8 验收（每个 teammate 交活前必须自证）

1. `node --check <自己写的每个 .mjs>` 全部通过。
2. 不 import 任何 npm 包，不 import `E:\dev\klecks*` 的任何文件。
3. 交活时提供一段说明：导出的函数签名、依赖了哪些 `ctx` 字段、有哪些已知未完成点。
4. 不改 `app/core/**`、`app/paint/**`、`app/shell/areas.mjs`、`app/shell/layout.mjs`、`tests/**`。
5. 不写 `main.js`、`app/index.html`、`app/styles/**`（除 T4）。

Lead 会在集成后跑：
- `node --test tests/*.test.mjs`（必须 110 pass / 0 fail）
- 启动 `MotionStudio.exe` + CDP 断言：6 个面板渲染、拖分隔条 iframe 不重载（已无 iframe，改为 doc 不重建）、画布可绘制、切帧隔离、撤销/重做、导出 PNG

---

## 9 关键实现约束（踩过的坑，别再犯）

1. **不要每次 render 清空 `el.textContent`**：外壳只在编辑器换类型时重挂，否则会销毁面板内部状态。
2. **像素画布尺寸**：`doc.width × doc.height` 是逻辑尺寸，显示层用 `engine` 自己的 view canvas，两者不同。
3. **`layers[0]` 是最上层**（不是最底层）。
4. **图层不透明度**是 `layer.opacity`（0..1），cel 上也有一个 `opacity`，面板只改图层那个。
5. **时间轴帧列宽固定 54px、行高 26px**，横向滚动由 `.tline-scroll` 承担，表头与行内容必须同步横向滚动。
6. **中文注释**，代码里不留 TODO 之外的英文长句。
