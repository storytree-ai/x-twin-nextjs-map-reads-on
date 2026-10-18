/**
 * next.config headers/redirects/rewrites and middleware matchers: source
 * patterns (path-to-regexp syntax), has/missing conditions and destination
 * interpolation. Pure: requests are { url: URL, headers: Headers }.
 */

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** Read a balanced "(...)" group starting at i; returns [body, nextIndex]. */
function readGroup(source, i) {
  let depth = 0;
  let j = i;
  for (; j < source.length; j++) {
    const ch = source[j];
    if (ch === "\\") {
      j++;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) break;
  }
  return [source.slice(i + 1, j), j + 1];
}

const cache = new Map();

/** Compile a source pattern ("/blog/:slug*", "/api/(.*)") to { match(pathname) -> params | null }. */
export function compileSource(source) {
  if (cache.has(source)) return cache.get(source);
  let re = "";
  const names = [];
  let unnamed = 0;
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    let name = null;
    let body = null;
    if (ch === ":") {
      const m = /^:([A-Za-z0-9_]+)/.exec(source.slice(i));
      if (m) {
        name = m[1];
        i += m[0].length;
        if (source[i] === "(") [body, i] = readGroup(source, i);
      }
    } else if (ch === "(") {
      [body, i] = readGroup(source, i);
      name = String(unnamed++);
    }
    if (name === null) {
      re += ch === "\\" ? escapeRe(source[++i] ?? "") : escapeRe(ch);
      i++;
      continue;
    }
    const modifier = "*+?".includes(source[i]) && source[i] ? source[i++] : "";
    const segment = body ?? "[^/]+?";
    const prefixed = re.endsWith("\\/") && modifier !== "";
    if (prefixed) re = re.slice(0, -2);
    const group = `(?<p${names.length}>${modifier === "*" || modifier === "+" ? `${segment}(?:\\/${segment})*` : segment})`;
    const prefix = prefixed ? "\\/" : "";
    re += modifier === "*" || modifier === "?" ? `(?:${prefix}${group})?` : `${prefix}${group}`;
    names.push(name);
  }
  const regex = new RegExp(`^${re}\\/?$`, "i");
  const compiled = {
    match(pathname) {
      const m = regex.exec(pathname);
      if (!m) return null;
      const params = {};
      names.forEach((n, idx) => {
        params[n] = m.groups[`p${idx}`];
      });
      return params;
    },
  };
  cache.set(source, compiled);
  return compiled;
}

export function parseCookies(header) {
  const out = {};
  for (const part of (header || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (!key || key in out) continue;
    let value = part.slice(eq + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {}
    out[key] = value;
  }
  return out;
}

function conditionValue(cond, request) {
  switch (cond.type) {
    case "header":
      return request.headers.get(cond.key) ?? undefined;
    case "cookie":
      return parseCookies(request.headers.get("cookie"))[cond.key];
    case "query":
      return request.url.searchParams.has(cond.key) ? request.url.searchParams.get(cond.key) : undefined;
    case "host":
      return request.url.hostname;
    default:
      return undefined;
  }
}

function conditionHolds(cond, request) {
  const value = conditionValue(cond, request);
  if (value === undefined) return false;
  const expected = cond.type === "host" ? cond.value ?? cond.key : cond.value;
  if (expected === undefined) return true;
  return new RegExp(`^(?:${expected})$`).test(value);
}

/** Params when the rule's source and has/missing conditions match the request, else null. */
export function matchRule(rule, request, pathname = request.url.pathname) {
  const params = compileSource(rule.source).match(pathname);
  if (!params) return null;
  if (rule.has && !rule.has.every((c) => conditionHolds(c, request))) return null;
  if (rule.missing && rule.missing.some((c) => conditionHolds(c, request))) return null;
  return params;
}

/** Substitute :name params into a destination or header value. */
export function interpolate(template, params) {
  return template.replace(/:([A-Za-z0-9_]+)[*+?]?/g, (whole, name) =>
    name in params ? params[name] ?? "" : whole,
  );
}

/** A destination URL with the request's query merged under its own. */
function destinationUrl(destination, params, request) {
  const external = /^[a-z][a-z0-9+.-]*:\/\//i.test(destination);
  const target = new URL(interpolate(destination, params), request.url);
  if (!external || target.origin === request.url.origin) {
    for (const [key, value] of request.url.searchParams) {
      if (!target.searchParams.has(key)) target.searchParams.append(key, value);
    }
  }
  return target;
}

/** { destination, status } for the first matching redirect, else null. */
export function findRedirect(redirects, request) {
  for (const rule of redirects || []) {
    const params = matchRule(rule, request);
    if (!params) continue;
    const target = destinationUrl(rule.destination, params, request);
    const destination =
      target.origin === request.url.origin && !/^[a-z][a-z0-9+.-]*:\/\//i.test(rule.destination)
        ? target.pathname + target.search + target.hash
        : target.href;
    return { destination, status: rule.statusCode || (rule.permanent ? 308 : 307) };
  }
  return null;
}

/** Every { key, value } header the matching rules add. */
export function collectHeaders(rules, request) {
  const out = [];
  for (const rule of rules || []) {
    const params = matchRule(rule, request);
    if (!params) continue;
    for (const h of rule.headers || []) out.push({ key: h.key, value: interpolate(h.value, params) });
  }
  return out;
}

/** The URL the first matching rewrite points at, else null. */
export function findRewrite(rules, request, pathname = request.url.pathname) {
  for (const rule of rules || []) {
    const params = matchRule(rule, request, pathname);
    if (params) return destinationUrl(rule.destination, params, request);
  }
  return null;
}

/** next.config rewrites() in either form, as { beforeFiles, afterFiles, fallback }. */
export function normalizeRewrites(rewrites) {
  if (Array.isArray(rewrites)) return { beforeFiles: [], afterFiles: rewrites, fallback: [] };
  return {
    beforeFiles: rewrites?.beforeFiles || [],
    afterFiles: rewrites?.afterFiles || [],
    fallback: rewrites?.fallback || [],
  };
}

/** Whether middleware's `config.matcher` selects the request (no matcher: everything). */
export function matchesMiddleware(config, request, pathname = request.url.pathname) {
  const matcher = config?.matcher;
  if (matcher === undefined || matcher === null) return true;
  const entries = Array.isArray(matcher) ? matcher : [matcher];
  return entries.some((entry) =>
    typeof entry === "string" ? compileSource(entry).match(pathname) !== null : matchRule(entry, request, pathname) !== null,
  );
}
