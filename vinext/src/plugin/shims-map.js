import path from "node:path";

/**
 * next/* module ids to vinext shim files (relative to the shims directory).
 * The contract is the fixture apps' next-shims.d.ts.
 */
export const NEXT_SHIMS = {
  next: "next.js",
  "next/app": "app.js",
  "next/cache": "cache.js",
  "next/compat/router": "compat-router.js",
  "next/config": "config.js",
  "next/document": "document.js",
  "next/dynamic": "dynamic.js",
  "next/form": "form.js",
  "next/head": "head.js",
  "next/headers": "headers.js",
  "next/image": "image.js",
  "next/link": "link.js",
  "next/navigation": "navigation.js",
  "next/router": "router.js",
  "next/script": "script.js",
  "next/server": "server.js",
};

/** Shims the rsc environment (react-server condition) loads instead. */
export const REACT_SERVER_SHIMS = {
  "next/navigation": "navigation.react-server.js",
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
