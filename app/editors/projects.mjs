/**
 * MotionStudio —— 项目库面板（editors/projects.mjs）
 *
 * 本地项目库的 UI，纯 DOM，不嵌 iframe：左侧列表以卡片形式展示已保存的项目
 * （缩略图、名称、纹理数×尺寸、体积、最近打开、绑定文件），**点卡片任意处即载入**，
 * 卡片上只留次级动作 `重命名 / 复制 / 历史 / 另存为 / 删除`（删除走危险色）。
 * 五条动作在 258px 卡片里放不下带文字的按钮，所以卡片动作一律图标化（见 styles/projects.css
 * §4）：`title` 与 `aria-label` 保留完整动作名，悬停与读屏都能读出来。
 *
 * 顶部（`.prj-top`）只有一个主行动「新建项目」+ 搜索框 + 排序下拉 + 标签筛选
 * （有标签时才出现）+ `…` 菜单：
 * 低频项（导入项目文件 / 导出整个项目库 / 导出精灵图 / 刷新 / 导入图片到当前文档）
 * 全部收进菜单；「解除文件绑定…」是**条件项**，只在当前项目绑定了 .msp 时出现。
 * 为什么收：它们是四件不同层级的事——「导入图片」改的是当前文档、「导出精灵图」
 * 是导出、「刷新」对本地库基本无意义，过去五个按钮平铺在一行，视觉权重与
 * 「新建」等同，用户不知道哪个是主操作。
 *
 * P2（alpha.46）给库加了排序 / 收藏置顶 / 标签 / 库容量四件事：
 *   - 排序：`SORT_MODES` 四档，选择存 localStorage（`ms.projects.sort`，读写都容错）；
 *   - 收藏：卡片右上角星标 → `api.setPinned(id, pinned)`，置顶永远排最前；
 *   - 标签：卡片名字下方的 chips（最多 3 个 + `+N`，末尾 `+` 调 `api.editTags(id)`），
 *     点 chip = 按该标签筛选；顶部标签下拉的第一项是「全部标签」；
 *   - 库容量：计数行追加「· 合计 X」（`api.totals(rows).bytes`，走现有 `fmtBytes`）。
 * 排序/筛选都是纯函数（`filterByTag` / `tagOptions` / `fallbackSortRows`），外壳接口
 * 不可用时退回本地排序 —— 面板半接线的状态也不许白屏。
 *
 * 「导入图片」走 `<input type="file" accept="image/*">` + FileReader（浏览器原生文件选择，
 * 不是主进程对话框）：选中的图片被当成一个 kind:'image' 对象插进**当前文档**的最上层，
 * 居中摆放，并从 0 秒起一直可见（纹理只在 0 秒落一次）。数据转换在 shell/project-store.mjs 的 imageElementFromFile /
 * addImageElement 里，面板只负责取文件与换文档。
 *
 * 数据与动作全部来自外壳注入的 `ctx.project`（见 shell/app.mjs 的 projectApi）：
 *   list() → Promise<记录[]>  current() → {id,name,file}|null  open(id)  create(opts)
 *   save(name?)  rename(id,name)  remove(id)  duplicate(id)  importFile()  exportFile()
 *   exportLibrary()  unbindFile()  subscribe(fn) → off()
 *   P2：setPinned(id,pinned) → {ok:true,pinned} | {ok:false,error}
 *       editTags(id) → {ok:true,tags} | {ok:false,canceled} | {ok:false,error}（两者异步，对话框在外壳里）
 *       sortRows(rows,mode) → 排好序的新数组  totals(rows) → {count,bytes}
 * 面板本身不认识 IndexedDB、不认识文件对话框，换存储不影响这里。
 *
 * 「该不该保存」这类判据一律不在这里：`api.open()` 内部会走 `beforeSwitch`（project-io.mjs），
 * 文档脏时由守卫浮层决定保存/丢弃/取消。面板只负责把「点被挡住了」和「点了没反应」
 * 区分开——busy 时给文案 + `aria-busy`，守卫浮层开着时整块面板 `inert`。
 *
 * 样式归 app/styles/projects.css。本文件只写类名；仅「重命名输入框所在行」这类
 * 必须在运行时才存在的对象用了极少量内联样式，保证在任何 CSS 下都可见。
 */

import { addImageElement, imageElementFromFile } from '../shell/project-store.mjs';
import { icon } from '../core/icons.mjs';
import { t } from '../i18n/index.mjs';

// 下面两张表是模块级常量，用户看得见的字段一律写成访问器：setLocale() 只换表、
// 不重建常量，写成普通属性会把首次渲染时的语言冻在里面（docs/本地化.md §5）。
// `act` / `icon` / `danger` / `sepBefore` 是行为与样式用的，不随语言变。

/** 卡片上的次级动作。顺序即渲染顺序；`danger` 的那条走 `--danger`。
 *  `duplicate` 是「库内另存一份」（副本有自己的 id，不碰任何文件）；
 *  `export` 的语义是「把这份项目另存为 .msp 文件」（写完会把 project.file 绑到新路径），
 *  文案与 title 在 `parts/projects.mjs` 里写清「另存为」，不再叫含糊的「存为文件」。 */
export const CARD_ACTIONS = [
    {
        act: 'rename',
        icon: 'pencil',
        get label() {
            return t('projects.card.rename');
        },
        get title() {
            return t('projects.card.rename.hint');
        },
    },
    {
        act: 'duplicate',
        icon: 'copy',
        get label() {
            return t('projects.card.duplicate');
        },
        get title() {
            return t('projects.card.duplicate.hint');
        },
    },
    {
        // 版本历史（alpha.47）：列出最近 10 条保存快照，可恢复到任意一版；恢复前先把
        // 当前状态存成一条历史，所以恢复本身可撤回。定时器图标表示「时间点」。
        act: 'history',
        icon: 'timer',
        get label() {
            return t('projects.card.history');
        },
        get title() {
            return t('projects.card.history.hint');
        },
    },
    {
        act: 'export',
        icon: 'save',
        get label() {
            return t('projects.card.export');
        },
        get title() {
            return t('projects.card.export.hint');
        },
    },
    {
        act: 'delete',
        icon: 'trash',
        danger: true,
        get label() {
            return t('projects.card.delete');
        },
        get title() {
            return t('projects.card.delete.hint');
        },
    },
];

/** `…` 菜单项。`sepBefore` 之后是「不属于项目库」的那一项，用分隔线标出层级差。
 *  条件项（只在有绑定文件时出现的「解除文件绑定…」）不在本表里，见 `menuItemsFor()`。 */
export const MENU_ITEMS = [
    {
        act: 'import',
        icon: 'folder-open',
        get label() {
            return t('projects.menu.import');
        },
        get title() {
            return t('projects.menu.import.hint');
        },
    },
    {
        // 「另存为」显式入口：把**当前文档**写成一个新的 .msp（弹保存对话框，可换路径）。
        // 与卡片上的 export 不同：那个写的是库里那条记录，有未保存改动时它是旧内容。
        act: 'saveAs',
        icon: 'export',
        get label() {
            return t('projects.menu.saveAs');
        },
        get title() {
            return t('projects.menu.saveAs.hint');
        },
    },
    {
        // 整库备份：把每个项目打包成一个 JSON（不是 .msp 单项目文件），
        // 恢复走「导入项目文件」—— 外壳会自动识别备份包并批量入库。
        act: 'exportLibrary',
        icon: 'save',
        get label() {
            return t('projects.menu.exportLibrary');
        },
        get title() {
            return t('projects.menu.exportLibrary.hint');
        },
    },
    {
        act: 'sheet',
        icon: 'grid',
        get label() {
            return t('projects.menu.sheet');
        },
        get title() {
            return t('projects.menu.sheet.hint');
        },
    },
    {
        act: 'refresh',
        icon: 'rotate-ccw',
        get label() {
            return t('projects.menu.refresh');
        },
        get title() {
            return t('projects.menu.refresh.hint');
        },
    },
    {
        act: 'image',
        icon: 'image-plus',
        sepBefore: true,
        get label() {
            return t('projects.menu.image');
        },
        get title() {
            return t('projects.menu.image.hint');
        },
    },
];

