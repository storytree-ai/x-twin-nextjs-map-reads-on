/**
 * next/dynamic: a component loaded through `loader`. The import starts when
 * dynamic() runs (module evaluation); the server and the client entry await
 * flushPreloads() before rendering, so a loaded component renders in place
 * and hydrates without a fallback. ssr: false renders `loading` (or nothing)
 * until after hydration.
 */
// A namespace import: the react-server build has no hooks to import by name.
import * as React from "react";

const { createElement, lazy, Suspense } = React;

const KEY = Symbol.for("vinext.dynamicPreloads");
const pending = (globalThis[KEY] ??= new Set());
const isServer = typeof window === "undefined";

/** Wait for every dynamic() import started so far. */
export function flushPreloads() {
  return Promise.all([...pending]);
}

function resolveComponent(mod) {
  return mod && typeof mod === "object" && "default" in mod ? mod.default : mod;
}

export default function dynamic(loaderOrPromise, options = {}) {
  const opts = typeof loaderOrPromise === "object" && loaderOrPromise && !("then" in loaderOrPromise) ? loaderOrPromise : options;
  const loader =
    typeof loaderOrPromise === "function"
      ? loaderOrPromise
      : loaderOrPromise && "then" in loaderOrPromise
        ? () => loaderOrPromise
        : opts.loader;
  const ssr = opts.ssr !== false;
  const Loading = opts.loading || null;
  let Loaded = null;
  let error = null;
  let promise = null;

  function load() {
    if (!promise) {
      promise = Promise.resolve()
        .then(loader)
        .then(
          (mod) => {
            Loaded = resolveComponent(mod);
          },
          (err) => {
            error = err;
          },
        );
      pending.add(promise);
      promise.finally(() => pending.delete(promise));
    }
    return promise;
  }

  const loading = (err) => (Loading ? createElement(Loading, { error: err || null, isLoading: !err, pastDelay: true }) : null);
  const LazyComponent = lazy(() => load().then(() => ({ default: Loaded || (() => loading(error)) })));

  function render(props) {
    if (Loaded) return createElement(Loaded, props);
    if (error) {
      if (Loading) return loading(error);
      throw error;
    }
    return createElement(Suspense, { fallback: loading(null) }, createElement(LazyComponent, props));
  }

  if (!ssr) {
    if (!isServer) load();
    function DynamicClientOnly(props) {
      if (isServer) return loading(null);
      const [mounted, setMounted] = React.useState(false);
      React.useEffect(() => {
        let live = true;
        load().then(() => live && setMounted(true));
        return () => {
          live = false;
        };
      }, []);
      if (!mounted) return loading(null);
      return render(props);
    }
    return DynamicClientOnly;
  }

  load();
  function DynamicComponent(props) {
    return render(props);
  }
  DynamicComponent.preload = load;
  return DynamicComponent;
}
