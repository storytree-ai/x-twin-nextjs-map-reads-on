/**
 * next/headers: the current request's headers(), cookies() and draftMode(),
 * each a promise that can also be used synchronously (Next.js 15's
 * transitional API). Reading any of them marks the render dynamic.
 */
import { getRequestContext, markDynamic } from "./internal/request-context.js";

const DRAFT_COOKIE = "__prerender_bypass";
const HEADERS_ERROR = "Headers cannot be modified. Read more: https://nextjs.org/docs/app/api-reference/functions/headers";
const COOKIES_ERROR =
  "Cookies can only be modified in a Server Action or Route Handler. Read more: https://nextjs.org/docs/app/api-reference/functions/cookies#options";

function requireContext(name) {
  const ctx = getRequestContext();
  if (!ctx) throw new Error(`\`${name}\` was called outside a request scope.`);
  markDynamic();
  return ctx;
}

/** A promise for `value` that also carries `value`'s members, methods bound to it. */
function syncThenable(value, members) {
  const promise = Promise.resolve(value);
  for (const name of members) {
    Object.defineProperty(promise, name, {
      get() {
        const member = value[name];
        return typeof member === "function" ? member.bind(value) : member;
      },
      configurable: true,
    });
  }
  return promise;
}

function readonlyHeaders(source) {
  const view = new Headers(source);
  const refuse = () => {
    throw new Error(HEADERS_ERROR);
  };
  view.set = refuse;
  view.append = refuse;
  view.delete = refuse;
  return view;
}

const HEADER_MEMBERS = ["get", "has", "entries", "keys", "values", "forEach", "getSetCookie", "set", "append", "delete", Symbol.iterator];

export function headers() {
  const ctx = requireContext("headers");
  ctx.readonlyHeaders ??= readonlyHeaders(ctx.headers);
  return syncThenable(ctx.readonlyHeaders, HEADER_MEMBERS);
}

function isWritable(ctx) {
  return ctx.phase === "route" || ctx.phase === "action";
}

function refuseCookieWrite() {
  throw new Error(COOKIES_ERROR);
}

/** The cookie store: reads the request (with this request's writes applied); writes become Set-Cookie headers. */
function createCookieStore(ctx) {
  const writable = isWritable(ctx);
  const store = {
    get: (...args) => ctx.cookies.get(...args),
    getAll: (...args) => ctx.cookies.getAll(...args),
    has: (name) => ctx.cookies.has(name),
    get size() {
      return ctx.cookies.size;
    },
    set(...args) {
      if (!writable) refuseCookieWrite();
      ctx.responseCookies.set(...args);
      const cookie = typeof args[0] === "object" ? args[0] : { name: args[0], value: args[1] };
      ctx.cookies.set(cookie.name, cookie.value ?? "");
      return store;
    },
    delete(...args) {
      if (!writable) refuseCookieWrite();
      ctx.responseCookies.delete(...args);
      ctx.cookies.delete(typeof args[0] === "string" ? args[0] : args[0].name);
      return store;
    },
    clear() {
      if (!writable) refuseCookieWrite();
      for (const { name } of ctx.cookies.getAll()) store.delete(name);
      return store;
    },
    toString: () => ctx.cookies.toString(),
    [Symbol.iterator]: () => ctx.cookies[Symbol.iterator](),
  };
  return store;
}

const COOKIE_MEMBERS = ["get", "getAll", "has", "size", "set", "delete", "clear", "toString", Symbol.iterator];

export function cookies() {
  const ctx = requireContext("cookies");
  ctx.cookieStore ??= createCookieStore(ctx);
  return syncThenable(ctx.cookieStore, COOKIE_MEMBERS);
}

const DRAFT_COOKIE_OPTIONS = { path: "/", httpOnly: true, sameSite: "none", secure: true };

export function draftMode() {
  const ctx = requireContext("draftMode");
  const mode = {
    get isEnabled() {
      return ctx.cookies.has(DRAFT_COOKIE);
    },
    enable() {
      if (!isWritable(ctx)) refuseCookieWrite();
      const value = Math.random().toString(36).slice(2) + Date.now().toString(36);
      ctx.responseCookies.set(DRAFT_COOKIE, value, DRAFT_COOKIE_OPTIONS);
      ctx.cookies.set(DRAFT_COOKIE, value);
    },
    disable() {
      if (!isWritable(ctx)) refuseCookieWrite();
      ctx.responseCookies.set(DRAFT_COOKIE, "", { ...DRAFT_COOKIE_OPTIONS, expires: new Date(0) });
      ctx.cookies.delete(DRAFT_COOKIE);
    },
  };
  return syncThenable(mode, ["isEnabled", "enable", "disable"]);
}
