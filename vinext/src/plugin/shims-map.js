import path from "node:path";

/**
 * next/* module ids to vinext shim files (relative to the shims directory).
 * The contract is the fixture apps' next-shims.d.ts.
 */
export const NEXT_SHIMS = {
  next: "next.js",
  "next/app": "app.js",
  "next/compat/router": "compat-router.js",
  "next/document": "document.js",
  "next/head": "head.js",
  "next/link": "link.js",
  "next/router": "router.js",
};

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** Vite resolve.alias entries: exact module ids, optionally with ".js". */
export function nextShimAliases(shimsDir) {
  return Object.entries(NEXT_SHIMS).map(([id, file]) => ({
    find: new RegExp(`^${escapeRe(id)}(?:\\.js)?$`),
    replacement: path.join(shimsDir, file),
  }));
}
