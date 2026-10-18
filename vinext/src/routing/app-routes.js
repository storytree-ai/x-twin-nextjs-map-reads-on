/**
 * App Router route table: files under `app/` to routes, each with the chain
 * of directory levels (layouts, templates and boundaries) from the root to
 * its leaf. Pure: used on the server and in tests.
 */
import { parseSegment, compareRoutes, matchSegments } from "./pages-routes.js";

const CODE_EXT_RE = /\.(tsx|ts|jsx|js|mjs|mts)$/;
const SPECIAL_FILES = {
  layout: "layout",
  template: "template",
  error: "error",
  loading: "loading",
  "not-found": "notFound",
  forbidden: "forbidden",
  unauthorized: "unauthorized",
  default: "default",
};

const isGroup = (seg) => /^\(.*\)$/.test(seg) && !seg.startsWith("(.");
const isSlot = (seg) => seg.startsWith("@");
const isIntercept = (seg) => seg.startsWith("(.");
const isPrivate = (seg) => seg.startsWith("_");

function decodeSegment(seg) {
  return seg.replace(/%5F/gi, "_");
}

function emptyLevel(dir, segment) {
  const level = { dir, segment, paramName: null };
  for (const key of Object.values(SPECIAL_FILES)) level[key] = null;
  return level;
}

/**
 * Build the App Router route table from file paths relative to the app
 * directory. Returns `routes` sorted so the first match wins (static >
 * dynamic > catch-all > optional catch-all) and the `root` level, whose
 * layout and not-found boundary render unmatched URLs.
 */
export function buildAppRoutes(files) {
  const normalized = files.map((f) => f.replace(/\\/g, "/").replace(/^\/+/, "")).filter((f) => CODE_EXT_RE.test(f) && !/\.d\.[mc]?ts$/.test(f));
  const dirs = new Map();
  const leaves = [];
  let globalError = null;
  for (const file of normalized) {
    const parts = file.split("/");
    const name = parts.pop().replace(CODE_EXT_RE, "");
    const dir = parts.join("/");
    if (dir === "" && name === "global-error") globalError = file;
    if (!dirs.has(dir)) dirs.set(dir, {});
    const entry = dirs.get(dir);
    if (SPECIAL_FILES[name]) entry[SPECIAL_FILES[name]] = file;
    if (name === "page" || name === "route") leaves.push({ dir, file, type: name });
  }

  const levelFor = (dir, segment) => {
    const level = emptyLevel(dir, segment);
    Object.assign(level, dirs.get(dir) || {});
    return level;
  };

  const routes = [];
  for (const leaf of leaves) {
    const fsSegments = leaf.dir === "" ? [] : leaf.dir.split("/");
    if (fsSegments.some((s) => isSlot(s) || isIntercept(s) || isPrivate(s))) continue;
    const levels = [levelFor("", "")];
    const urlSegments = [];
    const patternParts = [];
    for (let i = 0; i < fsSegments.length; i++) {
      const seg = fsSegments[i];
      const level = levelFor(fsSegments.slice(0, i + 1).join("/"), seg);
      if (!isGroup(seg)) {
        const decoded = decodeSegment(seg);
        const parsed = parseSegment(decoded);
        urlSegments.push(parsed);
        patternParts.push(decoded);
        if (parsed.name) level.paramName = parsed.name;
      }
      levels.push(level);
    }
    routes.push({
      pattern: "/" + patternParts.join("/"),
      type: leaf.type,
      file: leaf.file,
      segments: urlSegments,
      levels,
      isDynamic: urlSegments.some((s) => s.value === undefined),
    });
  }
  routes.sort(compareRoutes);
  const root = levelFor("", "");
  root.globalError = globalError;
  return { routes, root };
}

/** First route matching the pathname, with its decoded params, or null. */
export function matchAppRoute(routes, pathname) {
  const clean = pathname.split("?")[0].split("#")[0];
  const parts = clean.split("/").filter(Boolean);
  for (const route of routes) {
    const params = matchSegments(route.segments, parts);
    if (params) return { route, params };
  }
  return null;
}
