/**
 * Kleks Motion —— Blender 式区域树（split / join / swap / serialize）
 * 契约：src/motion/CONTRACT.md §2
 *
 * 约定
 * - 全部导出都是纯函数：**不修改入参**，返回新树（未改动的分支按引用共享）。
 * - 非法操作（找不到 id、只剩一个区域、id 指向 split）返回**原树本身**，不抛异常。
 * - 区域 id 是身份：split 时原区域保留 id，新区域拿新 id；join 后存活子节点保留自己的 id。
 */

/** @typedef {{type:'area', id:string, editor:string, size?:number, grow?:boolean}} Area */
/** @typedef {{type:'split', dir:'row'|'col', children:Node[], size?:number, grow?:boolean}} Split */
/** @typedef {Area|Split} Node */

const DEFAULT_EDITOR = 'timeline';
const ID_RE = /^area-(\d+)$/;
let seq = 0;

function isArea(n) {
  return !!n && typeof n === 'object' && n.type === 'area';
}

function isNode(n) {
  return isArea(n) || (!!n && typeof n === 'object' && n.type === 'split' && Array.isArray(n.children));
}

/** 只拷贝布局字段：不要往对象里写 undefined 键（deepStrictEqual 会区分缺键） */
function withLayout(out, src) {
  if (typeof src.size === 'number' && Number.isFinite(src.size)) out.size = src.size;
  if (typeof src.grow === 'boolean') out.grow = src.grow;
  // 折叠态也是布局的一部分：存盘/还原后标题栏还是折着的
  if (src.collapsed === true) out.collapsed = true;
  return out;
}

function bumpSeqFrom(id) {
  const m = ID_RE.exec(String(id));
  if (m) seq = Math.max(seq, Number(m[1]));
}

function freshId(taken) {
  let id;
  do {
    id = `area-${++seq}`;
  } while (taken && taken.has(id));
  return id;
}

/** 新区域节点。id 可显式指定（测试 / 反序列化用），否则自动生成。 */
export function createArea(editor, id) {
  const node = {
    type: 'area',
    id: id === undefined || id === null || id === '' ? freshId() : String(id),
    editor: editor === undefined || editor === null || editor === '' ? DEFAULT_EDITOR : String(editor),
  };
  bumpSeqFrom(node.id);
  return node;
}

/** 深度优先查找（area 或 split 都能找到），找不到返回 null。 */
export function findNode(root, nodeId) {
  if (!isNode(root)) return null;
  if (isArea(root)) return root.id === nodeId ? root : null;
  for (const child of root.children) {
    const hit = findNode(child, nodeId);
    if (hit) return hit;
  }
  return null;
}

/** 按遍历顺序（左→右 / 上→下）列出所有区域。 */
export function walkAreas(root) {
  const out = [];
  const visit = (n) => {
    if (!isNode(n)) return;
    if (isArea(n)) out.push(n);
    else for (const c of n.children) visit(c);
  };
  visit(root);
  return out;
}

/** 用 fn 替换第一个匹配 id 的 area：返回 {node, changed}，未改动时 node === 入参。 */
function mapArea(node, id, fn) {
  if (isArea(node)) {
    return node.id === id ? { node: fn(node), changed: true } : { node, changed: false };
  }
  let changed = false;
  const children = [];
  for (const child of node.children) {
    if (changed) {
      children.push(child);
      continue;
    }
    const r = mapArea(child, id, fn);
    if (r.changed) changed = true;
    children.push(r.node);
  }
  return changed ? { node: { ...node, children }, changed: true } : { node, changed: false };
}

/**
 * 把某区域一分为二（同 editor，新区域排在原区域之后）。
 * 新 split 承接原区域的 size/grow；两个子区域从默认布局开始 —— join 时再还回去。
 */
