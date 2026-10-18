/**
 * The URL of a page's RSC payload, and back: "/about?x=1" <-> "/about.rsc?x=1",
 * with "/" as "/index.rsc".
 */

export function rscUrl(href) {
  const url = new URL(href, "http://localhost");
  const pathname = url.pathname === "/" ? "/index" : url.pathname.replace(/\/+$/, "");
  return pathname + ".rsc" + url.search;
}

/** Split "/about.rsc" into the page pathname "/about" and a flag. */
export function parseRscPath(pathname) {
  if (!pathname.endsWith(".rsc")) return { pathname, isRsc: false };
  const base = pathname.slice(0, -4);
  return { pathname: base === "/index" || base === "" ? "/" : base, isRsc: true };
}
