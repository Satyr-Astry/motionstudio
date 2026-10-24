// 帮助面板：动画模型 + 快捷键。纯静态内容，不依赖 doc。
// 分两段用同一个 .hlp-title 做小节标题，避免新增 CSS。

const SECTIONS = [
    {
        title: '动画是怎么构成的',
        note: [
            ['画格', '某时刻起显示的那张画。时间上是离散的——到点就换图，中间没有过渡。在「画板」里画出来。'],
            ['关键帧', '位置、缩放、旋转、不透明度、网格变形。时间上连续插值，中间有过渡。拖手柄或改数值就会自动打帧。'],
            ['时间通道', '对象自己的时间。可偏移、缩放、循环，让同一个动画用不同节奏播；套到父对象上会传给整棵子树。'],
        ],
    },
    {
        title: '快捷键',
        items: [
            ['空格', '播放 / 暂停'],
            [',', '上一画格'],
            ['.', '下一画格'],
            ['Ctrl+Z', '撤销'],
            ['Ctrl+Shift+Z', '重做'],
            ['Ctrl+D', '把当前画格复制到新时刻'],
            ['Ctrl+Shift+L', '把当前画格链接到上一格（共用同一张图）'],
            ['Ctrl+Shift+H', '切换当前画格继承 / 独立'],
            ['B', '画笔'],
            ['E', '橡皮'],
            ['G', '填充'],
            ['I', '取色器'],
            ['H', '平移画布'],
            ['[', '笔尖变小'],
            [']', '笔尖变大'],
            ['0', '适配画布'],
            ['滚轮', '平移画布'],
            ['Ctrl+滚轮', '缩放画布'],
            ['拖区域标题', '交换两个区域'],
            ['拖分隔条', '调整区域比例'],
            ['双击分隔条', '复位比例'],
        ],
    },
    {
        title: '曲线区怎么用',
        note: [
            ['点关键帧', '选中它，出现切线柄。Shift 点可多选，空白处拖出框选。'],
            ['拖圆点', '上下改数值、左右改时间。按住 Shift 吸附画格切换点。'],
            ['拖手柄', '改缓动曲线——决定加速还是减速。'],
            ['双击空白', '在该时刻加一个关键帧。'],
            ['右键', '线性 / 贝塞尔 / 保持 / 删除关键帧。'],
        ],
    },
];

export function mount(el, ctx) {
    const root = document.createElement('div');
    root.className = 'hlp';

    for (const sec of SECTIONS) {
        const title = document.createElement('div');
        title.className = 'hlp-title';
        title.textContent = sec.title;
        root.appendChild(title);

        const list = document.createElement('div');
        list.className = 'hlp-list';

        if (sec.note) {
            // 概念说明：条目标签不加 kbd 边框，用描述块承载整段文字
            for (const [name, desc] of sec.note) {
                const item = document.createElement('div');
                item.className = 'hlp-item';
                const kbd = document.createElement('kbd');
                kbd.className = 'hlp-key';
                kbd.textContent = name;
                const span = document.createElement('span');
                span.className = 'hlp-desc';
                span.textContent = desc;
                item.append(kbd, span);
                list.appendChild(item);
            }
        }

        for (const [key, desc] of sec.items || []) {
            const item = document.createElement('div');
            item.className = 'hlp-item';
            const kbd = document.createElement('kbd');
            kbd.className = 'hlp-key';
            kbd.textContent = key;
            const span = document.createElement('span');
            span.className = 'hlp-desc';
            span.textContent = desc;
            item.append(kbd, span);
            list.appendChild(item);
        }

        root.appendChild(list);
    }

    el.appendChild(root);

    return {
        refresh() {},
        destroy() {
            root.remove();
        },
    };
}
