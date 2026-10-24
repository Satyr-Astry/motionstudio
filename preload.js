// 预加载脚本：只向渲染进程暴露最小的文件能力，其余一律不放开。
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('motionAPI', {
    /** 导出逐帧 PNG。frames 是 dataURL 数组，返回 {ok, dir, count} */
    exportFrames: (name, frames) => ipcRenderer.invoke('ms:export-frames', { name, frames }),
    /** 导出精灵图：png 是 dataURL，json 是帧表文本，返回 {ok, dir, png, json} */
    exportSheet: (name, png, json) => ipcRenderer.invoke('ms:export-sheet', { name, png, json }),
    /** 保存项目 JSON（弹出保存对话框） */
    saveProject: (name, json) => ipcRenderer.invoke('ms:save-project', { name, json }),
    /** 打开项目 JSON（弹出打开对话框），返回 {ok, file, json} */
    loadProject: () => ipcRenderer.invoke('ms:load-project'),
    /**
     * 导入 PSD / 图片（弹出打开对话框）。
     * exts 可选：一组扩展名用来收窄对话框（如 ['psd','psb']）。
     * 返回 {ok, path, name, ext, size, data:ArrayBuffer}；大文件走结构化克隆，不做 base64。
     */
    importFile: (exts) => ipcRenderer.invoke('ms:import-file', { exts: Array.isArray(exts) ? exts : null }),
    /**
     * 保存一段二进制（WebM 视频等）。bytes 传 ArrayBuffer / Uint8Array 都行。
     * 返回 {ok, file, size} / {ok:false, canceled} / {ok:false, error}
     */
    saveBinary: (name, bytes, ext, label) => ipcRenderer.invoke('ms:save-binary', { name, bytes, ext, label }),
    /** 在资源管理器里打开导出目录 */
    openFolder: (dir) => ipcRenderer.invoke('ms:open-folder', dir),
});