/**
 * 「解除文件绑定…」：**条件项**，只在当前项目绑定了 .msp 文件时出现。
 *
 * 为什么不放进 `MENU_ITEMS`：它盖的是「文件身份」，没有文件时出现只会让人点空。
 * 判定用 `menuItemsFor(file)`，`file` 由 `reload()` 从 `api.current().file` 缓存 ——
 * 纯函数，Node 里可直接测。
 */
const UNBIND_ITEM = {
    act: 'unbindFile',
    icon: 'unlink',
    get label() {
        return t('projects.menu.unbindFile');
    },
    get title() {
        return t('projects.menu.unbindFile.hint');
    },
};

/**
 * 菜单项清单：基础项来自 `MENU_ITEMS`，当前项目绑定了文件时在「导出整个库」之后
 * 插入「解除文件绑定…」。
 *
 * @param {string} [file] 当前项目绑定的文件路径（`api.current().file`）；空 = 无绑定
 * @returns {Array<object>} 有绑定时是新数组，无绑定时就是 `MENU_ITEMS` 本身
 */
export function menuItemsFor(file) {
    const path = String(file == null ? '' : file).trim();
    if (!path) return MENU_ITEMS;
    const out = MENU_ITEMS.slice();
    const at = out.findIndex((it) => it.act === 'exportLibrary');
    out.splice(at < 0 ? out.length : at + 1, 0, UNBIND_ITEM);
    return out;
}

/**
 * 搜索有库但无匹配时的文案：不能退回空态 CTA（那会让用户以为库是空的）。
 *
 * 写成函数而不是模块级字符串 —— `setLocale()` 不重建模块常量，字符串会把
 * 首次渲染的语言冻住，切到中文后仍然是英文这一句。
 */
export function noResultText() {
    return t('projects.noResult');
}

/** 搜索过滤：按名字子串匹配，忽略大小写与首尾空白。纯函数，Node 可直接测。 */
export function filterRows(rows, query) {
    const list = Array.isArray(rows) ? rows : [];
    const q = String(query == null ? '' : query).trim().toLowerCase();
    if (!q) return list;
    return list.filter((r) => String((r && r.name) || '').toLowerCase().includes(q));
}

/**
 * 标签筛选：`tag` 为空（'' / 纯空白 / null）时**原样返回同一个数组引用**（与 `filterRows`
 * 同一口径：没筛选就不产生新数组，调用方可以按引用判断「没筛」）。
 * 否则按 `tags` 数组包含匹配；脏记录（tags 缺失/非数组）直接不匹配，不抛。
 * 纯函数，Node 可直接测。
 */
export function filterByTag(rows, tag) {
    const list = Array.isArray(rows) ? rows : [];
    const want = String(tag == null ? '' : tag).trim();
    if (!want) return list;
    return list.filter((r) => {
        const tags = r && Array.isArray(r.tags) ? r.tags : [];
        return tags.includes(want);
    });
}

/**
 * 全库出现过的标签：去重、按 `localeCompare` 排序（中文按拼音、英文按字母）。
 * 顶部标签下拉与「没有标签时整条隐藏」的判据都用它。纯函数，Node 可直接测。
 */
export function tagOptions(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const seen = new Set();
    for (const r of list) {
        const tags = r && Array.isArray(r.tags) ? r.tags : [];
        for (const tag of tags) {
            const s = String(tag == null ? '' : tag).trim();
            if (s) seen.add(s);
        }
    }
    return [...seen].sort((a, b) => a.localeCompare(b));
}

/**
 * 排序档位。`mode` 是**落盘/契约值**（进 localStorage 与 `api.sortRows` 的第二个参数），
 * `labelKey` 只是词条键；写成常量而不是每次现拼，测试才能钉死「四档、顺序、键名」。
 * 为什么是这四档：最近保存（默认，找刚改过的）/ 最近打开（接着上次的活干）/
 * 名称（按名字找）/ 大小（清库时找占地方的）。
 */
export const SORT_MODES = Object.freeze([
    { mode: 'saved', labelKey: 'projects.sort.saved' },
    { mode: 'opened', labelKey: 'projects.sort.opened' },
    { mode: 'name', labelKey: 'projects.sort.name' },
    { mode: 'size', labelKey: 'projects.sort.size' },
]);

/** 缺省档位：与 P1 的行为一致（最近保存在前）。 */
export const SORT_DEFAULT = 'saved';

/** localStorage 键。读写都要 try/catch：隐私模式 / 禁用存储时 getItem 会抛。 */
export const SORT_STORAGE_KEY = 'ms.projects.sort';

/** 把任意输入夹回四档之一；未知值一律落回缺省档（localStorage 里可能是旧值/脏值）。纯函数。 */
export function normSortMode(mode) {
    const s = String(mode == null ? '' : mode);
    return SORT_MODES.some((m) => m.mode === s) ? s : SORT_DEFAULT;
}

/** 档位 → 词条键；未知档位给缺省档的键（调用方永远能 `t()` 出人话）。纯函数。 */
export function sortLabelKey(mode) {
    const s = normSortMode(mode);
    const hit = SORT_MODES.find((m) => m.mode === s);
    return hit ? hit.labelKey : 'projects.sort.saved';
}

/**
 * 外壳 `api.sortRows` 不可用（并行批次未落地 / 桥不在）时的本地兜底排序。
 * 口径与外壳契约一致：**pinned 永远最前**，其余按档位；不改入参（`slice()` 后排序）。
 * 纯函数，Node 可直接测。
 */
export function fallbackSortRows(rows, mode) {
    const list = Array.isArray(rows) ? rows : [];
    const m = normSortMode(mode);
    const valueOf = m === 'opened'
        ? (r) => Number(r && r.openedAt) || 0
        : m === 'size'
            ? (r) => Number(r && r.bytes) || 0
            : (r) => Number(r && r.savedAt) || 0;
    return list.slice().sort((a, b) => {
        // 与外壳 project-store 的 sortProjects 同口径：只认布尔 true 的 pinned
        const pin = (b && b.pinned === true ? 1 : 0) - (a && a.pinned === true ? 1 : 0);
        if (pin) return pin;
        if (m === 'name') {
            return String((a && a.name) || '').localeCompare(String((b && b.name) || ''));
        }
        return valueOf(b) - valueOf(a);
    });
}

/**
 * 读排序偏好。**必须容错**：隐私模式 / 禁用 localStorage 时 `getItem` 直接抛，
 * 面板不能因为读一个偏好就白屏；读不到就用缺省档。
 */
export function readSortMode() {
    try {
        if (typeof localStorage === 'undefined' || !localStorage) return SORT_DEFAULT;
        return normSortMode(localStorage.getItem(SORT_STORAGE_KEY));
    } catch (err) {
        return SORT_DEFAULT;
    }
}

/** 写排序偏好；写不进去不算失败（只是下次打开回到缺省档）。返回是否真的写成功。 */
export function writeSortMode(mode) {
    try {
        if (typeof localStorage === 'undefined' || !localStorage) return false;
        localStorage.setItem(SORT_STORAGE_KEY, normSortMode(mode));
        return true;
    } catch (err) {
        return false;
    }
}

