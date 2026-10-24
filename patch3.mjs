import fs from "node:fs";
const p = "tests/timeline.test.mjs";
let s = fs.readFileSync(p, "utf8");
const before = s;
s = s.replace(`        'addkey',
        'zoomout',
        'zoomin',`, `        'addkey',
        'snap',
        'zoomout',
        'zoomin',`);
if (s === before) console.log("NO MATCH");
fs.writeFileSync(p, s);
console.log(/snap/.test(s));
