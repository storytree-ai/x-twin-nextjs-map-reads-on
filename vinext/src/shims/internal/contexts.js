import { createContext } from "react";

/** The Pages Router instance the app tree renders under. */
export const RouterContext = createContext(null);

/** Server-side collector for next/head; null in the browser. */
export const HeadManagerContext = createContext(null);

/** next/document's render-time data (head HTML, scripts). */
export const DocumentContext = createContext(null);
