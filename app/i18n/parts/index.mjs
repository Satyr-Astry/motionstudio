/**
 * 词条分片注册表。
 *
 * 为什么把词典拆成「基础表 + 分片」而不是一张大表：
 *   基础表（`../en.mjs` / `../zh-Hans.mjs`）放全局共用的那几十条；分片按**代码归属**
 *   切开（帮助面板一份、命令面板一份、效果一份、各属性面板一份）。这样多个面板的
 *   本地化可以并行做，改一个面板只动一个分片文件，不会在同一个大对象里打架；
 *   一个分片长到几百条时也还读得动。
 *
 * 每个分片导出 `{ en: {...}, 'zh-Hans': {...} }`，键集合必须镜面（`_check-i18n.mjs` 校验）。
 * 分片之间**不允许出现同一个键** —— 合并时后者会静默覆盖前者，那是最难查的一类 bug。
 */
import helpPart from './help.mjs';
import commandsPart from './commands.mjs';
import effectsPart from './effects.mjs';
import panelsPart from './panels.mjs';
import shellPart from './shell.mjs';
import boardPart from './board.mjs';
import layersPart from './layers.mjs';
import propsPart from './props.mjs';
import timelinePart from './timeline.mjs';
import projectsPart from './projects.mjs';
import canvasPart from './canvas.mjs';

export const PARTS = [
    helpPart,
    commandsPart,
    effectsPart,
    panelsPart,
    shellPart,
    boardPart,
    layersPart,
    propsPart,
    timelinePart,
    projectsPart,
    canvasPart,
];
