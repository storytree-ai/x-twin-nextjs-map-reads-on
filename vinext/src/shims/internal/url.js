import { interpolatePattern } from "../../routing/pages-routes.js";

function appendQuery(params, query, skip) {
  for (const [key, value] of Object.entries(query || {})) {
    if (skip && skip.has(key)) continue;
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) for (const v of value) params.append(key, String(v));
    else params.append(key, String(value));
  }
}

/**
 * Turn a Link/router href (string or UrlObject) into a URL string. Dynamic
 * segments in an object pathname ("/posts/[id]") are filled from its query.
 */
export function formatHref(href) {
  if (href == null) return "";
  if (typeof href === "string") return href;
  if (href instanceof URL) return href.pathname + href.search + href.hash;
  let pathname = href.pathname || "";
  const query = href.query && typeof href.query === "object" ? href.query : null;
  let used = null;
  if (pathname.includes("[") && query) {
    const filled = interpolatePattern(pathname, query);
    if (filled) {
      pathname = filled.path;
      used = filled.used;
    }
  }
  const params = new URLSearchParams();
  if (query) appendQuery(params, query, used);
  else if (typeof href.query === "string") return pathname + "?" + href.query.replace(/^\?/, "");
  let search = href.search || (params.toString() ? "?" + params.toString() : "");
  if (search && search[0] !== "?") search = "?" + search;
  let hash = href.hash || "";
  if (hash && hash[0] !== "#") hash = "#" + hash;
  return pathname + search + hash;
}

/** URLSearchParams to a Next.js query object (repeated keys become arrays). */
export function searchParamsToQuery(searchParams) {
  const query = {};
  for (const [key, value] of searchParams) {
    if (key in query) {
      query[key] = Array.isArray(query[key]) ? [...query[key], value] : [query[key], value];
    } else {
      query[key] = value;
    }
  }
  return query;
}
