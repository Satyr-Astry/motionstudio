# CONTRACT v2：元素动画（Element Animation）

> 本文件在 v1 之上叠加，**只描述增量**。v1 未提及的部分继续有效。冲突时以本文件为准。

## 0. 变更摘要

| | v1（已实现） | v2（本次） |
| --- | --- | --- |
| 图层语义 | 绘图图层 | **元素 / 部件**（可独立运动、选中、命名的元件） |
| 变换求值 | 按帧取 `frameStart(doc, i)` | **按连续时间 `ctx.time()`（秒）** |
| 关键帧位置 | 只在帧起点 | 时间轴任意位置，可拖到两帧之间 |
| 选中 | 只有「当前图层」 | 画布点击命中 + 包围框 + 手柄 + warp 角 |
| 文件格式 | v1（layer/frame/cel） | **v2（element/frame/cel + assets）** |

**核心：双轨并行** —— 变换走连续时间曲线（全动画），像素仍按帧存 cel（可逐帧微调）。二者在渲染时相乘叠加。

## 1. 元素（Element）

`doc.layers[i]` 就是一个元素。字段在 v1 基础上新增：

```
element = {
  id, name, visible, locked, opacity, mixMode,
  kind: 'paint' | 'image',        // 手绘元素 / 导入图片元素
  anchor: { x, y },               // 归一化锚点 [0,1]，默认 {0.5, 0.5} = 内容中心
  transform: { keys: [...] },     // 连续时间轨道（结构不变，见 v1 §5）
  onClickIgnore: false,           // 命中测试时跳过（装饰层用）
}
```

- UI 文案统一叫「元素」；编辑器 id **仍为 `layers`**（不要改成 elements，会牵动持久化）。
- 元素内容矩形 = `celCell 位图尺寸`，缺省回退 `doc.width/height`。

## 2. 时间模型（最关键的一条）

- **唯一时间源**：`state.time`（秒，`0 <= time < totalSeconds`）。`state.frameIndex` 只是它的**派生刻度**。
- 变换求值：`stateAt(el.transform, time)`。
- 像素取值：`celAt(doc, frameAtTime(doc, time), el.id)`。
- 播放推进 `time` 连续变化；**帧边界只切换 cel，不打断变换曲线**。
- 打关键帧一律用 `t = ctx.time()`（浮点秒），**不吸附帧**。帧吸附只用于「画图」这个动作（保证笔画落到某个 cel 上）。
- `compositeFrame(target, doc, { time, frameIndex, ... })`：有新参数 `time`；`time` 缺省时回退 `frameStart(doc, frameIndex)`（向后兼容）。

## 3. 选中

```
state.selection = { id: string, mode: 'transform' | 'warp' } | null
```

- 点画布：从 `layers[0]`（最上层）往下遍历**可见且未锁定**的元素，做命中：
  1. 世界坐标 → 元素局部坐标：先按 `warp` 做四边形逆映射，再用 `matrixOf` 的逆矩阵；
  2. 局部坐标落在内容矩形内且 `getImageData` 该点 `alpha > 8` → 命中。
- 命中 → `setSelection({ id, mode: 'transform' })`；点空白 → `setSelection(null)`。
- `Alt`+点击 = 逐层穿透循环；`Shift`+点击 = 加选（v2 只记最后选中的一个，多选留 v3）。

## 4. 手柄（画布叠加层）

- `transform` 模式：8 个缩放手柄（`nw n ne e se s sw w`）+ 顶部旋转手柄 + 锚点十字。
- `warp` 模式：四角 `tl tr br bl` 手柄 + 每个边的中点（拖动做梯形）。
- 手柄尺寸恒定屏幕像素（不随缩放变大）：`8px` 方块，`pointer-events` 只在描边区域。
- 拖动任何手柄 = 在 `ctx.time()` 写关键帧（同 t 有 key 则 `setKeyState`）。
- 拖动画面空白处 = 移动选中元素（平移）。

## 5. 时间轴上的关键帧

- 每个元素行下面挂一条**变换轨道子行**（高度 14px），显示该元素 `transform.keys` 的菱形。
- 菱形：宽 7px，`transform: rotate(45deg)`，当前时间前后 3px 内高亮。
- 菱形可**水平拖动**改 `t`（不吸附帧；按 `Shift` 吸附到帧边界），双击删除，右键菜单选缓动。
- cel 格（主行）仍是逐帧方块，与菱形互不影响。

## 6. 文件格式 v2（`.msp`，JSON）

```jsonc
{
  "format": "motionstudio-project",
  "version": 2,
  "name": "示例",
  "savedAt": 1730000000000,
  "width": 900, "height": 640, "fps": 12,
  "loopMode": "cycle",
  "onion": { "enabled": false, "before": 1, "after": 1, "mode": "tint" },
  "elements": [
    {
      "id": "L1", "name": "头部", "visible": true, "locked": false,
      "opacity": 1, "mixMode": "source-over", "kind": "paint",
      "anchor": { "x": 0.5, "y": 0.5 },
      "transform": { "keys": [ { "t": 0, "state": {…}, "ease": "bezier", "h1": [.25,.1], "h2": [.75,.9] } ] }
    }
  ],
  "frames": [
    { "duration": 1, "cels": { "L1": { "image": { "w": 900, "h": 640, "dataUrl": "data:image/png;base64,…" } | null, "opacity": 1 } } }
  ],
  "assets": { "L1": "data:image/png;base64,…" }   // kind:'image' 的原始图，cel 为 null 时用
}
```

- **读 v1 自动升级**：补 `kind:'paint'`、`anchor:{0.5,0.5}`；`frames[].cels` 结构不变；旧 `doc.layers` → `elements`。
- 位图序列化规则同 v1（`OffscreenCanvas` 无 `toDataURL`，走临时 canvas）。
- 空 cel 写 `image: null`，不占体积。

## 7. 导入 / 导出

- **导入图片**：PNG / JPG / WebP → 新建 `kind:'image'` 元素，居中，`anchor {0.5,0.5}`，只填第 1 帧 cel（其余帧继承 `assets`）。
- **导入项目**：`.msp` / v1 `.json`。
- **导出**：PNG 序列（已有）、单帧 PNG、`.msp` 单文件、**精灵图**（横排 N 列，附 `.json` 帧表）。

## 8. 验收（缺一不可）

1. 拖动手柄 → 立刻出现关键帧；播放时元素**连续**运动，不是逐帧跳。
2. 关键帧菱形能拖到两帧之间（如 `t = 0.37s`），求值随之改变。
3. 逐帧微调：在第 5 帧画一笔，第 4/6 帧不受影响，但元素变换曲线覆盖全时间轴。
4. 保存 → 新建 → 载入：像素、关键帧时间、缓动控制点 **全部一致**。
5. 导入一张 PNG → 成为新元素，可选中、可变换、可打关键帧。
6. 点空白取消选中；点元素选中；`layers` 面板与画布选中态双向同步。
7. `node --test tests/*.test.mjs` 全绿；控制台零 error。
