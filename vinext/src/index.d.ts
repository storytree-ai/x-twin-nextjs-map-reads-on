import type { Plugin } from "vite";

export interface VinextOptions {
  /** Project root containing pages/ or app/ (defaults to Vite's root). */
  root?: string;
  /** Directory holding the app/ directory (defaults to the root), or false to disable the App Router. */
  appDir?: string | false;
}

export interface NextConfig {
  [key: string]: unknown;
}

export default function vinext(options?: VinextOptions): Plugin;
