# MotionStudio

一个本机运行的 2D 动画编辑器：**时间驱动**（没有「帧」这个概念，只有秒与关键帧）、**画板与编排分离**（画板只编辑一张「纹理」）、关键帧可以直接携带纹理、曲线可编辑缓动、支持 PSD 导入与 WebM / 精灵图导出。

基于 Electron + 原生 ES Module，无构建步骤、无第三方运行时依赖。

## 三个工作区

| 工作区 | 用途 | 组成 |
| --- | --- | --- |
| 编排 | 排时间、看合成结果 | 对象树 / 舞台 / 属性 / 时间轴 / 曲线 |
| 画板 | **只编辑当前这一张纹理** | 自带画布与相机、笔刷、大小、不透明度、取色、镜像、撤销 |
| 设置 | 与「画」无关的配置 | 文档 / 洋葱皮 / 偏好 / 信息 / 帮助 |

画板是独立的 canvas 和相机，不与舞台共享——这正是「笔不落在别处」的前提。

## 核心概念

- **纹理（texture）**：对象的图。一个对象有一库纹理，可被多个时刻复用。
- **关键帧（key）**：`{ t, state, ease, h1, h2, drawing }`。`drawing` 就是「这一帧起显示哪张纹理」；`drawing: null` 表示显式空白，没有该字段表示沿用上一张。
- **曲线**：每条通道（位置 / 缩放 / 旋转 / 斜切 / 不透明度 / 网格顶点）独立可编辑缓动；纵轴按通道语义给范围（旋转 ±180°、不透明度 0–1、位置 0–画布边长）。

## 运行

```powershell
cd E:\dev\motionstudio
npx electron .          # 或使用已打包的 MotionStudio.exe
```

开发时 Electron 会起一个本机静态服务（默认端口 43117），改完源码按 `F5` / `Ctrl+R` 重载即可。

## 测试

```powershell
npm test                # node --test tests/*.test.mjs
```

当前基线：**605 tests / 603 pass / 0 fail / 2 skipped**。

## 目录

```
app/
  core/     纯逻辑：doc-model（文档与关键帧）、transform、evaluator、timegraph、timebase、lattice、element、psd
  paint/    绘制管线：engine（舞台）、composite、brush（笔刷与笔尖）、surface、effects、patch（撤销区域）
  editors/  面板：canvas / board（纹理编辑器）/ layers / timeline / curve / palette / properties / …
  shell/    外壳：app（装配）、view-host（区域树与布局）、doc-state（文档与时间）、project-io（导入导出）
  styles/   设计令牌与样式
docs/       契约（CONTRACT-v*.md）、修复列表、使用说明
tests/      node:test 单元测试
```

## 文档

- [`docs/使用说明.md`](docs/使用说明.md) —— 怎么用（概念、快捷键、画板、时间轴、导出）
- [`docs/CONTRACT-v8-分区与时间轴.md`](docs/CONTRACT-v8-分区与时间轴.md) —— 分区、画板控件、纹理与关键帧的契约
- [`docs/CONTRACT-v6-时间模型.md`](docs/CONTRACT-v6-时间模型.md) —— 「没有帧，只有时间」的数据模型
- [`docs/修复列表-v8.md`](docs/修复列表-v8.md) —— 逐条问题的根因、修法与真机验证
- [`docs/UI-重构计划-v8.md`](docs/UI-重构计划-v8.md) —— 控件瘦身与 Klecks 笔刷移植计划

## 状态

早期开发中，接口与文件格式仍会变动。当前重点：曲线区的可用性、纹理库的多选与拖放、PSB / 更多纹理格式。
