import { useContext } from "react";
import { RouterContext } from "./internal/contexts.js";
import { formatHref } from "./internal/url.js";

function createEvents() {
  const all = new Map();
  return {
    on(type, handler) {
      if (!all.has(type)) all.set(type, new Set());
      all.get(type).add(handler);
    },
    off(type, handler) {
      all.get(type)?.delete(handler);
    },
    emit(type, ...args) {
      for (const handler of [...(all.get(type) || [])]) handler(...args);
    },
  };
}

const events = createEvents();
let state = { pathname: "/", route: "/", query: {}, asPath: "/", isReady: false, isFallback: false };
let ssrContext = null;
let navigateImpl = null;
let beforePopStateCb = null;

/** For servers that render outside a RouterContext provider. */
export function setSSRContext(ctx) {
  ssrContext = ctx;
}

function change(method, url, as, options) {
  const href = formatHref(url);
  const asPath = as === undefined || as === null ? href : formatHref(as);
  if (!navigateImpl) {
    if (typeof window !== "undefined") window.location[method === "replaceState" ? "replace" : "assign"](asPath);
    return Promise.resolve(false);
  }
  return navigateImpl(method, href, asPath, options || {});
}

/** A router object over a state snapshot, sharing the singleton's methods. */
export function createRouter(snapshot) {
  return {
    pathname: snapshot.pathname,
    route: snapshot.route ?? snapshot.pathname,
    query: snapshot.query || {},
    asPath: snapshot.asPath ?? snapshot.pathname,
    basePath: "",
    isReady: snapshot.isReady ?? true,
    isPreview: false,
    isFallback: snapshot.isFallback ?? false,
    isLocaleDomain: false,
    locale: undefined,
    locales: undefined,
    defaultLocale: undefined,
    events,
    push: (url, as, options) => change("pushState", url, as, options),
    replace: (url, as, options) => change("replaceState", url, as, options),
    back: () => window.history.back(),
    forward: () => window.history.forward(),
    reload: () => window.location.reload(),
    prefetch: () => Promise.resolve(),
    beforePopState: (cb) => {
      beforePopStateCb = cb;
    },
  };
}

const Router = {
  get pathname() {
    return state.pathname;
  },
  get route() {
    return state.route;
  },
  get query() {
    return state.query;
  },
  get asPath() {
    return state.asPath;
  },
  get isReady() {
    return state.isReady;
  },
  get isFallback() {
    return state.isFallback;
  },
  basePath: "",
  isPreview: false,
  events,
  push: (url, as, options) => change("pushState", url, as, options),
  replace: (url, as, options) => change("replaceState", url, as, options),
  back: () => window.history.back(),
  forward: () => window.history.forward(),
  reload: () => window.location.reload(),
  prefetch: () => Promise.resolve(),
  beforePopState: (cb) => {
    beforePopStateCb = cb;
  },
};

export function useRouter() {
  const router = useContext(RouterContext);
  if (router) return router;
  if (ssrContext) return createRouter(ssrContext);
  return createRouter(state);
}

export function withRouter(Component) {
  function WithRouter(props) {
    return Component({ ...props, router: useRouter() });
  }
  WithRouter.getInitialProps = Component.getInitialProps;
  return WithRouter;
}

/** Client runtime hooks: the entry installs navigation and updates state. */
export function __setRouterState(next) {
  state = next;
}
export function __setNavigate(fn) {
  navigateImpl = fn;
}
export function __getBeforePopState() {
  return beforePopStateCb;
}

export { RouterContext, events as __events };
export default Router;
