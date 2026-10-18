import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export const NEXT_CONFIG_FILES = ["next.config.ts", "next.config.mts", "next.config.mjs", "next.config.js", "next.config.cjs"];

export function findNextConfig(root) {
  for (const name of NEXT_CONFIG_FILES) {
    const file = path.join(root, name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/**
 * Load next.config.* (TS through Vite's runner, CJS through require) and
 * resolve function-form configs.
 */
export async function loadNextConfig(root, phase = "phase-development-server") {
  const file = findNextConfig(root);
  if (!file) return {};
  let mod;
  if (file.endsWith(".cjs")) {
    mod = createRequire(import.meta.url)(file);
  } else if (/\.m?ts$/.test(file)) {
    const { runnerImport } = await import("vite");
    mod = (await runnerImport(file, { root, configFile: false, logLevel: "silent" })).module;
  } else {
    try {
      mod = await import(pathToFileURL(file).href + `?t=${Date.now()}`);
    } catch (err) {
      // .js with CommonJS syntax in a "type": "module" package.
      if (/module is not defined|exports is not defined|require is not defined/.test(String(err?.message))) {
        const src = fs.readFileSync(file, "utf8");
        const m = { exports: {} };
        new Function("module", "exports", "require", src)(m, m.exports, createRequire(file));
        mod = m.exports;
      } else throw err;
    }
  }
  let config = mod?.default ?? mod;
  if (typeof config === "function") config = await config(phase, { defaultConfig: {} });
  return (await config) || {};
}
