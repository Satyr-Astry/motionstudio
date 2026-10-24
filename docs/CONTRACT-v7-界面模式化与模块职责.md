# CONTRACT v7 — 界面模式化与模块职责

本文件记录 v7 的界面结构与模块边界。与 v6（时间模型去帧化）配合看：v6 管数据，v7 管界面怎么把它呈现出来。

---

## §0 一句话

三个工作区各自只做一件事：**编排**做动画、**画板**造对象、**设置**改全局。任何面板都不该同时横跨两件事。

---

## §1 三个工作区（顶栏 tab）

| tab | id | 职责 | 允许出现 | 明确不该出现 |
|---|---|---|---|---|
| 编排 | `animate` | 摆时间、调关键帧、看曲线 | 画布（只选不画）、对象列表、属性、时间轴、曲线 | 画笔工具条、调色板 |
| 画板 | `draw` | 把东西画出来、提交成对象 | 画布（可画）、工具条、对象列表、调色板 | 时间轴、曲线、属性 |
| 设置 | `free` | 文档级与全局配置 | 文档、洋葱皮、信息、（偏好、帮助待接） | 画布、时间轴 |

**编排模式锁画笔**：`state.drawLocked` 在 `animate` 下为 true，`engine.onDown` 直接返回并把工具切回 `select`。这是硬约束，不是可选项——编排模式下画布只承担「选中与变换」一个职责。

---

## §2 顶栏

- 左：`＋ 保存 打开 导出 撤销 重做` + 项目名（脏时带 `•`）
- 中：三个工作区 tab
- 右：播放控制（**只在 `animate` 显示**）+ 画笔状态（`hover` 时显示，`animate` 下固定显示「选择」）

播放控制在非编排模式没有意义（没有时间轴可播），所以按 `chrome.update()` 里的 `tr.style.display = cur === 'animate' ? '' : 'none'` 隐藏。

---

## §3 属性面板的分组顺序

对象组必须在前，全局组在后。理由：用户打开属性面板 90% 是为了改当前对象。

```
对象变换 (is-object)   ← 有选中才显示
对象效果 (is-object)   ← 有选中才显示
时间
文档
时间轴
洋葱皮
信息
```

- 显隐必须用**内联 `style.display`**，不能用 `hidden`——`.prop-group` 自带 `display`，`hidden` 会被压掉。
- `data-k` 值（`xform` / `effects` / `doc` / `timebase` / `onion` / `info`）是跨模块契约，分包后靠它定位。

---

## §4 模块边界（v7 拆分结果）

| 文件 | 行数上限 | 职责 | 禁止 |
|---|---|---|---|
| `editors/properties.mjs` | 120 | 面板外壳与顺序 | 业务逻辑 |
| `editors/prop-kit.mjs` | 150 | 建 DOM 的公共函数 | 读 ctx |
| `editors/prop-object.mjs` | 240 | 对象变换 + 效果 | 文档/洋葱皮 |
| `editors/prop-doc.mjs` | 120 | 文档 + 时间轴分段 | 对象 |
| `editors/prop-onion.mjs` | 120 | 洋葱皮 | 其它 |
| `editors/prop-info.mjs` | 140 | 只读信息 | 写操作 |
| `editors/timeline.mjs` | 600 | 时间轴外壳与交互 | 几何计算 |
| `editors/timeline-geo.mjs` | 220 | 纯几何（**零 DOM**） | 触碰 document |
| `editors/timeline-paint.mjs` | 620 | 只画 DOM | `setDoc` / `patchObject` |
| `editors/timeline-keys.mjs` | 300 | 关键帧读写 | 布局 |
| `editors/curve.mjs` | 710 | 曲线外壳与交互 | 几何/绘制 |
| `editors/curve-geo.mjs` | 310 | 纯几何 + 命中（**零 DOM**） | 触碰 document |
| `editors/curve-draw.mjs` | 260 | 只画 canvas | 读写 doc |
| `editors/canvas.mjs` | 420 | 画布宿主与生命周期 | 手柄数学 |
| `editors/canvas-input.mjs` | 220 | 指针事件 → 意图 | 绘制 |
| `editors/canvas-chrome.mjs` | 285 | 叠加层绘制 | 事件绑定 |
| `core/gizmo.mjs` | 285 | 手柄数学（**纯函数**） | 触碰 DOM |

**「零 DOM」文件的判定标准**：在 Node 里 `import` 不报错，且不出现 `document` / `window` 字样。这类文件必须可被单元测试直接覆盖。

---

## §5 内置编辑器注册表（`registry.mjs`）

| id | 标题 | 默认所在 |
|---|---|---|
| `canvas` | 画布 | 三模式 |
| `toolbar` | 工具 | `draw` |
| `layers` | 对象 | `animate` / `draw` |
| `palette` | 调色 | `draw` |
| `properties` | 属性 | `animate` |
| `timeline` | 时间轴 | `animate` |
| `curve` | 曲线 | `animate` |
| `doc` | 文档 | `free` |
| `onion` | 洋葱皮 | `free` |
| `info` | 信息 | `free` |
| `help` | 帮助 | 待接（内容已就绪） |
| `prefs` | 偏好 | 待接（另一个代理在做） |

区域标题栏的下拉可切换到任意已注册编辑器——这是用户的逃生口：不满意默认布局就自己换。

---

## §6 动画模型的三个概念（帮助面板的文案基准）

| 概念 | 时间行为 | 管什么 | 在哪编辑 |
|---|---|---|---|
| 画格 cel | **离散**，到点换图 | 画什么 | 画板模式 |
| 关键帧 | **连续插值** | 画在哪、多大、转多少、多透 | 手柄 / 属性面板 / 时间轴 |
| 时间通道 | 变换时间本身 | 用不同节奏播、传给子树 | 对象行徽章 / 属性面板 |

三者正交：换画格不影响关键帧曲线；改关键帧不影响画格内容；改时间通道只改「什么时候取到哪一帧」。

---

## §7 验收基线

```
node --test tests/*.test.mjs   # 452 tests / 450 pass / 0 fail / 2 skipped
```

真机三模式往返（`audit.js`）：

| 模式 | 可见区域数 | `.cv-host` 数 |
|---|---|---|
| animate | 5 | 1 |
| draw | 4 | 1 |
| free | 3 | 1 |

区域尺寸基线（1384×841 窗口）：画布 848×557 / 对象 232×557 / 属性 292×557 / 时间轴 818×220 / 曲线 560×220。
