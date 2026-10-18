/**
 * next/navigation in server components (rsc environment): the control-flow
 * functions; the hooks belong to client components.
 */
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

function clientOnly(name) {
  return function () {
    throw new Error(`${name}() is only available in Client Components ("use client").`);
  };
}

export const usePathname = clientOnly("usePathname");
export const useSearchParams = clientOnly("useSearchParams");
export const useParams = clientOnly("useParams");
export const useRouter = clientOnly("useRouter");
export const useSelectedLayoutSegment = clientOnly("useSelectedLayoutSegment");
export const useSelectedLayoutSegments = clientOnly("useSelectedLayoutSegments");
export const useServerInsertedHTML = clientOnly("useServerInsertedHTML");
