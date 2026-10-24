/**
 * MotionStudio —— 导入编排：PSD / PNG / JPEG / WebP → 文档对象
 *
 * 为什么单独成模块：psd.mjs 只负责「字节 → 图层数组」，doc-model 只认「对象 + 位图」，
 * 中间这层（位图解码、PSD 坐标落到关键帧、插入顺序）不属于任何一边，
 * 也不该继续塞进已经有 800 行的 project-io.mjs。
 *
 * 对外是**纯函数**：只接 doc、只返回新 doc，不读外壳 ctx、不 flash、不写全局状态，
 * 所以 tests/import-file.test.mjs 能在 node 里直接测（那里没有 Electron、没有 ImageData）。
 * 唯一的运行期依赖是 ipc.mjs，而且只在 pickAndImport() 里用到：没有桥时返回失败对象，不抛。
 *
 * 这里有两条「映射规则」，改渲染层就必须回来对一遍：
 *
 * 一、PSD 组（'lsct'）→ 组对象 + 子对象 parentId。
 *    psd.mjs 只吐每层的 parentName（最近一层组名），既没有组自身的可见性 / 不透明度，
 *    也表达不了组套组（组记录不进 layers 数组）。组对象要带自己的 visible / opacity、
 *    嵌套组还要二级 parentId，所以本文件补一个只读的字节扫描 groupTreeOf()：
 *    段布局与配对规则逐条镜像 psd.mjs 的 readLayerSection / assembleLayers。
 *    扫描不可信（长度对不上、越界）时整体降级为「全部根对象」，绝不猜父子关系。
 *    坐标系：组的位移恒为 0，子对象写「相对父原点的 left/top」，父链由 evaluator.mjs
 *    的 matrixOfChain 相乘，画面位置与扁平导入一致。
 *
 * 二、PSD blendMode → 对象 mixMode。
 *    mixMode 的唯一消费者是 `g.globalCompositeOperation = layer.mixMode`
 *    （composite.mjs 的 drawLayer、evaluator.mjs 的 drawOne 各一处），所以可选值
 *    只能是 canvas 认识的那一组；见 MIX_MODE_BY_BLEND 上方的注释。
 */

import { parsePsd } from '../core/psd.mjs';
import { createDoc, makeObject } from '../core/doc-model.mjs';
import { createKey } from '../core/transform.mjs';
import * as ipc from './ipc.mjs';

/** 扩展名 → 分派类型。主进程 ms:import-file 的 filters 必须与这里一一对应。 */
const KIND_BY_EXT = {
    psd: 'psd',
    psb: 'psd',
    png: 'image',
    jpg: 'image',
    jpeg: 'image',
    webp: 'image',
};

/** 扩展名 → MIME：Blob 的 type 决定 createImageBitmap 走哪个解码器。 */
const MIME_BY_EXT = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
};

/** 导入本身不带时间信息，落到新文档时只求时间轴有刻度可用。 */
const DEFAULT_FPS = 12;
const DEFAULT_SECONDS = 1;

/**
 * PSD blendMode → 对象 mixMode。
 *
 * 依据（不是猜的）：mixMode 只被当作 canvas 的 globalCompositeOperation 直写
 * （composite.mjs 的 drawLayer：`g.globalCompositeOperation = layer.mixMode`；
 * evaluator.mjs 的 drawOne 同一句），因此取值必须是 canvas 2D 认识的那一组。
 * 这里只收「PSD 与 canvas 语义一致」的部分：
 *   normal → source-over（canvas 的默认盖图）
 *   darken / multiply / color burn / lighten / screen / color dodge / overlay /
 *   soft light / hard light / difference / exclusion / hue / saturation / color /
 *   luminosity 一一同名对应。
 * 其余一律回退 'source-over'（PSD 有、canvas 没有等价枚举）：
 *   dissolve（要逐像素抖动）、linear burn、darker color、linear dodge、
 *   lighter color、vivid light、linear light、pin light、hard mix、subtract、divide。
 * 特别说明「线性减淡」：它看起来像 canvas 的 'lighter'，但 'lighter' 是**合成**算子，
 * 颜色与 alpha 一起相加；PSD 的线性减淡只加颜色、不改 alpha，混用会在透明底上
 * 叠出错误的半透明边，所以宁可不映射。
 */