/** 统计口径：有查询时给「匹配 N / M」，没查询时给「共 M 个」。纯函数。 */
export function countLabel(total, matched, query) {
    const n = Number(total) || 0;
    if (!n) return '';
    const q = String(query == null ? '' : query).trim();
    if (!q) return t('projects.count.all', { n });
    return t('projects.count.matched', { matched: Number(matched) || 0, n });
}

/**
 * 把外壳接口的返回值归一成「真成了 / 用户取消 / 没成」。
 *
 * 三种来源都要吃得下：
 * - boolean —— open/create/rename/remove 这些老接口回 true|false；
 * - `{ok:true,…}` / `{ok:false,canceled?,error?}` —— exportFile / exportSpritesheet 这类
 *   要说明「写去了哪、为什么没写成」的接口；
 * - `null` / `undefined` —— **接口没跑起来**（桥不在、面板拿不到注入）。
 *
 * 为什么不能继续用 `ok !== false`：这条判据把 null 当成功。桥不在、主进程没响应时
 * 界面照样弹「已存为文件」，磁盘上却什么都没有 —— 这就是「没做却说成功」。
 * 纯函数，Node 可直接测。
 *
 * @returns {{ok:boolean, canceled:boolean, error:string, out:*}}
 */
export function actVerdict(out) {
    const bare = { ok: false, canceled: false, error: '', out: out };
    if (out === true) return Object.assign(bare, { ok: true });
    if (out === false) return Object.assign(bare, { error: t('projects.verdict.incomplete') });
    if (out == null) return Object.assign(bare, { error: t('projects.verdict.noAnswer') });
    if (typeof out === 'object') {
        if (out.ok === false) {
            const canceled = !!out.canceled;
            const why = String(out.error || '');
            return Object.assign(bare, {
                canceled: canceled,
                error: canceled
                    ? (why || t('projects.verdict.canceled'))
                    : (why || t('projects.verdict.incomplete')),
            });
        }
        // ok:true，或没写 ok 字段但确实回了对象：按成功处理，错误留空
        return Object.assign(bare, { ok: true });
    }
    // 其它标量（'done' / 1 / …）：有返回就当成了，但不当成「有凭据」
    return Object.assign(bare, { ok: true });
}


/**
 * 标签归一：只留**非空字符串**，去首尾空白、去重、最多 8 个。
 *
 * 记录来自用户数据（IndexedDB 里可能是手改/旧版写进去的脏值），渲染前必须收口：
 * 数字/对象/空串不进 chips，重复标签不占位，超过 8 个截断 —— 上限与外壳
 * `project-store.mjs` 的 `MAX_TAGS` 一致，面板不做第二套口径。
 */
function normTags(value) {
    const src = Array.isArray(value) ? value : [];
    const out = [];
    for (const tag of src) {
        if (typeof tag !== 'string') continue;
        const s = tag.trim();
        if (!s || out.includes(s)) continue;
        out.push(s);
        if (out.length >= 8) break;
    }
    return out;
}

/**
 * 规范化记录，容忍外壳给的不完整数据。
 *
 * `frames` 是**记录里真实存在的字段**（`project-store.mjs` 的 `makeRecord` / `stripRecord`
 * 都写它，口径是「纹理时间点数」）；早期一行 `if (r.cels)` 判断了一个记录里根本没有的
 * 字段，卡片 meta 那一项于是永远被静默跳过 —— 老记录只有 `cels` 时在这里兜一下。
 *
 * `pinned` / `tags` 是 P2 新增字段：老记录没有 → false / []，面板照常渲染。
 */
export function normRecord(rec, i) {
    const r = rec || {};
    return {
        id: String(r.id || 'rec-' + i),
        name: String(r.name || t('projects.untitled')),
        savedAt: Number(r.savedAt) || 0,
        width: Number(r.width) || 0,
        height: Number(r.height) || 0,
        // v6：记录里数的是纹理时间点数，真实字段是 frames；老记录若只有 cels 也读得出来
        frames: Number(r.frames) || Number(r.cels) || 0,
        layers: Number(r.layers) || 0,
        thumb: typeof r.thumb === 'string' ? r.thumb : '',
        bytes: Number(r.bytes) || 0,
        // 「最近打开」：外壳在打开/保存时写；老记录没有这个字段 → 0 = 不显示
        openedAt: Number(r.openedAt) || 0,
        // 绑定的 .msp 路径（没有绑定 = 空串）。完整路径只进卡片 title，meta 只放尾巴
        file: typeof r.file === 'string' ? r.file : '',
        // 收藏置顶：pinned 永远排最前（外壳 sortRows 负责，本地兜底排序也认它）。
        // 口径与外壳 project-store 一致：只认布尔 true —— 旧档/手改记录里的 1、'true'
        // 不算置顶，否则一条脏记录会永远占住列表最前面，用户看不出原因。
        pinned: r.pinned === true,
        // 标签：chips 与筛选下拉的来源（见 normTags 的收口口径）
        tags: normTags(r.tags),
    };
}

function pad2(n) {
    return n < 10 ? '0' + n : String(n);
}

/** 修改时间：今天只显示时分，其它显示月-日 时:分。 */
function fmtTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    if (!Number.isFinite(d.getTime())) return '—';
    const now = new Date();
    const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    const hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    return sameDay ? t('projects.time.today', { hm }) : pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + hm;
}

function fmtBytes(n) {
    if (!n) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
}

/**
 * 路径尾巴：卡片 meta 只放文件名（`C:\work\walk.msp` → `walk.msp`），完整路径进卡片
 * `title`（鼠标悬停才需要看到，否则一行 meta 会被路径撑满）。
 *
 * 同时认 `/` 与 `\`：浏览器/网页桥下可能是 POSIX 路径，桌面版是 Windows 路径。
 * 纯函数，Node 里可直接测。
 */
export function fileTail(path) {
    const s = String(path == null ? '' : path).trim();
    if (!s) return '';
    const parts = s.split(/[\\/]+/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : s;
}

/**
 * 卡片第二行：纹理时间点数 · 尺寸 · 对象数 · 体积 · 最近打开 · 绑定文件。
 *
 * 读的是 `normRecord` 归一后的 `r.frames`（记录真实字段），不是记录里不存在的 `r.cels`。
 * 「最近打开」（`openedAt`）与「文件」（`file`）都是可选字段：老记录没有就不显示，
 * 而不是显示一行「—」。纯函数（只查词条表），Node 里可直接测。
 */
export function metaLine(r) {
    const row = r || {};
    const parts = [];
    if (row.frames) parts.push(t('projects.meta.cels', { n: row.frames }));
    if (row.width && row.height) parts.push(row.width + '×' + row.height);
    // v2 起 doc.layers 语义是「对象」，展示口径跟着改（记录字段名仍叫 layers）
    if (row.layers) parts.push(t('projects.meta.layers', { n: row.layers }));
    const size = fmtBytes(row.bytes);
    if (size) parts.push(size);
    if (row.openedAt) parts.push(t('projects.meta.opened', { when: fmtTime(row.openedAt) }));
    const tail = fileTail(row.file);
    if (tail) parts.push(t('projects.meta.file', { file: tail }));
    return parts.join(' · ') || t('projects.meta.empty');
}

function mk(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = String(text);
    return node;
}

/**
 * 图标节点：`icon()` 返回的是 SVG **字符串**（见 core/icons.mjs:190 的 `@returns {string}`），
 * 不能直接 appendChild。这里用 <template> 转成真节点，并让 `.prj-ico` 落在 <svg> 自己身上
 * （不套多余的 wrapper —— wrapper 会多一层盒子，图标基线与按钮文字对不齐）。
 * 尺寸交给 styles/projects.css 的 `--icon-size`，`className` 由 icon() 自己拼。
 */
function icoNode(name, opts) {
    const tpl = document.createElement('template');
    tpl.innerHTML = icon(name, Object.assign({ className: 'prj-ico' }, opts || {})).trim();
    const node = tpl.content.firstChild;
    return node && node.nodeType === 1 ? node : null;
}

function button(act, text, title, iconName, extraClass) {
    const b = mk('button', 'prj-btn' + (extraClass ? ' ' + extraClass : ''), null);
    b.type = 'button';
    b.dataset.act = act;
    if (iconName) {
        const i = icoNode(iconName);
        if (i) b.appendChild(i);
    }
    if (text) b.appendChild(mk('span', 'prj-t', text));
    if (title) b.title = title;
    // 纯图标按钮（`…`）没有文字节点，读屏只能靠 aria-label，所以显式写一条
    b.setAttribute('aria-label', text || title || act);
    return b;
}

/** 轻提示：面板内部的灰色一行，不抢状态栏。 */
const HINT_MS = 2400;

/**
 * 失败提示停留时长。
 *
 * 失败文案里带「为什么 + 怎么补救」，2400ms 不够读完；同时失败不能被下一条
 * 普通提示立刻顶掉（见 `say` 的去重规则），否则用户只看到一个结果、看不到原因。
 */
const HINT_ERROR_MS = 7000;

/** FileReader → dataURL（失败给空串，调用方统一按「读不到」处理）。 */
function readAsDataURL(file) {
    return new Promise((resolve) => {
        try {
            const reader = new FileReader();
            reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
            reader.onerror = () => resolve('');
            reader.readAsDataURL(file);
        } catch (err) {
            resolve('');
        }
    });
}

/** 只挑图片文件，其余静默丢弃（accept 只是提示，拖进来的不一定守规矩）。 */
function imageFiles(list) {
    const out = [];
    for (const f of Array.from(list || [])) {
        if (!f) continue;
        const type = String(f.type || '');
        const name = String(f.name || '');
        if (type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp)$/i.test(name)) out.push(f);
    }
    return out;
}

