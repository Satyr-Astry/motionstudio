import fs from "node:fs";
const p = "app/editors/timeline-paint.mjs";
let s = fs.readFileSync(p, "utf8");
s = s.replace("    snap.setAttribute('aria-pressed', 'true');",
"    if (typeof snap.setAttribute === 'function') snap.setAttribute('aria-pressed', 'true');");
s = s.replace("    view.btns.snap.setAttribute('aria-pressed', on ? 'true' : 'false');",
"    if (typeof view.btns.snap.setAttribute === 'function') view.btns.snap.setAttribute('aria-pressed', on ? 'true' : 'false');");
fs.writeFileSync(p, s);
console.log(/typeof snap.setAttribute/.test(s), /typeof view.btns.snap.setAttribute/.test(s));
