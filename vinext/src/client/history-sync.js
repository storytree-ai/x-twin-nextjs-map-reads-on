/**
 * Shallow routing: the app's own window.history.pushState/replaceState calls
 * are reported (as a path, search and hash) so usePathname and
 * useSearchParams follow them; the router writes history through the
 * returned pushState/replaceState, which are not reported.
 */
export function installHistorySync(history, onChange) {
  const push = history.pushState;
  const replace = history.replaceState;
  const report = (url) => {
    if (url === undefined || url === null) return;
    const base = typeof location === "undefined" ? "http://localhost/" : location.href;
    const next = new URL(String(url), base);
    onChange(next.pathname + next.search + next.hash);
  };
  const pushState = function pushState(state, title, url) {
    push.call(history, state, title, url);
    report(url);
  };
  const replaceState = function replaceState(state, title, url) {
    replace.call(history, state, title, url);
    report(url);
  };
  history.pushState = pushState;
  history.replaceState = replaceState;
  return {
    pushState: (state, url) => push.call(history, state, "", url),
    replaceState: (state, url) => replace.call(history, state, "", url),
    // Put the originals back, unless something has wrapped ours since.
    restore() {
      if (history.pushState === pushState) history.pushState = push;
      if (history.replaceState === replaceState) history.replaceState = replace;
    },
  };
}
