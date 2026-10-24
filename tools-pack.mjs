import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const out = path.join(root, "dist", "MotionStudio-win32-x64");
const dist = path.join(root, "node_modules", "electron", "dist");
if (!fs.existsSync(dist)) throw new Error("找不到 electron dist: " + dist);

function rmrf(p) { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); }
function copyDir(src, dst, filter) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) {
        const s = path.join(src, name);
        const d = path.join(dst, name);
        if (filter && !filter(s, name)) continue;
        const st = fs.statSync(s);
        if (st.isDirectory()) copyDir(s, d, filter);
        else fs.copyFileSync(s, d);
    }
}

rmrf(out);
fs.mkdirSync(out, { recursive: true });
// 1) 整个 electron 运行时
copyDir(dist, out);
// 2) 应用本体塞进 resources/app（真实目录，不是 junction）
const appDir = path.join(out, "resources", "app");
fs.mkdirSync(appDir, { recursive: true });
for (const f of ["main.js", "preload.js", "package.json"]) fs.copyFileSync(path.join(root, f), path.join(appDir, f));
copyDir(path.join(root, "app"), path.join(appDir, "app"), (s, name) => {
    if (name === "img" && path.basename(path.dirname(s)) === "promo") return false; // 宣传片截图不进安装包
    return true;
});
// 3) 可执行文件改名
const exe = path.join(out, "electron.exe");
if (fs.existsSync(exe)) fs.renameSync(exe, path.join(out, "MotionStudio.exe"));

// 4) 安装 / 卸载脚本
const install = `@echo off
chcp 65001 >nul
setlocal
set "TARGET=%LOCALAPPDATA%\\Programs\\MotionStudio"
echo 正在安装 MotionStudio 0.0.1-alpha 到 %TARGET% ...
if exist "%TARGET%" rd /s /q "%TARGET%"
mkdir "%TARGET%"
xcopy "%~dp0MotionStudio-win32-x64\\*" "%TARGET%\\" /E /I /H /Y >nul
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell); $d=[Environment]::GetFolderPath('Desktop'); $p=[Environment]::GetFolderPath('Programs'); $a=Join-Path $env:LOCALAPPDATA 'Programs\\MotionStudio\\MotionStudio.exe'; foreach($dir in @($d,(Join-Path $p 'MotionStudio'))){ if(-not (Test-Path $dir)){ New-Item -ItemType Directory -Path $dir -Force | Out-Null }; $l=$s.CreateShortcut((Join-Path $dir 'MotionStudio.lnk')); $l.TargetPath=$a; $l.WorkingDirectory=Split-Path $a; $l.IconLocation=$a+',0'; $l.Save() }"
echo.
echo 安装完成：桌面与开始菜单都有 MotionStudio 快捷方式。
pause
`;
const uninstall = `@echo off
chcp 65001 >nul
set "TARGET=%LOCALAPPDATA%\\Programs\\MotionStudio"
echo 正在卸载 MotionStudio ...
powershell -NoProfile -Command "$d=[Environment]::GetFolderPath('Desktop'); $p=[Environment]::GetFolderPath('Programs'); Remove-Item (Join-Path $d 'MotionStudio.lnk') -ErrorAction SilentlyContinue; Remove-Item (Join-Path (Join-Path $p 'MotionStudio') 'MotionStudio.lnk') -ErrorAction SilentlyContinue"
if exist "%TARGET%" rd /s /q "%TARGET%"
echo 已卸载。
pause
`;
fs.writeFileSync(path.join(root, "dist", "安装.cmd"), install.replace(/\n/g, "\r\n"), "utf8");
fs.writeFileSync(path.join(root, "dist", "卸载.cmd"), uninstall.replace(/\n/g, "\r\n"), "utf8");

// 5) 统计
let files = 0, bytes = 0;
(function walk(d) { for (const n of fs.readdirSync(d)) { const p2 = path.join(d, n); const st = fs.statSync(p2); if (st.isDirectory()) walk(p2); else { files += 1; bytes += st.size; } } })(out);
console.log("打包目录:", out);
console.log("文件数:", files, " 体积:", (bytes / 1024 / 1024).toFixed(1), "MB");
console.log("exe 存在:", fs.existsSync(path.join(out, "MotionStudio.exe")));
console.log("app 入口存在:", fs.existsSync(path.join(appDir, "main.js")));
