/**
 * The App Router's client root, rendered by the ssr environment and hydrated
 * in the browser: it renders the current RSC payload's tree under the
 * next/navigation contexts, and navigates by fetching RSC payloads.
 */
import { createElement, startTransition, use, useEffect, useLayoutEffect, useMemo, useState } from "react";
import {
  AppRouterContext,
  PathnameContext,
  SearchParamsContext,
  ParamsContext,
} from "../shims/internal/app-contexts.js";
import { rscUrl } from "../shared/rsc-url.js";

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function fulfilled(value) {
  const promise = Promise.resolve(value);
  promise.status = "fulfilled";
  promise.value = value;
  return promise;
}

let navigateImpl = null;
let commitImpl = null;

/** Navigate the client router; settles once the navigation has committed or been dropped. */
export function navigate(href, options) {
  if (navigateImpl) return navigateImpl(href, options);
  window.location.assign(href);
  return Promise.resolve();
}

/** Commit a payload rendered for the current URL (a server action's re-render). */
export function commitPayload(payload) {
  commitImpl?.(payload);
}

function createRouter() {
  const go = (href, options, mode) => {
    if (navigateImpl) navigateImpl(href, { scroll: options?.scroll !== false, mode });
    else if (typeof window !== "undefined") window.location[mode === "replace" ? "replace" : "assign"](href);
  };
  return {
    push: (href, options) => go(href, options, "push"),
    replace: (href, options) => go(href, options, "replace"),
    back: () => window.history.back(),
    forward: () => window.history.forward(),
    refresh: () => go(window.location.href, { scroll: false }, "refresh"),
    prefetch: () => {},
  };
}

/** The router useRouter() returns under the App Router. */
export const router = createRouter();

/**
 * Root of the App Router tree. `initialPayload` is a promise of the RSC
 * payload ({ tree, pathname, search, params }); `fetchPayload(url)` returns a
 * promise of { payload } or { redirect } / { reload } for a navigation.
 */
export function AppRoot({ initialPayload, fetchPayload }) {
  const [state, setState] = useState(() => ({ payload: initialPayload, navId: 0, scroll: false }));
  const payload = use(state.payload);

  useEffect(() => {
    if (!fetchPayload) return;
    let latest = 0;
    async function navigate(href, { scroll = true, mode = "push", depth = 0 } = {}) {
      const url = new URL(href, window.location.href);
      if (url.origin !== window.location.origin) {
        window.location[mode === "replace" ? "replace" : "assign"](url.href);
        return;
      }
      const current = window.location.pathname + window.location.search;
      const target = url.pathname + url.search;
      if (mode === "push" && target === current && url.hash) {
        window.history.pushState(window.history.state, "", url.href);
        document.getElementById(decodeURIComponent(url.hash.slice(1)))?.scrollIntoView();
        return;
      }
      const id = ++latest;
      let result;
      try {
        result = await fetchPayload(rscUrl(url.href));
      } catch (err) {
        console.error(err);
        window.location.assign(url.href);
        return;
      }
      if (id !== latest) return;
      if (result.reload) {
        window.location[mode === "replace" ? "replace" : "assign"](url.href);
        return;
      }
      if (result.redirect) {
        if (depth > 10) return;
        navigate(result.redirect, { scroll, mode: mode === "pop" ? "replace" : mode === "refresh" ? "replace" : mode, depth: depth + 1 });
        return;
      }
      if (mode === "push") window.history.pushState({ __vinext: true }, "", url.href);
      else if (mode === "replace") window.history.replaceState({ __vinext: true }, "", url.href);
      startTransition(() => {
        setState((prev) => ({ payload: fulfilled(result.payload), navId: prev.navId + 1, scroll: scroll && mode !== "pop" && mode !== "refresh" }));
      });
    }
    navigateImpl = navigate;
    const commit = (payload) => {
      // Dropped if the router has since moved to another URL.
      if (payload.pathname !== window.location.pathname || (payload.search || "") !== window.location.search) return;
      startTransition(() => {
        setState((prev) => ({ payload: fulfilled(payload), navId: prev.navId + 1, scroll: false }));
      });
    };
    commitImpl = commit;
    window.history.replaceState({ __vinext: true, ...(window.history.state || {}) }, "", window.location.href);
    const onPopState = () => navigate(window.location.href, { mode: "pop" });
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
      if (navigateImpl === navigate) navigateImpl = null;
      if (commitImpl === commit) commitImpl = null;
    };
  }, [fetchPayload]);

  useIsomorphicLayoutEffect(() => {
    if (state.navId > 0 && state.scroll) window.scrollTo(0, 0);
  }, [state.navId]);

  const params = useMemo(() => payload.params || {}, [payload]);
  return createElement(
    AppRouterContext.Provider,
    { value: router },
    createElement(
      PathnameContext.Provider,
      { value: payload.pathname },
      createElement(
        SearchParamsContext.Provider,
        { value: payload.search || "" },
        createElement(ParamsContext.Provider, { value: params }, payload.tree),
      ),
    ),
  );
}
