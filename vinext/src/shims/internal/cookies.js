/**
 * Cookie parsing and serialisation, and the RequestCookies/ResponseCookies
 * classes next/server and next/headers expose (the @edge-runtime/cookies API).
 */

export function parseCookieHeader(header) {
  const out = new Map();
  if (!header) return out;
  for (const part of header.split(/;\s*/)) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const name = (eq === -1 ? part : part.slice(0, eq)).trim();
    if (!name || out.has(name)) continue;
    let value = eq === -1 ? "true" : part.slice(eq + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {}
    out.set(name, value);
  }
  return out;
}

function encodeValue(value) {
  return encodeURIComponent(String(value)).replace(/%(2[346B]|5E|60|7C)/g, decodeURIComponent);
}

/** A Set-Cookie header value for { name, value, ...attributes }. */
export function serializeCookie(cookie) {
  const { name, value = "" } = cookie;
  const parts = [`${name}=${encodeValue(value)}`];
  if (cookie.path) parts.push(`Path=${cookie.path}`);
  if (cookie.expires !== undefined) {
    const date = typeof cookie.expires === "number" ? new Date(cookie.expires) : cookie.expires;
    parts.push(`Expires=${date.toUTCString()}`);
  }
  if (cookie.maxAge !== undefined) parts.push(`Max-Age=${cookie.maxAge}`);
  if (cookie.domain) parts.push(`Domain=${cookie.domain}`);
  if (cookie.secure) parts.push("Secure");
  if (cookie.httpOnly) parts.push("HttpOnly");
  if (cookie.sameSite) {
    const s = String(cookie.sameSite === true ? "strict" : cookie.sameSite).toLowerCase();
    parts.push(`SameSite=${s[0].toUpperCase()}${s.slice(1)}`);
  }
  if (cookie.partitioned) parts.push("Partitioned");
  if (cookie.priority) parts.push(`Priority=${cookie.priority[0].toUpperCase()}${cookie.priority.slice(1)}`);
  return parts.join("; ");
}

/** Parse one Set-Cookie header value into { name, value, ...attributes }. */
export function parseSetCookie(header) {
  const [pair, ...attrs] = header.split(/;\s*/);
  const eq = pair.indexOf("=");
  const cookie = { name: pair.slice(0, eq), value: decodeURIComponentSafe(pair.slice(eq + 1)) };
  for (const attr of attrs) {
    const [k, ...v] = attr.split("=");
    const key = k.toLowerCase();
    const val = v.join("=");
    if (key === "path") cookie.path = val;
    else if (key === "max-age") cookie.maxAge = Number(val);
    else if (key === "expires") cookie.expires = new Date(val);
    else if (key === "domain") cookie.domain = val;
    else if (key === "secure") cookie.secure = true;
    else if (key === "httponly") cookie.httpOnly = true;
    else if (key === "samesite") cookie.sameSite = val.toLowerCase();
  }
  return cookie;
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeSetArgs(args) {
  const [first, value, options] = args;
  if (typeof first === "object" && first !== null) return { ...first };
  return { ...(options || {}), name: first, value };
}

/** Cookies of a request: read from a Headers object's Cookie header. */
export class RequestCookies {
  constructor(requestHeaders) {
    this._headers = requestHeaders;
    this._parsed = parseCookieHeader(requestHeaders.get("cookie"));
  }
  get size() {
    return this._parsed.size;
  }
  get(...args) {
    const name = typeof args[0] === "string" ? args[0] : args[0]?.name;
    return this._parsed.has(name) ? { name, value: this._parsed.get(name) } : undefined;
  }
  getAll(...args) {
    const all = [...this._parsed].map(([name, value]) => ({ name, value }));
    if (!args.length) return all;
    const name = typeof args[0] === "string" ? args[0] : args[0]?.name;
    return all.filter((c) => c.name === name);
  }
  has(name) {
    return this._parsed.has(name);
  }
  set(...args) {
    const { name, value } = normalizeSetArgs(args);
    this._parsed.set(name, String(value));
    this._write();
    return this;
  }
  delete(names) {
    const list = Array.isArray(names) ? names : [names];
    const result = list.map((n) => this._parsed.delete(n));
    this._write();
    return Array.isArray(names) ? result : result[0];
  }
  clear() {
    this._parsed.clear();
    this._write();
    return this;
  }
  _write() {
    try {
      this._headers.set("cookie", [...this._parsed].map(([n, v]) => `${n}=${encodeValue(v)}`).join("; "));
    } catch {}
  }
  [Symbol.iterator]() {
    return [...this._parsed].map(([name, value]) => [name, { name, value }])[Symbol.iterator]();
  }
  toString() {
    return [...this._parsed].map(([n, v]) => `${n}=${encodeValue(v)}`).join("; ");
  }
}

/** Cookies a response sets: kept in step with its Set-Cookie headers. */
export class ResponseCookies {
  constructor(responseHeaders) {
    this._headers = responseHeaders;
    this._map = new Map();
    const existing = typeof responseHeaders.getSetCookie === "function" ? responseHeaders.getSetCookie() : [];
    for (const header of existing) {
      const cookie = parseSetCookie(header);
      this._map.set(cookie.name, cookie);
    }
  }
  get(...args) {
    const name = typeof args[0] === "string" ? args[0] : args[0]?.name;
    return this._map.get(name);
  }
  getAll(...args) {
    const all = [...this._map.values()];
    if (!args.length) return all;
    const name = typeof args[0] === "string" ? args[0] : args[0]?.name;
    return all.filter((c) => c.name === name);
  }
  has(name) {
    return this._map.has(name);
  }
  set(...args) {
    const cookie = normalizeSetArgs(args);
    cookie.value = cookie.value === undefined ? "" : String(cookie.value);
    this._map.set(cookie.name, cookie);
    this._write();
    return this;
  }
  delete(...args) {
    const opts = typeof args[0] === "string" ? { name: args[0] } : args[0];
    return this.set({ ...opts, value: "", expires: new Date(0), path: opts.path || "/" });
  }
  _write() {
    this._headers.delete("set-cookie");
    for (const cookie of this._map.values()) this._headers.append("set-cookie", serializeCookie(cookie));
  }
  [Symbol.iterator]() {
    return [...this._map].map(([name, c]) => [name, c])[Symbol.iterator]();
  }
  toString() {
    return [...this._map.values()].map(serializeCookie).join("; ");
  }
}
