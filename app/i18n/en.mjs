/**
 * English strings — the default locale.
 *
 * Key grammar: `area.entity.field` (`editor.timeline.title`, `effect.blur.name`,
 * `channel.rotate.label`). Two rules, both enforced by `_check-i18n.mjs`:
 *   1. every key here must also exist in `zh-Hans.mjs` (and vice versa);
 *   2. keys are never built by concatenating Chinese fragments — each key is one
 *      whole sentence. That is why this is a table and not a search-and-replace.
 *
 * Placeholder syntax is `{name}`; `t(key, vars)` substitutes it.
 */
export default {
    'app.title': 'MotionStudio',

    'locale.en': 'English',
    'locale.zhHans': '简体中文',

    'pref.language': 'Language',
    'pref.language.row': 'Interface language',
    'pref.language.hint': 'Interface language. Takes effect immediately and does not touch project data.',

    'editor.canvas.title': 'Canvas',
    'editor.canvas.hint': 'Draw, zoom, pan',

    'editor.board.title': 'Board',
    'editor.board.hint': 'Edits only the current texture (separate from the timeline)',

    'editor.toolbar.title': 'Tools',
    'editor.toolbar.hint': 'Brush, tip, undo',

    'editor.tree.title': 'Hierarchy',
    'editor.tree.hint': 'Parent links (who you move with)',

    'editor.layers.title': 'Stack',
    'editor.layers.hint': 'Draw order (who covers whom)',

    'editor.timeline.title': 'Timeline',
    'editor.timeline.hint': 'Keys, duration and playback',

    'editor.curve.title': 'Curves',
    'editor.curve.hint': 'Continuous curves and bezier handles for object transforms',

    'editor.palette.title': 'Palette',
    'editor.palette.hint': 'Hue, lightness and recent colours',

    'editor.properties.title': 'Properties',
    'editor.properties.hint': 'Document, textures and transform parameters',

    'editor.doc.title': 'Document',
    'editor.doc.hint': 'Canvas size, frame rate and looping',

    'editor.onion.title': 'Onion skin',
    'editor.onion.hint': 'Ghosts of the previous and next textures',

    'editor.info.title': 'Info',
    'editor.info.hint': 'Object, texture and keyframe counts',

    'editor.prefs.title': 'Preferences',
    'editor.prefs.hint': 'Auto-save, undo depth, snapping and canvas background',

    'editor.help.title': 'Help',
    'editor.help.hint': 'Shortcut reference',

    'editor.projects.title': 'Projects',
    'editor.projects.hint': 'Saved projects: open, create, delete',
};
