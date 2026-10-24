# CONTRACT v6 —— 时间驱动模型（删除帧对象）

> 一句话：**没有帧，只有时间。** 内容属于「某一秒」，不属于「第几格」。

---

## 0. 这次要删掉什么

| 旧（v5 及以前） | 新（v6） |
| --- | --- |
| `doc.frames[fi].cels[objId].image` | `doc.objects[i].cels[{ at, image }]` |
| `doc.frames[fi].duration`（帧倍率） | 由两个画格的 `at` 之差天然表达 |
| `doc.frames.length` 决定总时长 | `doc.duration` 显式给出，缺失时按内容推算 |
| `frameIndex` / `frameStart(doc,i)` / `frameSeconds(doc,i)` | **全部删除**，一律换成秒 `t` |
| 时间轴画「帧块」，块宽 = 帧时长 × fps | 时间轴画**画格切换点**与**关键帧** |
| `hold`（跨帧继承） | 不存在该概念——画格一直沿用到下一个画格 |

`hold` 之所以被删掉：它存在的唯一理由是「相邻两帧要共享同一张图」。在时间模型里，
「某张图从 0.5 秒一直用到 2 秒」就是一条画格记录，不需要额外的继承标记。

---

## 1. 数据形状

```js
doc = {
  width, height, fps, loopMode,
  duration,          // 总时长（秒）；缺失时 = max(画格 at, 关键帧 t, 0.1)
  objects: [{
    id, name, visible, locked, opacity, mixMode, kind, anchor,
    parentId,        // v5：父子链
    time,            // v5：时间通道 { offset, scale, mode, from, to, hold, holdAt }
    transform: { keys: [{ t, state, ease, h1, h2 }] },   // 连续时间轨道
    effects: [],
    cels: [{ at, image }],          // ← 按 at 升序，至少一条
  }],
  timebase,          // v4：分段帧率（只影响「导出取哪些采样点」，不影响画格归属）
  onion, tags,
}
```

### 1.1 画格的读取规则（唯一权威）

```
celAt(obj, t) = at <= t 的最后一个画格；没有则 null
imageAt(obj, t) = celAt 的 image（空画格给 null）
```

即：**画格开启后一直生效，直到下一个画格接替它。** 没有「帧」来切断它，
所以两个画格之间隔 3 秒也合法，隔 1/240 秒也合法。

### 1.2 写画格

```
ensureCelAt(obj, t)   // 该时刻有画格就复用；没有就新建（默认继承上一张图）
setImageAt(obj, t, img)  // 写入位图（不继承）
removeCelAt(obj, t)   // 删除；最后一个画格不允许删
moveCel(obj, from, to)   // 把画格整体挪到别的时间
```

落笔时**不再有「当前帧的 cel」**，只有「当前时间的画格」：
`ensureCelAt(obj, ctx.time())` 取到的就是可写的那一格。

---

## 2. 公共 API（`app/core/doc-model.mjs`，已实现并 36 例全绿）

```
normAt(t)                       秒 → 合法非负数
makeObject(o)                   造对象（无 cels 时自动补 at=0 的空画格）
normCel(c)                      归一画格记录，at 非法返回 null
createDoc(o) / createDocument   造文档（别名），无 frames 字段
objectsOf(doc)                  objects 或 layers 都认
objectById(doc, id)
celTimes(obj)                   所有画格时间点（升序去重）
celIndexAt(obj, t)              二分定位，越界 -1
celAt(obj, t) / imageAt(obj, t)
hasCelAt(obj, t) / isCelBoundary(obj, t)
ensureCelAt(obj, t, {inherit})  → { obj, cel, created }
setImageAt(obj, t, image)
removeCelAt(obj, t) / moveCel(obj, from, to)
contentDuration(doc) / docDuration(doc) / totalSeconds(doc)
patchObject(doc, id, fn)        不可变更新单个对象
addObject / removeObject / reorderObject
migrateFromFrames(old)          v3/v4 → v6
eventTimes(doc)                 画格点 + 关键帧，升序
sampleTimes(doc, step)          等间隔采样
stateOf(obj, t) / emptyTrack() / makeKey(...)
```

