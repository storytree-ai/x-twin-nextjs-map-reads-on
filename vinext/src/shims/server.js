/**
 * next/server: NextRequest, NextResponse, after(), connection() and
 * userAgent(). NextResponse.next()/rewrite() speak to the middleware runner
 * through x-middleware-* headers, as Next.js does.
 */
import { RequestCookies, ResponseCookies } from "./internal/cookies.js";
import { getRequestContext, markDynamic, queueAfter } from "./internal/request-context.js";

export class NextURL extends URL {
  clone() {
    return new NextURL(this.href);
  }
  get basePath() {
    return "";
  }
  get buildId() {
    return undefined;
  }
  get locale() {
    return "";
  }
}

export class NextRequest extends Request {
  constructor(input, init = {}) {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    super(input, init);
    this._nextUrl = new NextURL(init.nextUrl ? String(init.nextUrl) : url);
    this._cookies = new RequestCookies(this.headers);
  }
  get nextUrl() {
    return this._nextUrl;
  }
  get cookies() {
    return this._cookies;
  }
  get geo() {
    return {};
  }
  get ip() {
    return undefined;
  }
  get page() {
    return undefined;
  }
  get ua() {
    return undefined;
  }
}

function initOf(init) {
  return typeof init === "number" ? { status: init } : init || {};
}

/** Headers for NextResponse.next/rewrite's `request.headers` override. */
function applyRequestOverride(headers, init) {
  const requestHeaders = init?.request?.headers;
  if (!requestHeaders) return;
  const override = new Headers(requestHeaders);
  const names = [];
  for (const [key, value] of override) {
    headers.set(`x-middleware-request-${key}`, value);
    names.push(key);
  }
  headers.set("x-middleware-override-headers", names.join(","));
}

export class NextResponse extends Response {
  constructor(body, init = {}) {
    super(body, init);
    this._cookies = new ResponseCookies(this.headers);
  }
  get cookies() {
    return this._cookies;
  }
  static json(body, init) {
    const options = initOf(init);
    const headers = new Headers(options.headers);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    return new NextResponse(JSON.stringify(body), { ...options, headers });
  }
  static redirect(url, init) {
    const options = initOf(init);
    const status = options.status ?? 307;
    if (![301, 302, 303, 307, 308].includes(status)) throw new RangeError(`Failed to execute "redirect" on "response": Invalid status code`);
    const headers = new Headers(options.headers);
    headers.set("location", String(url));
    return new NextResponse(null, { ...options, status, headers });
  }
  static rewrite(destination, init) {
    const options = initOf(init);
    const headers = new Headers(options.headers);
    headers.set("x-middleware-rewrite", String(destination));
    applyRequestOverride(headers, options);
    return new NextResponse(null, { ...options, headers });
  }
  static next(init) {
    const options = initOf(init);
    const headers = new Headers(options.headers);
    headers.set("x-middleware-next", "1");
    applyRequestOverride(headers, options);
    return new NextResponse(null, { ...options, headers });
  }
}

/** Run `task` (a function or promise) after the response has been sent. */
export function after(task) {
  queueAfter(getRequestContext(), task);
}

/** Wait for a real request: opts the render out of static caching. */
export function connection() {
  markDynamic();
  return Promise.resolve();
}

export class NextFetchEvent {
  constructor(request) {
    this.request = request;
    this._promises = [];
  }
  waitUntil(promise) {
    this._promises.push(promise);
  }
}

export function userAgentFromString(ua = "") {
  const isBot = /bot|crawler|spider|crawling/i.test(ua);
  const browser = /Edg\/([\d.]+)/.exec(ua)
    ? { name: "Edge", version: /Edg\/([\d.]+)/.exec(ua)[1] }
    : /Chrome\/([\d.]+)/.exec(ua)
      ? { name: "Chrome", version: /Chrome\/([\d.]+)/.exec(ua)[1] }
      : /Firefox\/([\d.]+)/.exec(ua)
        ? { name: "Firefox", version: /Firefox\/([\d.]+)/.exec(ua)[1] }
        : /Version\/([\d.]+).*Safari/.exec(ua)
          ? { name: "Safari", version: /Version\/([\d.]+)/.exec(ua)[1] }
          : {};
  const mobile = /Mobi|Android|iPhone/i.test(ua);
  return {
    ua,
    isBot,
    browser,
    device: mobile ? { type: "mobile" } : {},
    engine: {},
    os: /Windows/.test(ua) ? { name: "Windows" } : /Mac OS X/.test(ua) ? { name: "Mac OS" } : /Linux/.test(ua) ? { name: "Linux" } : {},
    cpu: {},
  };
}

export function userAgent(request) {
  return userAgentFromString(request.headers.get("user-agent") || "");
}

export { RequestCookies, ResponseCookies };
