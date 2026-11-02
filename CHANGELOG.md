## v0.6.0 — 2026-11-03 · 拆仓：核仓独立，桌面壳迁往 motionstudio-desktop

单仓时代结束。本仓从此只放**核**：渲染层（`app/`，静态站点根）、测试、文档、质量门；Electron 桌面壳（`main.js` / `preload.js` / IPC / 打包）迁到新仓 [`motionstudio-desktop`](https://github.com/Satyr-Astry/motionstudio-desktop)，它把本仓以 **git submodule** 挂在 `core/`。两半之间的缝仍然只有一条：`app/shell/ipc.mjs` 的 `bridge()` 读 `window.motionAPI`，通道契约由壳仓的 `test/channels.test.mjs` 与核仓的 `tests/ipc-contract.test.mjs` 各守一半。

### 本仓删了什么

- `main.js`（422 行）、`preload.js`（40 行）—— 桌面入口与桥暴露面；
- `tools-pack.mjs` —— 手写打包脚本（electron-builder 的 NSIS / dir 目标已覆盖，且它对 submodule 的 `.git` 文件没有过滤）；
- `tools-split.mjs` + `tests/split-plan.test.mjs` —— 一次性迁移工具与它的测试（本仓已不需要）；
- `tools-shell-channels.tpl.mjs` —— 壳仓 `test/channels.test.mjs` 的模板（已落地到壳仓）。

### 本仓改了什么

- `package.json`：删 `main` / `build` / `start` / `dist` / `dist:dir` / `split` 脚本与 `electron-builder` 依赖；`electron` 保留**只为** `npm run smoke`（唯一能抓「测试全绿 + 面板白屏」的闸）；`check` 仍是五道门；`serve` 成为运行入口；版本升到 `0.6.0`。
- `_check-syntax.mjs` / `_check-docs.mjs` 的 `ROOT_TOOLS` 从 6 个收到 **4 个**（`tools-serve.mjs` / `tools-smoke.cjs` / `_check-layers.mjs` / `_check-docs.mjs`），语法检查因此从 111 变为 **109/109**。
- 新增 `.gitattributes`（`* text=auto eol=lf`），与壳仓同一套行尾规则。
- README 两版：运行方式改为「本仓跑 `npm run serve`（网页）／桌面版去壳仓 `clone --recursive`」；目录结构删掉壳文件；「Repository split」从计划改成既成事实；基线数字按拆后实测更新。
- 桌面壳的 `main.js` 不是删掉，而是**搬走并改一行**：`APP_DIR` 由 `__dirname/app` 改为 `__dirname/core/app`（核仓的站点根自带一层 `app/`）；壳仓的打包 `files` 指向 `core/app/**/*` 并排除 `!core/.git`。

### 验证

本仓：`npm test` **1684 / 1677 pass / 7 skipped / 0 fail**（120 个测试文件；拆走 `tests/split-plan.test.mjs` 的 5 条）；`npm run check` 五道门全绿（静态 105 模块 0/0/0 · 语法 109/109 · 分层 0 违规 · 文档基线一致 · 本地化 129 条待迁、缺口 0）；`npm run smoke` 15/15 编辑器、`PROBLEMS []`。

壳仓：`npm run check:syntax` 通过；`npm test` 通道契约 **6/6**；Electron 探针确认窗口从 `core/app/index.html` 起、`window.motionAPI` 是对象且八个方法齐全（`exportFrames`…`openFolder`）、7 个 canvas、11 个顶栏按钮；`npm run dist:dir` 打包后 `app.asar` 共 130 项，含 `core/app/index.html` 与 `core/app/shell/app.mjs`（`core/app` 下 125 个文件），**不含** `core/.git` / `core/tests` / `core/docs` / `core/_check-*`；`dist/win-unpacked/MotionStudio.exe` 启动后保持运行、可正常关窗。

### 需要知道的

- 老的单仓 clone 仍可当**核**用（`npm run serve`），但不再有桌面壳；桌面版请重新 `git clone --recursive` 壳仓。
- 本仓版本号从此是**唯一产品版本号**；壳仓默认同版本，壳单独修 bug 用 `<核版本>.<壳修订>`（见壳仓 README §版本号规则）。
- `.msp` 存档格式**不变**（仍是 v4）：拆仓只动代码组织，不动数据。


项目库 P2 的最后一块。以前只有「当前存档」一个状态：改坏了、误覆盖了，除了「另存为」分叉没有别的退路。这一版让**每次保存都留一份快照**（最近 10 份），项目面板能列出并恢复到任意一份，而且**恢复本身可逆**——恢复前会先把当前状态也存成一份历史。

### 快照从哪来（store）

- IndexedDB 从 v1 升到 **v2**，新增 `versions` store（`keyPath: 'id'` + 非唯一索引 `projectId`）；升级是**幂等**的（新库直建 / 老库升级 / 重复触发都能过），并加了 `onversionchange` 自动关闭，避免旧窗口把升级卡在 `onblocked`（那会让新窗口悄悄落回内存空库）。
- `pushVersion(rec)`：把 `{id, projectId, name, savedAt, at, bytes, sig, project}` 写入；`sig` 是项目 JSON（`savedAt` 归零后）的 **FNV-1a 指纹**——与最新快照指纹相同就不入库，所以自动保存不会每拍刷一条；入库后按 `at` 只保留 **最近 10 条**。
- `listVersions(projectId)`（轻量 meta、按时间倒序）/ `getVersion(vid)` / `deleteVersion(vid)`；node 无 IndexedDB 时走内存兜底（测试依赖它）。
- **删项目时把它的历史一起删**：否则每个删掉的项目会留下最多 10 份完整位图 JSON 的孤儿行。

### 怎么用（io + panel）

- `saveProject` / `autoSaveProject` 落库成功后**静默**留快照（失败只 `console.error`，不能因为「历史没留上」把保存判失败）。
- 卡片动作新增 **History**（时钟图标）：`openHistory(projectId)` 用外壳现有的 `askChoice` 列出版本（「{时间} · {体积}」），选中后二次确认「恢复到这个版本？当前状态会先存为一条历史」。
- `restoreVersion`：**当前项目** → 先把内存里的真实状态存一份历史 → `jsonToDoc` → `applyDoc` 整份换文档（撤销栈清空、保存时间跟着快照走）；**别的项目** → 只更新库记录、不切当前文档（同样先留一份当前内容）。恢复后卡片 meta 的尺寸/对象数/纹理时间点数/体积**跟着快照重算**，不会出现「恢复成 40×30，卡片还写着 64×64」。
- 卡片动作区改为 5 个等分图标按钮（重命名 / 复制 / 历史 / 另存为 / 删除）：258px 卡片一行放下、无横向溢出，`title`/`aria-label` 保留全名。

### 验证

`npm test` **1689 / 1687 pass / 2 skipped / 0 fail**（121 个测试文件；+13 条新断言）；`npm run check` 五道门全绿（静态 105 模块 0/0/0 · 语法 111/111 · 分层 0 违规 · 文档基线一致 · 本地化 129 条待迁未增加、词典 1457/1457 镜面）；`npm run smoke` 15/15 编辑器、`PROBLEMS []`。另做了一次性 Electron 探针（仓库外，已删）：真实 IndexedDB **v1→v2 升级**后老项目存活、`versions` store 与 `projectId` 索引就位；「保存 → 改 → 再保存」历史 2 条、内容不变时去重不新增；恢复旧快照后记录宽度回到 40 且恢复前状态已入历史；258px 卡片 5 个图标一行 22px、无溢出。

### 需要知道的

- 版本历史是**项目库内**能力：`.msp` 文件本身仍是单份（文件的历史 = 用户自己的备份/版本管理）；「另存为」与整库备份里也**不含**历史快照。
- 快照占空间：单份快照是完整项目 JSON（含位图 dataURL），最多 10 份/项目。大项目库会明显变大 —— 这是「能回到过去」的直接代价，先按 10 份封顶。
- 不做「版本对比 / 命名版本 / 手动删除单条历史」：先看真实使用频率再排。


alpha.44/45 把项目库的「不丢数据」和「该有的动作」补齐了，但库一大就变成一摊按保存时间倒序的卡片。这一版给它加上**组织能力**：能排、能置顶、能打标签、能看见库有多大，并在「同一个 `.msp` 被两个项目抢着绑定」时把话说清。

### 排序（4 档，记住选择）

- 项目库工具栏新增排序下拉：**最近保存 / 最近打开 / 名称 / 大小**；选择存 `localStorage['ms.projects.sort']`（读写都 `try/catch`，隐私模式退回默认值，不白屏）。
- `store.sortProjects(rows, mode)` 纯函数：无效 mode 退回 `saved`；**置顶永远一级键**；组内 saved/opened 时间倒序、name `localeCompare`、size 字节倒序；同值用原始下标兜底稳定；不改入参。
- 面板侧 `api.sortRows` 不可用或抛错时退回本地 `fallbackSortRows`，排序永不失效。

### 收藏置顶（star）

- 卡片右上角星标按钮：`aria-pressed` + 「置顶/取消置顶」词条；`api.setPinned(id, pinned)` → `store.updateProjectMeta`（只允许改 `pinned`/`tags` 两个字段的白名单写口）。
- 置顶卡片永远排在最前；星标用新增的 `star` 图标（CSS 选中态填实）。`pinned` 只认布尔 `true`（`1`/`'true'` 不算），面板与 store 同口径，避免「看起来置顶却没排最前」。

### 标签（chips + 筛选 + 编辑）

- 记录新增 `tags: string[]`：`normalizeTags` 负责 trim、去空、去重、最多 8 个、每个最多 24 字符（超长截断而不是丢弃）。
- 卡片名字下方显示标签 chips（最多 3 个 + `+N`），末尾常驻 `+` 打开外壳的内联输入框（逗号/中文逗号/顿号/分号都可分隔；**空串 = 清空标签**，与「取消」可分辨）。
- 点任意 chip = 按该标签筛选；工具栏另有「标签筛选」下拉（首项「全部标签」，无标签时整条隐藏）；筛选激活时计数改用「匹配 M / N」。

### 库容量与「同一文件绑定冲突」

- 计数行追加 **合计 X**（`store.libraryTotals(rows)` 的 `bytes` 求和，坏记录按 0）；搜索/标签筛选时体积口径仍是整库。
- **同一 `.msp` 被两个项目绑定**时不再静默抢：`writeProjectFile`（另存为/存文件）成功写盘后若发现该文件已绑在别的记录上，弹二选一「转移给当前项目 / 取消」——
  - 转移：清空其它记录的 `file`（若冲突方正是当前打开项目，连内存 `project.file` 一起清）、本记录绑定新文件；
  - 取消：**不回滚已经写出的文件**，绑定保持原样，error 档说明「文件已写出，但绑定未转移」。
- `loadProject` / `importProjectFile` 打开一个已被别人绑定的文件时**静默转移**绑定并 flash 说明，不再留两个记录指向同一个文件。

### 验证

`npm test` **1676 / 1674 pass / 2 skipped / 0 fail**（121 个测试文件；+25 条新断言）；`npm run check` 五道门全绿（静态 105 模块 0/0/0 · 语法 111/111 · 分层 0 违规 · 文档基线一致 · 本地化 129 条待迁未增加、词典 1442/1442 镜面）；`npm run smoke` 15/15 编辑器、`PROBLEMS []`。另做了一次性 Electron 集成探针（临时脚本已删）：4 条带 pinned/tags 的记录 → 置顶在最前且星填实、chips `3 + +N`、计数「All 4 projects · Total 2 KB」、标签筛选「Matched 2 / 4」、排序选 Size 后 `localStorage['ms.projects.sort']='size'`、`+` 打开输入框改标签即时生效、844px 窄窗无横向溢出，console errors 0。

### 需要知道的

- 「分组」没有做成树，而是用**标签**承担（自由标签 + 筛选）；真正的分组树/收藏夹若以后要做，会与标签语义重叠，先看真实使用反馈。
- **版本历史还没做**（下一步唯一剩下的 P2 项）：会在保存时留最近 N 个快照并可恢复。
- `pinned`/`tags` 是老记录缺省安全字段（缺了按 `false`/`[]` 处理），不升 `.msp` 存档版本。


alpha.44 把「库 + 文件两者并存」的**地基**打好了（Ctrl+S 会回写已绑定的 `.msp`），但用户手里能用的动作仍只有「打开 / 新建 / 重命名 / 另存为 / 删除」。这一版补上 P1 该有的四件事，并顺手把「这个项目上次是什么时候打开的、绑的是哪个文件」摆到卡片上。

### 库里能复制一份了（`duplicate`）

- 卡片动作新增 **Duplicate**（`CARD_ACTIONS`：rename / duplicate / export / delete）：`projectApi.duplicate(id)` → `store.duplicateProject`，副本拿到**新 id、新名字**（`{name} copy` / `{name} 副本`）、`savedAt`/`openedAt` 刷新，`thumb` 与项目内容原样复用。
- **副本不继承 `.msp` 绑定**：否则在副本里按 `Ctrl+S` 会把副本内容写回**原项目的文件**（与 alpha.44 修的「跨卡片另存为改绑定」是同一类坑）。
- 以前想分叉只能「存为文件 → 再导回来」，每一步都要面对磁盘对话框。

### 卡片 meta：「最近打开」与「绑定文件」

- 记录新增 `openedAt`（与 `savedAt` 分开）：`loadProject` / `importProjectFile` / `restoreLastProject` 经 `touchOpenedAt` 写回库，**保存不会刷新它** —— 否则「最近打开」排序其实变成「最近保存」。
- 卡片第二行现在显示：纹理时间点数 · 尺寸 · 对象数 · 体积 · **Opened**（最近打开） · **File**（只放文件名尾巴，完整路径进卡片 `title`）；老记录没有 `openedAt` 时整项省略，不显示 `—` 或 0。
- `.prj-sub` 允许两行截断，meta 变长不会撑破 258px 卡片。

### 整库备份与恢复（不再是「清站点数据 = 全丢」）

- 菜单新增 **Export the whole library…** → `projectApi.exportLibrary()`：逐条读完整记录 → `store.libraryBundleOf` 打包成 `{format:'motionstudio-library', version:1, exportedAt, app, projects:[完整项目节点]}` → 走既有 `saveBinaryChecked` 落盘（浏览器桥自动改为下载）。
- 恢复用**同一个入口**：`importProjectFile` 解析后先认 `isLibraryPayload`，逐条 `jsonToDoc` 校验入库，报「成功 N / 失败 M」，**不切换当前文档、不动撤销栈**（恢复备份不是打开项目，用户可能正画到一半）。单个 `.msp` 导入行为一字未改。
- 空库、序列化失败、取消、无桥都有各自可分辨的提示；备份包与单个项目文件同为 `.json`，靠 `format` 区分。

### 解除文件绑定（`unbindFile`）

- 菜单新增条件项 **Unbind file…**：**只有当前项目绑定了 `.msp` 时才出现**（`menuItemsFor(file)` 纯函数；`reload()` 缓存 `api.current().file`，变了才重建菜单，且不抢搜索框焦点）。
- 二次确认写明「文件本身不会被删除」；解除后 `project.file` 与库记录的 `file` 一起清空，`Ctrl+S` 回到「只写项目库」。以前打开过一次文件就会把之后每次保存都写回它，没有任何撤回入口。

### 顺手收口的可访问性

- 删除后焦点按下标接回「原位置剩下的那张卡」（列表重画后不掉回 `<body>`）；结果提示走 `.prj-hint` 的 `role=status` / `aria-live=polite` 播报。
- 8 秒撤销条仍是外壳 `holdUndoBar`，面板侧不重写（源码守卫钉住）。

### 验证

`npm test` **1651 / 1649 pass / 2 skipped / 0 fail**（121 个测试文件；+20 条新断言）；`npm run check` 五道门全绿（静态 105 模块 0/0/0 · 语法 111/111 · 分层 0 违规 · 文档基线一致 · 本地化 129 条待迁未增加、词典 1409/1409 镜面）；`npm run smoke` 15/15 编辑器、`PROBLEMS []`。另做了一次性 Electron DOM 探针（临时脚本在 `%TEMP%`，已删）：有绑定 → 菜单 7 项含 Unbind、复制分发 `duplicate:a` 且提示副本真名、整库导出提示带 N 与路径、解除后 `current().file` 清空且菜单回到 6 项、删除后焦点接回卡片，console 错误 0。

### 需要知道的

- 「图标名唯一」的守卫从**全局唯一**收窄为**同一表面内唯一**：菜单「导出整个库」与卡片「另存为」都用 `save`（都是「写到磁盘」，从不同时出现在视野里；现有图标集里没有第三个文件语义图标）。测试注释写明了理由。
- 备份包只备份**库记录**，不备份运行时偏好（语言、布局、导出预设）；恢复后的卡片没有缩略图（缩略图需要 DOM 现画，备份里不存）。
- 仍属 P2、未做：分组 / 标签 / 收藏 / 手动排序、版本历史、同一 `.msp` 被两个项目绑定时冲突选择。


这一版只做用户反馈的两件事，但两件都是「功能其实在、入口却丢了」的回归：

1. **「属性里的纹理管理有问题，不能选择当前纹理」** —— v10 把纹理库从对象面板搬到属性面板时，**行列表没跟着搬**，只剩缩略图 + 一句摘要 + 四个动作按钮。摘要说「当前第 3 张」，用户却没有任何地方能点第 1 张。
2. **「项目管理有重大缺陷」** —— `Ctrl+S` 只写 IndexedDB，从不写回已打开的 `.msp`。用户打开文件 → 改 → `Ctrl+S` → 看到「已保存」→ 关掉 → 磁盘上还是旧的。这是会直接丢成果的一条。

用户拍板：项目身份 = **两者并存**（库=草稿箱、文件=正式交付），纹理管理 = **纹理抽屉**（完整列表）。两条都按拍板落地。

### 纹理抽屉（`0.5.0-alpha.44`）

- `app/editors/prop-textures.mjs` 摘要行下方新增可展开的 **Library** 列表（`+309/−18`）。
- 每行：32×32 缩略图 + 序号 + `W × H` + 引用信息（`@0.00s` / `@0.00s · 3 处` / `未使用`；完整时刻表在 `title`）+ 当前徽标；当前时刻生效那行高亮。
- **点一行 = 把这张纹理放到当前时刻**（`ctx.placeDrawing`，一次 `setDoc` = 一条撤销）；点当前那行是 no-op，不写空撤销。
- 行内删除**两步确认**（第一下变「确认？」，4 秒后自动收回），未使用纹理也能删；最后一张删不掉。
- 纯函数 `textureRows(obj, now)` / `textureRowRef(row)` / `formatTextureTime(sec)` 可 node 直测（25 条断言）；样式在 `app/styles/textures.css`（`.ptx-*`，限高 164px 滚动）；20 条词条 ×2 语言。
- 展开态在 `refresh()` 之间保持；无对象/无纹理时整块隐藏，空态仍由摘要句说明。

### 项目管理：两者并存 + 保存回写文件

- 新通道 `ms:save-project-to`（`main.js` 校验非空 + **绝对路径**后 `writeFileSync`，`preload.js` / `app/shell/ipc.mjs` 同步，头注释 7 → 8 通道；`bridge-web.mjs` 诚实回 `unsupported`）。
- `saveProject()`（`app/shell/project-io.mjs`）：库写成功后若 `project.file` 非空，用**与「存为文件」同一份** `projectFilePayload()` 序列化回写；三种结局可分辨 —— 只入库 / 入库+回写 / **库已保存但文件未更新**（error 档，明说原因）。`autoSaveProject()` 也走回写。
- 顶栏（`app/shell/chrome.mjs`）：有绑定时项目名后显示路径尾巴（完整路径在 `title`），项目 `title` 增加 file/noFile 句；「保存」按钮 title 随绑定状态切换（`shell.file.saveTitleFile` / `saveTitleLibrary`）。仍是 11 个按钮。
- 「另存为…」显式化：卡片 `export` 文案改为另存为，`…` 菜单新增 `saveAs`（写**当前文档**，不写库里的旧存档）。
- 项目面板底部常驻「项目库在 IndexedDB，清站点数据会丢，重要项目请另存为」提示（`projects.library.warning`）。
- 修 `metaLine` 的字段错配：`r.cels` → 记录真实字段 `r.frames`（`normRecord` 兼容老记录），卡片 meta 的「N 纹理」重新显示。
- **顺手堵住一条同源丢数据路径**：`writeProjectFile` 以前给**别的卡片**另存为时也无条件把 `project.file` 绑到那个文件，下一次 `Ctrl+S` 就覆盖别人的文件；现在只有写的就是当前项目才改绑定，当前文档另存为会同步库记录的 `file`。

### 验证

`npm test` **1631 / 1629 pass / 2 skipped / 0 fail**（121 个测试文件）；`npm run check` 五道门全绿（静态 105 模块 0/0/0 · 语法 111/111 · 分层 0 违规 · 文档基线一致 · 本地化 129 条缺口 0）；`npm run smoke` 15/15 编辑器、`PROBLEMS []`。另做了一次性 Electron DOM 探针（仓库外脚本，已删）：展开/高亮/点行切换 + `undo()` 一步回退、两步删除、`4.3s` 自动收回、切文档后开合态保持；顶栏绑定/解绑两种保存语义、面板常驻提示、菜单项顺序，console 错误 0。

### 需要知道的

- `dirty` 的语义定为「与项目库一致」：库写成功即清，回写失败只报警、不回滚 `dirty`（否则自动保存会每拍重试）。文件是否最新靠顶栏路径 + error flash 暴露。
- 卡片「另存为」写的是**库里那条存档**（当前项目有未保存改动时是旧内容），菜单「另存为」写**当前文档**；两种语义都写在 title 里，未加确认框。
- `beforeunload` 的自动保存是 fire-and-forget，回写可能来不及 —— 与库写同一限制，不是本批新引入的。


待修清单里 D7 记着一条：**锚点拖动的松手逻辑只有真机验证，没有单测**。这段逻辑不长，但三条规则每条都踩过坑：

- 按 `Esc` 取消时**不能写**文档（曾经写成「取消也提交」，用户按 Esc 反而改了锚点）；
- 整段拖动**只在松手时写一次**（撤销记录由 `setAnchor` 内部产生，这里再 push 一条就要按两下才退得回去）；
- 外壳没提供 `setAnchor` 时**既不能写、也不能提示「已取消」**（那会让用户以为操作被拒绝了）。

这一版把这段决策从 DOM 事件流里抽出来，变成纯函数 `core/gizmo.mjs` 的 `anchorDropAction({ hasPreview, canceled, canSetAnchor })`，返回 `'cancel' | 'commit' | 'none'`。

### 改了什么

- `core/gizmo.mjs` 新增 `anchorDropAction`（纯函数，不碰 DOM）；
- `canvas-input.mjs` 的锚点分支改为先算 `action` 再执行，三条分支各自只做一件事；
- 新增 `tests/anchor-drop.test.mjs` 6 条：Esc → cancel、有预览且有入口 → commit、没入口 → none、没预览 → none（即使 canceled）、坏输入不抛、以及**接线守卫**（`setAnchor` 在整个文件里只被调用一次，就在 commit 分支）。

### 验证

`npm test` **1609 / 1607 pass / 2 skipped / 0 fail**（121 个测试文件）；`npm run check` 五道门全绿（静态 105 模块 0/0/0 · 语法 111/111 · 分层 0 违规 · 文档基线一致 · 本地化 129 条缺口 0）；`npm run smoke` 15/15、0 条 console 错误。

### 需要知道的

- 这次只把**决策**抽出来测，DOM 事件接线（pointerdown/move/up 与节流）仍然没有自动化 —— 但「按 Esc 会不会误写」「会不会写两次」这两个最容易出事的判断现在有护栏了。
- 抽纯函数时顺手把历史写法固定住：guard 断言锚点分支里不会再出现「`if (!dragCanceled)` 里调 setAnchor」这种把取消写成提交的写法。
## v0.5.0-alpha.42 — 2026-11-02 · 删掉「可运行孤儿」，顺手修好对象命名

这一版做两件相关的事：**删掉一条从来没人调用的代码链**，并把它暴露出来的「对象缺省名」问题修掉。

### 删掉「画板 → 对象」提交链（约 200 行）

`app/core/board.mjs`（110 行）+ `app/shell/object-factory.mjs`（88 行）是 2026-10 就记在账本里的「可运行孤儿」：能跑通、有测试，但**生产代码零消费者**。

- `object-factory` 的 `createObjectFromBoard` / `createEmptyObject` / `attachImage` 从来没人调；
- 它唯一的活口是 `nextObjectName`（建骨骼命令用它起名），这个已经搬进 `core/doc-model.mjs`；
- `app/editors/board.mjs` 那个 1670 行的「画板」是**纹理像素编辑器**，跟这套名字相同的孤儿模块没有一行关系。

删完后：`app/core/board.mjs`、`app/shell/object-factory.mjs`、`tests/board.test.mjs` 一起消失，本地化待迁 **142 → 129 条**，`app/` 模块 107 → 105。

### 顺手修好的：对象缺省名有五个来源，彼此不一致

以前「新建对象叫什么」散在五处：

| 位置 | 名字 |
|---|---|
| `app.mjs` 新建文档 | `Object 1` |
| `doc-model.createDoc` 补对象 | `对象 1` |
| `cel.addLayer` 新建对象 | `对象 N` |
| `project-store.elementShell` 读入兜底 | `对象 N` |
| `object-factory.nextObjectName` | `对象 N` |

于是英文界面下会出现「文档里第一个对象叫 Object 1，再新建一个却叫 对象 2」。

现在只有**一处真源**：`core/doc-model.mjs` 的 `DEFAULT_OBJECT_NAME` / `defaultObjectName(n)` / `nextObjectName(doc)`。

- 统一为英文 `Object N` —— 它**是用户数据**（进层级面板、导出、`.msp`），不跟界面语言走，而缺省语言是 en，所以英文才自洽；
- `nextObjectName` 同时**避开老项目里的中文「对象 N」**，不会出现重名；
- 其它四处全部改为引用真源。

### 验证

`npm test` **1603 / 1601 pass / 2 skipped / 0 fail**（120 个测试文件）；`npm run check` 五道门全绿（静态 105 模块 0/0/0 · 语法 111/111 · 分层 0 违规 · 文档基线一致 · 本地化 129 条缺口 0）；`npm run smoke` 15/15、0 条 console 错误。

新增 `tests/object-naming.test.mjs` 7 条：缺省名与编号、跳过已占用编号、避开老项目的中文命名、`createDoc` 与 `addLayer` 走同一真源、**源码守卫「`'Object 1'` 只许出现在 doc-model」**、以及「两个孤儿模块确实没了」。

### 需要知道的

- 删掉的能力在 git 历史里（`7e0637d` 之前的提交），将来真要「画板提交成对象」时可以从历史里捞回来重做 —— 那需要补按钮、case 分支、ctx 装配，以及**现在完全不存在的 board 草稿状态容器**，本来也不是一行接线的事。
- 老项目里已有的「对象 N」名字**不会被改写**（那是用户数据），只是新建时不再产生中文名。
## v0.5.0-alpha.41 — 2026-11-02 · 画布上的提示不再说中文

`canvas-input.mjs` 是画布指针交互的主文件（命中、拖动生命周期、锚点拖动、网格软拖）。它的提示与撤销标签一直是**硬编码中文**：

- `notify('已取消')`、`notify('已移动旋转原点')`、`notify('已更新关键帧')`、`notify('已变形网格')`、`notify('这次拖动没有改变网格')`、`notify('格点变形：影响 N 个顶点')`
- 撤销栈里的 `label: '格点变形'` / `'变换'` —— 这些会显示在顶栏的撤销提示里，同样是用户可见文字

英文界面下这些会突然冒出中文 toast。这一版把它们全搬进新分片 `app/i18n/parts/canvas.mjs`（8 条 × 2 语言），并加测试保证**这个文件里再也不会出现中文字符串字面量**。

### 顺带的效果

本地化待迁从 **153 → 142 条**。剩下的主要是 `{ok:false, reason}` 诊断返回值与纯 core 编码器的 throw 文案（都是有意不迁的）。

### 第五道闸当场发挥作用

改完先跑全量测试，`_check-docs.mjs` 立刻红：新增 `canvas.mjs` 之后 `app/` 模块数 106 → 107、测试文件 119 → 120，而 README 还写着旧数字。这正是 `alpha.40` 那道闸的用途 —— 以前这种漂移只能靠人记得改。

两版 README 与使用说明的目录块已同步（107 模块 / 120 测试文件 / 113-113 语法）。

### 验证

`npm test` **1614 / 1612 pass / 2 skipped / 0 fail**（120 个测试文件）；`npm run check` 五道门全绿（静态 107 模块 0/0/0 · 语法 113/113 · 分层 0 违规 · 文档基线一致 · 本地化 142 条缺口 0）；`npm run smoke` 15/15、0 条 console 错误。

新增 `tests/i18n-parts-canvas.test.mjs` 6 条：两表镜面且键前缀统一、英文表无汉字、键真的并进运行期词典、**`canvas-input.mjs` 里零中文字符串字面量**、源码用到的键词典里都有、切语言后提示跟着变。

### 需要知道的

- 词条分片现在 11 个（`parts/index.mjs` 的 `PARTS` 顺序有意义的，合并时同键会抛错）。
- 撤销标签也进词条了：切语言后**历史撤销记录的标签不会回改**（它们已经写在那条记录里），这是预期的。
## v0.5.0-alpha.40 — 2026-11-02 · 让「手填的基线数字」不能再悄悄漂

这个仓库的账本、README、CHANGELOG 每一批都要手填一组数字：版本号、批次数、模块数、测试文件数、语法检查数。**填错不会红** —— 只会让下一个人读到过期基线。`docs/待修与优化清单` 曾长期写着「741 tests」，而实际已经 1599，就是这类欠账的样本。

这一版加第五道静态闸 `_check-docs.mjs`，把六处**静态可数**的数字钉住：

| 检查 | 口径 |
|---|---|
| 版本号 | `package.json` 的 `version` == `CHANGELOG.md` 第一条 `## v…` |
| 账本批次 | `docs/README.md` 的「N 个批次」 == 主账本里 `## 1xx.` 的节数 |
| 模块数 | 两版 README 的「106 个模块」 == `app/` 下真实 `.mjs`（跳过 `_` 开头，与 `_check-static` 同口径） |
| 测试文件数 | 两版 README == `tests/*.test.mjs` 的个数 |
| 语法检查数 | 两版 README 的「112/112」 == `app/` 模块数 + 根工具脚本数（与 `_check-syntax` 同口径） |

它**故意不跑测试**（那要几秒，会拖慢 `npm run check`），所以「测试条数」这一项仍然手填 —— 但至少「文件数」对不上时会当场红，而条数通常跟着文件数一起变。

### 它第一次跑就抓到了两处

1. `docs/README.md` 写「52 个批次」，主账本实际 **53 节**（`alpha.39` 新增的 §1bb 没同步）；
2. 我这一批新增 `tests/doc-gate.test.mjs` 之后，README 的「118 个测试文件」立刻过期 —— 闸门当场报 `实际 119`。

两处都已修正。这正是它存在的意义：**以前这类错误只能靠人记得**。

### 验证

`npm test` **1608 / 1606 pass / 2 skipped / 0 fail**（119 个测试文件）；`npm run check` **五道门**全绿（静态 106 模块 0/0/0 · 语法 112/112 · 分层 0 违规 · **文档基线一致** · 本地化 153 条缺口 0）；`npm run smoke` 15/15、0 条 console 错误。

新增 `tests/doc-gate.test.mjs` 9 条：全对齐时无问题、版本/模块/测试/语法/批次任一处漂移都会被抓、CHANGELOG 版本只认第一条、README 读数字段的正则在文案改动后仍能抽出、账本计数只数批次节、以及「真跑一次必须 exit 0」。

### 需要知道的

- **`ROOT_TOOLS` 有两份**（`_check-syntax.mjs` 与 `_check-docs.mjs`），加根工具脚本要同时改 —— 测试里有一条断言在盯着这件事，但它只能检查「清单里有谁」，不能自动同步两份。
- 测试**条数**仍然手填：它要跑完整个套件才知道。要让这条也自动，得把 `npm test` 的结果写进文件再校验，那会把闸门变慢，暂不做。
## v0.5.0-alpha.39 — 2026-11-02 · 导入的图也能用油漆桶了

这是待修清单里唯一「主流程工具撞上主流程素材」的功能洞：**导入的 PNG/PSD 纹理不能用油漆桶**。原因很具体 —— 导入链路产出的是 `ImageBitmap`，它没有 `getContext`，而画板其它工具都是「原地改画布」。

直接「复制成画布再画回去」也不行：**同一张位图可能被多个关键帧共享**，就地替换会把别处的画面一起改掉。

### 做法：复制 → 填充 → 写回关键帧

1. 按位图尺寸建一张离屏画布，把位图画进去；
2. 在画布上跑同一套 `floodFillRegion`（不是另写一份填充算法）；
3. 用新增的 `ctx.setCelImage()` 把结果**写回当前关键帧的 drawing** —— 它内部走 `setImageAt`，与「落笔克隆」是同一条真源路径：纹理库、渲染侧、存档三者看到的是同一张图。

所以：

- **一次 setDoc、一步撤销**（undo 标签「替换纹理图」），不会偷偷改共享位图；
- 写回之后这张纹理**变成普通画布纹理**，后续填充/画笔都是原生路径，不再走转换；
- 老外壳（没提供 `setCelImage`）仍退回原来的「暂不支持」提示，不会静默失败。

### 验证

`npm test` **1599 / 1597 pass / 2 skipped / 0 fail**（118 个测试文件）；`npm run check` 四道全绿；`npm run smoke` 15/15、0 条 console 错误。

新增 `tests/board-bitmap-fill.test.mjs` 4 条：bitmap 分支真的转过去了（且保留老外壳兜底）、离屏画布尺寸与「不另写填充算法」、`setCelImage` 走 `setImageAt` 且在两处 ctx 暴露、以及 `floodFillRegion` 对全透明位图的纯逻辑（8 像素全填 / 同色不重复改 / 越界不改）。

### 需要知道的

- **真机手测还没做**：node 里没有 canvas 与 `ImageBitmap`，自动化只能守到「接线正确 + 算法正确」。要确认像素行为，得在应用里导入一张 PNG 然后用油漆桶点一下。
- 转换发生在**第一次填充时**，不是导入时 —— 只导入不填的项目不会有额外开销。
## v0.5.0-alpha.38 — 2026-11-02 · 两个「不会红但会悄悄错」的地方

这一版处理的都是**不报错、不返红、只会错得很安静**的隐患，全部用源码守卫钉住。

### 播放刷新：新编辑器漏登记会当场红

`app/shell/refresh-plan.mjs` 决定播放时刷哪些面板，靠三张手写清单：时间档（`canvas` / `board` / `timeline` / `curve` / `properties`）、纹理粒度（`layers`）、其余算静止。

问题在「其余算静止」：**新加一个编辑器时，如果它其实读 `ctx.time()` 却没人登记，症状是「播放时这个面板不更新」** —— 不报错、不红，极难自查。

修法：把「静止」从**隐式**改成**显式**（新增 `STATIC_EDITORS`），并加一条测试断言「三档并集 == `registry.EDITORS`」。以后新增编辑器如果不归类，`npm test` 直接红。注册表从源码里抽 id（不 import，因为 registry 会把 15 个编辑器连同 DOM 一起拉起来）。

### 透明度阈值：两处语义相反，现在互相指认

- `core/element.mjs` 的 `hitTest`：**`alpha > threshold` 才算命中**；
- `paint/engine.mjs` 的 `pixelHex`：**`alpha < 阈值就返回 null`**（取色器语义）。

两处阈值都是 8，但**方向相反**，而且这是有意的：取色要能取到几乎透明的颜色，命中则不该被 1/255 的噪点抓住。以前只有一个测试文件记着这件事，代码里没有任何提示 —— 谁想「统一一下」就会踩雷。现在两边注释互相点名，并有测试断言「谁都不许把方向改掉」。

### 验证

`npm test` **1595 / 1593 pass / 2 skipped / 0 fail**（117 个测试文件）；`npm run check` 四道全绿；`npm run smoke` 15/15、0 条 console 错误。

新增 `tests/refresh-and-alpha.test.mjs` 3 条：静止档存在且覆盖 `help` / `projects` / `prefs` / `palette`、三档并集等于注册表、两处阈值互相指认且常量未被改动。

### 需要知道的

- `STATIC_EDITORS` 是**白名单式**的：以后新增编辑器，除了写 `registry.mjs`，还要在这三张表里挑一张 —— 会红一次，但那正是它存在的意义。
- 阈值语义仍然没有合并：合并会让「取色取不到浅色」或「命中被噪点抓住」二者之一发生。
## v0.5.0-alpha.37 — 2026-11-02 · 两条「小但一直被忍着」的欠账

这一版处理清单里两个**代价 S、却一直没人做**的条目，外加把那份清单自己校准了一遍 —— 它还挂着「741 tests / 45 个测试文件」的旧基线。

### 时间轴：`Shift + 滚轮` 横向滚动

以前时间轴只有 `Ctrl + 滚轮` 缩放。片子长于视口时，**缩放解决不了「往后翻」** —— 用户只能去拖总时长那种笨办法。

现在：

- `Shift + 滚轮` → 横向滚动（鼠标用户只有 `deltaY`，所以竖滚轮在 Shift 下也当横滚；触控板的 `deltaX` 优先）；
- 组合键**互斥**：Shift 优先于 Ctrl/Cmd，否则按住 Shift 再滚会变成缩放；
- 滚了内容区会**同步刻度尺**（`syncRulerScroll`），否则刻度与画面错位；
- 位置夹在 0 以上（`nextScrollLeft` 纯函数，可单测）。

帮助面板的「时间」组与使用说明都补了这条 —— 它没有按钮，用户不会「发现」它，只能靠文档或试。

### 超大图导入：不再静默跳过裁边

`IMAGE_TRIM_MAX_PIXELS = 4096×4096`：超过阈值时自动裁边会被跳过，而这件事**以前完全不说** —— 用户只看到「导入后四周空白特别多」，不知道为什么。现在导入小结会多一句「图太大，已跳过自动裁边（保留整张 W×H）」。

### 待修清单校准（`docs/待修与优化清单-2026-10.md`）

- 基线从 `741 tests / 45 文件 / 70 模块` 换成当前真值；
- A–D 四组逐条复核，新增「现状」列：**B3 / B4 / B5 / B6 / B7 / C4 / D2 / D4 已修或已消解**（每条都带证据），`A1 / A6 / D5` 标「未复核」而不是猜；
- 保留已消解条目（删掉等于让下一个人再怀疑一遍），并补了一节「本轮之外新增的两条」（`core → i18n` 是设计决定、拆仓技术障碍已清零）。

### 验证

`npm test` **1589 / 1587 pass / 2 skipped / 0 fail**（116 个测试文件）；`npm run check` 四道全绿；`npm run smoke` 15/15、0 条 console 错误。新增 `tests/timeline-wheel.test.mjs` 5 条（纯函数 + 源码守卫：组合键互斥、deltaX 优先、两处监听都在）。

## v0.5.0-alpha.36 — 2026-11-02 · 两骨链一步算准，肘部还能选边

`alpha.29` 的 IK 用 CCD 迭代逼近，两骨可达时误差 1e-3、而且**膝/肘会翻面**：目标拖过链的延长线，肘部就跳到另一侧。这一版把最常见的两骨情形换成**余弦定理解析解**，顺带给出「肘部朝向」选项。

### 两骨：解析解（精确 + 可控）

- `app/core/ik.mjs` 新增 `solveTwoBoneExact()`：用余弦定理直接算出两个关节的目标角度，**一步到位**，命中误差 1e-6 量级（迭代解只到 1e-3）。
- 依然只在**世界空间绕关节旋转**（`D = T(P)·R(δ)·T(−P)` 左乘），所以缩放、旋转、`skewX/skewY` 全都自然带上，不需要分解矩阵。
- 两种够不着都处理了：**太远 → 伸直**；**太近（< |L1−L2|）→ 折到最短可达**。都不抛错、不产 NaN，只是命中不了目标。
- 三骨及以上仍走 CCD —— 多骨没有唯一解，解析法无从下手。

### 肘部朝向：auto / 左 / 右

`ik` 字段多一个 `bend`：

- `auto`（缺省）：**保持当前那侧**（按「根→目标」与「根→中关节」的叉积符号），目标轻微移动不会让肘部突然翻面；
- `left` / `right`：强制把肘部放在对应一侧，两骨链会精确执行。

属性面板的 IK 组多了「肘部朝向」下拉。和链长一样，**没有目标时它也是灰的** —— 留一个能点但无效的控件比灰掉更让人困惑。

### 这不是极向量

极向量（pole vector）是「在三维里约束弯曲平面」的完整解法；2D 里没有平面，真正对应的是「肘部朝哪边」，所以这一版给的是 `bend`。它解决了「翻面」，但没有解决「肘部该偏多少」那种精细控制 —— 那需要单独一期。

### 验证

`npm test` **1584 / 1582 pass / 2 skipped / 0 fail**（115 个测试文件）；`npm run check` 四道全绿（静态 106 模块 0/0/0、语法 111/111、分层 0 违规、本地化 153 条缺口 0）；`npm run smoke` 15/15、0 条 console 错误。

新增 `tests/ik-two-bone.test.mjs` 6 条：解析解误差 < 1e-6、`left`/`right` 互为镜像且都命中目标、`auto` 在目标微小移动时不翻面、够不着时伸直（共线叉积 < 1）、太近时折叠不出 NaN、三骨链仍走 CCD。

### 需要知道的

- `.msp` 仍是 **v4**：`ik.bend` 是纯增量字段，旧版本读新文件会忽略它（回落到 `auto`）。
- 「肘部朝向」只对**两骨链**精确生效；三骨以上它只影响 CCD 的起步姿态，不保证最终朝向。
## v0.5.0-alpha.35 — 2026-11-02 · 分层第一次有了机器守卫

`CONTRACT.md` 早写了 `app/` 的分层（core / paint / editors / shell / i18n），但**没有一行代码检查它**。分层腐化不会红、不会崩：某天有人在 `core/` 里 `import` 了 DOM，「core 是纯逻辑、能被 Node 单测」这条前提就悄悄作废了 —— 而 `npm test` 依然全绿。

这一版加了第四道静态闸 `_check-layers.mjs`，并接进 `npm run check`。

### 规则（当前实测 0 违规）

| 导入方 | 允许 |
|---|---|
| `core/` | `core/`、`i18n/` + **一条白名单**（`evaluator → paint/effects`，纯滤镜函数，反过来会成环） |
| `paint/` | `core/`、`paint/`、`i18n/` |
| `i18n/` | 只有自己（叶子层） |
| `editors/` | `core/`、`paint/`、`editors/`、`i18n/` + 两条白名单（项目库读存档、偏好面板读 doc-state） |
| `shell/` | 全部（装配层） |

**为什么 `core → i18n` 是允许的**：`i18n` 是叶子层，只 import 自己的词条表；本地化 P2/P3 之后 `timegraph.describeTime`、`psd` 的错误串、`brush` 的笔名都在词条表里。硬要 core 不碰 i18n，只能把文案重新写死回 core —— 那是倒退。

### 白名单本身也被检查

如果某条白名单已经用不上（对应的 import 不在了），脚本会报「多余的白名单」并 exit 1。否则白名单只会越攒越多，最后没人知道它还挡着什么。当前三条白名单全部命中。

### 它抓得住什么

`tests/layer-gate.test.mjs`（8 条）用**合成边**做负对照：`core→shell`、`core→editors`、`paint→editors`、`i18n→core`、`editors→shell` 五类越界都会被判违规；`editors→shell` 只对白名单里的那两个文件放行，换个文件就红。另有一条「真跑一次必须 exit 0」与一条「core/paint 的日内边里不许出现指向上层的 import」。

### 数字变化

`npm run check` 从三道门变成四道；语法门新增 `_check-layers.mjs`（111/111：106 个 `app/` 模块 + 5 个根工具脚本）。

### 验证

`npm test` **1577 / 1575 pass / 2 skipped / 0 fail**（114 个测试文件）；`npm run check` 四道全绿（静态 106 模块 0/0/0、语法 111/111、分层 0 违规、本地化 153 条缺口 0）；`npm run smoke` 15/15、0 条 console 错误。

## v0.5.0-alpha.34 — 2026-11-02 · 应用内帮助讲清楚了骨骼与 IK

`alpha.20`–`alpha.30` 把骨骼、蒙皮、刷权重、IK 一路做完了，但**应用内的「帮助」面板一句都没提**：概念段只讲纹理 / 关键帧 / 时间通道。用户按 `?` 或开帮助面板，会以为这软件只有画与关键帧 —— 功能存在、入口在命令面板里，却没人告诉他。

这一版在帮助面板的「概念」段补了两行：

- **骨骼**：骨头是没有纹理的普通对象；用父子关系连成链，旋转父骨就甩动整条链 —— 这就是骨架动画；命令面板里可以新建骨骼。
- **IK（反向动力学）**：给链尾那根骨指定一个目标对象，链就会弯过去够它；解算只进渲染矩阵、不回写关键帧，所以**属性面板显示关键帧值、画布显示解算后的姿态**。

两行文案进了词条表（`help.concept.bone.*` / `help.concept.ik.*`），中英各一份；`tests/i18n-parts-help.test.mjs` 的域计数守卫从「概念 7 条」改成「11 条（5 行 × 名 + 说明）」，防止以后有人删空这一段。

### 验证

`npm test` **1569 / 1567 pass / 2 skipped / 0 fail**；静态检查 **106** 模块 0/0/0；语法 **110/110**；本地化 **153** 条待迁、缺口 0；`npm run smoke` 15/15 编辑器、0 条 console 错误（帮助面板在冒烟里会被挂载并切过一次）。

### 需要知道的

- 帮助面板里的**快捷键**分组没有新增条目：骨骼的三条命令（新建骨骼 / 绑定到选中骨骼 / 解除绑定）目前**没有快捷键**，只在命令面板里。给它们配键位要先决定键位表还剩哪些空位，那是另一件事。
- 这次只补了「概念」，没有补「图例」——骨骼在画布上的样子（实心根关节 + 末端小圆、选中高亮、IK 青色虚线）还没有图例说明。

## v0.5.0-alpha.33 — 2026-11-02 · 拆仓真的跑了一遍

`alpha.31` 把拆仓做成了工具，但**工具从没被完整跑过** —— 这种状态最危险：它看起来能用，真跑起来大概率在第三步红。这一版把 `--apply` 真正执行了一次，把踩到的三处问题修掉，结果是**两个仓都能独立跑通自己的质量门**。

### 实测结果（写到仓库外的临时目录，当前仓库一个字节没动）

| | 核仓（`app/` + `tests/` + 三道闸） | 壳仓（`main.js` + `preload.js`） |
|---|---|---|
| `npm test` | **1564 / 1558 pass / 0 fail / 6 skipped** | `test/channels.test.mjs` **3/3** |
| 静态检查 | 106 模块、残留 0、坏 import 0、未使用 import 0 | —（壳仓不该有这三道闸，跑了会崩） |
| 语法检查 | **108/108** | `node --check main.js preload.js` OK |
| 本地化 | 153 条、缺口 0 | — |
| 其它 | `tools-serve.mjs` 起服务 → `/` 200 `text/html`（浏览器模式在核仓里成立） | `main.js` 的 `APP_DIR` 已指向 `core/app` |

核仓那 6 条 skip = 4 条跨仓通道断言（缺壳自动降级）+ 2 条既有标记；**没有一条失败**。

### 跑出来的三个问题（都修了）

1. **`tests/ipc-contract.test.mjs` 有一条「必须是合仓形态」的断言**。它原本是「拆仓那天会红，提醒改契约测试」的哨兵 —— 但真跑起来它让核仓第一条测试就红。改成**两种形态都成立**：合仓跑三方交叉，核仓跑核侧快照；真正该钉的是「有降级分支」，不是「现在是不是合仓」。
2. **`tests/split-plan.test.mjs` 在核仓里 import 不到 `tools-split.mjs`**（迁移工具不进核仓）。工具新增 `PRUNE_IN_CORE`：搬运后把「测迁移工具本身」的测试删掉，并打印裁剪了什么。
3. **壳仓的跨仓通道测试一开始写错了**：它假设 preload 里 `ipcRenderer.invoke('ms:x')` 紧跟方法名，实际每个方法都带 payload 与 `Object.assign`。改成「通道集合与 main 的 handler 集合完全一致」+「核仓 `ipc.mjs` 调用的方法名 preload 都暴露了（`openInFolder` 作为老名字兜底豁免）」，并把模板提到 `tools-shell-channels.tpl.mjs`（进语法门，不再是一段内联字符串）。

### 验证

主仓读数不变：`npm test` **1569 / 1567 pass / 2 skipped / 0 fail**；静态检查 106 模块 0/0/0；语法 **110/110**（新增模板文件）；本地化 153 条缺口 0；冒烟 15/15、0 条 console 错误。

### 现在的状态

拆仓的**技术障碍已经清零**，剩下的全是需要人拍板的事（见 `docs/拆仓方案-2026-11-02.md` §9）：核仓要不要保留 `electron` 依赖、壳仓用新仓还是搬历史、`appId`/安装目录要不要改。验证用的临时产出已删除；要复现随时 `npm run split:apply`。

## v0.5.0-alpha.32 — 2026-11-02 · 使用说明追上了程序

`docs/使用说明.md` 停在几个月前：只写了 `.msp` **v2** 的文件格式、没有骨骼、没有蒙皮、没有 IK、导出还只有 PNG 序列与 WebM、测试数写着 381。程序已经走到 `alpha.31`，手册却让人以为这些东西不存在 —— 这比没写更糟。这一版是纯文档更新，不动一行代码。

### 补了什么

- **新章节「六、骨骼 · 蒙皮 · 权重 · IK」**：建骨 / 搭链 / 蒙皮（含「被蒙皮对象不许把父级指向骨骼」这条硬约束）/ 手动刷权重（每顶点 4 根骨）/ IK（目标是一个普通对象、只进渲染矩阵不回写关键帧、青色虚线、没有极向量）。后面的章节顺延为七、八、九。
- **`.msp` 格式块重写成 v4 真相**：`elements` + `drawings` 是纹理真源、`transform.keys[].drawing` 引用它、`cels` 只是投影缓存（手改不生效）、`effects` 有层内稳定 `id` 与按参数名挂的轨道、`skin` / `ik` / `bone` 都在里面、解算结果与译文都不进档。原文那份 v2 的 `frames:` 结构早就不存在了。
- **导出整段重写**：四档预设、格式 / 画质 / 引擎帧表三个控件、PNG 序列分片写盘、精灵图的三种帧表（含 Aseprite / Godot / Unity 认的 array 形式）、GIF 与 APNG（含 GIF 的三条格式限制）、WebM 的实时录制注意点，以及**浏览器模式也能导出**。
- **界面语言**：设置面板里切 English / 简体中文，立刻生效；`.msp` 里的内容与语言无关。
- **目录树重写**：补上 `i18n/`、`skin.mjs` / `weight-paint.mjs` / `ik.mjs` / `gif.mjs` / `apng.mjs`、`bridge-web.mjs`、三个根工具脚本与 `tools-split.mjs`，测试数改成当前真值。
- **已知限制补了 7 条**：IK 没有极向量、IK 不回写关键帧、蒙皮每顶点 4 根骨、骨骼不会被导出成引擎格式、GIF/APNG 的限制、界面尚未完全词条化（含 console 与纯 core 错误串为何仍是中文）、拆仓尚未执行（只备了工具）。顺手删掉一条已经过期的「效果轨道按 `fx<序号>` 命名」—— alpha.15 起是稳定 id `fx-1`。

### 验证

文档改动不影响代码。五道门复跑：`npm test` **1569 / 1567 pass / 2 skipped / 0 fail**；静态检查 **106** 模块 0/0/0；语法 **109/109**；本地化 153 条缺口 0；`npm run smoke` 15/15、0 条 console 错误。全仓 `*.md` 过一遍「无控制字符」检查。

## v0.5.0-alpha.31 — 2026-11-02 · 拆仓从「方案」变成「一条命令」

拆仓方案（`docs/拆仓方案-2026-11-02.md`）写了九步，但前四步全是**机械搬运**：建两个目录、把文件分到两边、生成两份 `package.json`、改 `main.js` 里那一行静态服务路径。手工做一次要二十分钟，做第二次一定会漏。

这一版把这几步做成 `tools-split.mjs`：**默认只预演，不改任何文件**；加 `--apply` 才真的写到一个新目录（不删当前仓库的任何东西）。

### 它做什么

- **核仓**（`<out>/motionstudio`）：`app/` `tests/` `docs/` 三道闸 `tools-*.mjs` `package-lock.json` 两版 README，以及一份**删掉全部桌面字段**的 `package.json` —— 没有 `main`、没有 `build`、没有 `dist`，`devDependencies` 只留 `electron`（唯一理由：`npm run smoke` 需要一个 Electron 二进制去开无 preload 的窗口）。
- **壳仓**（`<out>/motionstudio-desktop`）：`main.js` `preload.js` `tools-pack.mjs`，`package.json` 的 `files` 改成 `core/app/**/*` 并加 `!core/.git`（submodule 的 `.git` 是**文件**，会被 `copyDir` 当普通文件拷进安装目录），`postinstall` 拉 submodule，另生成一份跨仓通道测试骨架 `test/channels.test.mjs`。
- **`main.js`** 里指向 `app` 的静态服务路径改写为 `core/app`，找不到目标行时**原样返回并警告**（不猜、不改坏）。

### 为什么挂载点是 `core/` 而不是 `app/`

核仓的站点根就是它自己的 `app/`。如果把 submodule 挂到壳仓的 `app/`，入口会变成 `app/app/index.html`，而 `main.js` 期望 `__dirname/app/index.html` —— 静态服务直接 404 白屏。挂 `core/` 只需改 `main.js` 一行，代价最小。

### 它不做什么

**不碰 git**。`git init`、`git tag -split-baseline`、`git submodule add` 全部留给人工 —— 这些是有副作用的操作，值得看一眼再敲。脚本跑完会打印接下来的四步。

### 验证

`npm test` **1569 tests / 1567 pass / 2 skipped / 0 fail**（113 个测试文件）；静态检查 **106** 个模块、残留 0、坏 import 0、未使用 import 0；语法检查 **109/109**（`tools-split.mjs` 也进了语法门）；本地化 **153** 条待迁、缺口 0；`npm run smoke` 15/15 编辑器、0 条 console 错误。

### 用法

```
npm run split            # 预演：打印要搬什么、要改哪几份
npm run split:apply      # 真的写到 ../motionstudio-split/（目标目录已存在会拒绝，不覆盖）
```

## v0.5.0-alpha.30 — 2026-11-02 · 让 IK 看得见

上一版 IK 能用了，但**约束在数据里，画布上看不出来**：用户会看到骨头自己转，却不知道是哪个对象在拽它、这根骨属不属于某条链。这一版在画布上补了一层连线。

### 画布：链尾 → 目标，一条虚线 + 一个十字

- 选中「参与解算的骨」或「目标对象」时，从链尾骨骼的末端画一条**青色虚线**到目标对象的锚点，目标点再画**空心圆 + 十字**（只画圆的话，压在别的骨头上会被误认成末端关节）。
- 只在有选区且与这条链相关时出现，其余时候整层不画 —— 否则每根带 IK 的骨都在画布上拖一条虚线。
- 末端位置走 **`boneWorldMatrix(doc, el, t, sol)`**，与求值器、蒙皮同一张覆盖表。用 `elementWorldMatrix` 会画在**未解算**的位置上：骨头在 A 点、连线从 B 点出发 —— 这种错位肉眼一看就错，但改一行代码就会发生，所以这条用源码守卫钉住。
- 绘制顺序在权重层之后、`selectionInfo()` 判空之前（没选中任何对象时不该有连线）。

### 验证

`npm test` **1564 tests / 1562 pass / 2 skipped / 0 fail**（112 个测试文件）；静态检查 **106** 个模块、残留 0、坏 import 0、未使用 import 0；语法检查 **108/108**；本地化 **153** 条待迁、缺口 0；`npm run smoke` 15/15 编辑器、0 条 console 错误。

### 需要知道的

- 仍然**没有极向量**，也**没有在画布上直接拖目标**：拖目标对象本身即可（它就是普通对象）。要做「拖末端骨自动生成目标」那种交互，是另一期。
- IK 依然**不回写关键帧**：链上骨骼的旋转数值不会跟着解算结果变。面板显示关键帧值、画布显示解算姿态，这是设计。

## v0.5.0-alpha.29 — 2026-11-02 · IK 真的能用了

上一版（`alpha.28`）只有解算器和设计稿，界面上什么都看不见。这一版把它接进求值器与蒙皮，并在属性面板给了三行控件 —— **现在可以建一根链、拖目标对象让骨头弯，皮肤跟着弯。**

### 接缝：求值器与蒙皮读同一张表

- `app/core/evaluator.mjs` 的 `matrixOfChain(chain, t, sol)` 增加覆盖表参数：遍历到某根骨时，命中覆盖表就用表里的**绝对**世界矩阵替换累乘值。`worldMatrix` / `parentMatrix` / `evalLayer` 传同一张表。
- `app/core/skin.mjs` 的 `boneWorldMatrix(doc, el, t, sol)` 与 `boneMatrices(..., sol)` 同样查这张表；`applySkin` 内部调 `solveIk(doc, t)`。
- 两边拿到的是**同一个 Map**：`solveIk` 有单槽缓存（键 = doc 引用 + 时间），而 doc 是不可变更新，所以引用相等即可安全命中。**
  这条不变量用一条「求值器矩阵与蒙皮矩阵逐项相等（< 1e-9）」的测试钉住** —— 少传一个参数的表现是「骨架弯了、皮肤不弯」，不报错、不返红，只是画错。

### 面板：三行

属性面板的骨骼段多了「IK（反向动力学）」一组：

1. **启用 IK** 复选框；
2. **目标对象** 下拉（列出除自己以外的所有对象，另有一项「（无）」）；
3 . **参与解算的骨数**（1–8）。

没有目标时链长框是灰的 —— 留一个「能点但无效」的输入框比灰掉更让人困惑。约束挂在**链尾骨骼**上：`{ targetId, chain, iterations, enabled }`。

**目标点是一个普通对象**，所以它能用已有的变换通道打关键帧 —— 「让 IK 跟着动画走」不需要任何新的动画 UI，也不需要新的通道类型。

### 存档

`ik` 进两处白名单（写盘与读入各一次归一）与 `makeObject`（只挂不归一，与 `skin` 同一套「边界归一、构造器只搬运」的做法）。**`.msp` 仍是 `VERSION=4`**：纯增量字段，旧读入器的白名单会丢弃未知键，不需要迁移。解算结果一个字节都不进档（有测试：`JSON.stringify` 前后相等）。

### 验证

`npm test` **1559 tests / 1557 pass / 2 skipped / 0 fail**（111 个测试文件）；静态检查 **106** 个模块、残留 0、坏 import 0、未使用 import 0；语法检查 **108/108**；本地化 **153** 条待迁、缺口 0；`npm run smoke` 15/15 编辑器、0 条 console 错误。

### 需要知道的

- **没有极向量（pole vector）**。CCD 从当前姿态起步、每轮只转最小角度（`IK_MAX_STEP = 0.35` rad），所以「保持上一帧的姿态」天然抑制翻面；但如果你把目标拖过链的延长线，肘部仍可能翻到另一侧。要彻底解决需要单独一期做极向量约束。
- **面板显示的是关键帧值，画布显示的是解算后的姿态**。IK 只进渲染矩阵、不回写关键帧（设计如此：改写会污染撤销栈与存档），所以链上骨骼的旋转数值不会跟着变。想让某根骨既受 IK 又受关键帧，只能把「参与解算的骨数」缩短到那根骨之下。
- 目标对象同时**指向链上某根骨**时会被拒绝解算（否则每帧目标被自己推着跑，表现是抖动或发散）。这条在 `ikChains` 里做，不是靠 UI 拦。

## v0.5.0-alpha.28 — 2026-11-02 · IK 的解算器与它踩到的两个坑

这是骨骼线第三期（IK）的**第一步**：只交货「解算器 + 设计稿」，**没有任何消费者，界面上看不到变化**。所以这一版对用户是零变化，对人（下一个接手的人）是把最脏的那部分先做完并钉住。

### 解算器：CCD，只产出「覆盖表」

- 新增 `app/core/ik.mjs`（**约 330 行**，纯 core、零 DOM）。`solveIk(doc, t)` 返回 `Map<骨 id, 世界矩阵>`；求值器与蒙皮以后各自在遍历里查这张表，命中就用绝对矩阵、没命中才累乘。**永远不把解算结果写回 `transform.keys`** —— 那会污染撤销栈、落盘和 `sameObjectPixels`，用户会看到刚打的关键帧被算法悄悄改掉。
- 约束挂在**链尾骨骼**上：`{ targetId, chain, iterations, enabled }`。**目标点是另一个普通对象**，于是它天然可以打关键帧、可以被父链带动 —— 「IK 目标动画」不需要任何新通道类型。
- 选 CCD 而不是 FABRIK：FABRIK 在位置空间迭代，解完要把位置反解成旋转，而本项目 state 允许 `skewX/skewY` 与非等比缩放，反解不成立；解析法只对两骨、无 skew 成立。CCD 直接在**世界旋转**上迭代，只用矩阵乘与 `atan2`。

### 两个坑（都是测试逼出来的）

1. **单轮步长必须夹住**（`IK_MAX_STEP = 0.35` rad ≈ 20°）。不夹的话末端关节会「一步转到位」，把两骨链折回到根上：追一个比链长短的目标时，末端骨一次转 180°，末端正好落在父关节位置。此后父关节的「关节→末端」向量长度变成 0，**任何旋转都不改变末端位置**，迭代再多也出不来。测试里「两骨可达」那条用例不夹步长时偏差稳定在 100px。
2. **退化方向要有兜底**。即使夹了步长，仍可能撞上「末端与关节重合」的瞬间；原实现直接跳过，结果链卡在折叠姿态。改成用**骨骼自己的 +x 轴**（世界矩阵第一列）当参考方向，角度就仍有定义。

### 测试（12 条，全在用数值说话）

单骨 180°、两骨可达（< 1e-3）、不可达退化为伸直（末端到目标 = 600 − 240 = 360，且 y 落在同一条线上）、`chain` 超长截断到根、链只能由骨组成、目标在链内时拒绝解算（防每帧被自己推着跑）、`normalizeIk` 夹取与坏 `targetId` 作废、单槽缓存同帧复用同一张表、**解算不修改输入文档**（`JSON.stringify` 前后相等）、源码守卫（不 import evaluator/skin，防成环）。

### 验证

`npm test` **1544 tests / 1542 pass / 2 skipped / 0 fail**（109 个测试文件）；静态检查 **106** 个模块、残留 0、坏 import 0、未使用 import 0；语法检查 **108/108**；本地化 **153** 条待迁、缺口 0；`npm run smoke` 15/15 编辑器、0 条 console 错误。

### 需要知道的

- **这一版没有任何用户可见变化**：`ik` 字段还没进 `makeObject` 白名单与存档白名单，所以即使手写进 doc 也会在保存/读入时丢掉 —— 那是步 2 的事，写在设计稿 §9。
- 设计稿 `docs/IK设计-2026-11-02.md` 里 §3.1 记的就是上面两个坑，含「为什么解析解不会遇到这些问题」。

## v0.5.0-alpha.27 — 2026-11-02 · 动态图有了第二种格式

`0.5.0-alpha.26` 补了 GIF，但 GIF 的透明只有 1 位、只有 256 色 —— 半透明边缘会被切成硬边，渐变会出现色带。本版补上 **APNG**：全彩、真正的 8 位 alpha，代价是环境必须有 `CompressionStream`。

### APNG：全彩 + 8 位透明，零依赖自己拼

- 新增 `app/core/apng.mjs`（**322 行**，纯 core、不 import 任何模块）。手写 PNG 分块与 CRC32（多项式 `0xEDB88320`），自己拼 `IHDR` / `acTL` / `fcTL` / `IDAT` / `fdAT` / `IEND`。
- **压缩走 `CompressionStream('deflate-raw')` 拿裸 deflate，再自己补 zlib 头 `78 9C` 与 adler32 尾**（adler 算在未压缩数据上）—— 这样零依赖、也不需要自己写一个 deflate 实现。
- 三处最容易写错的地方都写进了注释：`fcTL` 与 `fdAT` **共用一个 sequence 计数器**（从 0 连续递增，`fdAT` 的数据前面多 4 字节 sequence）、`blend_op = 0`（SOURCE，直接覆盖；写成 OVER 会让半透明帧叠影）、`dispose_op = 1`（BACKGROUND）。
- 每帧独立压缩、各自一块 `IDAT`/`fdAT`，不拆块；每个扫描行前的 filter 字节统一写 `0`（None）—— **不做行过滤优化**，换实现简单与输出可预测。
- 环境没有 `CompressionStream` 时 `canEncodeApng()` 返回 false，导出路径会**明确告诉你改用 GIF 或 WebM**，不会写出半个文件。

### 解码器验过，不是「字节像」

- 测试里用 `node:zlib` 的 `inflateSync` 反向解压：4×3 纯红 + 4×3 纯蓝、`delayMs: 40`，文件 204 字节、7 个块的 CRC 全部与 `zlib.crc32` 独立核对、`sequence` 读出来是 `fcTL:0, fcTL:1, fdAT:2`、解压后每行 filter 字节 `0,0,0`、像素逐字节相等。
- **Pillow 12.3.0 真解码**：8×6 三帧红绿蓝 → `is_apng True, n_frames 3`，每帧 `duration 50.0ms`，逐帧像素正确，`loop 7` 也读得出来。
- `blend_op` 的行为级验证：帧1 不透明红 + 帧2 半透明绿（α=128），Pillow 合成后第 2 帧是 `(0,255,0,128)`（直接覆盖）；写成 OVER 会变成约 `(127,128,0,255)`，也就是叠影。
- GDI+ 也能打开它（老解码器只放第一帧），说明这份文件同时是合法的静态 PNG。

### 接线

导出对话框加了第六个按钮「导出 APNG」。编码是流式 deflate、没有分帧进度，所以**进度条只报 0 → 1**，和 GIF 一样。坏输入（空数组、尺寸不一致、`data` 长度不符）抛 `RangeError`/`TypeError`，在 `exportApng()` 里当场变成可读错误，不会冒到 IPC 层。

### 验证

`npm test` **1532 tests / 1530 pass / 2 skipped / 0 fail**（108 个测试文件）；静态检查 **105** 个模块、残留 0、坏 import 0、**未使用 import 0**；语法检查 **107/107**；本地化 **153** 条待迁、缺口 0；`npm run smoke` 15/15 编辑器、0 条 console 错误。

### 需要知道的

- APNG 的那 153 条待迁里有 **7 条在 `app/core/apng.mjs`**（throw 文案），和 `gif.mjs` 的 6 条同因：core 编码器有「不 import 任何模块」的守卫，不能 import 词条函数。这是纯 core 的代价，不是漏迁。
- APNG 不是所有聊天软件都认；GIF 兼容性更好但质量差。两个都留着，让用户按场合选。

## v0.5.0-alpha.26 — 2026-11-02 · 导出能交到别人手里了

本项目一直写着「面向独立游戏与前端演示的 2D 动画工具」，但导出面板只出 PNG 序列、精灵图（自家格式 + Phaser）与实时录制的 WebM —— **帧表给别人用不了，动图发不出去**。本版补上三件：GIF、Aseprite 帧表、导出预设。界面上的导出对话框第一次能选格式、画质与「谁会读这份帧表」。

### GIF：一个文件、带透明、发出去就能播

- 零依赖编码器 `app/core/gif.mjs`（**485 行**，纯 core）。全局调色板 + 5 位直方图 + 中位切分，透明索引固定 0 号位；可选 Floyd–Steinberg 抖动（默认关，确定性无随机数）。
  选 median cut 而不是八叉树：像素画与特效动画只有几十色、且色相分得开，八叉树按位层级合并会先把皮肤色系砍成一团。
- LZW 有三处容易写错的地方，都写进了注释与测试：码宽切换比字典容量晚一步（`nextCode > (1 << codeSize)`，写成 `>=` 会错位一码）、clear 码要用**当前**码宽发出后再复位、最后一码残余位必须补零否则解码器收不到 eoi。
- 测试不只验字节：`tests/gif.test.mjs` 里放了一份按规范写的**独立解码器**做往返对拍，另用 Windows GDI+ 真解码过 16×12 三帧（红/绿/全透明）与 64×48 噪声图（码宽涨到 12 位，抽样 32 像素零误差）。
- 导出对话框加了第五个按钮。**量化是同步的，所以进度条只报 0 → 1**；编码抛错会当场变成可读错误，不会写出半个文件。

### 导出预设与「谁会读它」

- `app/core/export-options.mjs` 新增四档预设：**引擎**（PNG、不缩放、帧表三份都出）、**网页**（WebP 0.85、纹理 2048）、**聊天**（PNG、纹理 1024）、**排版**（2× 缩放、不裁边、纹理 8192）。约束写在实现里：**预设只是初值，不是模式** —— `applyPreset` 返回新对象，没有 locked 字段，也没有观察者，选完再改不会被改回去。
- **`engine` 这项以前界面上根本没有**，于是一直停在 `own`，README 里「给 Godot / Phaser 用的帧表」是空头承诺。现在它是下拉框，四个选项都带 title 说明谁会读：Aseprite / TexturePacker / Godot / Love2D / Unity 的导入器，以及 Phaser 3 的 `this.load.atlas()`。
- 格式与画质也第一次有控件（画质框按格式自动启用/停用）。`trim` 与 `maxTextureSize` 仍无控件，只有预设会写它们 —— 但**会存进偏好**，否则「点了排版预设下次开面板就失效」。

### Aseprite JSON 帧表

`asepriteJSON(sheet)` 出 array 形式的帧表，能被第三方导入器直接吃。**唯一需要换算的单位是 `duration`：项目内部用秒，Aseprite 用毫秒**，并且 0 会被它当成「用缺省」，所以最小钳到 1ms。帧矩形与 `phaserJSON()` 逐帧一致（有测试钉住）。

### 验证

`npm test` **1515 tests / 1513 pass / 2 skipped / 0 fail**（107 个测试文件）；静态检查 **104** 个模块、残留 0、坏 import 0、**未使用 import 0**；语法检查 **106/106**；本地化 **146** 条待迁、缺口 0、词典镜面；`npm run smoke` 15/15 编辑器、0 条 console 错误。

### 需要知道的

- **GIF 的三条硬限制**（写进 README 了，不是隐藏缺陷）：透明只有 1 位（半透明边缘会被切成全透或全不透）、256 色对渐变不友好、同样内容比 WebM 大得多。
- 那 146 条待迁中**有 6 条在 `app/core/gif.mjs` 里迁不动**：core 编码器有一条「不 import 任何模块」的守卫，不能像 `psd.mjs` 那样 import 词条函数。这是纯 core 的代价，不是遗漏。

## v0.5.0-alpha.25 — 2026-11-02 · 权重能刷了 · 检查器自己失明过一次

骨骼线「手动刷权重」走完第二步：**顶点不只是看得见，现在能刷上去**。同时把工具名、笔名、调色板与画布浮动条搬进词条表，中文待迁降到 140 条。

### 刷权重：补足法、三种结束方式

- 权重态下压住顶点拖动即可涂抹。算的是**补足法**：目标骨 `wNew = w + (target − w) × 强度`，其余骨按 `(1 − wNew) / max(1 − w, 1e-9)` 等比例让位，最后交给 `normalizeSkin` 收口。
  为什么不能用「改一根再让归一化去补」：原 `{0.5, 0.3, 0.2}` 只把 b0 设到 0.8 再归一，得 **0.615**，而且连刷两次都到不了 0.8——用户会觉得「刷不动」。
- **不用 coalesce**：`DOC_GESTURE_MS` 是 350ms，靠它合并撤销会让粒度随手感漂移。改成拖动每帧 `silent` 写入、松手补**唯一**一条命令、Esc 静默回滚。一次涂抹 = 一步撤销，可预期。
- 笔刷范围按**归一化参数空间**算，不按像素——缩放、旋转、非等比尺寸下手感一致。
- 顶点填充用主骨色、透明度随主权重（`0.45 + 0.55 × mainW`）；Σw ≈ 0 的顶点画空心；目标骨加粗并垫 `#ffd479`（权重态下 ACCENT 已经是笔刷圈的颜色，同色会分不清「当前骨骼」与「笔刷边界」）。

### 界面语言：工具、笔刷、调色板、画布浮动条

工具（7 项）、工具条（8）、笔刷（7）、调色板（7）、层级行提示（9）、画布浮动条（7）共 45 条 × 两种语言进 `panels.mjs`。笔刷名用 `get name()` 访问器——`board.mjs` 那三个消费者直接读 `BRUSH_PRESETS[i].name`，改成键要连改三个文件，getter 让它们一行不动就跟着切语言。

中文待迁从 **188 → 140 条**（全量起点 1610）。

### 一件必须记下来的事：检查器自己失明过一次

`_check-i18n` 的「编辑器覆盖」那一段，抽 id 的正则要求 `{ id: 'x', title: ... }` 形状。删掉 `EDITORS` 的中文字段之后，正则一个都抽不到 → **打印 0/0、退出码 0、一切看起来正常**。

检查器失明时不会有任何东西变红。补法两层：抽 id 改认 `{ id, mount }`；`tests/static-gate.test.mjs` 加一条真跑断言，要求覆盖行必须是 **N/N** 而不是 0/0。

### 验证

`npm test` **1471 tests / 1469 pass / 2 skipped / 0 fail**（104 个测试文件）；`_check-static` 103 模块、残留 0 / 坏 import 0 / 未使用 import 0；`_check-syntax` **105/105**；`_check-i18n --strict` 中文 140 条、缺口 0、词典 en 1268 / zh-Hans 1268 镜面；`npm run smoke` **15/15** 编辑器、`PROBLEMS []`。

---

## v0.5.0-alpha.24 — 2026-11-02 · 顶点看得见了 · 353 行死样式清掉

这一版没有新功能可用起来——它是骨骼线「手动刷权重」的第一步：**先把蒙皮网格的顶点摆到画布上、并且点得中**。写入权重是下一步。

### 蒙皮顶点：看得见、点得中、改得动会重画

绑定骨骼之后，画布上现在会画出当前对象的蒙皮网格顶点：未选中的用骨头的缺省色、当前选中的用 `#ffd479`、权重和为 0 的用 `#ff6b6b` 空心。属性面板的蒙皮段多了「编辑权重」开关和目标骨下拉——打开开关后点顶点就选中它（不进画笔），右键取色与空格平移的行为一个字没改。

顶点位置**只从求值路径拿**：`app/core/weight-paint.mjs` 的 `skinVertices()` 内部调 `applySkin` 走同密度分支，所以顶点永远落在用户看到的形变位置上。这一点由测试钉住——它与 `createEvaluator(doc).lattice(el,t).map()` 的逐点差必须 < 1e-9。这条断言是「顶点停在绑定姿势」的唯一守卫。

顺手修掉一个会让上面全部白做的缺陷：`app/shell/doc-state.mjs` 的 `sameObjectPixels` 逐字段比了 visible/opacity/kind/anchor/cels/transform/effects 却没有 `skin`，于是只改权重时 `commitDoc` 判「像素没变」、`scheduleRender` 不跑，症状是「涂了没反应」而看起来像命中判定坏了。同一函数此前漏过 `effects`，这是第二次——白名单字段是会持续漏的那类地方。

`state.weight` 里额外带了 `layerId`：用户换目标骨时要先点骨骼，那一刻选区是骨骼，靠选区反查对象会让顶点当场消失。代价是「只选中骨骼」也能编辑权重，而这正是需要的行为。

### 353 行从未生效的 CSS

用无壳 Electron 窗口把 15 个编辑器加设置面板全切一遍、dump 运行时真实 className（320 个），与 CSS 里定义的 334 个做差，剩下 122 个逐个回查 `app/**/*.mjs`，最后定位到规则块：**34 个类名全仓无人引用**，`+12 / −353` 行。

其中三组有历史回响：`.bd-ask-*` / `.bd-btn` / `.bd-tool` 是画板旧的单类规则（`board.css` 自己的注释就写着「panels.css 末尾还有一套单类旧规则」）；`.top-transport` / `.top-tr-btn` / `.top-time` 是顶栏播放控制（`chrome.mjs` 写着「顶栏塞一个 transport 的后果是同一件事有两个入口」——它早就被否定了，CSS 留了下来）；`.lyr-thumb` / `.lyr-cel*` 是缩略图时代的残留。

四道门没有一道会看「这个类名还有人造吗」，所以这 353 行既没生效也没报错。清理方法本身可复用，见账本 §1am 第 237 条。

### 冒烟读数稳定了

`tools-smoke.cjs` 原本把「首屏已挂载的那个编辑器」跳过且不计入 ok，于是编辑器覆盖数在 14 与 15 之间漂移，没法拿来做回归对比。现在跳过但计入 ok，读数恒为 `tried=14 ok=15`。

### 验证

`npm test` → **1442 tests / 1440 pass / 2 skipped / 0 fail**（103 个测试文件）；`check:static` → 103 个模块、残留 0 / 坏 import 0 / **未使用 import 0**；`check:syntax` → **105/105**（103 个 `app/` 模块 + 2 个根工具脚本）；`check:i18n --strict` → 中文文案 218 条、词典 1223/1223 镜面、缺口 0；`npm run smoke` → `EDITORS tried=14 ok=15 failed=[]`、`PROBLEMS []`、`SMOKE OK`。


## v0.5.0-alpha.23 — 2026-11-02 · 死 import 清零 · 静态检查补第三段

纯清理，没有用户可见变化。两件事：

### 删掉 43 个从未被使用的 import（11 个文件）

全是「功能删了但 import 没删」的残渣。最大一处是 `app/shell/app.mjs`：`timebase` 整块 11 个符号（`normalizeSegments` / `hasTimebase` / `fpsAt` / `segmentIndexAt` / `segmentRange` / `addSegment` / `removeSegment` / `setSegmentFps` / `setSegmentAt` / `resetTimebase` / `sampleTimes`）、`timegraph` 的 5 个、`element` 的 3 个、`evaluator` / `lattice` 各 2 个——这些能力早就挪进 `app/shell/ctx-time.mjs` 了，`app.mjs` 只是还举着旧名字。其余散在 `timeline-paint.mjs`(7)、`ctx-time.mjs`(3)、`canvas-chrome.mjs`(2)、`project-io.mjs`(2)，以及 `element` / `evaluator` / `layers` / `timeline` / `engine` / `doc-state` 各 1。

删除方式：先按「`import` 之后 body 里还有没有这个标识符」扫一遍，逐条 `read` 确认，再改；改完四道门 + 冒烟全绿。

### `_check-static.mjs` 补上第三段：未使用 import

这条缝记在工作笔记里很久了——脚本只查「帧概念残留」与「`import` 的名字是否真的被 export」，**查不出「import 了却没用」**，所以那 43 个才能攒下来。现在补上了，并且：

- 判定前先把 `import … from '…'` 语句整段从 body 里剥掉（不剥的话，名字在 import 行里就出现过一次，检查永远为绿）。
- 用标识符边界正则（`(^|[^\w$.])name(?![\w$])`），避免把 `xxxT` 当成 `t`。
- 注释里提到也算「用到」——宁可漏报，不可误报。误报会逼人加 ignore 注释，闸门就废了。
- **有问题时 `process.exitCode = 1`**。三段里任何一段非空都失败；这是它第一次真的会让 `npm run check` 红。
- 负对照验证过：临时往 `app/core/lattice.mjs` 塞一行 `import { buildSpritesheet } from '../shell/spritesheet.mjs';`，脚本报 `app/core/lattice.mjs ← buildSpritesheet` 并 exit 1；删掉后回到 0。

顺带把「脚本自己也要有护栏」补上：新增 `tests/static-gate.test.mjs` 4 条，钉住「三段标题还在、body 必须先剥 import、要有 exitCode、真跑一次 exit 0 且末行三类都报数」。以后谁重构这个脚本时把它删了，测试会红。

### 拆仓准备（三件，来自 `task-22` 的核仓预检）

有人把「核」（`app/` + `tests/` + 三道闸 + `tools-smoke.cjs`）复制到仓库外，挂上 node_modules，在**完全没有 `main.js`/`preload.js`/electron-builder** 的树里跑了一遍——结论是核仓形态成立，但暴露了三块缺口：

- **`tests/ipc-contract.test.mjs` 在核仓里必红**（4 条都读 `../preload.js` 与 `../main.js`）。改成**一个文件两种形态**：合仓时有壳文件就走三方交叉（最强），缺壳时那 4 条自动 `skip`，改由新增的两条「核侧快照」接管（桥函数集合 = 七个通道 + 兼容老名 `openInFolder`；浏览器桥实现全部七个）。另加一条测试提醒「当前是合仓形态」——拆仓那天它会红，红就是在说「该改契约测试了」。
- **仓库里没有 `tools-serve.mjs`**，而方案文档的 `"serve"` 脚本指向它。补上（约 100 行零依赖 `node:http`，MIME 表照抄 `main.js`，`resolve` + `startsWith` 防越界）。实测：`/` → 200 `text/html`、`/shell/app.mjs` → 200 `text/javascript`、`/styles/tokens.css` → 200 `text/css`、`/../main.js` → 404。`npm run serve` 现在真的能在浏览器里开出完整应用。
- **smoke 的固定端口 43812 不并发**（核仓跑冒烟 + 壳仓 `npm start` 会撞，预检里实测过一次 `EADDRINUSE`）。改成可覆盖：`MS_SMOKE_PORT=0` 交给系统分配并回读实际端口，默认仍是 43812。

- **`tools-serve.mjs` 与 `tools-smoke.cjs` 不在任何一道门的扫描范围**——`_check-static.mjs` 与 `_check-syntax.mjs` 都只 walk `app/`，根目录的工具脚本写坏了只有真去跑才知道。把两个文件名并进 `_check-syntax.mjs` 的 `ROOT_TOOLS`（`statSync` 兜「文件不存在就跳过」，拆仓后核仓没有壳工具也不会崩）。负对照验证：往 `tools-serve.mjs` 尾部塞一行 `function broken( {` → `SyntaxError: Unexpected end of input`、exit 1；还原后 `104 个模块全部通过 node --check`。

预检还确认了一件反证：**三道闸放进只有 `main.js`/`preload.js` 的树里会直接崩**（`ENOENT …\app`、`ERR_MODULE_NOT_FOUND app/i18n/index.mjs`）——所以壳仓那边不能照搬它们，只能 `node --check` + 自建通道测试。这条已写进 `docs/拆仓方案-2026-11-02.md`。

### 验证

`npm test` → **1429 tests / 1427 pass / 2 skipped / 0 fail**（102 个测试文件）；`check:static` → 102 个模块、**残留 0 / 坏 import 0 / 未使用 import 0**；`check:syntax` → **104/104**（102 个 `app/` 模块 + 2 个根工具脚本）；`check:i18n --strict` → 中文文案 218 条、缺口 0；`npm run smoke` → 15/15 编辑器、0 条 console 错误（默认端口与 `MS_SMOKE_PORT=0` 各跑一次都绿）；`npm run serve` → 四个 URL 状态码与 MIME 全对，越界 404。

## v0.5.0-alpha.22 — 2026-11-02 · 能绑骨了，还能刷权重（下一期）

骨骼动画第二期后半的第一半（P2-B：绑定与自动权重）。上一版给了蒙皮求值器，但只能靠代码往里写 `skin`；这一版把它接到界面上——**选中骨头，点一下「绑定到选中骨骼」，皮肤就跟着骨头弯**。权重是自动算的（最近两根骨、距离平方衰减），手动刷权重是下一期（P2-C）。

### 新增

- **两个命令**：`object.bind-skin`（绑定到选中骨骼）与 `object.unbind-skin`（解除绑定）。都在命令面板里，走的都是 `patchObject` → `setDoc(..., { label })` 这条路，**一步撤销**；四条拒绝分支（没选中对象 / 目标是骨骼 / 目标的父级已是骨骼 / 一根骨都没选）全排在写文档之前，撤销栈里不会留空步。
- **绑定语义**：当前选中对象是「被蒙皮的那个」，其它被选中的 `kind: 'bone'` 是「骨骼」。网格取 `SKIN_DEFAULTS.grid`（4×4），权重用 `autoWeights` 自动算，骨骼的绑定姿态快照存的是**绑定那一刻的世界矩阵**（不是时间戳，所以之后挪播放头不会改变绑定关系）。
- **属性面板多了「蒙皮」段**：只在带 `skin` 的对象上出现，一行只读摘要「已绑 N 根骨 · 网格 4×4」+ 一个解除绑定按钮。按钮与命令共用同一份实现，没有第二条写路径。

### 父链硬约束真的拦住了

蒙皮对象如果把 `parentId` 指向骨骼，`worldMatrix` 与蒙皮会各乘一次，变成双重变形。这条以前只是方案文档里的一句话，现在**落在拖拽路径上**：`app/editors/tree.mjs` 的 `dragover` 给非法落点标 `drop-invalid`（光标就不会先给出「能落」的假信号），`drop` 在处理里早退并提示。判定抽成导出的纯函数 `parentBlocked(doc, movedId, targetId)`，可单测。绑定时另有一条对称检查（被绑对象**当前**父级已经是骨骼 → 拒绝）：那一刻对象还没有 `skin`，`parentBlocked` 判不出来，两条检查各守一个时刻。

顺手删掉一条假兜底：`tree.mjs` 里的 `setParentOf` 会调 `ctx.setParent`，而 ctx 上从来没有这个方法（真正叫 `setLayerParent`），分支永远 `return`。连函数一起删了（−11 行），现在没有 `moveSubtree` 会明确提示，而不是静默什么都不做。

### 验证

`npm test` → **1420 tests / 1418 pass / 2 skipped / 0 fail**（上一版 1407/1405/2，新增 `tests/skin-bind.test.mjs` 13 条）；`check:static` → 102 个模块、残留 0、坏 import 0；`check:syntax` → 102/102；`check:i18n --strict` → 中文文案 219 条持平、词典 1217/1217 镜面、缺口 0；`npm run smoke` → **15/15 个编辑器挂载、0 条 console 错误**（这一版动了 UI，冒烟是硬要求）。逐条台账在 `docs/修复列表-v8.md` §1ak。

## v0.5.0-alpha.21 — 2026-11-02 · 皮肤会跟着骨头弯了

骨骼动画第二期（P2-A：蒙皮模型与求值）。**这一版没有界面**——没有「绑定骨骼」按钮、没有权重刷子，那些是 P2-B/P2-C。它交付的是**地基**：一套纯函数 LBS 求值器，接在 `evalLayer` 的一个接缝上，让「带 `skin` 的对象」在渲染时按骨骼弯折。**用代码写进去的蒙皮现在就能工作**；数据能存能读，`.msp` 格式没变。

### 蒙皮怎么算

`app/core/skin.mjs`（新建，500 行，全是纯函数，不碰 DOM）。每根骨在绑定姿态下存一份世界矩阵快照 `bind`，求值时：

```
rels[k] = M_now(k) · bind(k)⁻¹        // 每根骨先算好，顶点循环里不重算
W       = Σ w_k · rels[k] · P          // 顶点到世界
Q       = worldMatrix(layer, t)⁻¹ · W  // 回到层的局部空间
off     = Q − P                        // 加进 lattice 的 pts[i]
```

三条实现上的硬决定：**失效骨跳过并把剩余权重重新归一到 1**（不归一会让 Σw<1 的仿射组合把皮肤整体拉向原点，表现成「删一根骨就缩小」）；**Σw ≤ 1e-12 的顶点当纯 warp 处理**，不产 NaN；**`st.warp` 全程只读**（那是用户数据），蒙皮偏移与它逐顶点相加，密度不同时按 `latticeOffset` 重采样。

对拍：单骨纯平移时 `map(0,0)=(60,30)`、`map(1,1)=(860,630)`；层自身绕中心转 90° 再叠加骨骼旋转时 `map(1,0)=(7.000000000000049, 807.0000000000001)`，与手算逐项相等（这条同时反证「层的世界矩阵不是单位阵」，防假绿）。

### 顺手修掉的两个真缺陷

都是 P1 埋下、P2 才暴露的：`evaluator.sizeOf` 没有 `bone` 分支，骨骼求值时回退文档尺寸，导致**同一根骨在求值器与 `element.mjs` 里的世界矩阵差 293px 平移**（P1 因为骨骼不绘制、不命中，所以没露头；一绑权重整块皮肤就错位）；`elementMatrixOf` 的缺省锚点固定 `{0.5,0.5}`，而 `element.mjs` 按 kind 分（骨骼绕根部）——手搓的、没有 `anchor` 字段的骨骼会在求值器里绕中心转。

### 存档

`skin` 进 `elementToJSON` 与 `elementShell` 两个白名单，**`.msp` 仍是 `version: 4`**：`bone` 与 `skin` 都可缺省，v4 读侧本来就用白名单过滤、丢弃不认识的键，因此不需要迁移代码，也不需要升版本号。`makeObject` 只做形状校验、原样搬运（不归一），归一在读档与求值两个边界各做一次——这样 `doc-model` 不必 import `skin.mjs`（否则成环）。

### 规格文档的四处自相矛盾一并改了

`docs/骨骼动画方案-2026-11-02.md`：§3.3 说「`.msp` 升到 5」与施工规格、P1、P2 三处「仍是 4」打架（已按「不升」重写并说明判据）；§3.1 的骨骼缺省值还是草案的 `width: 10 / #4a7dff`（P1 已定稿 `width: 14 / #7d8fa8`）；§4.3 的示例写的是对象形式 `applySkin({...})` 而规格是 6 个位置参数；`resampleWeights` 在总述里有、在导出清单里漏了。另补了一条「`normalizeSkin` 为什么不重采样」。

### 验证

`npm test` → **1407 tests / 1405 pass / 2 skipped / 0 fail**（上一版 1372/1370/2，净增 35 条，其中 `tests/skin.test.mjs` 34 条、`tests/i18n-parts-layers.test.mjs` 新增别名守卫 1 条）；`check:static` → 102 个模块、残留 0、坏 import 0；`check:syntax` → 102/102；`check:i18n --strict` → 中文文案 219 条持平、缺口 0；`npm run smoke` → 15/15 个编辑器挂载、0 条 console 错误。逐条台账在 `docs/修复列表-v8.md` §1aj。

## v0.5.0-alpha.20 — 2026-11-02 · 骨架立起来了

骨骼动画第一期：文档模型认识第三种对象 `kind: 'bone'`，画布上画出骨架，属性面板能调形状，命令面板能建骨。**这一版没有蒙皮**——骨头不能带纹理变形，那是第二期（P2）。但骨头就是普通对象：它走同一套 `transform` 通道、同一个父链、同一份时间轴，所以**今天就能拿它搭层级：建几根骨头挂成链，给旋转打关键帧，把有纹理的对象挂到骨头下面跟着动**。逐条台账在 `docs/修复列表-v8.md` §1ah。

### 骨头是一种对象，不是一种新机制
- `kind` 从两值扩到三值：`paint` / `image` / **`bone`**。骨骼带三个外观字段 `bone: { len, width, color }`（缺省 120×14、`#7d8fa8`），`len` 夹在 8–4096、`width` 夹在 2–256，坏色值回退，越界夹取不丢弃。
- 它**没有纹理**：不占纹理库、不进 `imageAt`、求值器照旧走「无图不绘制」那条老分支——所以为骨骼改动求值逻辑是零行。`elementSize` 给它一条分支（取 `len×width`），否则会退回文档尺寸，选框和手柄会撑满整块画布。
- 锚点缺省在**根部中点**（`{0, 0.5}`）而不是对象中心：骨头绕根转，不是绕自己腰转。这是骨骼唯一和普通对象不同的约定。

### 画布上看得见、点得中
- 新增骨架叠加层：所有骨头常显（未选中 0.42 透明度），选中的用强调色底衬 + 实心关节，根部画实心圆、末端画小圆，线宽随缩放夹在 2–48。骨架和选框用**同一条矩阵路径**（`objectParentMatrix` × 世界矩阵），不会错位。
- **修了一条会让工具显得坏掉的缝**：通用命中检测对「没有位图的对象」直接跳过，骨骼看得见却点不中。现在骨骼单独放行，命中区沿骨头长度、粗细方向放宽到一个阈值；空的手绘对象仍然整块不可点（没有图画在那里，点它就是不该命中）。

### 建骨、调形、挂层级
- 命令面板新增「新建骨骼」（`object.add-bone`）：在当前选中对象的同一层建一根骨头。bone 与锚点由 core 按 kind 兜底，外壳不手写这些字面量。
- 属性面板新增骨骼段（长度 / 粗细 / 颜色），只在骨头被选中时出现；写口和对象名、不透明度是同一条路径——一次改动一步撤销。
- 层级面板显示「骨骼」这一种类；把任意对象拖成骨头的子级，它就跟着骨头动。

### 存档仍然兼容
`.msp` **不升版本**（仍是 v4）：`bone` 是可缺省字段，老档读进来没有它就拿缺省外观；`kind` 白名单在序列化两侧共用同一份，只对 `kind === 'bone'` 且形状合法的对象写/收 `bone`。译文与词条键一个字都不进存档。

### 验证
`npm test` → **1372 tests / 1370 pass / 2 skipped / 0 fail**（99 个测试文件）；`node _check-static.mjs` → 101 个模块、残留 0、坏 import 0；`node _check-syntax.mjs` → 101/101；`node _check-i18n.mjs --strict` → 中文文案 **219 条**（283 行，37 个文件）、词典缺口 0。新增 `tests/bone-model.test.mjs`（23 条：归一与夹取、`elementSize` 分支、锚点、往返、落盘纯净性、不升版本、命中）与 `tests/bone-editor.test.mjs`（12 条：骨架存在性与调用位置、面板三字段与区间、写口、命令、四词条中英齐全、`.msp` 里不许出现词条）。

## v0.5.0-alpha.19 — 2026-11-02 · 界面不再说两种话

本地化第二期：外壳、通知、以及全部面板的文案搬进词典。**面向用户的中文字面量从 1343 条降到 0 条**——剩下的中文只有给开发者看的 `console` 日志与几处内部哨兵。逐条台账在 `docs/修复列表-v8.md` §1ag。

### 现在切语言是完整的一次切换
- 新增六个分片（`shell` 269 / `board` 85 / `layers` 117 / `props` / `timeline` 100 / `projects` 154 条），合计 **988 条**，与第一期合计 1233 条进词典，`en` / `zh-Hans` 逐键镜面。
- 顶栏是启动时建的一次性 DOM，切语言只重挂面板管不到它——所以 `chrome.mjs` 新增 `syncLabels()`，在每次 `update()` 里按当前语言重写文件按钮、工作区 tab、脏点提示；`WS_TABS` 的 title 与 `FILE_ACTIONS` 的文案也从常量改成键。**顶栏、面板、浮层、快捷键帮助现在同时切。**
- 快捷键浮层挂在 `body` 上，不归面板重挂管——`applyLocale()` 里单独给它 `setGroups()` 一次。

### 出错时会说人话
- 提示条分档：普通提示 1.6 秒，**错误 6 秒且不会被下一条普通消息顶掉**（`doc-state.mjs` 的 `noteAlive()` / `NOTE_ERROR_MS`）。
- 项目库与外壳的失败一律带原因：浏览器里点了导出会说「这个环境没有保存通道」，桌面桥没回话会说「保存接口没有响应」，保存接口回了成功却没给路径会说「文件可能没落地」——不再有静默的「已取消」。

### 一件被推翻的事
上一版把新文档的默认对象名做成了词条（`shell.doc.defaultObjectName`），这一版**回退成固定名 `Object 1`**。对象名是用户数据：它会进层级面板、会被导出、会写进 `.msp`、用户随时可以改。跟着界面语言走意味着同一份文档里可能混着两种语言的对象名，切换界面语言还会让「新建的对象叫什么」随设置变化。**界面文案跟语言，用户数据不跟**——这条界线比「看起来都翻译了」重要。

### 还有多少中文
- 词典缺口 0 处，`en`/`zh-Hans` 各 1233 条（原 1610 条待迁的 96.9% 已迁）。
- 保留不译的：`console.*` 开发日志 27 条（诊断信息，先例 `app/editors/canvas.mjs:208`）、`core/timegraph.mjs` 的 16 条 `{ok:false,reason}` 诊断（是 API 返回值，被父链测试逐字断言）、`curve.mjs` 的一条哨兵 `'无时间变换'`（用于和 `describeTime()` 相等比较，不显示）。
- `_check-i18n.mjs` 新增一段「`t` 被局部标识符遮蔽」检查：`t` 只有一两个字母长，被 `const t = e.target` 抢占后，同作用域里调 `t('…')` 会在运行时抛 `TypeError`（本版真的踩到一次：`ctx-time.mjs` 的 `const t = Math.max(...)`，页面不报错、跑到那行才炸）。当前报 5 处，逐处看过作用域都没有调用 `t()`，留作自查清单。

### 验证
`npm test` → **1337 tests / 1335 pass / 2 skipped / 0 fail**（97 个测试文件）；`node _check-static.mjs` → 101 个模块、残留 0、坏 import 0；`node _check-syntax.mjs` → 101/101；`node _check-i18n.mjs --strict` → 中文文案 **219 条**（283 行，37 个文件）、词典缺口 0。新增测试 `tests/i18n-parts-{shell,board,layers,props,timeline,projects}.test.mjs`，其中 shell 片钉死了两条契约：`ipc.mjs` 的通道名必须原样（不许走词条）、逐文件中文条数必须恰好等于允许的 `console` 条数。

## v0.5.0-alpha.18 — 2026-11-02 · 文案有了去处 · 浏览器能开口

本地化从骨架走到第一期实际抽词，同时把「当网页跑」的两件前置条件做实：浏览器桥装上了，跨仓通道契约有了测试。逐条台账在 `docs/修复列表-v8.md` §1af。

### 四个片区的文案搬进了词典
- 帮助面板、命令面板、效果与类型名、九个面板常量档，共 **245 条**搬进 `app/i18n/parts/`（help 99 / commands 76 / effects 28 / panels 42）。切语言时它们立刻跟着变，不用重启。
- 常量表改成**访问器**（`get name() { return t('…'); }`）。原因很实在：`setLocale()` 只换表、不重建模块常量，写成普通属性就会把首次渲染的语言冻在里面。代价是每次读多一次查表，换来所有消费者零改动。
- `EFFECT_DEFS` 被 `Object.freeze` 冻着，运行期换不了标签——所以它只留**键字段**（`nameKey` / `params[].labelKey`，由 `id + 参数名` 派生，因为这两个值本身就是落盘值），译文全在词典里。
- **译文一个字都不进 `.msp`**：新测试逐条断言存档里的效果只有 `type` / `id` / 参数名 / `tracks`。

### 浏览器里能用了
- 新增 `app/shell/bridge-web.mjs`：没有桌面壳时自动接管七路通道——导出走下载、打开走文件选择框、`openFolder` 明确告诉你浏览器没有文件管理器。
- 它**不抢桌面壳的活**：检测到 `window.motionAPI` 就直接空转。`ipc.mjs` 仍是唯一接触桥的文件（新增 `setBridge()`）。
- 没用 File System Access API：`showSaveFilePicker` 必须在用户手势里同步调用，而导出发生在几十个 await 之后，接进去必抛 SecurityError。要接得把「先选路径」提到按钮点击那一刻，属整链重构，这一版不做。

### 跨仓契约钉住了
- 新增 `tests/ipc-contract.test.mjs`：`ipc.mjs` ↔ `preload.js` ↔ `main.js` 三方按符号核对，断言通道恰为七个、数量相等、浏览器桥覆盖同一组方法名。
- 这条缝以前没人管——`_check-static.mjs` 只扫 `app/`，`main.js` 与 `preload.js` 完全不覆盖。拆仓之后它就是跨仓库契约，改名会在测试里立刻红，而不是让某个功能静默返回 null。

### 顺手清掉与修掉
- 画布上约 160 行不可达代码（对象浮动工具条在 v8 就从画面上拿掉了，代码一直空转）连节点、事件、导出、CSS 一起删干净，`canvas-chrome.mjs` 341 → 189 行。画布上不该有第二套对象入口。
- **修**：洋葱皮选「淡化」不生效——面板写 `'dim'`，归一化只认 `'fade'`，读回来永远是「着色」。
- **修**：切语言后快捷键浮层还是旧语言（它挂在 body 上，不归面板重挂管）。

### 需要知道的
- **迁移后的源码不再保留中文原文**，`t()` 只传键。原计划是 `t(key, '原文')` 留回退，但那样 `_check-i18n` 的数字一条都降不下来——指标必须能归零。缺词风险由「合并撞键抛错 + 每条键两表非空 + `--strict` 缺口 0」三重兜住。
- 还剩 **1343 条**（原 1610）没迁，重灾区是导出/保存/项目库那些就地拼装的通知与错误串。那是 P2。

### 验证
`node --test tests/*.test.mjs` → **1262 tests / 1260 pass / 2 skipped / 0 fail**（91 个文件）；`_check-static.mjs` 95 个模块、残留 0、坏 import 0；`_check-syntax.mjs` 95/95；`_check-i18n.mjs --strict` 缺口 0、中文文案 1343 条。
## v0.5.0-alpha.17 — 2026-11-02 · 本地化骨架（英文优先）

界面文案第一次有了「词条表」这层东西，语言也第一次成了可切换的设置项。本版是本地化的 P0：**只搭骨架、只接两处可见文案，其余界面外观零变化**。逐条台账在 `docs/修复列表-v8.md` §1ae。

### 语言第一次可切换
- 新增 `app/i18n/`：`index.mjs`（`t()` / `setLocale()` / `normalizeLocale()` / `htmlLangOf()`）+ 两份词典 `en.mjs` / `zh-Hans.mjs`（36 条：15 个编辑器的标题与悬停提示 + 语言项自身）。
- **缺省语言是英文**（`DEFAULT_LOCALE = 'en'`），`<html lang>` 跟着切换（`en` / `zh-CN`），屏幕阅读器与断词规则读的是它。
- 设置面板新增「语言 / 界面语言」段，选项用各自语言自称（`English` / `简体中文`）—— 一个只会英文的人切进中文界面时，仍得认得那四个字才能切回来。
- 选择存进 `ms.prefs`；`cleanPrefs` 认 `zh` / `zh-CN` / `cn` / `chs` 等写法，手改偏好文件不会把界面卡死。

### 切语言必须有人重绘
- `setLocale()` **只换表、不重绘**，否则会形成 i18n → view-host → 编辑器 → i18n 的回环。重绘由外壳负责：`view-host` 新增 `remountAll()`（重挂各面板，**跳过画布实例** —— 引擎宿主与视口在里面，重挂会丢正在画的笔），`app.mjs` 新增 `applyLocale()` 并在 `buildViews()` 之前应用启动语言（否则第一帧会先按缺省语言渲染再被刷掉）。

### 还差多少，有了尺子
- 新增 `_check-i18n.mjs`：扫 `app/**/*.mjs` 的**非注释**中文字面量并按条数排行，校验两份词典键集合镜面、`core/prefs.mjs` 的语言白名单与 i18n 一致、注册表每个编辑器都配了标题与提示。
- 它**默认只报数、永远 exit 0**（这是进度尺，不是闸门）；`--strict` 时才因缺口退出 1。`npm run check` 里接的是非 strict 版。
- 首次实测：**1610 条 / 1329 行 / 57 个文件**仍未走词条表，前三名 `project-io.mjs` 206 条、`app.mjs` 139 条、`board.mjs` 110 条。

### 需要知道的
- 词典用**静态 import 而不是 fetch JSON**：同步加载让 `boot()` 不必变成 async，也就不存在「文案到达前先闪一遍中文」。
- `t(key, '原文')` 的形态保证「漏翻 = 显示调用点原文」，不会出现空白按钮。本版只接了区域头与设置面板，其余 1600 条仍在代码里 —— 那是 P1→P4 的活。
- 英文词典里除 `locale.*`（语言自称）之外**不允许出现中文**，这条有测试守着。

### 验证
`node --test tests/*.test.mjs` → **1192 tests / 1190 pass / 2 skipped / 0 fail**（85 个文件）；`_check-static.mjs` 89 个模块、残留 0、坏 import 0；`_check-syntax.mjs` 89/89；`_check-i18n.mjs --strict` 缺口 0。

## v0.5.0-alpha.16 — 2026-11-02 · 界面瘦身 · 失败要说话 · 门面重写

用户这一轮给的是四条方向：删掉时间轴上没用的控件、本地化英文优先、程序要能当网页跑并把桌面壳拆出去、说清它服务于谁。本版先落两条能立刻动的（多余控件、六处「没做却说成功」），并把门面与方向补上；本地化与网页桥排在下一版。逐条台账在 `docs/修复列表-v8.md` §1ad。

### 时间轴：删掉两个按下去没反应的按钮
- 「上格 / 下格」走的 `goCel` 里 ctx 分支是死代码（`has('prevCel')` 恒 false），而且用 `setTime` 而不是 `setTimeClamped` —— 违反 `CONTRACT-v8:45`（`setTime` 会 `wrapTime` 回绕）。按钮、分派、disabled、整个 `goCel` 一并删除，**能力保留**：`Shift+,` / `Shift+.`、命令面板、画板快捷键三处仍在。
- 「曝光 / 删格」改名「再曝光 / 删曝光」，分组名 `cel`→`tex`，禁用判据从 `obj.cels` 投影改成 `celTimes` 真源。**这两个功能与右键菜单不等价**，所以留下：再曝光是复用当前纹理（不新建图），删曝光只摘 `drawing`（关键帧与变换留着，画面回落到上一张）。

### 六处「没做却说成功」
六处都不依赖 Electron，但网页化之后会全部变成用户可见的数据丢失，所以先修：
- **WebM 导出录完不落盘**：对话框分支只返回「WebM 在内存里」，字节随闭包丢掉却显示完成。现在 `exportVideo` 录完必须写盘，取消与失败分开报。
- **项目库「存为文件」判据是 `ok !== false`**：桥返回 null 也弹「已存为文件」。新增纯函数 `actVerdict(out)`：`null` / `undefined` 是「这一步没跑起来」，不是成功；`ok:true` 但没给路径也要报「文件没落地」。
- **项目库「导出精灵图」同样**：接口回了成功但帧表是空的，现在会说出来。
- **「导出当前帧」把失败当取消**：原守卫 `typeof ipc.saveBinary !== 'function'` 恒假（`ipc` 是命名空间对象）。改用 `ipc.available()`，并新增 `ipc.saveBinaryChecked()` 把「无桥 / 空字节 / 同步抛错 / 没响应 / 被拒绝 / 用户取消」拆成可分辨的六种结果；`ipc.lastFailure()` 让「preload 没挂这一路」和「挂了但一调用就抛」不再混为一谈。
- **未命名项目刷新即丢**：草稿节奏原挂在 `prefs.autoSave`（默认关）后面，所以永远轮不到。未命名文档现在固定 3 秒落地草稿（已命名的仍听用户偏好），并加签名比对避免闲置时每 3 秒重写整份文档；自动保存失败会红字说出来。
- **错误提示 1.6 秒且会被「已取色」顶掉**：`flash(msg, 'error')` 现在停留 6 秒，且**普通提示压不掉未过期的错误**（新错误仍可盖旧错误）；顶栏被省略号截断时把整句挂 `title`。

### 门面与方向
- `README.md` 整篇改英文（用户要求「英文必须是第一位」），新建 `README.zh-Hans.md` 对照，两份顶部互链。新增三节：它服务于谁（独立游戏 2D 美术 / 前端与动效 / 内容作者，并写明不做什么）、三种运行方式（桌面 · **浏览器** · **仓库拆分**）、以及 IPC 七通道这条跨仓契约。
- 浏览器与拆仓两节**只写现状**：网页桥尚未落地，落地前「能画能动能播，但导出与保存会明确告诉你需要桌面壳——不会假装成功」（正是本版修出来的行为）；桌面壳将迁到独立仓库，本仓库成为核。
- 新建 `docs/骨骼动画方案-2026-11-02.md`：定位、数据模型（`kind:'bone'` + `skin`）、LBS 数学与「必须在 `worldMatrix⁻¹` 空间算偏移」的推导、四阶段路线（骨骼即对象 / 网格蒙皮 / IK 只算不写关键帧 / `.msp` v5 互操作）与 4 条待拍板。

### 需要知道的语义变更
- `exportFrames` / `exportSpritesheet` / `exportCurrentFrame` / `exportVideo` / `copyFrameToClipboard` 的返回值由「`null` 或 boolean」改为 `{ok, ...}`。仓内调用点全是 fire-and-forget，不受影响；外部脚本若用 `if (!exportFrames())` 判定会反。
- 未命名文档不再受「自动保存已关」影响（数据安全优先）；已命名文档完全照旧。

### 验证
`npm test` **1177 tests / 1175 pass / 2 skipped / 0 fail**；`npm run check` 86 模块、残留 0、坏 import 0、`node --check` 86/86；测试文件 84 个。新增 `tests/ipc-failure.test.mjs`（23 例：假桥注入的真断言 + 源码守卫），`tests/timeline.test.mjs` 改为 13 个 act 并新增 3 例，`tests/icons.test.mjs` 的图标条数按实测改为 13。

## v0.5.0-alpha.15 — 2026-10-26 · 时间基准与效果身份

第 24 批（效果参数全线动画化）开工前的清障。两条都是「24 批一动手就会被放大」的前置缺陷：效果的**写入口时间基准**和**效果的寻址方式**。

### 时间基准：在时间子树里打帧会落错位置
- 效果写入口（`patchEffect` / `setEffectParam` / `keyEffectParam` / `clearEffectParam`）与 `writeKeyAt` 一直在用**播放头（文档时间）**当轨道时间，而求值侧（`evaluator.mjs` 的 `localTime`）、渲染侧（`composite.mjs:313`）、曲线侧（`ctx.objectLocalTime`）全都用**该对象的局部时间**。对象只要挂了父级、或改过时间通道 `offset/scale`，帧就打在错误的时刻：曲线把播放头画在局部 4 秒，新帧却出现在 3 秒，越拖越偏。
- 新增统一换算入口 `localTimeOfLayer(doc, layer)`；`patchEffect` 把局部时间作为第二参交给回调，四个写入口的 `mutate(fx, t)` 全部改用它。三个外部调用点（旋转原点、lattice 缩放/重置）传的本就是全局时间，不存在双重换算。
- `writeKeyAt` 同样先把入参换算成局部时间 —— 它是网格 warp / 变换面板 / 画布手柄的唯一写入口。

### 效果身份：按 id 寻址，不再按数组下标
- 效果原先只有数组下标这一种身份。属性面板删除按钮的闭包里记的是构建 DOM 时那份文档的 `idx`，重绘之前点一下就会删错；`dataset.fxIndex` 更是全仓无读取者的死字段。这也让第 24 批没法给出稳定的通道 id。
- 给每条效果一个**层内**稳定 id：`fx-<n>`。发号只发生在两处 —— 存档载入（`effectsFromJSON`）与 `setLayerEffects` 出口；**确定性发号**（同一份老档反复载入总是同一组 id）且全合法时返回原数组引用，不制造无意义 diff。刻意不放进 `defaultEffect`（不知道兄弟列表，会发重号）也不放进 `normalizeEffect`（它按白名单收键会丢 `tracks`，且是渲染期每帧路径）。
- 命令层四个入口的形参从 `fxIndex` 改为 `fxId`、内部走 `indexOfEffect`；面板的签名、删除、就地同步、颜色回写全部改按 id。手写的非序号 id（如 `fx-outline`）原样保留，也不会抬高序号高水位。
- 通道 id 定名 `fx.<effectId>.<paramKey>`，id 字符集禁「.」，24b 才能安全地 `split('.')`。
- 老存档**零迁移**：效果轨道一直挂在效果自己身上（`layer.effects[i].tracks[参数名]`），文档里没有第二张「通道 → 轨道」表，所以发号对已存轨道完全透明。测试里有一条硬断言专门钉住这件事。

### 清理与文档
- 删 `ctx.subtreeCount` / `ctx.layerDepth` 两个零调用包装（含因此变死的两行 import，-14 行）；删 `app.mjs` 的两处死 import；`layers.mjs` 的 `indentOf` / `MAX_VISIBLE_DEPTH` 死缩进档合并为常量 `DROP_INDENT`。
- 两处过期行号反向误导：`修复列表-v8.md:384` 与 `合流计划-2026-10.md:24` 都还在写「缩进用 `layers.mjs:549-555` 的 `ctx.layerDepth`」，而该实现早已移除（那几行现在是时间弹层的「冻结」按钮）。改为指向现值 `editors/tree.mjs:128`。

### 验证
`npm test` **1151 tests / 1149 pass / 2 skipped / 0 fail**；`npm run check` 86 模块、残留 0、坏 import 0、`node --check` 86/86。新增 `tests/layer-time-base.test.mjs`（5 例，含「用播放头写帧会落错位置」的旧行为对照）与 `tests/effect-id.test.mjs`（12 例，含「补号前后 filter 串逐字相同」「二次往返不漂移」）。

## v0.5.0-alpha.14 — 2026-10-26 · 写路径与存档收口

不是新功能。接手复核时发现四条同源缝隙：`cels` 是投影，却被三处 UI 写路径与一处序列化当真源用；外加 `effects` 整条字段漏在白名单外。共同点：**屏幕上完全看不出来，伤害全在存档边界**（保存前纹丝不动，重开项目才现形）。逐条台账在 `docs/修复列表-v8.md` §1aa，完整复核在 `docs/接手复核-2026-10-26.md`。

### 存档：三条丢数据的
- **效果不落盘**：`elementToJSON` / `elementShell` 是两个字段白名单，都没有 `effects` —— 给对象加的效果（静态参数 + 轨道）保存即消失。两侧各补字段 + 5 个私有函数。fx 轨道是「通道字典 + `state.x`」、transform 轨道是「`channels` + `value`」，故意**不泛化** `trackToJSON`（泛化后两套形状看起来同构，读代码的人会以为它们本来一样）；载入侧刻意**不调** `normalizeEffect`（它会丢 `tracks`、会 clamp 用户数据）。未知效果类型照原样落盘、读入时才丢 —— 不替用户删数据。`VERSION` 仍 4，老档兼容。
- **存档写投影**：`docToJSON` 直接信 `obj.cels`，而 `timeline-geo` 拖拽只浅替换 `transform`、不重算投影 → 拖/删关键帧后保存，重开项目**纹理错位**、**已删纹理复活**。改为 `drawingCelsOf()` 从 `key.drawing` + `drawings` 现算（与 `imageAt` 同一条取图路径）。
- **UI 三处写 cels**：`app.mjs` 的 `addCelAt` / `clearCelAt` / `celImageForPaint` 手拼 `{cels:[...]}`，屏幕毫无变化，但落盘 `cels` 出现 `[0,2,2]`（同一时刻两次）、重开纹理跑到别的时刻。三处改走 `setImageAt` / `setKeyDrawing`。

### 画板：新纹理与上一张联动
- `ensureCelAt(inherit:true)` 返回上一格**同一张位图的引用**（`addDrawing` 同 id 直接复用不克隆），`activeCel()` 取到就原件直接画 → 改一张两张一起变。改为 `res.created` 时先 `cloneSurface` 再 `setImageAt` 进库。顺带修掉「空库 + 空白时刻落笔整笔丢失」（两条分支都不执行、不写回文档）。

### 清理
- 删 `app/paint/thumb.mjs`（44 行，全仓零引用）、`doc-model.mjs` 的不可达分支、`editors/layers.mjs` 自带的第二套树序实现与 3 个零调用函数（净删约 110 行）。树序唯一来源改为 `core/hierarchy.treeOrder(doc)`，同层行序按 `drawOrder`。
- **本版唯一的用户可见变化**：父子面板 `Shift` 连选区间改按显示的 id 序——`core/selection.mjs:59` 的契约是「顺序即显示顺序」，原实现走 `doc.objects` 数组序，行序一变就会错位。

### 文档
- 8 处文档/注释与实现不符，其中三处是**文档反向误导实现**：`docs/层级与叠放-2026-10.md:57`「`moveSubtree` 只改 parentId、不碰 drawOrder」、`:76`「tree 不允许拖行间」、`:44` 过期签名 —— 都与 `core/timegraph.mjs:394-417`（连注释都写着相反的理由）和三区拖拽实现相反。`CONTRACT-v7:18` 与 `core/board.mjs` 描述的「画板提交成对象」没有生产入口（补了实测段）。`textures.mjs:2`「纹理（旧称「纹理」）」是 `dd72cd2` 批量替换误伤的自指。
- `README.md` 的 `.msp` 格式段改成 v8 真相：**纹理属于关键帧**（`drawings` + `key.drawing` 是真源，`cels` 是投影缓存，手改不生效）；三处过期数字同步（81 个测试文件 / 86 个模块 / 1132 passing）。

### 验证
`npm test` **1134 tests / 1132 pass / 2 skipped / 0 fail**；`npm run check` 86 模块、残留 0、坏 import 0、`node --check` 86/86。四条修复各有**回退实测**：把行改回旧写法 → `store-projection` 3 红 1 绿、`project-effects` 5 红 1 绿（绿的那条正是老档兼容）。

## v0.5.0-alpha.13 — 2026-10-26 · 网格软拖 · 选择模型 · 拖拽反馈 · 导出栈

按 `docs/开发计划-2026-10-26.md` 一批次一批次落地，本版含第 26 / 28 / 29 / 32 / 33 五批。

### 画板：网格内部拖拽（第 26 批）
- 拖图像内部但没点中格点 → **影响附近格点**（不再是移动对象）。算法移植 Klecks `ffd.ts:317 warpLatticeViaPoint`：Bernstein 权重 × 距离斜坡 `1 - d/(1/3)`、外侧再乘 `edgeFalloff=0.5`、按 `Σw²·strength` 分配位移，最后乘 `1/J` 一次归一即精确落地（误差 ≤7.1e-15，不再需要迭代）。
- 半径按**格数**取 `max(1/3, 1/cols)`：纯 Klecks 的 1/3 补丁比例在 1×1 网格中心拖拽时一个顶点都碰不到（实测 `sumWeightsSq=0`）。
- 撤销：逐帧 `{silent:true}` + 松手 `pushCommand` 一条 —— 显式 `coalesce` 的 700ms 窗口会把慢拖断成多条（实测），故不依赖时间窗；`Esc` 静默回落不留重做栈痕迹。
- 拖动中画虚线影响圈（夹在对象 `[0,1]²` 内）。新增 `app/core/warp-drag.mjs`、`tests/warp-drag.test.mjs`（16 例）、`docs/网格拖拽-2026-10.md`。

### 编排：选择模型（第 28 批）
- 关键帧：单击只选它、`Shift`/`Ctrl` 点累加（再点移出）、`Shift+Alt+点` 连选、框选追加、`A` 全选 / `Alt+A` 取消 / `Ctrl+I` 反选 / `B` 框选模式 / `Esc` 退出。时间轴与曲线共用 `app/core/selection.mjs` 的 `clickIntent`。
- 对象：叠放与父子面板支持多选（同套修饰键）、批量删除/显隐、整块拖拽**一次 `setDoc` 落全部**且保持相对次序；父子关系只对单选生效（多选拖动给提示）。
- 修掉两个自造 bug：编辑时吃掉 `else if (act === 'del')`（点删除无反应、点合并反删对象）、批量删除后选择集合未清。曲线自己的 `Ctrl+A/I` 曾重复报数（显示 4 个实际 0 个），改为只改集合、读数由时间轴独占。

### 编排：拖拽反馈（第 29 批）
- 拖动关键帧显示浮层（`t = 0.167 s · 第 2 帧 · 吸附:帧`），冲突时追加红字「该时刻已有关键帧」，被占用的那颗标 `.is-blocked`。浮层挂 `body`、只写 `transform`、rAF 合并、夹在视口内（三尺寸拖到右下角极限仍完整可见，残留 0）。
- `Esc` 取消拖动（只在拖动中接管 + `preventDefault`），不碰 `moveKeys`。曲线 `.curve-tip` 与时间轴统一到同一实现；删掉无消费方的 `dataset.preview` 死属性。

### 导出栈（第 32 / 33 批）
- 三条导出命令全部走对话框：范围（左闭右开 `ceil(span*fps - 1e-9)`）、缩放、格式（png/webp/jpeg + 质量）、图集上限、trim、引擎格式；进度条 + 可取消；键盘契约（`Esc` 关、`Tab` 全走、`Enter` 导出、初焦在导出）。
- PNG 序列改**分片写**（每片 16 帧、首片建目录 + `uniqueDir` 去重、片间让出宏任务），不再攒 base64 一次过 IPC。
- 精灵图新增：超上限**自动分张**（单帧本身超限则明确报错不产图）、内容裁剪（格尺寸跟着收到内容盒最大宽高：`2700×640/13815B` → **`420×84/868B`**）、Phaser 3 JSON Hash、单帧导出、复制到剪贴板（三条降级文案各自可辨，且不再被后续 flash 覆盖）。
- 新增 `app/editors/export-dialog.mjs`、`app/core/export-options.mjs`、`app/styles/export.css`、`tests/export-options.test.mjs`、`tests/sheet-split.test.mjs`、`tests/sheet-trim.test.mjs`、`docs/导出栈-2026-10.md`。

### 验证
`npm test` **1117 tests / 1115 pass / 2 skipped / 0 fail**；`npm run check` 87 模块、残留 0、坏 import 0、`node --check` 87/87；三尺寸（1680×1000 / 1280×800 / 1000×620）审计 `small/unlabeled/symbolOnly/truncation/errors` 全 0。
## v0.4.0-alpha.12 — 2026-10-26 · 叠放与父子彻底分离 + Blender 式列表拖拽

这一版把「层级」和「叠放」从**数据**到**手势**都拆干净：改谁就只改谁，另一个数据一个字节都不动。

### 叠放面板：只改叠放
- 拖拽落点收成两区（插到这一行之上 / 之下），写入只走 `ctx.moveDrawOrder` —— v10 之前这里调 `moveSubtree`（改 parentId），在叠放面板拖一下会静默改掉父子关系。
- `↑ / ↓` 改走 `drawOrder`（以前调 `reorderObject` 改 `doc.objects`，在 drawOrder 世界里点了没反应）。
- 「向下合并」的「下层」按 `drawOrder` 取（视觉上压在它下面的那个），不再按数组下一个。

### 父子面板：三区落点（Blender Outliner 手感）
- 行上缘 25% = 插到它上面（成为同一父级的兄弟）、中段 50% = 成为它的子对象、下缘 25% = 插到它下面；`before/after` 画 2px 强调线 + 左端圆点，`into` 是虚线框。
- 拖到空白 = 脱父并排到最底（`rootEnd`）。
- 拖进自己的子孙 → 淡红底 + 禁手光标（不弹窗，指针不动就能看出为什么）。
- 全部走 `ctx.moveSubtree`：一次 `setDoc`、一条撤销，**层级与叠放一起回退**。

### core
- `moveSubtreeDoc` 补第 3 步：整块子树在 `drawOrder` 里跟着搬（`before` → 目标子树首项之前，`after`/`into` → 目标子树末项之后，`rootEnd` → 末尾），末尾 `normalizeDrawOrder`。
- `app/core/layer-order.mjs` 新增 `treeZone(ratio)`、`reorderIndex(order, id, targetId, where)`（返回「移除自身之后」的下标，向下拖不会差一位）。

### 顺带修的
- 属性面板「纹理」组那行「重设」与按钮重名 → 按钮叫「应用」。
- 三处注释还写着 v10 前的两步模型（`setLayerParent` + `moveLayerTo`），已改成「层级走 moveSubtree、叠放走 moveDrawOrder」。
- 落点判定曾因「先记落点再清落点」导致上缘被当成中段，调换顺序后正常。

### 验证
`1035 tests / 1033 pass / 2 skipped / 0 fail`；静态检查 82 模块、`node --check` 82/82。真机：叠放拖 `a,b,c → a,c,b` 且三行 `parentId` 全空；父子拖 `c` 到 `a` 中段 → `c:a` + `drawOrder a,c,b`，一次撤销两样一起回退；1000×620 下 `.tree` 无溢出。
# MotionStudio 更新日志

## v0.3.0-alpha.11 — 2026-10-26 · 层级与叠放拆成两个模块，纹理搬进属性面板

按新规则这是**加功能 + 一次结构性重构**，批次 +1（0.2.x → 0.3.0）。契约写在 `docs/层级与叠放-2026-10.md`，一句话：**三件事各管一处，互不代偿**。

**1. 层级和叠放从此是两个独立事实**
以前只有 `parentId` 一棵树，叠放顺序是 `doc.objects` 的下标——于是「把父对象挪一层」会把它和它的孩子拆开，同一棵树能排出两种画法。现在：
- 层级 = `object.parentId`，归新模块 `app/core/hierarchy.mjs`（`parentChainOf` / `collectSubtree` / `isDescendant` / `treeOrder` / `normalizeParents`）。
- 叠放 = `doc.drawOrder: string[]`，归新模块 `app/core/draw-order.mjs`，`drawOrder[0]` 是最上层，集合与对象集合恒等，缺字段时 `normalizeDrawOrder` 现算（等幂）。
- **改层级不动叠放，改叠放不动层级**——这是这次重构唯一的硬规矩。

绘制侧跟着改：`composite.mjs` 与 `evaluator.mjs` 都按 `drawOrderOf(doc)` 逆序画。真机核对：同样是 `objects [红, 蓝]`，`drawOrder ['b','r']` 时中心像素是 `0,0,255`，`['r','b']` 时是 `255,0,0`。

**2. 对象面板一件事一个区域**
左列从「叠放 / 父子树 / 纹理库挤在 230 px」拆成上下两块：
- 上：「父子」面板（`app/editors/tree.mjs`，占 180 px）只编辑谁是谁的子对象——缩进 12 px/级、折叠、「N 个子对象」胶囊、拖到空白处脱父。
- 下：「叠放」面板只回答「谁盖谁」——纯扁平列表，没有缩进、没有折叠、没有缩略图，行尾一枚「N 纹」角标说明这个对象有几张纹理。拖拽只改 `drawOrder`，一次一条撤销。

**3. 纹理搬进属性面板**
「这个对象有几张图」属于对象属性，不属于画布秩序。属性面板多了「纹理」组：缩略图、数量、动作四枚（新建 / 独特化 / 删除 / 裁到内容）、画布尺寸与重设（左 / 中 / 右对齐）。对象面板里那一整截画格库连同它的缩略图、棋盘格、折叠箭头一起删掉了——搬家后留两份实现，下次改一处就得读三处。

**4. 术语统一：画格 → 纹理**
`app/**` 里 43 个文件、386 处「画格」全部改成「纹理」（画格库 → 纹理库、画格切换点 → 纹理切换点……）。**数据字段名不改**：`cels` / `drawing` / `celTimes` 保持原样，`.msp` 格式不受影响；映射表在 `docs/术语.md`。

**5. 增量播放速度与方式（alpha.10 的内容，本版一并发布）**
见下方 v0.2.0-alpha.10 一节。

**验证**：`node --test tests/*.test.mjs` → **1028 tests / 1026 pass / 2 skipped / 0 fail**；`npm run check` → 82 模块（静态检查 0 残留 0 坏 import、`node --check` 82/82）；70 个测试文件。新增 `tests/draw-order.test.mjs` 8 例、`tests/hierarchy.test.mjs` 6 例、`tests/order-render.test.mjs` 14 例。

**过程记录（照旧写在这里）**：删 `layers.mjs` 死代码时 `node --check` 一路绿，删完启动页面才炸出两处孤儿调用 `drawingsOf`（副标题与「N 纹」角标各一处），改走 `textureCount(layer)` 才干净——语法检查不等于能跑，这条已经第三次应验，`npm run check:syntax` 只能拦住语法层。

## v0.2.0-alpha.10 — 2026-10-25 · 预览播放：速度与方式

按新规则这是**加功能**，所以批次 +1（0.1.x → 0.2.0），`alpha.10` 接在上一个序号后面。两件事：播放能变速，播放方式补齐四种。

**1. 播放速度（观看偏好，不进文档）**
走带后面多了一枚 `1×`：点一下换档（0.25× / 0.5× / 1× / 1.5× / 2× / 4×），Shift+点倒着换，省得为降一档绕一整圈。速度存在 `ms.prefs` 里，重开窗口仍然是你上次的档位 —— 它描述的是「你怎么看」，不是「这段动画是什么」，所以不进 `.msp`。
真机：`1× → 1.5× → 2× → 4×`，`localStorage['ms.prefs'].playSpeed === 4`；1× 下每 110 ms 前进约 0.12 s。

**2. 播放方式四种：循环 / 来回 / 反向循环 / 单次**
方式是文档字段 `doc.loopMode`（设置 → 文档里本来就在改它），所以工具条那枚按钮**写文档**，两个入口是同一处真源，不会出现「面板说循环、播放却在往回走」。设置里的「往返」也统一改成「来回」，同一个模式不该有两个名字。
- 循环：播到末尾从头继续
- 来回：播到末尾倒着回来，往返不停
- 反向循环：从末尾倒着播到开头，再回到末尾
- 单次：播到末尾就停

四种映射收进 `app/core/playback.mjs` 的 `playbackAt(acc, total, mode)`（纯函数，node 里可直测），`playLoop` 只负责「乘速度、推进、必要时停」。真机采样（总时长 1 s，每 110 ms 一次）：循环 `0.70 / 0.83 / 0.95 / 0.07 / 0.18`；来回 `0.88 / 0.98 / 0.88 / 0.77 / 0.65`；反向循环从 0 起播 `0.88 / 0.77 / 0.65 / 0.55 / 0.43`；单次 `0.68 / 0.80 / 0.92 / 1 / 1` 且自动停。

**顺带修掉的两处**
- 反向循环刚接上时「一按播放就跳到末尾」：累计量从 0 起算，而反向的显示时刻是 `total - 累计量`。起播时按模式换算（`total - 当前时间`），现在从哪儿起步就从哪儿往回走。
- `ms.prefs` 的两处写入会互相覆盖（设置面板整份覆盖、工具条只改一项）。`commit()` 改成读-改-写：在设置里存一次，不会再把你刚调的速度冲回 1×。

**图标**：新增 `loop / pingpong / loop-reverse / play-once / gauge` 五枚（69 → 74）。「反向循环」用的是**镜像轮廓**而不是「同一圈换两个箭头尖」——16 px 下箭头尖只有 3 px，靠它分不出正反；镜像后连缺口位置都反了，一眼能看出两枚不是同一张图。

**验证**：`node --test tests/*.test.mjs` → **985 tests / 983 pass / 2 skipped / 0 fail**；`npm run check` → 77 模块（静态检查 0 残留 0 坏 import、`node --check` 77/77）；66 个测试文件。新增 `tests/playback.test.mjs` 13 例（四种方式的边界、退化输入、来回镜像对称、累计量连续不跳变）。
## v0.1.2-alpha.9 — 2026-10-25 · 关键帧移动与时间轴/曲线同步

用户反馈的一句话是「关键帧移动逻辑有问题，时间轴和曲线不同步，操作逻辑反人类」。三处根因叠加，逐条修：

**1. 曲线拖一下就「偷偷分家」**（主因）
在曲线里挪一个点，代码会顺手把该字段提升成独立轨道（`track.channels.x`），共用关键帧留在原地 —— 从这一刻起，时间轴那颗菱形不再驱动这个字段，曲线看的是另一套键。手柄拖动、右键改缓动、缓动预设、自动切线、删点、双击加点，六处都是同一句。现在统一由 `writeModeOf()` 判断：**只有已经是独立轨道才写通道轨，否则改的就是共用关键帧**；提升变成显式动作。

**2. 同一像素位置，两个面板落到不同时刻**
曲线过去是「无条件吸整帧 + Shift 吸画格」，时间轴是「磁铁开=吸帧 / Shift=关磁铁可落两帧之间 / 磁铁关=自由 / Shift=吸 0.1s 网格」。同一套操作在两个面板给出不同结果，这正是「不同步」的手感来源。现在共用一个判据 `snapForDrag()`：真机实测曲线拖 → 0.583s（第 7 帧）、时间轴拖 → 0.667s（第 8 帧），两边都按磁铁开关走。

**3. 拖到已有关键帧的时刻，另一颗点会静默消失**
时间轴遇到同刻冲突是「跳过并回报数量」，曲线却是静默合并。现在曲线也加闸门：目标时刻被别的键占着就不动，并提示「这个时刻已经有关键帧了：换一帧再拖，或先把那一颗删掉」。真机：两颗键 `[0.5, 1]`，把 0.5 拖到 1.0 → 仍是两颗。

**验证**：`node --test tests/*.test.mjs` → **972 tests / 970 pass / 2 skipped / 0 fail**；`npm run check` → 76 模块（静态检查 0 残留 0 坏 import、`node --check` 76/76）；65 个测试文件。新增 `tests/curve-write-mode.test.mjs` 15 例（写盘模式、磁铁四档、拖共用键行为、同刻闸门），`tests/curve-snap.test.mjs` 按新口径重写接线断言。

**顺手记下的两个探针坑**：合成 `PointerEvent` 必须显式给 `buttons: 1`（否则 `curve.mjs` 的 pointermove 会把拖动当场清掉，看起来像「曲线不可拖」）；曲线画布类名是 `.curve-plot`，标记点的 y 要用 `PAD_T/PAD_B + computeRange + vToY` 算，颜色扫描抓不到它。
## v0.1.1-alpha.8 — 2026-10-25 · 插入线跟随滚动

版本号 `0.1.1-alpha.8`（上一个标签 `v0.1.0-alpha.7`）。按新规则这是**纯修 bug**，所以批次不变、修订 +1。

你报的是「对象栈列表下滚之后，插入线会渲染在滚动前的位置」。根因很干净：列表是滚动容器，插入线是它的绝对定位子元素，子元素的 `top` 跟内容一起滚；而代码里用 `getBoundingClientRect()` 相减算出来的是**视口**坐标，少加了 `list.scrollTop` —— 于是滚多少就偏多少。

修法：把这段换算提成纯函数 `dropLineTop()`（带注释说明两种坐标系），并补 3 条测试（含「滚动后与未滚动的差值恒等于 scrollTop」）。真机在 1000×620、40 个对象、可滚 909px 下取四档：`scrollTop 0 / 130 / 290 / 899`，插入线的视口位置与目标行边缘差恒为 −1px（2px 线宽的正常覆盖）；修前在 130 档会高整整 130px。

逐条读数见 [修复列表 §1u](docs/修复列表-v8.md)。基线：**957 tests / 955 pass / 2 skipped / 0 fail**；76 个模块 0 残留、坏 import 0、语法 76/76。
## v0.1.0-alpha.7 — 2026-10-25 · 对象层级与笔刷参数批

版本号 `0.1.0-alpha.7`（上一个标签 `v0.0.1-alpha.6`）。**这一版起启用新的版本号规则**：`0.<批次>.<修订>-alpha.<序号>` —— 批次是「成批的用户可见功能」，修订只在纯修 bug 时 +1、加功能归零，`alpha` 序号全局只增不减。`0.0.1-alpha.*` 那七版记录为脚手架期。规则全文见 [合流计划 §5](docs/合流计划-2026-10.md)。

起点是你那两句话：「对象栈中的拖拽操作反人类，不能通过拖拽调整层次，附属对象不知道有什么用」与「UI 可不可以更美观，能不能多层嵌套父子关系」。

**对象层级（这一批的主体）**

- **换父不再跳位**：以前拖成子对象只改 `parentId`，父坐标系换了但关键帧的 x/y 没换算，松手当场跳到别处。现在按「当下这一刻」算一次位移并加到**所有**关键帧上 —— `t=0` 与 `t=1` 的世界坐标都不变。
- **三区拖拽 + 落点预览**：行的上 25% = 插到前面、中 50% = 变成子对象、下 25% = 插到后面；拖到列表空白 = 脱父排最后。落点是 2px 插入线 + 3px 圆点，非法目标（拖进自己的子孙）标红，拖到边缘自动滚动。
- **树形显示**：按深度优先排列，父子引导线 + 「N 子」计数胶囊 + 子行缩略图 22px；`Alt+点箭头` 只折一支分支；空态有文案。
- **键盘也能挪**：`Alt+↑/↓` 同级重排、`Alt+→` 缩进、`Alt+←` 提升（往外成为父的兄弟），一次按键 = 一条撤销。**方向口径按实测定稿**：`→` 往里、`←` 往外 —— 这与代码里 `demote`/`promote` 的命名顺序相反，接反过一次，被真机读数抓住。
- **属性面板承认父子关系**：对象组末尾多了「父对象」（点它跳到父）与「父级：脱离」两行；继承项补上「混合模式」凑齐五项。

**笔刷参数（上一轮欠的）**

- **压感接进画板**：链路本来就在舞台引擎里跑得好好的，画板自己的 `stamp()` 从没读过 `e.pressure`。现在接上了 —— 鼠标与 `pressure===0.5`（设备不支持压感）恒按满压画，逐像素与改动前一致（同一手势同哈希 `a5347625`）；真机 pen0.2 中位宽 4px、pen0.8 16px、pen1.0 18px。
- **间距按 Klecks 口径重标定**：根因是口径差 —— Klecks 的 `settingSpacing = 0.8489` 是**半径**倍数，我们按**直径**存，0.12 实际等于 0.24·R，比它密 3.54 倍（软笔 5.31×、散点 8.49×），这正是「半透明笔两点就变实色」的来源。七支笔全部重标定，并做了一次性迁移（只删「恰好等于旧默认值」的 spacing，你手调过的值原样保留）。
- **修掉一个既有缺陷**：稳定器开高档时松手，笔迹尾巴会断成一段段空白（档位 5 时断 95 列）—— 追平稳定器滞后原来只落一个点，现在按间距插值补点，实测空段 0。

**流水线（这一批才补上的挡板）**

- 新增 `npm run check:syntax`：对 `app/**/*.mjs` 逐个 `node --check`（76 个模块，几百毫秒）。原因很直接 —— 这一批**两次**出现「测试全绿 + 静态检查干净 + 页面白屏」（一次是一个函数被 `export` 两次，一次是文件被写了一半少个 `}`），而 `npm test` 从不加载 DOM 模块、静态检查也不做语法解析。现在 `npm run check` 串起两者。
- 三条遗留 P2 一并收口：`setDoc` 的 updater 抛错会提示「这次修改没有生效（内部出错）」而不是只打控制台；手改存档造成父子成环时会提示「文档里有循环的父子关系（N 个对象），它们不会被绘制」（只提醒一次）；老存档缺 `duration` 时补 0 而不是让键不存在（形状与 `createDocument` 对齐）。

逐条读数见 [修复列表 §1t](docs/修复列表-v8.md)。基线：**954 tests / 952 pass / 2 skipped / 0 fail**；静态检查 76 个模块残留 0、坏 import 0；语法检查 76/76；64 个测试文件；69 个图标。
### 本版期间的另一处修复 · 「适配」零变化时的静默（提交 c0dd10e）

你反馈「点击适配还是没用」。查下来的结论与上一批正好相反：**适配没坏，是它在"没有变化"的时候一句话都不说**。

- 画板刚建纹理时 `ensureFit()` 就已经把相机放到适配位，此时再点「适配」算出的是同一组 `zoom/panX/panY`，画面逐像素相同 —— 从用户视角看就是按钮失效。实测：新建后纹理屏幕矩形 1121×797，点适配仍 1121×797；普通滚轮放大六档后撑到 1439×821，再点适配才回到 1121×797。
- 现在两个工作区的「适配」都会说话：已就位时提示「视图已经在适配位置：整张纹理都可见。要去掉四周的透明区，用「裁到内容」」，真的改变了视图时提示「已适配视图：…」。编排侧 `engine.fitView()` 改为返回「这次是否真的改变了视图」，HUD 据它区分两种情形。
- 画板「适配」的 title 补成「把整张纹理缩放到刚好可见（只动视图，不改像素）· 0 键」，把「适配 ≠ 裁图」写进悬停提示里。

逐条读数见 [修复列表 §1s](docs/修复列表-v8.md)。（该修复单独提交于 `c0dd10e`，随本版一起发布；当时的基线是 873/871。）

## v0.0.1-alpha.6 — 2026-10-25 · 纹理像素尺寸批

版本号 0.0.1-alpha.6（上一个标签 v0.0.1-alpha.5）。

起点是你那句「画板的对象尺寸适配无法使用，当我擦除冗余部分时点击适配后无法去除透明通道尺寸到合适尺寸，以及无法在画板中调节对象尺寸」。查下来的结论是：**这件事从来没有入口**，不是坏了 —— 画板的「适配」只改视图相机（`board.mjs:255 fit()`），像素一个都不动；全仓既没有「裁到内容」也没有「重设纹理画布尺寸」的命令。

现在画板的动作段尾部多了四个控件：`⌗ 裁到内容`、`[宽] × [高]`、`▣ 应用`、`居中⌄`（九宫格对齐，默认居中）。

- **裁到内容**：按 alpha 包围盒把纹理裁成紧凑位图，同时把对象原点补上 `(box.x, box.y)` —— 画面不跳，只是四周透明被去掉、对象尺寸变成真实内容尺寸。真机界面路径：900×640 画一笔 → 裁 → **45×25**、原点 427/306、尺寸框自动跟着变；`Ctrl+Z` 一次图与位置一起回滚。
- **重设画布**：宽/高 + 对齐，扩展时内容按对齐方式落到新画布、原点反向补偿，**内容在世界坐标里不动**。上限 4096（与 `doc-model` / `BOARD_MAX` / 属性面板三处既有限制一致）。
- 两件事都是**一次操作一条撤销**；失败一律返回 `false` 并自己提示（全透明 / 四周没多余透明区 / 尺寸越界 / 尺寸没变化 / 读不出像素），不静默。
- 尺寸控件会跟着文档实时刷新（`＋纹理`、`undo`、`redo` 之后都是）—— 上一版的「按钮停在旧禁用态」不会再出现。

同时修掉两个会误导人的东西：

- **动作名跨面板撞名**：顶栏「新建项目」和画板「＋纹理」都叫 `data-act="new"`，任何跨面板的选择器都会取错按钮。画板改用 `new-tex`，并加了一条静态测试把两张动作表求交集（非空即失败）。
- **对象栈工具条不再折叠**：复制 / 上移 / 下移 / 合并 / 删除 五个动作回到面板工具条常显（纯图标 22×22，`title` + `aria-label`），`⋯` 菜单与它那套浮层/外部点击逻辑整体删除。新增 `chevron-up`、`merge-down` 两枚图标。

逐条与真机读数见 [修复列表 §1r](docs/修复列表-v8.md) 与 [纹理尺寸](docs/纹理尺寸-2026-10.md)。基线：**873 tests / 871 pass / 2 skipped / 0 fail**，静态检查 74 个模块、残留 0、坏 import 0，图标表 68 枚。

## v0.0.1-alpha.5 — 2026-10-25 · 项目管理批

版本号 0.0.1-alpha.5（上一个标签 v0.0.1-alpha.4）。

起点是你那句「项目管理检查一下，有什么缺点，与主界面交互等，总结问题合并计划并修复」。审计做出来的结论是：**项目库把「文件管理器」的心智套在了「文档状态机」上** —— 它能存能读能改名，但任何一次「载入 / 新建 / 删除」都直接换掉或丢掉内存里的文档，而整个界面里**没有一处承认「当前文档有未保存的改动」**。真机可复现的丢数据：改一处属性（顶栏出现 `•`）→ 在库里点「载入」→ 改动消失、`•` 消失、全程零对话框。全量拆解与验收读数在 [项目管理](docs/项目管理-2026-10.md)，逐条在 [修复列表 §1p](docs/修复列表-v8.md)。

**不再丢东西**
- 新增纯函数 `app/core/project-guard.mjs` 的 `guardDecision()`：干净 → 直接走；有未保存改动且**已有名字** → 静默入库再走（保存过的人不该被每次打断）；**未命名** → 三选「保存并继续 / 丢弃改动 / 取消」。载入、新建、导入三个入口统一走它。
- **未命名项目现在也会自动保存**：写单条草稿 `__draft__`（不出现在项目库列表里），下次启动问「发现上次未保存的草稿（HH:MM），要恢复吗？」。跨页面真机验证恢复后对象名一字不差。
- 删除项目改为「确认 + 8 秒撤销」；删掉当前项目后顶栏回到「未命名项目」并说明「文档还在内存，Ctrl+S 可重新入库」。
- 关窗口保护：`beforeunload` 只在脏时阻止，已命名的先静默入库再放行。

**一个「自动保存其实没在保存」的真缺陷**
- 1s 自动保存拍子原本写在偏好面板里（注释写着「拍子跟着面板存亡」）—— 用户切到「编排」或「画板」，设置面板被卸载 → `clearInterval` → **自动保存从此不发生**。现在拍子挂在 `installProjectSafety()` 里跟应用走，间隔与开关仍读同一份偏好。
- 同时修掉 `autoSaveProject()` 入库分支漏更新 `savedAtMs`：定时器跑了、库也写了，但「上次保存时间」不动。
- 首次 Ctrl+S 不再弹系统文件对话框（那是「另存为」的行为）；重命名当前项目不再把它标脏。

**项目库面板**
- 点卡片任意处即载入（原来 `cursor:pointer` 却只有四个小按钮能操作）；动作只留 `重命名 / 存为文件 / 删除`，删除用 `--danger`。
- head 收成「＋ 新建项目 ｜ 搜索 ｜ `…` 菜单」：低频项（导入项目文件 / 导出精灵图 / 刷新 / 导入图片）进菜单，「导入图片」不再冒充项目库动作。
- 搜索按名字实时过滤 + 「没有匹配的项目」；卡片补「保存于 今天 HH:MM」与画布尺寸、对象数。
- 240 行内联样式表 `MODAL_CSS` 整体搬进 `app/styles/projects.css`（`index.html` 引入）并删除注入代码，顺带修掉那句因 `inherit` 非法而**从未生效**的 `font:12.5px/1.5 inherit`。三尺寸审计：`truncation` 0、可点区 <20×20 **0 个**、字号 ⊆ {11,12}。
- 三选浮层出现时**库浮层留在原地**并 `inert`（不再「库没了、突然冒出个对话框」），Esc 只关三选不关库；`…` 菜单先吃 Esc。

**顶栏与帮助**
- 项目区拆三段：图标 + 名字 + 脏点。未入库显示「未命名项目（未入库）」，脏点带 `aria-label`，保存成功有 ≤800ms 的「已保存」反馈，`title` 补「上次保存 HH:MM:SS · 存储：indexeddb / memory」。
- 帮助表「文件」组 5 → 6 行：补 `Ctrl+S 保存到项目库`、`Ctrl+O 打开项目库`，以及一条行为说明（载入/新建前自动保存已命名的项目，未命名会先问你）。

**一条方法论教训**
- 本轮改 `project-io.mjs` 时出现重复 `export`，**页面白屏**，而 `node --test` 仍 846 全绿、`_check-static` 仍干净 —— 因为测试不 import 这个 DOM 侧模块、静态检查只验 import 路径存在性、不做语法解析。**测试绿 ≠ 页面能开**，本轮起动该文件必须真机开一次：页面能加载、`.top-project` 非 null、CDP `exceptionThrown` 为零。

基线：**846 tests / 844 pass / 2 skipped / 0 fail**；静态检查 73 个模块、残留 0、坏 import 0；测试文件 54 个；图标 64 枚。

## v0.0.1-alpha.4 — 2026-10-25 · 风格统一与鲁棒性批

版本号 0.0.1-alpha.4（上一个标签 v0.0.1-alpha.3）。

这一批的起点是「按你自己的感觉来……你自己发现问题然后统一风格，检查代码鲁棒性后，解决现有所有问题」：先把**已有的**视觉语言收敛成一套，再让画板**不再靠隐藏文字来省宽度**，最后用审计把「能坏但还没坏」的地方一次性钉住。逐条证据在 [修复列表 §1o](docs/修复列表-v8.md)，审计全文在 [鲁棒性审计](docs/鲁棒性审计-2026-10.md)。

**视觉统一**
- 令牌收口：`--h-field` 20 → **22px**（同面板 `input` 与 `select` 并排差 2px）、`.prop-title` 由 `--h-bar` 改 `--h-head`（26 → 24，与面板顶边基准对齐）。
- 选中态从四种语言收成一套：新增 `--sel-bg` / `--sel-bg-strong` / `--sel-bar`，对象行与画格行共用两种强度；实心强调色统一改 `--accent-2`（白字 4.24 → **5.73:1**），`--accent` 只留给身份色（关键帧菱形、播放头、分割线）。
- 13 个面板顶部各自挂 3 个常驻字形按钮（共 **39 个**）改为悬停显现：`opacity` + `:hover` / `:focus-within` / `:focus-visible`，`@media (hover: none)` 恒显 —— 键盘仍可达，低频操作不再占用最高频的位置。

**画板**
- **工具条改三段**：工具段（7 支笔 + 色板 + 取色 + 填充 + 镜像）｜动作段（撤销/重做/稳定器/画格前后/＋纹理/独特化/适配，1px 竖线分隔）｜参数段（六项常显）。**删掉整个参数浮层**（`settingsBtn` / `openPop` / `closePop`），同一个参数不再有两个入口，「恢复默认」并入末格行尾。
- **参数段是真网格**：`repeat(auto-fit, minmax(360px, 1fr))`，每格固定「标签/滑杆/数值」，`.bd-lab` 恒 44px 右对齐、数值 44px `tabular-nums`；1680 → 3 列×2 行、1280/1000 → 2 列×3 行，参数段高 48 / 72 / 72，最小窗口画布从 367 抬到 **395px**。
- **不再靠隐藏文字省宽度**：删掉 `board.css` 里两条 `@media (max-width:1100px)` 的 `display:none`（「＋纹理 / 独特化 / 适配」的文字与六项参数标签于是被**删掉**而不是截断）。宽度不够时改为折行。
- 7 支笔从单字（像/圆/软/铅/晕/散/擦）改为「图标 + 两字短名」，配全名 `title`。

**图标**
- 新增 12 枚（7 支笔的剪影 + `flip-h/v/both` + `sliders` + `stabilizer` + `image-plus`），总数 **64**。
- **三档线宽真正归一**：`stroke-width: calc(1.3 * 24 / var(--icon-px))`，14 / 16 / 28px 三档物理线宽全部 **1.3px**（改前分别是 0.93 / 1.07 / 1.87）。测试钉住「不许写死数字 stroke」。

**鲁棒性（审计：没有 P0）**
- **旧存档按 1 fps 打开的缺陷**：`doc-model.mjs` 的 `clampNum(old.fps, 1, 120) || 12` 是死代码 —— `clampNum` 对非有限数返回下限，所以缺 `fps` 的 v1–v3 存档落到 **1**，播放慢 12 倍、刻度与导出时长全错 12 倍。修后 v3 无 `fps` / `fps:0` 都回到 12，`fps:24` 保持 24，真实 v4 存档逐项不变（它不走 `migrateFromFrames`）。
- 导入对话框开着时改文档会被导入结果整体覆盖（此前靠模态阻挡，「碰巧安全」）：现在等值时仍走整体替换，不等时只把新对象并进当前文档。
- `prefs` 里 `sizeW/sizeH` 与 `objectW/objectH` 字段名不一致 → **面板改的对象默认尺寸重启后失效**：改为新键优先 + 旧键兜底 + 双写，跨重启生效。
- `prefs` 增加白名单与逐项校验（`cleanPrefs` 纯函数）；`undoLimit` / `objectW` 的 0 与负数退回缺省而不是夹到下限；`createDoc` 补 **4096** 上限（与仓库既有三处限制对齐）。
- 如实标注：`JSON.parse` 全仓 10 处无一裸奔、22 个恶意 payload 一个没抛 —— 这一批修的是「能坏但还没坏」的地方，不是已爆的雷。

**基线**：809 tests / 807 pass / 2 skipped / 0 fail；静态检查 72 个模块、帧概念残留 0、坏 import 0；51 个测试文件；图标表 64 枚。

## v0.0.1-alpha.3 — 2026-10-25 · 交互与视觉收敛批

版本号 0.0.1-alpha.3（上一个标签 v0.0.1-alpha.2）。以下四个批次是 alpha.3 之后的连续工作，随 alpha.4 一起发布。

四个提交：`72c9527` 图标系统与帮助收口 · `80d3c24` 画板取色/稳定器 · `ec4dce9` 命中与锚点/导入裁剪 · `d92a567` 视觉令牌与最小窗口。

**画板**
- **右键 / `Alt+左键` 取色**：对照 Klecks 补齐的临时工具（`tempTriggers = ['mouse-right','alt']`），按住连续取、松开回原笔刷，不写笔刷状态、不进撤销栈；透明像素提示而不是返回黑色（有意差异，已记录）。
- **手抖稳定器 6 档**：`app/paint/stabilizer.mjs` 纯函数（level→α 表 + Klecks 滞后公式对照），按钮与 `Ctrl+滚轮` 调档；真机同轨迹笔迹包围盒 21px → 8px、拐点 3 → 1、二阶差分均值降到 5.8%。
- 工具表与画板栏图标化，7 个笔刷名保留文字；`＋纹理` 不再「点了没反应」（同时把它放进时间轴）。

**编排 / 画布**
- **命中测试**：`quadInverseLocal` 把越界解夹回 `[0,1]`，导致对象左/上界外 1–2px 反被算中；`uv === 1` 时索引越界，最右一列、最下一行点不中。新增 `latticeInverseRaw` 与 `element.localUv`，容差不再由三样东西乘积决定。
- **旋转原点可以直接拖**（修复列表 #64 的真实原因）：命中分支自始就在，但 `applyMatrix` 返回 `{x,y}` 被当成数组取 `a[0]` → `NaN` → 恒 false，按在原点实际命中 `nw` 手柄（实测缩放 X 被拖成 −12.333）。改为 `pickAnchor` / `anchorUvFromMatrix`，拖动只画虚线预览、松手写一次 `setAnchor`、`Esc` 取消、一次拖动一条撤销。
- 画布 HUD 由「适配 + 百分比」两个孤立按钮改成分段缩放带（`−` / 百分比 / `＋` / 适配）。

**导入**
- PSD 图层与 PNG/JPG/WebP 一律裁到 alpha 包围盒：对象贴合内容、世界位置不变（`left + dx`），超大图按 `IMAGE_TRIM_MAX_PIXELS` 跳过并记 `trimSkipped`。`alphaBounds` 改整 32 位字扫描 + 整行短路，8000×8000 满层 97.5ms → 66µs。

**界面**
- 内联 SVG 图标系统（`app/core/icons.mjs`，52 枚 24×24 stroke 1.6，零 DOM 零依赖）：顶栏、对象面板、属性面板、变换组、时间轴工具条、曲线预设、区域头、命令面板全部换成图标 + `title` + `aria`。
- 帮助 / 图例收口为**唯一数据源**（`help.mjs`）：设置工作区渲染 6 张帮助面板、`.tline-legend` 与 `?` 浮层同源；顺带补上 3 条「代码有、表里没有」的键位。
- 字号 9 档收到 4 档（12 / 11 / 10 / 13），补 `--icon*` / `--sp-*` / `--t-fast` / `--focus-ring` 令牌；属性组标题吸顶；开关命中区 34×16 → 34×22。
- 最小窗口（1000×620）逐工作区收溢出：时间轴工具条按级收字并可横滚、画板栏 1100px 断点收标签（内容 782 → 726，余 +34）、属性行可换行、区域头不再画到邻居身上。
- 项目库空态重做（图标 + 主副文案 + 主按钮）；`main.js` 写死页面缩放策略（附证据边界：本机负对照显示原本也不缩放，属防御性约束）。

**第二批（同日收尾，四个提交）**：`e8ff561` 刻度尺适应全长 · `1763745` 导入图像命中 · `a93faea` 快捷键浮层最小窗口 · `20666d2` 画板油漆桶。

- **画板油漆桶**（`G`）：`app/paint/fill.mjs` 是纯函数（`floodFillRegion(data,w,h,sx,sy,hex,tol)`），容差 24、四邻域、填完 alpha 写 255；撤销绑 canvas 引用而不是对象 id，所以换画格后再撤销也不会写错图。导入的位图纹理（`ImageBitmap` 无 `getContext`）显式拒绝并提示。连填 20 次中位 2.9 ms。
- **导入的图片与 PSD 图层现在点得中**：`pixelAlpha` 用 `getContext('2d')` 读像素，而导入链路产出的是 `ImageBitmap` —— 永远读回 0，整张图被判为全透明。新建 `app/core/hit-mask.mjs`（`alphaMaskOf` + `WeakMap` 按图像对象缓存，失败也缓存 null），`hitTest` 改走掩膜；掩膜不可用时退回矩形命中（宁可多选中一次也不要选不中）。首次含构建 5 ms、缓存后 0.013 ms/次。
- **双击刻度尺 = 适应全长**：`timeline-geo.fitZoom(doc, availPx)` 是纯函数，`ZOOM_MIN/ZOOM_MAX` 夹紧，时长或视口为 0 时返回 null 而不是猜一个数。
- **`?` 浮层在最小窗口不再切字**：`max-height ≤ 700px` 时加宽到 900px、内容三列、`max-height 84vh`，`.keys-body` 补细滚动条与 `overscroll-behavior: contain`（原来 1000×620 下 62px 内容被滚出视野且没有可见滚动条）。
- 可点区全部 ≥20×20（`prop-toggle` 34×16 → 34×22 实体盒、`prop-check` 14×22 → 20×20、`pal-hue` 18 → 20px 并删掉 `palette.mjs` 里重复的内联尺寸）；`.bd-bar` gap 5 → 4px，1000×620 内容 738 → 728。
- 帮助表补最后一条「代码有、表里没有」：`V` 选择工具；`tests/shortcuts-overlay.test.mjs` 的行数断言改成跟着数据走（`expectedRows` 由 `SHORTCUT_GROUPS` 推导）。

**第三批（同日收尾，四个提交）**：`d9fe18f` 帮助表按工作区拆组 · `e78aa2f` 播放刷新分级 · `7dcc822` 合并对象保留变换 · `54520b5` 台账。

- **播放时刷新真正分级了**（修复列表 P0 #12，两轮之前就记成「进行中」的那条）：`refreshPanels` 的两档其实跑的是同一个循环 —— `full` 只写进统计字段，「只刷跟时间有关的面板」从未生效。新建 `app/shell/refresh-plan.mjs`（`planRefresh` / `celSignature` 纯函数，判据只有「该面板的 refresh 读不读 `ctx.time()`」，逐模块列代码行做理由），面板耗时 40 对象档 99.7 → 35.5 ms/秒、`layers` 30 次/秒 → 1 次。**顺带修掉「暂停时没有全量补刷」**：停止分支现在补 `scheduleRefresh()`，属性面板不会再停在播放中的旧值。
  - 如实标注：本机 40 对象档改前改后都是 60 帧、`maxGap 16.8 ms`、长帧 0，**掉帧定性需要弱机复测**；3 对象档 50.9 → 56.2 ms 是噪声，不算收益。
- **向下合并不再吞掉上层的变换**（P1 #15）：`mergeDown` 以前用 `drawImage(image, 0, 0)` 以单位矩阵烤上层，位置/旋转/缩放/不透明度动画一合并就没了，纯变换关键帧更是完全不参与采样。改为复用 `evaluator.drawEvaluated` 的两条既有分支（下层 `ignoreTransform`、上层 `baseMatrix: inv(Ml)`），合成语义仍只有一份；真机六组 800/800/800+1600/800+800/127 全部归零。唯一保留的差异「结果落到下层坐标系」不是 bug，已在合并菜单提示里说明。
- **`?` 浮层与设置里的键位表按工作区拆成 6 组**（文件/时间/关键帧/编排画布/画板/视图）：`E` 在编排是橡皮、在画板是取色器，`空格` 在编排是播放、在画板是按住平移 —— 以前挤在一张表里，两种语境互相打架。每条都给了代码行锚点，没有一条指不到行。

**基线**：741 tests / 739 pass / 2 skipped / 0 fail；静态检查 70 个模块、帧概念残留 0、坏 import 0；45 个测试文件；图标表 52 枚。

## v1.0.0-beta.1 — 2026-10-25 · 第一个公开测试版（Beta）

**定位**：本机运行的时间驱动 2D 动画编辑器（Beta：接口与文件格式仍可能变）。没有「帧」这个概念，只有秒与关键帧；画板与编排彻底分离；纹理挂在关键帧上。

### 核心模型
- **时间即唯一主轴**：`object.transform.keys = [{ t, state, ease, h1, h2, drawing }]`，`t` 是秒，任意浮点时刻都能打帧，插值/缓动/网格变形全部连续。
- **纹理属于关键帧**：`key.drawing` 指向对象纹理库里的一张图；`drawing: null` 表示显式空白，缺字段表示沿用上一张。换图 = 一次关键帧操作，时间轴只有一条轴。
- **对象层级与时间通道**：父子变换、可见性/不透明度沿父链生效（`effectiveVisible` / `effectiveOpacity`）；每个对象有自己的时间偏移/倍率/循环模式。
- **统一求值器**：`core/evaluator.mjs` 一条路径同时应用局部时间、父链矩阵、变换通道与效果链，渲染/导出/命中测试共用。

### 画板（独立纹理编辑器）
- 自带 canvas 与私有相机（zoom/pan），与舞台零共享，落笔与纹理像素 1:1（真机四点测量偏差 ≤1px）。
- 笔刷：像素笔 / 圆笔 / 软笔 / 铅笔 / **晕染** / **离散点** / 橡皮；硬度·间距·抖动·流量可调并按笔刷记忆。
- 取色器（`E`）、镜像（无/左右/上下/四向）、`[` `]` 调笔尖、`1..7` 直选笔刷、笔刷游标圈、`0` 适配、空格/中键平移。

### 编排
- 时间轴：播放控制与读数在工具条内（VS Code 式分区），`first/prev/play/next/last` + 加曝光/删画格 + 加关键帧 + 磁铁吸附 + 缩放；`Ctrl+滚轮` 以指针为锚缩放。
- 关键帧：多选/框选/批量缓动/拖动预览（松手才写文档）/复制粘贴/跳上下关键帧/冲突跳过，文档级撤销与像素撤销共用一个历史栈。
- 曲线编辑器：按通道语义给纵轴范围（旋转 ±180°、不透明度 0–1、位置 0–画布边长），横向可平移（中键/Alt+拖动），支持贝塞尔切线。
- 属性面板：分「对象段 / 工程段」两段；可改名字、尺寸（整张拉伸）、不透明度、可见性、**旋转原点**（百分比 + 居中，换原点不换位）。

### 导入导出
- **PSD 导入**：自研纯 JS 解析器（PSD/PSB、8bit RGB/Gray、raw/RLE/zip/zip+预测），图层 → 对象、组 → 父子层级、blendMode → mixMode；支持对话框导入与拖放导入。
- 导出：**WebM 视频**（MediaRecorder，优先 VP9）、精灵图（PNG + 每帧坐标 JSON）、PNG 序列、项目存档（`.msp`，纹理与纹理库一起存）。
- 宣传片与素材：`docs/promo/`（27.4s，代码绘制，可重新生成）。

### 工程
- 605 个单测（603 pass / 2 skip / 0 fail），`npm test`；静态检查 `npm run check` 扫 65 个模块，0 残留 0 坏 import。
- 无构建步骤、无运行时第三方依赖；Electron + 原生 ESM。

### 已知限制
- 窗口被遮挡/最小化时 Chromium 节流合帧，MediaRecorder 会录出静止画面；WebCodecs 路线可用但与可见性无关的封装暂无 Cues 索引（进度条拖动受限）。
- PSB 与「组内只含调整层/带蒙版」等边缘形态未用真实样本回归；16/32 位与 CMYK/Lab/索引色 PSD 不支持。
- 画布上直接拖旋转原点尚未接线（面板数字框与「居中」可用）。**后续（0.0.1-alpha.3）**：已修复，根因是命中分支把 `{x,y}` 当数组取值得到 `NaN`、恒不命中 —— 见修复列表 #64 与 [画布锚点拖动](docs/画布锚点拖动-2026-10.md)。