const MIX_MODE_BY_BLEND = Object.freeze({
    normal: 'source-over',
    darken: 'darken',
    multiply: 'multiply',
    'color burn': 'color-burn',
    lighten: 'lighten',
    screen: 'screen',
    'color dodge': 'color-dodge',
    overlay: 'overlay',
    'soft light': 'soft-light',
    'hard light': 'hard-light',
    difference: 'difference',
    exclusion: 'exclusion',
    hue: 'hue',
    saturation: 'saturation',
    color: 'color',
    luminosity: 'luminosity',
});

/** 兜底混色：canvas 默认的「直接盖上去」。 */
const DEFAULT_MIX_MODE = 'source-over';

/**
 * PSD blendMode（psd.mjs 已转成可读名，未知码是 4 字节原串）→ mixMode。
 * 认不出就回退 source-over：宁可画得朴素，也不要往 canvas 里塞非法字符串
 * （非法值会被静默忽略，排查起来比回退更费劲）。
 */
export function mixModeOf(blendMode) {
    const key = typeof blendMode === 'string' ? blendMode.trim().toLowerCase() : '';
    return Object.prototype.hasOwnProperty.call(MIX_MODE_BY_BLEND, key) ? MIX_MODE_BY_BLEND[key] : DEFAULT_MIX_MODE;
}

/* ─────────────────────────── 小工具 ─────────────────────────── */

/** 小写扩展名（不含点）；没有扩展名返回 ''。 */
export function extOf(name) {
    const m = /\.([A-Za-z0-9]+)$/.exec(String(name == null ? '' : name));
    return m ? m[1].toLowerCase() : '';
}

/** 扩展名 → 'psd' | 'image' | ''（空 = 不支持）。 */
export function kindOf(name) {
    return KIND_BY_EXT[extOf(name)] || '';
}

/**
 * 把 IPC 传回来的载荷统一成 Uint8Array。
 * 主进程发的是 ArrayBuffer；这里顺手认 ArrayBufferView，
 * 免得哪天主进程改成 Uint8Array、整条链路静默失效。
 */
export function toBytes(data) {
    if (!data) return null;
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return null;
}

function intOr(v, def) {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? n : def;
}

