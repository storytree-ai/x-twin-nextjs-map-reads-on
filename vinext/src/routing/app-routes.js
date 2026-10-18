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

// Metadata file conventions: [kind, file name, static extensions, root only].
// A code extension makes the file generated, a route module.
const METADATA_FILES = [
  ["favicon", /^favicon$/, ["ico"], true],
  ["icon", /^icon\d*$/, ["ico", "jpg", "jpeg", "png", "svg"], false],
  ["apple", /^apple-icon\d*$/, ["jpg", "jpeg", "png"], false],
  ["openGraph", /^opengraph-image\d*$/, ["jpg", "jpeg", "png", "gif"], false],
  ["twitter", /^twitter-image\d*$/, ["jpg", "jpeg", "png", "gif"], false],
  ["manifest", /^manifest$/, ["json", "webmanifest"], true],
  ["robots", /^robots$/, ["txt"], true],
  ["sitemap", /^sitemap$/, ["xml"], false],
];
const KIND_ORDER = METADATA_FILES.map(([kind]) => kind);
const HEAD_KINDS = new Set(["favicon", "icon", "apple", "openGraph", "twitter", "manifest"]);
// Generated metadata with more than one entry (generateSitemaps, generateImageMetadata).
export const METADATA_ID_PARAM = "__metadata_id__";

/** The metadata convention of an app/ file (path relative to app/), or null. */
export function metadataFileOf(file) {
  const parts = file.split("/");
  const base = parts.pop();
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  const name = base.slice(0, dot);
  const ext = base.slice(dot + 1);
  const isCode = CODE_EXT_RE.test(base) && !/\.d\.[mc]?ts$/.test(base);
  for (const [kind, nameRe, exts, rootOnly] of METADATA_FILES) {
    if (!nameRe.test(name)) continue;
    if (rootOnly && parts.length > 0) return null;
    if (kind === "favicon" && isCode) return null;
    if (isCode) return { kind, name, isStatic: false };
    return exts.includes(ext) ? { kind, name, ext, isStatic: true } : null;
  }
  return null;
}

/** Files the app route table takes in: code modules and metadata files. */
export function isAppFile(file) {
  return (CODE_EXT_RE.test(file) && !/\.d\.[mc]?ts$/.test(file)) || metadataFileOf(file) !== null;
}

/** The URL path a metadata file answers at, under its directory's URL path. */
function metadataPath(dirPath, meta) {
  const prefix = dirPath === "/" ? "" : dirPath;
  if (meta.kind === "robots") return "/robots.txt";
  if (meta.kind === "sitemap") return `${prefix}/sitemap.xml`;
  if (meta.kind === "manifest") return meta.isStatic ? `/manifest.${meta.ext}` : "/manifest.webmanifest";
  return meta.isStatic ? `${prefix}/${meta.name}.${meta.ext}` : `${prefix}/${meta.name}`;
}

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
  const normalized = files.map((f) => f.replace(/\\/g, "/").replace(/^\/+/, "")).filter(isAppFile);
  const dirs = new Map();
  const leaves = [];
  const metadataFiles = [];
  let globalError = null;
  for (const file of normalized) {
    const meta = metadataFileOf(file);
    if (meta) {
      metadataFiles.push({ file, meta });
      continue;
    }
    const parts = file.split("/");
    const name = parts.pop().replace(CODE_EXT_RE, "");
    const dir = parts.join("/");
    if (dir === "" && name === "global-error") globalError = file;
    if (!dirs.has(dir)) dirs.set(dir, {});
    const entry = dirs.get(dir);
    if (SPECIAL_FILES[name]) entry[SPECIAL_FILES[name]] = file;
    if (name === "page" || name === "route") leaves.push({ dir, file, type: name });
  }

  const routes = [];
  const headFiles = new Map();
  for (const { file, meta } of metadataFiles) {
    const dir = file.split("/").slice(0, -1);
    if (dir.some((s) => isSlot(s) || isIntercept(s) || isPrivate(s))) continue;
    const urlParts = dir.filter((s) => !isGroup(s)).map(decodeSegment);
    const dirPath = "/" + urlParts.join("/");
    const href = metadataPath(dirPath, meta);
    const add = (pattern) => {
      const segments = pattern.slice(1).split("/").map(parseSegment);
      routes.push({ pattern, type: "metadata", file, segments, levels: [], metadata: meta, isDynamic: segments.some((s) => s.value === undefined) });
    };
    add(href);
    // A generated sitemap or image can be many: /sitemap/<id>.xml, /icon/<id>.
    if (!meta.isStatic && meta.kind !== "robots" && meta.kind !== "manifest") {
      add(`${meta.kind === "sitemap" ? `${dirPath === "/" ? "" : dirPath}/sitemap` : href}/[${METADATA_ID_PARAM}]`);
    }
    if (HEAD_KINDS.has(meta.kind)) {
      const key = dir.join("/");
      if (!headFiles.has(key)) headFiles.set(key, []);
      headFiles.get(key).push({ kind: meta.kind, file, href, isStatic: meta.isStatic });
    }
  }
  for (const list of headFiles.values()) {
    list.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  }

  const levelFor = (dir, segment) => {
    const level = emptyLevel(dir, segment);
    Object.assign(level, dirs.get(dir) || {});
    level.metadataFiles = headFiles.get(dir) || [];
    return level;
  };

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

/**
 * Where a render error that failed the HTML shell is caught: the deepest
 * level above `below` with an error.tsx (whose boundary sits inside that
 * level's layout, so it catches errors from deeper levels and the page),
 * -1 for global-error.tsx (around the root layout), or null when none is left.
 * `below` is the level whose boundary failed last (Infinity at first).
 */
export function nextErrorBoundary(levels, below, hasGlobalError) {
  for (let i = Math.min(below - 1, levels.length - 1); i >= 0; i--) {
    if (levels[i].error) return i;
  }
  return below >= 0 && hasGlobalError ? -1 : null;
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
