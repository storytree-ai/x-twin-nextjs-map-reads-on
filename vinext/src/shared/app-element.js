import { createElement } from "react";
import { HeadManagerContext, RouterContext } from "../shims/internal/contexts.js";

function DefaultApp({ Component, pageProps }) {
  return createElement(Component, pageProps);
}

/**
 * The tree rendered into #__next, identical on server and client so that
 * hydration matches: router and head providers around _app around the page.
 */
export function createAppElement({ App, Component, pageProps, router, headManager = null }) {
  return createElement(
    HeadManagerContext.Provider,
    { value: headManager },
    createElement(
      RouterContext.Provider,
      { value: router },
      createElement(App || DefaultApp, { Component, pageProps, router }),
    ),
  );
}