function clamp01(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 1;
    return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** 去掉扩展名的文件名（对象名用它，'a.png' → 'a'）。 */
function stripExt(name) {
    return String(name || '').replace(/\.[^./\\]*$/, '');
}

/* ─────────────────────────── 位图解码 ─────────────────────────── */

/**
 * PSD 图层 → 可绘制位图。
 * 优先 ImageData（Chromium 里最快），退回临时 canvas，最后退回裸像素描述；
 * 三层兜底是为了让同一份代码在渲染进程、node 测试、无 GPU 环境里都能走通。
 */
async function psdLayerImage(layer) {
    const w = intOr(layer.width, 0);
    const h = intOr(layer.height, 0);
    if (!w || !h) return null;
    const need = w * h * 4;
    const src = layer.rgba instanceof Uint8ClampedArray ? layer.rgba : new Uint8ClampedArray(layer.rgba || 0);
    if (src.length < need) return null;
    // 复制一份再交给 ImageData：解码是异步的，PSD 缓冲若被复用会画出花屏
    const pixels = new Uint8ClampedArray(src.subarray(0, need));

    if (typeof ImageData === 'function' && typeof createImageBitmap === 'function') {
        try {
            return await createImageBitmap(new ImageData(pixels, w, h));
        } catch (err) {
            // 某些环境里 createImageBitmap(ImageData) 会被拒，掉到 canvas 路径
        }
    }
    if (typeof ImageData === 'function' && typeof document !== 'undefined' && document.createElement) {
        try {
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const g = canvas.getContext('2d');
            if (g) {
                g.putImageData(new ImageData(pixels, w, h), 0, 0);
                return canvas;
            }
        } catch (err) {
            // 继续掉到裸像素
        }
    }
    // node / 无 DOM：返回足够画图的数据描述，psdToObjects 仍可用于测试与预检
    return { width: w, height: h, data: pixels, psd: true };
}

/** 位图文件（PNG/JPEG/WebP）→ ImageBitmap；o.decode 可注入（测试用）。 */
async function decodeBitmap(bytes, name, decoder) {
    if (typeof decoder === 'function') {
        try {
            return await decoder(bytes, name);
        } catch (err) {
            return null;
        }
    }
    if (typeof Blob !== 'function' || typeof createImageBitmap !== 'function') return null;
    const type = MIME_BY_EXT[extOf(name)] || 'image/png';
    try {
        return await createImageBitmap(new Blob([bytes], { type }));
    } catch (err) {
        return null;
    }
}

/* ─────────────────── PSD 图层 → 文档对象（映射规则的核心） ─────────────────── */

/**
 * 一个 PSD 图层 → 一个文档对象。
 * 位置落到 transform 的首帧关键帧，而不是给对象加偏移字段：
 * makeObject 的 anchor 默认是 {0,0}，elementMatrix 在 anchor=0 时退化成纯平移，
 * 所以 keys[0].state 的 (x,y) 就是「图层左上角在父对象坐标里的位置」。
 * parent 非空时写的是相对父原点的偏移；组自身的位移恒为 0，所以这里等价于
 * 直接用文档坐标，而画面位置仍由 evaluator.mjs 的 matrixOfChain 逐级相乘还原。
 *
 * @param {object} layer psd.mjs 的图层
 * @param {*} image 已解码位图
 * @param {{id:string,x:number,y:number,visible:boolean}|null} parent 所属组对象（根图层为 null）
 * @param {{grouped:number}} report 统计口径
 */
function psdObject(layer, image, parent, report) {
    const name = String(layer.name == null ? '' : layer.name).trim() || '图层';
    if (parent) report.grouped += 1;

    return makeObject({
        name,
        // 自身隐藏的层在导入前就丢了，所以这里只剩「祖先隐藏」一种情况：
        // 求值器只看本层的 visible（drawEvaluated 不沿 parentId 往上查），
        // 组的隐藏必须在这里落到子对象身上，否则整棵子树照画不误。
        visible: parent ? parent.visible : true,
        opacity: clamp01(layer.opacity),
        mixMode: mixModeOf(layer.blendMode),
        kind: 'image',
        cels: [{ at: 0, image }],
        parentId: parent ? parent.id : undefined,
        transform: {
            keys: [createKey(0, {
                x: intOr(layer.left, 0) - (parent ? parent.x : 0),
                y: intOr(layer.top, 0) - (parent ? parent.y : 0),
            })],
        },
    });
}

/**
 * 一个 PSD 组 → 一个组对象：没有位图，只承担父子关系、可见性与不透明度。
 * 组自身不带位移，所以 transform 恒为 {0,0}；子对象沿用文档坐标即可。
 * 空组（没有任何可导入的子对象）不会走到这里——没有内容就不该占一个面板项。
 */
function groupObject(node, parent) {
    const name = String(node.name == null ? '' : node.name).trim() || '组';
    return makeObject({
        name,
        // 组不可见 → 整棵子树不渲染，这条也写进子对象（见 psdObject）
        visible: !!node.visible && (!parent || parent.visible),
        opacity: clamp01(node.opacity),
        // 组不产出像素：PSD 组的混合模式在本渲染器里没有落点（父子只叠变换/不透明度），
        // 与其塞一个永不生效的值，不如明确写成默认值。
        mixMode: DEFAULT_MIX_MODE,
        kind: 'image',
        cels: [{ at: 0, image: null }],
        parentId: parent ? parent.id : undefined,
        transform: { keys: [createKey(0, { x: 0, y: 0 })] },
    });
}

/* ───────────────── PSD 组结构（'lsct'）的只读扫描 ───────────────── */

/**
 * 为什么还要扫一遍字节：psd.mjs 的输出只有「图层 → parentName」，
 * 组记录（组自身的 visible / opacity / 嵌套关系）被 assembleLayers 丢掉了，
 * 组套组更是根本没出现在 layers 数组里。组对象要带自己的属性、二级 parentId 要对，
 * 只能回到字节里取。本函数与 psd.mjs 的读法逐条对齐：同样的段布局、同样的
 * 'lsct' 1/2/3 配对、同样的 'luni' 覆盖 pascal 名、同样的奇数长度补 1 字节；
 * 它只跳数据、不解码通道，所以是同步的纯函数。任何不一致都不抛，返回 null
 * 让调用方降级——宁可平铺，也不要编造父子关系。
 *
 * @param {Uint8Array} bytes
 * @returns {{root:object, layerCount:number}|null}
 */
function groupTreeOf(bytes) {
    try {
        return scanGroupTree(bytes);
    } catch (err) {
        return null;
    }
}

function scanGroupTree(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let pos = 0;
    let end = bytes.byteLength;

    const need = (n) => {
        if (!(n >= 0) || n > end - pos) throw new Error('组扫描越界');
    };
    const u8 = () => { need(1); const v = view.getUint8(pos); pos += 1; return v; };
    const u16 = () => { need(2); const v = view.getUint16(pos); pos += 2; return v; };
    const i16 = () => { need(2); const v = view.getInt16(pos); pos += 2; return v; };
    const u32 = () => { need(4); const v = view.getUint32(pos); pos += 4; return v; };
    const i32 = () => { need(4); const v = view.getInt32(pos); pos += 4; return v; };
    const skip = (n) => { need(n); pos += n; };
    const u64 = () => {
        need(8);
        const hi = view.getUint32(pos);
        const lo = view.getUint32(pos + 4);
        pos += 8;
        return hi * 4294967296 + lo;
    };
    const i64 = () => {
        need(8);
        const hi = view.getInt32(pos);
        const lo = view.getUint32(pos + 4);
        pos += 8;
        return hi * 4294967296 + lo;
    };
    const text = (n) => {
        need(n);
        let s = '';
        for (let i = 0; i < n; i += 1) s += String.fromCharCode(bytes[pos + i]);
        pos += n;
        return s;
    };
    const utf16be = (chars) => {
        need(chars * 2);
        let s = '';
        for (let i = 0; i < chars; i += 1) {
            s += String.fromCharCode(view.getUint16(pos));
            pos += 2;
        }
        return s;
    };

    // 文件头：与 readHeader 同序（签名 / 版本 / 预留 / 通道 / 高 / 宽 / 位深 / 色彩模式）
    if (text(4) !== '8BPS') return null;
    const version = u16();
    if (version !== 1 && version !== 2) return null;
    const psb = version === 2;
    skip(6);
    u16();
    u32();
    u32();
    u16();
    u16();
    skip(u32()); // 色彩模式数据
    skip(u32()); // 图像资源

    // 只在「图层与蒙版」段 → 「图层信息」段里读，边界收窄后 need() 自然拦住越界
    const sectionLen = psb ? u64() : u32();
    if (!(sectionLen > 0)) return null;
    end = Math.min(pos + sectionLen, end);
    const infoLen = psb ? u64() : u32();
    if (!(infoLen > 0)) return null;
    end = Math.min(pos + infoLen, end);

    const countRaw = psb ? i64() : i16();
    const count = Math.abs(Number(countRaw)) || 0;
    if (!count) return null;

    // 附加数据：蒙版、混合范围、pascal 名、附加块（'luni' 覆盖名字，'lsct' 给分组类型）
    function readExtra(rec, extraEnd) {
        if (!(extraEnd > pos)) return;
        const maskLen = u32();
        if (maskLen > 0) skip(maskLen);
        const rangeLen = u32();
        if (rangeLen > 0) skip(rangeLen);
        if (pos < extraEnd) {
            const nameLen = u8();
            if (nameLen > 0) rec.name = text(nameLen);
            const pad = (4 - ((1 + nameLen) % 4)) % 4;
            if (pad > 0 && pos + pad <= extraEnd) pos += pad;
        }
        const minBlock = psb ? 16 : 12;
        while (extraEnd - pos >= minBlock) {
            const at = pos;
            const sig = text(4);
            if (sig !== '8BIM' && sig !== '8B64') break;
            const key = text(4);
            const len = psb ? u64() : u32();
            if (!(len <= extraEnd - pos)) break;
            const blockEnd = pos + len;
            if (key === 'luni') {
                if (len >= 4) {
                    const chars = u32();
                    if (chars > 0 && chars * 2 <= blockEnd - pos) rec.name = utf16be(chars);
                }
            } else if (key === 'lsct' || key === 'lsdk') {
                if (len >= 4) rec.divider = u32();
            }
            pos = blockEnd;
            // 少数写出器不把奇数长度补齐算进长度字段，下一个块能对齐才补 1 字节
            if ((len & 1) !== 0 && pos < extraEnd) pos += 1;
            if (pos <= at) break;
        }
    }

    const records = [];
    for (let i = 0; i < count; i += 1) {
        i32(); i32(); i32(); i32(); // 图层矩形 top / left / bottom / right
        const channels = u16();
        for (let c = 0; c < channels; c += 1) {
            i16(); // 通道 id
            skip(psb ? 8 : 4); // 通道数据长度
        }
        if (text(4) !== '8BIM') throw new Error('图层记录签名错误');
        const blend = text(4);
        const opacity = u8();
        u8(); // 剪切标记
        const flags = u8();
        u8(); // 填充字节
        const extraLen = u32();
        const extraEnd = Math.min(pos + extraLen, end);
        const rec = { name: '', visible: (flags & 0x02) === 0, opacity: opacity / 255, blend, divider: 0 };
        readExtra(rec, extraEnd);
        pos = extraEnd;
        records.push(rec);
    }

    // 配对规则照抄 assembleLayers：3 = 组结束；1 = 组开始；2 在有 3 的文件里也是开始，
    // 在只会写 1/2 的样本里当结束用。
    const hasEndMarker = records.some((rec) => rec.divider === 3);
    const root = { kind: 'root', children: [] };
    const stack = [root];
    let layerCount = 0;
    for (const rec of records) {
        const type = rec.divider;
        if (type === 3) {
            if (stack.length > 1) stack.pop();
            continue;
        }
        if (type === 1 || type === 2) {
            if (type === 2 && !hasEndMarker && stack.length > 1) {
                stack.pop();
                continue;
            }
            const node = { kind: 'group', name: rec.name, visible: rec.visible, opacity: rec.opacity, children: [] };
            stack[stack.length - 1].children.push(node);
            stack.push(node);
            continue;
        }
        // layers 数组的顺序就是「非分隔记录」的字节顺序，所以下标可以直接对齐
        stack[stack.length - 1].children.push({ kind: 'layer', index: layerCount });
        layerCount += 1;
    }
    return { root, layerCount };
}

/**
 * 组树 + 图层数组 → 对象数组（top-first：结果 [0] 是视觉最上层）。
 * 组对象排在自己的子对象前面（面板里组压着内容），视觉顺序不受影响：
 * 组没有像素，绘制时拿不到图就跳过。
 */
async function buildObjects(tree, layers, makeImage, report) {
    return emitNode(tree.root, null, { layers, makeImage, report });
}

async function emitNode(node, parent, ctx) {
    if (!node) return [];
    if (node.kind === 'root') return emitChildren(node.children, parent, ctx);
    if (node.kind === 'layer') {
        const one = await emitLayer(node.index, parent, ctx);
        return one ? [one] : [];
    }
    // 组：先造组对象（子对象要拿它的 id 和可见性），再决定这个组值不值得留下
    const group = groupObject(node, parent);
    const parentX = parent ? parent.x : 0;
    const parentY = parent ? parent.y : 0;
    // 组原点 = 父原点（组自身不位移），子对象因此继续用文档坐标
    const kids = await emitChildren(node.children, {
        id: group.id,
        x: parentX,
        y: parentY,
        visible: group.visible,
    }, ctx);
    if (!kids.length) return [];
    ctx.report.groups += 1;
    return [group].concat(kids);
}

/**
 * children 在 PSD 里是自底向上排的（assembleLayers 按字节顺序 push），
 * 倒序取才会得到 top-first。每个节点自带「组对象 + 子对象」的完整片段，
 * 拼起来仍是连续的视觉叠放顺序。
 */
async function emitChildren(children, parent, ctx) {
    const out = [];
    const list = Array.isArray(children) ? children : [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
        const part = await emitNode(list[i], parent, ctx);
        for (let k = 0; k < part.length; k += 1) out.push(part[k]);
    }
    return out;
}

/** 单个图层 → 对象；被跳过时返回 null，hidden / empty 统一在这里记账。 */
async function emitLayer(index, parent, ctx) {
    const layer = ctx.layers[index];
    if (!layer) return null;
    // 隐藏图层默认丢掉：PSD 里关掉的层通常只是存档用的参考
    if (!layer.visible) {
        ctx.report.hidden += 1;
        return null;
    }
    if (!(Number(layer.width) > 0) || !(Number(layer.height) > 0)) {
        ctx.report.empty += 1;
        return null;
    }
    let image = null;
    try {
        image = await ctx.makeImage(layer);
    } catch (err) {
        image = null;
    }
    if (!image) {
        ctx.report.empty += 1;
        return null;
    }
    return psdObject(layer, image, parent, ctx.report);
}

/**
 * 降级路径：组扫描不可信（长度对不上 / 越界）时，所有图层平铺成根对象，
 * 组名仍写进对象名（`组名/图层名`，与旧版导入一致）。不丢信息，也不编造父子关系。
 * 返回值同样是 top-first。
 */
async function flatObjects(layers, makeImage, report) {
    const ctx = { layers, makeImage, report };
    const built = [];
    for (let i = 0; i < layers.length; i += 1) {
        const obj = await emitLayer(i, null, ctx);
        if (!obj) continue;
        const group = String((layers[i] && layers[i].parentName) || '').trim();
        if (group) {
            obj.name = group + '/' + obj.name;
            report.grouped += 1;
        }
        built.push(obj);
    }
    return built.slice().reverse();
}

/**
 * 把导入出来的对象并进目标文档。
 * 没有基准文档时用 createDoc 造一份（它会塞一个占位对象，这里整表替换掉）。
 */
function importTargetDoc(base, objects, opts) {
    if (base && typeof base === 'object') {
        // 已有对象整体后移：新导入的排最上面，才能立刻看见 / 被选中
        const key = Array.isArray(base.objects) ? 'objects' : 'layers';
        const rest = Array.isArray(base[key]) ? base[key] : [];
        return { ...base, [key]: objects.concat(rest) };
    }
    const o = opts || {};
    const shell = createDoc({
        width: o.width,
        height: o.height,
        fps: Number(o.fps) > 0 ? Number(o.fps) : DEFAULT_FPS,
        duration: Number(o.duration) > 0 ? Number(o.duration) : DEFAULT_SECONDS,
    });
    return { ...shell, objects };
}

/**
 * PSD 字节 → 新文档（不可变：绝不改动传入的 doc）。
 *
 * @param {ArrayBuffer|Uint8Array} buffer 完整 PSD/PSB 字节
 * @param {object} [opts]
 * @param {object} [opts.doc] 基准文档（并进去）；不给就按 PSD 尺寸新建一份
 * @param {'top-first'|'array'} [opts.order] 插入顺序，默认 top-first（视觉与 PSD 一致）
 * @param {Function} [opts.makeImage] 自定义「图层 → 位图」，测试用
 * @returns {Promise<{ok:boolean, doc?:object, report?:object, activeId?:string, error?:string}>}
 */
export async function psdToObjects(buffer, opts) {
    const o = opts || {};
    const bytes = toBytes(buffer);
    if (!bytes || !bytes.byteLength) return { ok: false, error: '没有读到 PSD 内容' };

    let parsed;
    try {
        parsed = await parsePsd(bytes);
    } catch (err) {
        // parsePsd 对 16/32 位、CMYK 抛的是中文原因：原样透出比一句「导入失败」有用
        return { ok: false, error: String((err && err.message) || err) || 'PSD 解析失败' };
    }

    const makeImage = typeof o.makeImage === 'function' ? o.makeImage : psdLayerImage;
    const layers = Array.isArray(parsed.layers) ? parsed.layers : [];
    const report = {
        kind: 'psd',
        psdWidth: intOr(parsed.width, 0),
        psdHeight: intOr(parsed.height, 0),
        layers: layers.length,
        imported: 0,
        hidden: 0,
        empty: 0,
        grouped: 0,
        groups: 0,
        order: o.order === 'array' ? 'array' : 'top-first',
    };

    // 组结构只能回字节里扫（psd.mjs 丢掉了组记录，见 groupTreeOf 的注释）；
    // 层数对不上就说明扫描与解析没对齐，宁可降级也不编造父子关系
    const tree = groupTreeOf(bytes);
    const trusted = !!tree && tree.layerCount === layers.length;
    // 两条路径都返回 top-first：组对象排在自己的子对象前面
    const built = trusted
        ? await buildObjects(tree, layers, makeImage, report)
        : await flatObjects(layers, makeImage, report);
    if (!built.length) return { ok: false, error: 'PSD 里没有可导入的图层（全部隐藏或为空）', report };

    // doc.objects[0] 才是视觉最上层（composite.mjs 倒序遍历绘制）：
    // order:'array' 要的是结构自底向上，整表反转即可，组与子对象一起翻。
    const list = report.order === 'array' ? built.slice().reverse() : built.slice();
    report.imported = list.length;

    const base = o.doc && typeof o.doc === 'object' ? o.doc : null;
    const doc = importTargetDoc(base, list, {
        width: report.psdWidth || 900,
        height: report.psdHeight || 640,
        fps: o.fps,
        duration: o.duration,
    });
    // 选中项取最上层那个（对象面板第 0 项）
    return { ok: true, doc, report, activeId: list[0].id };
}

/**
 * PNG/JPG/WebP 字节 → 一个 kind:'image' 的对象并进文档。
 * 只加对象，不动 doc.width/height —— 位图比画布大就溢出，用户自己缩放。
 *
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {object} [opts] {doc, name, x, y, decode}
 * @returns {Promise<{ok:boolean, doc?:object, report?:object, activeId?:string, error?:string}>}
 */
export async function imageToObject(buffer, opts) {
    const o = opts || {};
    const bytes = toBytes(buffer);
    if (!bytes || !bytes.byteLength) return { ok: false, error: '没有读到图片内容' };

    const name = String(o.name || '');
    const bitmap = await decodeBitmap(bytes, name, o.decode);
    if (!bitmap) return { ok: false, error: '图片解码失败（扩展名和真实格式可能不符）' };

    const w = Math.max(1, intOr(bitmap.width, 0));
    const h = Math.max(1, intOr(bitmap.height, 0));
    const base = o.doc && typeof o.doc === 'object' ? o.doc : null;
    const canvasW = base ? Math.max(1, intOr(base.width, w)) : w;
    const canvasH = base ? Math.max(1, intOr(base.height, h)) : h;
    // 位图自己没有坐标：居中放入画布。贴 (0,0) 会让大图只剩右下角，看着像导入失败。
    const x = o.x !== undefined && Number.isFinite(Number(o.x)) ? Math.round(Number(o.x)) : Math.round((canvasW - w) / 2);
    const y = o.y !== undefined && Number.isFinite(Number(o.y)) ? Math.round(Number(o.y)) : Math.round((canvasH - h) / 2);

    const obj = makeObject({
        name: stripExt(name) || '导入的图片',
        visible: true,
        opacity: 1,
        kind: 'image',
        cels: [{ at: 0, image: bitmap }],
        transform: { keys: [createKey(0, { x, y })] },
    });
    const doc = importTargetDoc(base, [obj], { width: canvasW, height: canvasH, fps: o.fps, duration: o.duration });
    return {
        ok: true,
        doc,
        activeId: obj.id,
        report: { kind: 'image', width: w, height: h, x, y, imported: 1 },
    };
}

/**
 * 按文件名分派：PSD 走 psdToObjects，位图走 imageToObject。
 * @param {{name:string, data:ArrayBuffer|Uint8Array}} payload 主进程 ms:import-file 的返回
 */
export async function importBuffer(payload, opts) {
    const o = opts || {};
    const name = String((payload && payload.name) || o.name || '');
    const kind = kindOf(name);
    if (!kind) {
        const ext = extOf(name);
        return { ok: false, error: '不支持的文件类型：' + (ext ? '.' + ext : '（没有扩展名）') };
    }
    const shared = { ...o, name };
    if (kind === 'psd') return psdToObjects(payload && payload.data, shared);
    return imageToObject(payload && payload.data, shared);
}

/**
 * 弹系统文件选择框 + 分派 + 生成新文档（唯一会碰主进程的入口）。
 * 没有桥 / 取消 / 解析失败一律返回 `{ok:false, ...}`，由调用方 flash，不抛。
 *
 * @param {{doc?:object, exts?:string[], order?:string}} [opts]
 */
export async function pickAndImport(opts) {
    const o = opts || {};
    let res = null;
    try {
        res = await Promise.resolve(ipc.importFile(o.exts));
    } catch (err) {
        res = null;
    }
    // 没有 preload 桥（纯浏览器打开 index.html）：给一句可读的原因
    if (!res) return { ok: false, error: '导入需要桌面版（浏览器里没有文件对话框）' };
    if (res.ok === false) {
        const canceled = res.canceled === true;
        return { ok: false, canceled, error: canceled ? '' : String(res.error || '打开文件失败') };
    }
    const name = String(res.name || res.path || '');
    const kind = kindOf(name);
    if (!kind) {
        const ext = extOf(name);
        return { ok: false, error: '不支持的文件类型：' + (ext ? '.' + ext : '（没有扩展名）') };
    }
    return importBuffer({ name, path: res.path || '', data: res.data }, {
        doc: o.doc,
        name,
        order: o.order,
        x: o.x,
        y: o.y,
        fps: o.fps,
        duration: o.duration,
        makeImage: o.makeImage,
        decode: o.decode,
    });
}
