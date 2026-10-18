/**
 * React contexts the App Router root provides to next/navigation's hooks.
 * Loaded in the ssr and client environments only (react-server has no
 * createContext).
 */
import { createContext } from "react";

export const AppRouterContext = createContext(null);
export const PathnameContext = createContext(null);
export const SearchParamsContext = createContext(null);
export const ParamsContext = createContext(null);
/** The segments below the nearest layout, for useSelectedLayoutSegment(s). */
export const LayoutSegmentsContext = createContext(null);
