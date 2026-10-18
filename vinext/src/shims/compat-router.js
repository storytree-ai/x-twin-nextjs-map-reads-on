import { useContext } from "react";
import { RouterContext } from "./internal/contexts.js";

/** next/compat/router: the Pages Router, or null outside one. */
export function useRouter() {
  return useContext(RouterContext);
}
