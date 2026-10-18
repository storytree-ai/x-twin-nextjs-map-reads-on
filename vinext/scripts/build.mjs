// Build: copy the ES module sources to dist/ and make the CLI executable.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src");
const dist = path.join(root, "dist");

fs.rmSync(dist, { recursive: true, force: true });
fs.cpSync(src, dist, { recursive: true });
fs.chmodSync(path.join(dist, "cli.js"), 0o755);
console.log(`vinext: built ${path.relative(process.cwd(), dist) || "dist"}`);
