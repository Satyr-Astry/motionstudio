import fs from "node:fs";
const p = "tests/timeline.test.mjs";
let s = fs.readFileSync(p, "utf8");
const before = s;
s = s.replace("'prevcel', 'nextcel', 'addcel', 'delcel', 'addkey',", "'prevcel', 'nextcel', 'addcel', 'delcel', 'addkey', 'snap',");
if (s === before) console.log("NO MATCH");
fs.writeFileSync(p, s);