**所有权约定**：这些都是纯函数，不改入参；脏输入返回安全值不抛异常。

---

## 3. 下游改造清单

### 3.1 `app/core/cel.mjs`（要瘦身）

保留：`createDocument`（转发 doc-model）、洋葱皮配置归一、`compositeFrame` 的**签名**
（内部改走 doc-model）。
删除：`frameStart` / `frameSeconds` / `frameCount` / `syncCels` / `makeCel` /
`resolveCelImage` / `isHolding` / `setCelHold` / `materializeCel` / `linkCels` /
`unlinkCel` / `cloneFrame` / `sampleFrame`（帧概念整体消失）。
时长一律 `totalSeconds(doc) = docDuration(doc)`。

### 3.2 `app/paint/*`

- `composite.mjs`：按 `imageAt(obj, t)` 取图；`drawLayer` 的 `frameIndex` 参数删除，只留 `t`。
- `engine.mjs`：落笔用 `ensureCelAt(obj, t)`；`getFrame()` 换成 `getTime()`。
- `onion.mjs`：洋葱皮改为「上一个/下一个**画格切换点**的前后 N 个画格」。
- `thumb.mjs`：缩略图取 `imageAt(obj, t)`。
- `ops.mjs`：清空/取色按 `imageAt`。

### 3.3 `app/editors/timeline.mjs`（重写）

行 = 对象。每行画：
- **画格点**：小方块，x = `timeToX(cel.at)`，可拖（改 `at`）、双击删、右键菜单。
- **关键帧菱形**：x = `timeToX(key.t)`，v5 已有的交互保留。
- **播放头**：一条竖线。
- 不再有帧块、帧号列、帧倍率、`+加帧/复帧/链接`。

### 3.4 `app/shell/app.mjs`

删除：`addFrame` / `deleteFrame` / `cloneFrame` / `linkFrameCel` / `unlinkFrameCel` /
`setHoldAt` / `setFrameDurationAt` / `frameIndex` / `setFrame` / `nextFrame` / `prevFrame`。
新增：`celTimesOf(objId)` / `addCelAt(t)` / `removeCelAt(t)` / `moveCelAt(from,to)` /
`goprevCel` / `goNextCel`（跳到上一个/下一个画格点）。
`clampSelection` 只夹时间到 `[0, docDuration(doc)]`。

### 3.5 `app/shell/project-store.mjs`

格式 `version: 4`：对象里写 `cels: [{at, image}]`（位图仍走 `assets` 去重），
删 `frames` 段。读 v2/v3 时调 `migrateFromFrames`。

---

## 4. 验收

1. `node --test tests/*.test.mjs` 全绿（含重写后的 cel/timeline/paint 测试）。
2. 新建文档 → 在 0 秒画一笔 → 在 2 秒画另一笔 → 1 秒处显示第一笔、2.5 秒处显示第二笔。
3. 时间轴上看到 2 个画格点，拖动其中一个改时间，画面立即跟着变。
4. 保存 → 读回 → 画格时间点与位图逐点一致；旧 `.msp`（v2/v3）打开后自动迁移成秒。
5. 导出 PNG 序列：采样点由 `sampleTimes` 决定，不再有「帧序号」。
6. 冷启动 `hostCount === 1`、`window.motionStudio` 无 `frame` 相关键残留。

---

## 5. 踩坑约束

- **不要在 `doc-model.mjs` 里 import `cel.mjs`**（循环依赖）；需要时长就用 `docDuration`。
- 位图对象**不要深拷贝**：同一张图被多个画格引用是常态（继承语义），拷贝会爆内存。
- `at` 一律用秒、浮点比较容差 `1e-9`；不要用「帧号 × fps」反推。
- 迁移时**不要给每一帧都建画格**：只给「有图变化」的时间点建（否则文件爆炸）。
- 时间轴改造后 `LS_VER` 要再 +1，否则旧 localStorage 里存着帧块布局。
