/**
 * next/navigation for client components (ssr and client environments). The
 * App Router root provides the contexts; under the Pages Router the hooks
 * fall back to the Pages router state.
 */
import { useContext, useMemo } from "react";
import {
  AppRouterContext,
  PathnameContext,
  SearchParamsContext,
  ParamsContext,
  LayoutSegmentsContext,
} from "./internal/app-contexts.js";
import { RouterContext } from "./internal/contexts.js";
import { ReadonlyURLSearchParams } from "./internal/readonly-search-params.js";

export {
  notFound,
  forbidden,
  unauthorized,
  redirect,
  permanentRedirect,
  RedirectType,
  unstable_rethrow,
} from "./internal/navigation-errors.js";
export { ReadonlyURLSearchParams };

function pagesRouter() {
  return useContext(RouterContext);
}

export function usePathname() {
  const pathname = useContext(PathnameContext);
  const pages = pagesRouter();
  if (pathname !== null) return pathname;
  if (pages) return pages.asPath.split(/[?#]/)[0];
  return typeof window !== "undefined" ? window.location.pathname : "/";
}

export function useSearchParams() {
  const search = useContext(SearchParamsContext);
  const pages = pagesRouter();
  const value =
    search !== null
      ? search
      : pages
        ? (pages.asPath.split("#")[0].split("?")[1] ?? "")
        : typeof window !== "undefined"
          ? window.location.search
          : "";
  return useMemo(() => new ReadonlyURLSearchParams(value), [value]);
}

export function useParams() {
  const params = useContext(ParamsContext);
  const pages = pagesRouter();
  if (params !== null) return params;
  return pages ? pages.query : {};
}

const fallbackRouter = {
  push: (href) => window.location.assign(href),
  replace: (href) => window.location.replace(href),
  back: () => window.history.back(),
  forward: () => window.history.forward(),
  refresh: () => window.location.reload(),
  prefetch: () => {},
};

export function useRouter() {
  const router = useContext(AppRouterContext);
  const pages = pagesRouter();
  if (router) return router;
  if (pages) {
    return {
      push: (href, options) => pages.push(href, undefined, options),
      replace: (href, options) => pages.replace(href, undefined, options),
      back: () => pages.back(),
      forward: () => window.history.forward(),
      refresh: () => pages.replace(pages.asPath),
      prefetch: () => {},
    };
  }
  return fallbackRouter;
}

export function useSelectedLayoutSegments() {
  return useContext(LayoutSegmentsContext) || [];
}

export function useSelectedLayoutSegment() {
  const segments = useSelectedLayoutSegments();
  return segments.length ? segments[0] : null;
}

export function useServerInsertedHTML() {}
