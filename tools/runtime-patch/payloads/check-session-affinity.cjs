const fs = require("node:fs");
const source = fs.readFileSync(process.env.ROUTER_CODEX_SESSION_AFFINITY_FILE, "utf8");
const required = [
  "codex-multi-auth local policy: versioned affinity tombstones",
  "writeVersionFloor = 0",
  "forgetSessionWithVersion(sessionKey",
  "clearAllWithVersion(writeVersion)",
  "entry.deleted === true",
];
if (required.some((value) => !source.includes(value))) process.exit(1);
