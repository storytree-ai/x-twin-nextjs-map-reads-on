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

  // Every directory under app/ (with one or more files below it), for finding slots.
  const allDirs = new Set();
  for (const file of normalized) {
    const parts = file.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) allDirs.add(parts.slice(0, i).join("/"));
  }
  const childDir = (dir, seg) => (dir === "" ? seg : `${dir}/${seg}`);
  const slotNamesOf = (dir) => {
    const names = [];
    for (const d of allDirs) {
      const parts = d.split("/");
      const seg = parts.pop();
      if (isSlot(seg) && parts.join("/") === dir) names.push(seg.slice(1));
    }
    return names.sort();
  };
  const urlPartsOf = (fsSegments) => fsSegments.filter((s) => !isGroup(s) && !isSlot(s)).map(decodeSegment);

  // Levels for the directories below `base` down to `fsSegments`' end.
  const levelsBelow = (base, fsSegments) => {
    const levels = [];
    let dir = base;
    for (const seg of fsSegments) {
      dir = childDir(dir, seg);
      const level = levelFor(dir, seg);
      if (!isGroup(seg) && !isSlot(seg)) {
        const parsed = parseSegment(decodeSegment(isIntercept(seg) ? INTERCEPT_RE.exec(seg)[2] : seg));
        if (parsed.name) level.paramName = parsed.name;
      }
      levels.push(level);
    }
    return levels;
  };

  // A slot's content for the URL parts below its layout: the slot's page for
  // the same parts (under the slot's own layouts), else its default.tsx.
  const slotContent = (slotDir, rest) => {
    const prefix = slotDir + "/";
    for (const leaf of leaves) {
      if (leaf.type !== "page") continue;
      if (leaf.dir !== slotDir && !leaf.dir.startsWith(prefix)) continue;
      const below = leaf.dir === slotDir ? [] : leaf.dir.slice(prefix.length).split("/");
      if (below.some((s) => isSlot(s) || isIntercept(s) || isPrivate(s))) continue;
      const parts = urlPartsOf(below);
      if (parts.length === rest.length && parts.every((p, i) => p === rest[i])) {
        return { file: leaf.file, levels: [levelFor(slotDir, slotDir.split("/").pop()), ...levelsBelow(slotDir, below)] };
      }
    }
    const fallback = dirs.get(slotDir)?.default;
    return fallback ? { file: fallback, levels: [levelFor(slotDir, slotDir.split("/").pop())] } : null;
  };

  // The levels from the root to the end of `fsSegments`, each with its slots
  // for the URL `urlParts` (which may run past `fsSegments`, for a slot's page).
  const chain = (fsSegments, urlParts) => {
    const levels = [levelFor("", ""), ...levelsBelow("", fsSegments)];
    let consumed = 0;
    levels.forEach((level, i) => {
      if (i > 0 && !isGroup(level.segment)) consumed++;
      level.slots = {};
      for (const name of slotNamesOf(level.dir)) {
        const content = slotContent(childDir(level.dir, "@" + name), urlParts.slice(consumed));
        if (content) level.slots[name] = content;
      }
    });
    return levels;
  };
  const addRoute = (type, file, fsSegments, urlParts) => {
    const urlSegments = urlParts.map(parseSegment);
    routes.push({
      pattern: "/" + urlParts.join("/"),
      type,
      file,
      segments: urlSegments,
      levels: chain(fsSegments, urlParts),
      isDynamic: urlSegments.some((s) => s.value === undefined),
    });
  };

  const intercepts = [];
  const slotOnly = [];
  for (const leaf of leaves) {
    const fsSegments = leaf.dir === "" ? [] : leaf.dir.split("/");
    if (fsSegments.some(isPrivate)) continue;
    const k = fsSegments.findIndex(isIntercept);
    if (k >= 0) {
      if (leaf.type === "page") intercepts.push(interceptOf(leaf, fsSegments, k));
      continue;
    }
    const j = fsSegments.findIndex(isSlot);
    if (j >= 0) {
      if (leaf.type === "page") slotOnly.push({ parent: fsSegments.slice(0, j), urlParts: urlPartsOf(fsSegments) });
      continue;
    }
    addRoute(leaf.type, leaf.file, fsSegments, urlPartsOf(fsSegments));
  }
  // A page only under a slot makes its URL a route, the slot parent's
  // default.tsx rendering as children.
  for (const { parent, urlParts } of slotOnly) {
    const pattern = "/" + urlParts.join("/");
    const fallback = dirs.get(parent.join("/"))?.default;
    if (!fallback || routes.some((r) => r.pattern === pattern)) continue;
    addRoute("page", fallback, parent, urlParts);
  }
  for (const entry of intercepts) {
    entry.levels = levelsBelow(entry.owner, entry.below);
    delete entry.below;
  }
  intercepts.sort(compareRoutes);
  routes.sort(compareRoutes);
  const root = levelFor("", "");
  root.globalError = globalError;
  return { routes, root, intercepts };
}

const INTERCEPT_RE = /^(\(\.\.\.\)|(?:\(\.\.\))+|\(\.\))(.*)$/;

/**
 * An intercepting page: the URL it intercepts ((.) beside the intercepting
 * segment, each (..) one URL segment up, (...) from the root), the directory
 * of the layout it renders inside (`owner`) and the slot it fills there
 * ("children" when it is not under a slot).
 */
function interceptOf(leaf, fsSegments, k) {
  const [, marker, name] = INTERCEPT_RE.exec(fsSegments[k]);
  const sourceParts = fsSegments.slice(0, k).filter((s) => !isGroup(s) && !isSlot(s)).map(decodeSegment);
  const base = marker === "(...)" ? [] : marker === "(.)" ? sourceParts : sourceParts.slice(0, Math.max(0, sourceParts.length - marker.length / 4));
  const rest = fsSegments.slice(k + 1).filter((s) => !isGroup(s) && !isSlot(s)).map(decodeSegment);
  const urlParts = [...base, ...(name ? [decodeSegment(name)] : []), ...rest];
  let j = -1;
  for (let i = k - 1; i >= 0; i--) {
    if (isSlot(fsSegments[i])) {
      j = i;
      break;
    }
  }
  const ownerEnd = j >= 0 ? j : k;
  return {
    pattern: "/" + urlParts.join("/"),
    segments: urlParts.map(parseSegment),
    file: leaf.file,
    owner: fsSegments.slice(0, ownerEnd).join("/"),
    slot: j >= 0 ? fsSegments[j].slice(1) : "children",
    below: fsSegments.slice(ownerEnd),
  };
}

/**
 * The intercepting page for a client navigation to `pathname` from
 * `fromPathname`: the route the client is on (which must run through the
 * intercepting layout), the intercept, its params and the owner's level.
 */
export function matchIntercept(intercepts, routes, pathname, fromPathname) {
  if (!fromPathname || !intercepts?.length) return null;
  const parts = pathname.split("?")[0].split("/").filter(Boolean);
  for (const intercept of intercepts) {
    const params = matchSegments(intercept.segments, parts);
    if (!params) continue;
    const from = matchAppRoute(routes, fromPathname);
    if (!from || from.route.type !== "page") continue;
    if (matchAppRoute(routes, pathname)?.route === from.route) continue;
    const ownerIndex = from.route.levels.findIndex((l) => l.dir === intercept.owner);
    if (ownerIndex < 0) continue;
    return { route: from.route, fromParams: from.params, intercept, params, ownerIndex };
  }
  return null;
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
