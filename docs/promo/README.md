# MotionStudio 宣传片

- `motionstudio-promo.webm` —— 27.4s / 1384×840 / VP9，**顺序播放正常**；MediaRecorder 输出没有 Cues 索引，拖进度条会回开头。
- `poster.png` —— 封面（标题场景，t≈2.4s 的 `draw()` 输出）。
- `index.html` —— 本地播放页（`<video>` + 分镜说明 + 重新生成方法）。
- 素材与源码：`app/promo/promo.js`（确定性渲染 `draw(g,t,w,h)` + `record()` + `encodeWebM()`）、`app/promo/img/*.png`（取自真机截图）。

## 重新生成

应用窗口必须可见。截图/录制的经验教训：

1. `MediaRecorder` + `canvas.captureStream(fps)`：依赖实时合成，窗口 hidden 时只出首帧（曾录出 11MB 却全片静止）。
2. `Page.bringToFront` 在最小化时不生效；用 user32 的 `ShowWindowAsync(handle, 9)` 恢复窗口后才 `document.hidden === false`。
3. 另一条路是 WebCodecs `VideoEncoder`（`vp09.00.10.08`）+ 自写 EBML/WebM 封装：与可见性无关、3.6s 编完 822 帧，但没有 Cues，同样不可随意 seek。

## 分镜

| 时间 | 场景 |
| --- | --- |
| 0.0–3.4 | 标题：时间驱动，没有「帧」 |
| 3.4–7.0 | 编排：一个工作区只做一件事 |
| 7.0–10.6 | 纹理属于关键帧（key.drawing / 空白 / 沿用） |
| 10.6–14.2 | 画板只编辑一张纹理，自带画布与相机 |
| 14.2–17.8 | 笔刷：晕染 + 离散点 |
| 17.8–21.2 | 工具条一行：笔刷/色块/大小/透明/取色/镜像/撤销 |
| 21.2–24.2 | PSD 导入、WebM/精灵图/PNG 序列、项目存档 |
| 24.2–27.4 | 结尾：仓库地址 |