export function splitNode(root, nodeId, dir) {
  if (!isNode(root)) return root;
  const target = findNode(root, nodeId);
  if (!isArea(target)) return root;
  const taken = new Set(walkAreas(root).map((a) => a.id));
  const sibling = createArea(target.editor, freshId(taken));
  const r = mapArea(root, nodeId, (area) => {
    const keep = { type: 'area', id: area.id, editor: area.editor };
    return withLayout({ type: 'split', dir: dir === 'col' ? 'col' : 'row', children: [keep, sibling] }, area);
  });
  return r.changed ? r.node : root;
}

/** 移除一个区域。父节点只剩 1 个子节点时上提（把父 split 换成这个子节点）。 */
function removeArea(node, id) {
  if (isArea(node)) {
    return node.id === id ? { node: null, changed: true } : { node, changed: false };
  }
  let changed = false;
  const children = [];
  for (const child of node.children) {
    if (changed) {
      children.push(child);
      continue;
    }
    const r = removeArea(child, id);
    if (r.changed) {
      changed = true;
      if (r.node) children.push(r.node);
    } else {
      children.push(child);
    }
  }
  if (!changed) return { node, changed: false };
  if (children.length === 0) return { node: null, changed: true };
  if (children.length === 1) {
    // 上提：父 split 的布局字段转交给唯一的子节点（子节点自己的值优先）
    const only = children[0];
    const out = withLayout({ ...only }, only);
    if (out.size === undefined && typeof node.size === 'number') out.size = node.size;
    if (out.grow === undefined && typeof node.grow === 'boolean') out.grow = node.grow;
    return { node: out, changed: true };
  }
  return { node: { ...node, children }, changed: true };
}

/** 移除区域；只剩一个区域时是非法操作（返回原树）。 */
export function joinNode(root, nodeId) {
  if (!isNode(root)) return root;
  if (walkAreas(root).length <= 1) return root;
  if (!isArea(findNode(root, nodeId))) return root;
  const r = removeArea(root, nodeId);
  if (!r.changed || !r.node) return root;
  return r.node;
}

function mapAll(node, fn) {
  if (isArea(node)) return fn(node);
  return { ...node, children: node.children.map((c) => mapAll(c, fn)) };
}

/** Blender 式互换两个区域的编辑器（只换 editor，id / 布局不动）。 */
export function swapEditors(root, idA, idB) {
  if (!isNode(root) || idA === idB) return root;
  const a = findNode(root, idA);
  const b = findNode(root, idB);
  if (!isArea(a) || !isArea(b)) return root;
  const ea = a.editor;
  const eb = b.editor;
  return mapAll(root, (n) => {
    if (n.id === idA) return { ...n, editor: eb };
    if (n.id === idB) return { ...n, editor: ea };
    return n;
  });
}

/** 规范化成可直接 JSON.stringify 的普通对象（丢弃未知字段与 undefined 键）。 */
export function serialize(root) {
  if (!isNode(root)) return null;
  if (isArea(root)) {
    return withLayout({ type: 'area', id: root.id, editor: root.editor }, root);
  }
  const children = [];
  for (const child of root.children) {
    const s = serialize(child);
    if (s) children.push(s);
  }
  return withLayout({ type: 'split', dir: root.dir === 'col' ? 'col' : 'row', children }, root);
}

/** serialize 的逆操作；非法结构返回 null（不抛异常）。 */
export function deserialize(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (obj.type === 'area') {
    if (typeof obj.id !== 'string' || obj.id === '') return null;
    const area = {
      type: 'area',
      id: obj.id,
      editor: typeof obj.editor === 'string' && obj.editor ? obj.editor : DEFAULT_EDITOR,
    };
    bumpSeqFrom(area.id);
    return withLayout(area, obj);
  }
  if (obj.type === 'split') {
    if (!Array.isArray(obj.children) || obj.children.length === 0) return null;
    const children = [];
    for (const c of obj.children) {
      const d = deserialize(c);
      if (!d) return null;
      children.push(d);
    }
    return withLayout({ type: 'split', dir: obj.dir === 'col' ? 'col' : 'row', children }, obj);
  }
  return null;
}