export function mount(host, ctx) {
    const api = ctx && ctx.project;
    const panel = mk('div', 'prj-panel');

    // ── head：一个主行动 + 搜索 + 排序 + 标签筛选 + `…` 菜单 ────────────
    const head = mk('div', 'prj-top');
    head.setAttribute('role', 'toolbar');
    head.setAttribute('aria-label', t('projects.head.aria'));

    const btnNew = button('new', t('projects.new'), t('projects.new.hint'), 'plus', 'prj-primary');

    const search = mk('label', 'prj-search');
    const searchIco = icoNode('search');
    const searchInput = mk('input', 'prj-search-input');
    searchInput.type = 'search';
    searchInput.placeholder = t('projects.search.placeholder');
    searchInput.setAttribute('aria-label', t('projects.search.aria'));
    if (searchIco) search.appendChild(searchIco);
    search.appendChild(searchInput);

    // 排序：四档来自 SORT_MODES；label 只是控件前的短词，选项文案走词条表。
    // 选择落 localStorage（读写容错见 readSortMode / writeSortMode）。
    let sortMode = readSortMode();
    const sortWrap = mk('label', 'prj-sort');
    sortWrap.appendChild(mk('span', 'prj-filter-label', t('projects.sort.label')));
    const sortSelect = mk('select', 'prj-sort-select');
    sortSelect.setAttribute('aria-label', t('projects.sort.aria'));
    for (const item of SORT_MODES) {
        const opt = mk('option', '', t(item.labelKey));
        opt.value = item.mode;
        sortSelect.appendChild(opt);
    }
    sortSelect.value = sortMode;
    sortWrap.appendChild(sortSelect);

    // 标签筛选：第一项「全部标签」；库里一个标签都没有时整条隐藏（见 syncTagFilter）。
    const tagWrap = mk('label', 'prj-tag-filter');
    tagWrap.hidden = true;
    tagWrap.appendChild(mk('span', 'prj-filter-label', t('projects.tagFilter.label')));
    const tagSelect = mk('select', 'prj-tag-select');
    tagSelect.setAttribute('aria-label', t('projects.tagFilter.aria'));
    tagWrap.appendChild(tagSelect);

    const count = mk('span', 'prj-count', '');
    count.setAttribute('aria-live', 'polite');
    const grow = mk('span', 'prj-gap');

    const btnMore = button('more', null, t('projects.more'), 'more-horizontal', 'prj-more');
    btnMore.setAttribute('aria-haspopup', 'menu');
    btnMore.setAttribute('aria-expanded', 'false');

    const menu = mk('div', 'prj-menu');
    menu.hidden = true;
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', t('projects.more'));
    // 菜单项在 paintMenu() 里建：是否带「解除文件绑定…」取决于当前项目有没有绑定文件

    head.appendChild(btnNew);
    head.appendChild(search);
    head.appendChild(sortWrap);
    head.appendChild(tagWrap);
    head.appendChild(count);
    head.appendChild(grow);
    head.appendChild(btnMore);
    head.appendChild(menu);

    // 浏览器原生选图：不走主进程对话框，FileReader 读成 dataURL 后交给 project-store。
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.multiple = true;
    fileInput.className = 'prj-file';
    fileInput.style.display = 'none';

    const hint = mk('div', 'prj-hint', '');
    hint.setAttribute('role', 'status');
    hint.setAttribute('aria-live', 'polite');
    const list = mk('div', 'prj-grid');
    const empty = mk('div', 'prj-empty', t('projects.empty'));
    const noresult = mk('div', 'prj-noresult', noResultText());
    // 项目库只住在浏览器 IndexedDB：清站点数据 / 换浏览器用户 = 全丢。
    // 这条必须常驻在面板里（用户不会去读文档），所以和空态并列、不随列表刷新消失。
    // 样式在 styles/projects.css 的 .prj-note（面板样式归 Lead，见该文件头）。
    const libraryNote = mk('div', 'prj-note', t('projects.library.warning'));

    panel.appendChild(head);
    panel.appendChild(hint);
    panel.appendChild(list);
    panel.appendChild(libraryNote);
    panel.appendChild(fileInput);

    let rows = [];
    let query = '';
    // 当前标签筛选（'' = 不筛）。不落盘：标签筛选是「这一眼想看什么」，不是长期偏好。
    let tagFilter = '';
    // 上次重建标签下拉时的选项签名：选项没变就不重建，避免每次 paint 都把用户正开着的
    // 原生下拉关掉（搜索框每敲一个字都会 paint）。
    let tagSig = null;
    let currentId = '';
    // 当前项目绑定的文件路径（api.current().file）。reload() 里刷新，菜单靠它决定是否
    // 出现「解除文件绑定…」；缓存而不是每次现取，因为菜单渲染是同步的。
    let currentFile = '';
    let busy = false;
    let importing = false;
    let hintText = '';
    let hintAt = 0;
    let hintKind = ''; // '' | 'info' | 'error'：只有错误提示享受「不被顶掉」的特权
    let renaming = null; // { id, value }
    let off = null;
    let live = true;

    /** `…` 菜单开合：aria-expanded 与 hidden 必须同步，否则读屏与视觉会各说各话。 */
    function setMenu(open) {
        const on = !!open;
        menu.hidden = !on;
        btnMore.setAttribute('aria-expanded', on ? 'true' : 'false');
        if (on) {
            const first = menu.querySelector('.prj-mi');
            if (first && typeof first.focus === 'function') first.focus();
        }
    }

    function menuOpen() {
        return !menu.hidden;
    }

    /**
     * 重建 `…` 菜单。
     *
     * 菜单项随「当前项目有没有绑定文件」变（见 `menuItemsFor`），所以不能只在 mount 时
     * 建一次：`reload()` 发现 file 变了就重建。重建会换掉按钮节点，因此**只有焦点本来就
     * 在菜单里**才把焦点接回第一项 —— 否则后台刷新（subscribe / 自动保存）会把用户正在
     * 搜索框里打的字抢走焦点。
     */
    function paintMenu() {
        const active = typeof document !== 'undefined' ? document.activeElement : null;
        const hadFocus = !!active && menu.contains(active);
        menu.replaceChildren();
        for (const it of menuItemsFor(currentFile)) {
            if (it.sepBefore) menu.appendChild(mk('div', 'prj-mi-sep'));
            const mi = mk('button', 'prj-mi', null);
            mi.type = 'button';
            mi.dataset.act = it.act;
            mi.setAttribute('role', 'menuitem');
            mi.setAttribute('aria-label', it.label);
            mi.title = it.title || it.label;
            const ico = icoNode(it.icon);
            if (ico) mi.appendChild(ico);
            mi.appendChild(mk('span', 'prj-t', it.label));
            menu.appendChild(mi);
        }
        if (hadFocus) {
            const first = menu.querySelector('.prj-mi');
            if (first && typeof first.focus === 'function') first.focus();
        }
    }

    paintMenu();

    /**
     * 面板内的轻提示。
     *
     * @param {string} text
     * @param {'info'|'error'} [kind] error 停留更久，且不会被紧随其后的普通提示顶掉
     */
    function say(text, kind) {
        const level = kind === 'error' ? 'error' : 'info';
        // 失败原因不能被「已刷新」这类普通提示盖掉：面板里只有一个 hint 位，
        // 盖掉就等于用户看不到为什么没成。
        if (level !== 'error' && hintKind === 'error' && Date.now() - hintAt < HINT_ERROR_MS - 20) return undefined;
        const ms = level === 'error' ? HINT_ERROR_MS : HINT_MS;
        hintText = String(text || '');
        hintAt = Date.now();
        hintKind = level;
        hint.textContent = hintText;
        hint.setAttribute('role', level === 'error' ? 'alert' : 'status');
        hint.classList.toggle('is-on', !!hintText);
        hint.classList.toggle('is-error', level === 'error');
        const timer = setTimeout(() => {
            if (!live) return;
            if (Date.now() - hintAt < ms - 20) return;
            hint.textContent = '';
            hintKind = '';
            hint.classList.remove('is-on');
            hint.classList.remove('is-error');
        }, ms);
        return timer;
    }

    if (!api) {
        panel.setAttribute('aria-label', t('projects.offline.aria'));
        panel.appendChild(mk('div', 'prj-off', t('projects.offline.text')));
        host.appendChild(panel);
        return { refresh() {}, destroy() {} };
    }

    /**
     * 收藏星标：卡片右上角（名字行尾部）。`aria-pressed` 表达「当前是否置顶」，
     * title / aria-label 用「置顶 / 取消置顶」两条词条（读屏不能只听到「按钮」）。
     */
    function pinButton(r) {
        const b = mk('button', 'prj-pin' + (r.pinned ? ' is-on' : ''), null);
        b.type = 'button';
        b.dataset.act = 'pin';
        b.setAttribute('aria-pressed', r.pinned ? 'true' : 'false');
        const label = r.pinned ? t('projects.pin.off') : t('projects.pin.on');
        b.setAttribute('aria-label', label);
        b.title = label;
        const ico = icoNode('star');
        if (ico) b.appendChild(ico);
        return b;
    }

    /**
     * 标签 chips：名字下方一行。最多显示 3 个，多出来的收成 `+N`；末尾永远有 `+`
     * （给还没有标签的项目一个入口，否则新项目没有地方可以加标签）。
     * 点 chip = 按该标签筛选（由 onClick 里的 `.prj-tag` 分支接走）。
     */
    function tagChips(r) {
        const wrap = mk('div', 'prj-tags');
        const tags = Array.isArray(r.tags) ? r.tags : [];
        for (const tag of tags.slice(0, 3)) {
            const chip = mk('button', 'prj-tag', tag);
            chip.type = 'button';
            chip.dataset.tag = tag;
            const hint = t('projects.tag.filter.hint', { tag: tag });
            chip.title = hint;
            chip.setAttribute('aria-label', hint);
            wrap.appendChild(chip);
        }
        if (tags.length > 3) {
            const more = mk('span', 'prj-tag-more', '+' + (tags.length - 3));
            more.title = t('projects.tag.more', { n: tags.length - 3 });
            wrap.appendChild(more);
        }
        const add = mk('button', 'prj-tag-add', '+');
        add.type = 'button';
        add.dataset.act = 'editTags';
        add.setAttribute('aria-label', t('projects.tag.add'));
        add.title = t('projects.tag.add.hint');
        wrap.appendChild(add);
        return wrap;
    }

    function card(r) {
        const item = mk('article', 'prj-card');
        item.dataset.id = r.id;
        item.tabIndex = 0;
        if (r.id === currentId) item.classList.add('is-current');
        if (r.pinned) item.classList.add('is-pinned');
        if (renaming && renaming.id === r.id) item.classList.add('is-renaming');
        const when = r.savedAt ? fmtTime(r.savedAt) : t('projects.card.unsaved');
        // 完整路径只放在 title 里：卡片一行 meta 放尾巴（见 metaLine），悬停才给全路径
        item.title = r.file
            ? t('projects.card.titleFile', { name: r.name, when: when, file: r.file })
            : t('projects.card.title', { name: r.name, when: when });
        item.setAttribute('aria-label', t('projects.card.aria', { name: r.name, when: when }));

        const thumb = mk('div', 'prj-thumb');
        if (r.thumb) {
            const img = document.createElement('img');
            img.className = 'prj-thumb-img';
            img.src = r.thumb;
            img.alt = r.name;
            thumb.appendChild(img);
        } else {
            thumb.appendChild(mk('span', 'prj-thumb-empty', t('projects.thumb.empty')));
        }

        const meta = mk('div', 'prj-meta');
        const nameRow = mk('div', 'prj-name-row');
        const editing = !!(renaming && renaming.id === r.id);
        if (editing) {
            const input = mk('input', 'prj-rename');
            input.type = 'text';
            input.value = renaming.value;
            input.setAttribute('aria-label', t('projects.rename.aria'));
            input.style.width = '100%';
            input.style.minWidth = '80px';
            nameRow.appendChild(input);
            // 图标标记，paint() 之后统一 focus（见 focusRename）
        } else {
            nameRow.appendChild(mk('div', 'prj-name', r.name));
            if (r.id === currentId) nameRow.appendChild(mk('span', 'prj-badge', t('projects.card.badge')));
            // 星标放名字行尾部（CSS 的 margin-left:auto 把它顶到卡片右上角）
            nameRow.appendChild(pinButton(r));
        }
        meta.appendChild(nameRow);
        // 标签 chips 在名字下方；重命名进行中不显示（避免改名的同时误触筛选）
        if (!editing) meta.appendChild(tagChips(r));
        meta.appendChild(mk('div', 'prj-sub', metaLine(r)));
        meta.appendChild(mk('div', 'prj-time', t('projects.card.time', { when: when })));

        const actions = mk('div', 'prj-actions');
        if (editing) {
            actions.appendChild(button('rename-ok', t('projects.rename.ok'), t('projects.rename.ok.hint')));
            actions.appendChild(button('rename-cancel', t('projects.rename.cancel'), t('projects.rename.cancel.hint')));
        } else {
            for (const a of CARD_ACTIONS) {
                actions.appendChild(button(a.act, a.label, a.title, a.icon, a.danger ? 'prj-del' : ''));
            }
        }

        item.appendChild(thumb);
        item.appendChild(meta);
        item.appendChild(actions);
        return item;
    }

    function focusRename() {
        const input = list.querySelector('input.prj-rename');
        if (!input) return;
        input.focus();
        if (typeof input.select === 'function') input.select();
    }

    /**
     * 展示顺序：搜索 → 标签筛选 → 排序（pinned 由排序保证永远最前）。
     * `api.sortRows` 是并行批次刚钉死的接口：没落地 / 半成品抛错时退回本地
     * `fallbackSortRows`，否则一次 paint 就能让面板白屏。
     */
    function sortRowsFor(list, mode) {
        if (typeof api.sortRows === 'function') {
            try {
                const out = api.sortRows(list, mode);
                if (Array.isArray(out)) return out;
            } catch (err) {
                /* 外壳半成品：退回本地排序 */
            }
        }
        return fallbackSortRows(list, mode);
    }

    /** 库容量：`api.totals(rows)` → {count,bytes}；接口不在时本地求和兜底（同口径）。 */
    function totalsFor(list) {
        if (typeof api.totals === 'function') {
            try {
                const out = api.totals(list);
                if (out && typeof out === 'object') {
                    return { count: Number(out.count) || 0, bytes: Number(out.bytes) || 0 };
                }
            } catch (err) {
                /* 外壳半成品：退回本地求和 */
            }
        }
        let bytes = 0;
        for (const r of list) bytes += Number(r && r.bytes) || 0;
        return { count: list.length, bytes: bytes };
    }

    /**
     * 同步标签筛选下拉：选项来自 `tagOptions(rows)`，第一项「全部标签」。
     * 没有标签 → 整条隐藏；当前筛选的标签随数据消失 → 退回「全部」。
     * 选项签名没变就不重建节点（见 tagSig 的注释）。
     */
    function syncTagFilter() {
        const opts = tagOptions(rows);
        tagWrap.hidden = !opts.length;
        if (!opts.length) tagFilter = '';
        else if (tagFilter && !opts.includes(tagFilter)) tagFilter = '';
        const sig = opts.join('\u0001');
        if (sig !== tagSig) {
            tagSig = sig;
            tagSelect.replaceChildren();
            const all = mk('option', '', t('projects.tagFilter.all'));
            all.value = '';
            tagSelect.appendChild(all);
            for (const tag of opts) {
                const opt = mk('option', '', tag);
                opt.value = tag;
                tagSelect.appendChild(opt);
            }
        }
        tagSelect.value = tagFilter;
    }

    /** 点标签 chip = 按它筛选；再点同一个标签不取消（取消走顶部下拉的「全部标签」）。 */
    function setTagFilter(tag) {
        tagFilter = String(tag == null ? '' : tag).trim();
        paint();
    }

    /**
     * 记下「重画前焦点在列表里的哪个控件的哪个动作」。
     *
     * 为什么需要：星标 / 加标签成功后会 `reload()` → `paint()` 整块重画，焦点会掉回
     * `<body>`；键盘与读屏用户得从面板头顶重新走一遍（删除动作的 `focusAfterDelete`
     * 解决的是同一个问题）。只认列表里的元素 —— 焦点在搜索框时不许被抢走。
     */
    function captureListFocus() {
        const active = typeof document !== 'undefined' ? document.activeElement : null;
        if (!active || !list.contains(active) || typeof active.closest !== 'function') return null;
        const cardNode = active.closest('.prj-card');
        if (!cardNode) return null;
        return {
            id: cardNode.dataset.id || '',
            act: (active.dataset && active.dataset.act) || '',
        };
    }

    /** 按快照把焦点接回同一张卡的同一个动作；卡没了（被删/被筛掉）就不动。 */
    function restoreListFocus(snap) {
        if (!snap || !snap.id) return;
        const cards = list.querySelectorAll('.prj-card');
        for (const cardNode of cards) {
            if (cardNode.dataset.id !== snap.id) continue;
            const target = snap.act ? cardNode.querySelector('[data-act="' + snap.act + '"]') : cardNode;
            if (target && typeof target.focus === 'function') target.focus();
            return;
        }
    }

    function paint() {
        // 先同步筛选条：数据变了（删掉最后一个带该标签的项目）时 tagFilter 会在这里被退回「全部」
        syncTagFilter();
        const searched = filterRows(rows, query);
        const tagged = filterByTag(searched, tagFilter);
        const shown = sortRowsFor(tagged, sortMode);
        // 计数：保留「共 N 个 / 匹配 M / N」，有库时再追加「· 合计 X」。
        // 标签筛选也算「筛选」：否则筛剩 2 张、计数却写「共 4 个」，用户会以为筛坏了。
        // 体积口径是**整个库**（api.totals(rows)），不是当前筛选结果 —— 这是「库容量」。
        const filterText = String(query == null ? '' : query).trim() || tagFilter;
        const base = countLabel(rows.length, shown.length, filterText);
        const bytes = totalsFor(rows).bytes;
        const size = bytes ? t('projects.count.size', { size: fmtBytes(bytes) }) : '';
        count.textContent = base && size ? base + ' · ' + size : (base || size);
        const focusSnap = captureListFocus();
        list.replaceChildren();
        if (!rows.length) {
            list.appendChild(empty);
            return;
        }
        // 有库但没匹配：给「没有匹配的项目」，不能退回空态 CTA（那会让用户以为库是空的）
        if (!shown.length) {
            list.appendChild(noresult);
            return;
        }
        for (const r of shown) list.appendChild(card(r));
        if (renaming) focusRename();
        else restoreListFocus(focusSnap);
    }

    async function reload() {
        if (!live) return;
        try {
            const [items, cur] = await Promise.all([api.list(), Promise.resolve(api.current && api.current())]);
            if (!live) return;
            rows = (items || []).map(normRecord);
            currentId = cur && cur.id ? String(cur.id) : '';
            // 绑定的文件变了 → 菜单的「解除文件绑定…」要跟着出现/消失（菜单是同步渲染的，
            // 所以在这里缓存一份；current() 已有 file 字段，不必再取一次）
            const nextFile = String((cur && cur.file) || '');
            if (nextFile !== currentFile) {
                currentFile = nextFile;
                paintMenu();
            }
            paint();
        } catch (err) {
            say(t('projects.err.read', { msg: (err && err.message) || err }));
        }
    }

    /**
     * 统一跑一个异步动作：防重入、按结果说话、结束后刷新列表。
     *
     * 判据用 `actVerdict`，不再用 `ok !== false` —— 后者把「接口没跑起来」（null）
     * 当成功，于是「存为文件」「导出精灵图」在桥不在时也会弹「已…」。
     *
     * @param {() => (boolean|object|null|Promise<any>)} fn
     * @param {string} [okText] 成功文案；不给就不说话（调用方自己按返回值补）
     * @returns {Promise<{ok:boolean,canceled:boolean,error:string,out:*}>}
     */
    async function run(fn, okText) {
        const idle = { ok: false, canceled: false, error: t('projects.busy'), out: null };
        if (busy) {
            // 不许静默：点被挡掉和点了没反应是两件事，用户必须能分辨
            say(idle.error);
            return idle;
        }
        busy = true;
        panel.classList.add('is-busy');
        panel.setAttribute('aria-busy', 'true');
        let verdict = idle;
        try {
            verdict = actVerdict(await fn());
            if (verdict.ok) {
                if (okText) say(okText);
            } else if (verdict.canceled) {
                say(verdict.error || t('projects.verdict.canceled'));
            } else {
                say(verdict.error || t('projects.verdict.incomplete'), 'error');
            }
        } catch (err) {
            const msg = (err && err.message) || err;
            // 把抛出去的原因也放进返回值：调用方拿到的不该只是「没成」
            verdict = actVerdict({ ok: false, error: t('projects.err.action', { msg: msg }) });
            say(verdict.error, 'error');
        } finally {
            busy = false;
            panel.classList.remove('is-busy');
            panel.removeAttribute('aria-busy');
            if (live) await reload();
        }
        return verdict;
    }

    function findRow(id) {
        return rows.find((r) => r.id === id) || null;
    }

    /**
     * 删除后把焦点交给「原位置剩下的那张卡」。
     *
     * 为什么不按 id 找：卡片 id 来自 IndexedDB，拼 CSS 选择器要转义；下标的语义也更贴用户
     * 预期 —— 删掉第 3 张，焦点落到现在的第 3 张（即原来的第 4 张）。列表空了就什么也不做
     * （空态 CTA 自己可聚焦）。
     */
    function focusAfterDelete(index) {
        if (!live) return;
        const cards = list.querySelectorAll('.prj-card');
        if (!cards.length) return;
        const at = Math.min(Math.max(0, index), cards.length - 1);
        const node = cards[at];
        if (node && typeof node.focus === 'function') node.focus();
    }

    /** 导入图片：选中的图片依次插成 kind:'image' 对象（居中、每帧可见）。 */
    async function importPictures(files) {
        if (importing || !live) return;
        if (typeof ctx.doc !== 'function' || typeof ctx.setDoc !== 'function') {
            say(t('projects.import.noDocApi'));
            return;
        }
        const list_ = imageFiles(files);
        if (!list_.length) {
            say(t('projects.import.notImage'));
            return;
        }
        importing = true;
        panel.classList.add('is-busy');
        let ok = 0;
        let fail = 0;
        let lastId = '';
        try {
            for (const file of list_) {
                const dataUrl = await readAsDataURL(file);
                if (!dataUrl) {
                    fail++;
                    continue;
                }
                const spec = await imageElementFromFile({ name: file && file.name, dataUrl: dataUrl });
                if (!spec) {
                    fail++;
                    continue;
                }
                const doc = ctx.doc();
                const made = doc ? addImageElement(doc, spec) : null;
                if (!made) {
                    fail++;
                    continue;
                }
                ctx.setDoc(() => made.doc);
                lastId = made.element.id;
                ok++;
            }
            if (lastId && typeof ctx.setActiveLayer === 'function') {
                try {
                    ctx.setActiveLayer(lastId);
                } catch (err) {
                    /* 外壳接口细节差异，不影响已经插进去的对象 */
                }
            }
            // 「成功 N 张 + 失败 M 张」是一句话里的两个数，不拼句：两条整句各自带走自己的数
            if (ok) say(fail ? t('projects.import.doneSome', { ok: ok, fail: fail }) : t('projects.import.done', { ok: ok }));
            else say(t('projects.import.noPixels'));
        } catch (err) {
            say(t('projects.import.failed', { msg: (err && err.message) || err }));
        } finally {
            importing = false;
            panel.classList.remove('is-busy');
        }
    }

    function onFileChange() {
        // files 是活引用，先拷出来再清空 input（否则同名文件选第二次不触发 change）
        const picked = Array.from(fileInput.files || []);
        fileInput.value = '';
        importPictures(picked);
    }

    function commitRename() {
        if (!renaming) return;
        const next = String(renaming.value || '').trim();
        const id = renaming.id;
        const old = findRow(id);
        renaming = null;
        if (!next || (old && next === old.name)) {
            paint();
            return;
        }
        run(() => api.rename(id, next), t('projects.rename.done', { name: next }));
    }

    async function onAct(act, id, item) {
        const row = id ? findRow(id) : null;
        if (act === 'more') {
            setMenu(!menuOpen());
            return;
        }
        if (act === 'new') {
            await run(() => api.create(), t('projects.create.done'));
            return;
        }
        if (act === 'image') {
            if (typeof fileInput.click === 'function') fileInput.click();
            else say(t('projects.importFile.noPicker'));
            return;
        }
        if (act === 'import') {
            await run(() => api.importFile(), t('projects.importFile.done'));
            return;
        }
        if (act === 'saveAs') {
            // 另存为：当前文档 → 新的 .msp（外壳弹保存对话框并回填 project.file）。
            // 不传 id：传 id 会让外壳去写库里那条**旧**存档，而不是用户眼前的这份。
            const v = await run(() => api.exportFile());
            if (v.ok && v.out && v.out.file) say(t('projects.save.done', { file: v.out.file }));
            else if (v.ok) say(t('projects.save.noPath'), 'error');
            return;
        }
        if (act === 'exportLibrary') {
            // 整库备份：外壳把每个项目打包成一个 JSON 落盘（恢复走「导入项目文件」）
            const v = await run(() => api.exportLibrary());
            if (!v.ok) return; // 失败/取消的原因 run 已经说过一遍，别叠话
            const n = Number(v.out && v.out.count) || 0;
            const file = String((v.out && v.out.file) || '');
            // 没拿到路径时不许说「已导出」：那是「没做却说成功」
            if (file) say(t('projects.exportLibrary.done', { n: n, file: file }));
            else say(t('projects.exportLibrary.noPath'), 'error');
            return;
        }
        if (act === 'unbindFile') {
            // 「解除文件绑定…」：二次确认在外壳里做；用户取消回 {ok:false,canceled:true}，
            // 由 run() 说「已取消」，面板不重复说话。
            await run(() => api.unbindFile(), t('projects.unbind.done'));
            return;
        }
        if (act === 'sheet') {
            // 精灵图：主进程落盘 PNG + 每帧坐标 JSON
            const fn = (ctx && ctx.exportSpritesheet) || (api && api.exportSpritesheet);
            if (!fn) {
                say(t('projects.sheet.missing'), 'error');
                return;
            }
            // 不传 okText：成功文案要带帧数和目录，那是返回值里才有的东西
            const v = await run(() => fn({}));
            if (!v.ok) return; // 失败/取消的原因 run 已经说过一遍，别叠话
            const n = Number(v.out && v.out.count) || 0;
            const dir = (v.out && v.out.dir) || '';
            if (n > 0) say(dir ? t('projects.sheet.doneDir', { n: n, dir: dir }) : t('projects.sheet.done', { n: n }));
            else say(t('projects.sheet.empty'), 'error');
            return;
        }
        if (act === 'refresh') {
            await reload();
            say(t('projects.msg.refreshed'));
            return;
        }
        if (!row) return;
        if (act === 'pin') {
            // 收藏置顶：把**目标状态**显式传给外壳（不是「切换」），避免连点两下时按旧值算。
            // 接口没接线（并行批次未落地）时明确说一声，不许静默失败。
            if (typeof api.setPinned !== 'function') {
                say(t('projects.p2.notWired'), 'error');
                return;
            }
            const want = !row.pinned;
            // 成功不说话：外壳 setPinned 已经在顶栏 flash「已置顶 / 已取消置顶」，面板再报一遍
            // 就是同一件事说两次；失败由 run() 用错误档说清原因。
            await run(() => api.setPinned(row.id, want));
            return;
        }
        if (act === 'editTags') {
            // 标签编辑对话框在外壳里（`api.editTags` 异步返回 {ok,tags}/{canceled}），
            // 面板只管调、刷新与播报结果；取消由 run() 说「已取消」，不叠话。
            if (typeof api.editTags !== 'function') {
                say(t('projects.p2.notWired'), 'error');
                return;
            }
            await run(() => api.editTags(row.id), t('projects.tag.updated'));
            return;
        }
        if (act === 'open') {
            await run(() => api.open(row.id), t('projects.open.done', { name: row.name }));
            return;
        }
        if (act === 'rename') {
            renaming = { id: row.id, value: row.name };
            paint();
            return;
        }
        if (act === 'rename-ok') {
            commitRename();
            return;
        }
        if (act === 'rename-cancel') {
            renaming = null;
            paint();
            return;
        }
        if (act === 'duplicate') {
            // 库内复制：外壳给副本新 id/名字，返回 {ok,id,name}；文案要带**副本的名字**
            // （用户输入过原名 + 序号之类），所以 okText 走返回值分支，不在 run() 里写死
            const v = await run(() => api.duplicate(row.id));
            if (v.ok) say(t('projects.duplicate.done', { name: (v.out && v.out.name) || row.name }));
            return;
        }
        if (act === 'history') {
            // 版本历史：外壳负责列快照 → 二次确认 → 恢复（恢复前先把当前状态存成历史）。
            // 取消是正常结局（run() 只说一句「已取消」），不报错；成功提示由外壳 flash。
            if (typeof api.history !== 'function') {
                say(t('projects.history.notWired'), 'error');
                return;
            }
            await run(() => api.history(row.id));
            return;
        }
        if (act === 'export') {
            // 「存为文件」必须拿到路径才算成：外壳回成功却没给路径时不能弹「已存为文件」
            const v = await run(() => api.exportFile(row.id));
            if (v.ok && v.out && v.out.file) say(t('projects.save.done', { file: v.out.file }));
            else if (v.ok) say(t('projects.save.noPath'), 'error');
            return;
        }
        if (act === 'delete') {
            // 焦点收口：删除会让列表整块重画（paint 里 replaceChildren），先把「聚焦的是不是
            // 这张卡、它是第几张」记下来；删成功后把焦点交给同位置剩下的那张卡，
            // 否则焦点会掉回 <body>，键盘/读屏用户得从面板头顶重新走一遍。
            const wasFocused = !!(item && typeof item.contains === 'function' && item.contains(document.activeElement));
            const index = item ? Array.prototype.indexOf.call(list.querySelectorAll('.prj-card'), item) : -1;
            const v = await run(() => api.remove(row.id), t('projects.remove.done', { name: row.name }));
            if (currentId === row.id) currentId = '';
            // 撤销条（8 秒，真实删除后出现）由外壳 project-io 的 holdUndoBar 负责，面板这里
            // 只做两件事：列表靠 run() 的 finally 重读（库里另有项目时正常刷新）、
            // 结果提示走 .prj-hint 的 aria-live=polite 播报。
            if (v.ok && wasFocused) focusAfterDelete(index);
            return;
        }
        if (item) item.classList.add('is-on');
    }

    function onClick(e) {
        // 变量名不叫 `t`：那会遮蔽 i18n 的 `t()`，同函数里后加的文案就取不到词条
        const target = e.target;
        // 标签 chip：点它 = 按这个标签筛选。必须在 [data-act] 分支之前接走 ——
        // 否则会落到「点卡片任意处 = 载入」那一步，用户只想筛一下却把项目打开了。
        const chip = target && typeof target.closest === 'function' ? target.closest('.prj-tag') : null;
        if (chip) {
            e.preventDefault();
            setTagFilter(chip.dataset.tag || '');
            return;
        }
        const btn = target && typeof target.closest === 'function' ? target.closest('[data-act]') : null;
        if (btn) {
            e.preventDefault();
            const item = btn.closest('.prj-card');
            const id = item ? item.dataset.id : '';
            // `more` 自己负责开合，其余动作执行前先收起菜单
            if (btn.dataset.act !== 'more') setMenu(false);
            onAct(btn.dataset.act, id, item);
            return;
        }
        // 点到菜单与 `…` 之外就收起（菜单没有全屏遮罩，靠这一条收口）
        if (menuOpen() && target && typeof target.closest === 'function' && !target.closest('.prj-menu') && !target.closest('.prj-more')) {
            setMenu(false);
        }
        const picked = target && typeof target.closest === 'function' ? target.closest('.prj-card') : null;
        if (!picked) return;
        if (renaming) return;
        const row = findRow(picked.dataset.id);
        if (!row) return;
        // 点卡片任意处 = 载入（A 方案：守卫只活在 project-io 的 beforeSwitch 一处）
        run(() => api.open(row.id), t('projects.open.done', { name: row.name }));
    }

    function onKey(e) {
        // 菜单开着时 Esc 只收菜单，不再冒泡去关掉整个浮层
        if (e.key === 'Escape' && menuOpen()) {
            e.preventDefault();
            e.stopPropagation();
            setMenu(false);
            if (typeof btnMore.focus === 'function') btnMore.focus();
            return;
        }
        if (!renaming) {
            // 卡片可聚焦：Enter/空格等同于点卡片（键盘也能载入）
            if (e.key === 'Enter' || e.key === ' ') {
                const target = e.target;
                if (target && target.classList && target.classList.contains('prj-card') && target.dataset.id) {
                    e.preventDefault();
                    onAct('open', target.dataset.id, target);
                }
            }
            return;
        }
        if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            commitRename();
            return;
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            renaming = null;
            paint();
        }
    }

    function onInput(e) {
        // 变量名不叫 `t`：会遮蔽 i18n 的 t()
        const el = e.target;
        if (el && el.classList && el.classList.contains('prj-search-input')) {
            query = String(el.value || '');
            paint();
            return;
        }
        if (!renaming) return;
        if (el && el.classList && el.classList.contains('prj-rename')) renaming.value = el.value;
    }

    /**
     * 两个下拉走 `change`（原生 select 的可靠事件；`input` 在各版本里不一致）。
     * 排序选择落 localStorage —— 写不进去（隐私模式）只是下次回到缺省档，不影响本次排序。
     */
    function onChange(e) {
        const el = e.target;
        if (!el || !el.classList) return;
        if (el.classList.contains('prj-sort-select')) {
            sortMode = normSortMode(el.value);
            writeSortMode(sortMode);
            paint();
            return;
        }
        if (el.classList.contains('prj-tag-select')) {
            tagFilter = String(el.value || '');
            paint();
        }
    }

    function onDoubleClick(e) {
        const picked = e.target && typeof e.target.closest === 'function' ? e.target.closest('.prj-card') : null;
        if (!picked || renaming) return;
        // 卡片内部的按钮 / 标签 chip 不吃双击：双击 chip 的第一次点击已经改了筛选，
        // 再顺手进「重命名」只会让人莫名其妙（双击卡片空白处才是重命名）。
        if (e.target && typeof e.target.closest === 'function' && e.target.closest('button, input')) return;
        const row = findRow(picked.dataset.id);
        if (!row) return;
        renaming = { id: row.id, value: row.name };
        paint();
    }

    panel.addEventListener('click', onClick);
    panel.addEventListener('keydown', onKey);
    panel.addEventListener('input', onInput);
    panel.addEventListener('change', onChange);
    panel.addEventListener('dblclick', onDoubleClick);
    fileInput.addEventListener('change', onFileChange);

    host.appendChild(panel);
    if (typeof api.subscribe === 'function') {
        try {
            off = api.subscribe(() => {
                if (live) reload();
            });
        } catch (err) {
            off = null;
        }
    }
    reload();

    return {
        /** 外壳在结构变化/切工作区后会调；重进面板时重新读库。 */
        refresh() {
            if (!live) return;
            reload();
        },
        focusFrame() {
            /* 项目库与帧无关 */
        },
        destroy() {
            live = false;
            panel.removeEventListener('click', onClick);
            panel.removeEventListener('keydown', onKey);
            panel.removeEventListener('input', onInput);
            panel.removeEventListener('change', onChange);
            panel.removeEventListener('dblclick', onDoubleClick);
            fileInput.removeEventListener('change', onFileChange);
            if (typeof off === 'function') {
                try {
                    off();
                } catch (err) {
                    /* 忽略 */
                }
                off = null;
            }
            if (panel.parentNode) panel.parentNode.removeChild(panel);
        },
    };
}
