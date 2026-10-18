/**
 * Pages Router route table: file paths under `pages/` to URL patterns, and
 * matching a pathname against them. Pure: used on the server and the client.
 */

const PAGE_EXT_RE = /\.(tsx|ts|jsx|js|mjs|mts)$/;
const SPECIAL_RE = /^(_app|_document|_error|404|500)$/;

// Segment kinds, in match precedence order.
const STATIC = 0;
const DYNAMIC = 1;
const CATCH_ALL = 2;
const OPTIONAL_CATCH_ALL = 3;

function parseSegment(seg) {
  let m = /^\[\[\.\.\.([^\]]+)\]\]$/.exec(seg);
  if (m) return { kind: OPTIONAL_CATCH_ALL, name: m[1] };
  m = /^\[\.\.\.([^\]]+)\]$/.exec(seg);
  if (m) return { kind: CATCH_ALL, name: m[1] };
  m = /^\[([^\]]+)\]$/.exec(seg);
  if (m) return { kind: DYNAMIC, name: m[1] };
  return { kind: STATIC, value: seg };
}

/** "posts/[id].tsx" -> "/posts/[id]"; null for files that are not routes. */
export function fileToPattern(file) {
  const rel = file.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!PAGE_EXT_RE.test(rel) || /\.d\.[mc]?ts$/.test(rel)) return null;
  const noExt = rel.replace(PAGE_EXT_RE, "");
  const parts = noExt.split("/");
  if (parts.length === 1 && SPECIAL_RE.test(parts[0])) return null;
  if (parts[parts.length - 1] === "index") parts.pop();
  return "/" + parts.join("/");
}

function compareRoutes(a, b) {
  const len = Math.max(a.segments.length, b.segments.length);
  for (let i = 0; i < len; i++) {
    const sa = a.segments[i];
    const sb = b.segments[i];
    if (!sa) return -1;
    if (!sb) return 1;
    if (sa.kind !== sb.kind) return sa.kind - sb.kind;
  }
  return a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0;
}

/**
 * Build the route table from file paths relative to the pages directory,
 * sorted so the first match wins: static > dynamic > catch-all > optional.
 */
export function buildPagesRoutes(files) {
  const routes = [];
  for (const file of files) {
    const pattern = fileToPattern(file);
    if (pattern === null) continue;
    const segments = pattern === "/" ? [] : pattern.slice(1).split("/").map(parseSegment);
    routes.push({
      pattern,
      file: file.replace(/\\/g, "/"),
      segments,
      isApi: pattern === "/api" || pattern.startsWith("/api/"),
      isDynamic: segments.some((s) => s.kind !== STATIC),
    });
  }
  return routes.sort(compareRoutes);
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function matchSegments(segments, parts) {
  const params = {};
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.kind === CATCH_ALL || seg.kind === OPTIONAL_CATCH_ALL) {
      const rest = parts.slice(i);
      if (rest.length === 0 && seg.kind === CATCH_ALL) return null;
      if (rest.length > 0) params[seg.name] = rest.map(safeDecode);
      return params;
    }
    const part = parts[i];
    if (part === undefined) return null;
    if (seg.kind === STATIC) {
      if (seg.value !== part && seg.value !== safeDecode(part)) return null;
    } else {
      params[seg.name] = safeDecode(part);
    }
  }
  return parts.length === segments.length ? params : null;
}

/** First route matching the pathname, with its params, or null. */
export function matchPagesRoute(routes, pathname) {
  const clean = pathname.split("?")[0].split("#")[0];
  const parts = clean.split("/").filter(Boolean);
  for (const route of routes) {
    const params = matchSegments(route.segments, parts);
    if (params) return { route, params };
  }
  return null;
}

/** Fill a pattern ("/posts/[id]") from params; for interpolating Link hrefs. */
export function interpolatePattern(pattern, params) {
  const used = new Set();
  const segments = pattern === "/" ? [] : pattern.slice(1).split("/");
  const out = [];
  for (const raw of segments) {
    const seg = parseSegment(raw);
    if (seg.kind === STATIC) {
      out.push(raw);
      continue;
    }
    used.add(seg.name);
    const v = params[seg.name];
    if (seg.kind === DYNAMIC) {
      if (v === undefined || v === null) return null;
      out.push(encodeURIComponent(String(v)));
    } else {
      const arr = v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];
      if (arr.length === 0 && seg.kind === CATCH_ALL) return null;
      for (const p of arr) out.push(encodeURIComponent(String(p)));
    }
  }
  return { path: "/" + out.join("/"), used };
}
