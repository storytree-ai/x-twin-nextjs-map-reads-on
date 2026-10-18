/**
 * The metadata the App Router renders into <head>: `metadata` and
 * `generateMetadata` merged root to leaf (title templates included). The
 * full Metadata API lands with its own increment; this covers title and
 * description.
 */
import { createElement, Fragment } from "react";

function titleOf(value, template) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return template ? template.replace("%s", value) : value;
  if (typeof value === "object") {
    if (typeof value.absolute === "string") return value.absolute;
    if (typeof value.default === "string") return value.default;
  }
  return undefined;
}

/** Merge the metadata of modules ordered root layout first, page last. */
export async function resolveMetadata(mods, props) {
  let title;
  let template = null;
  let description;
  for (const mod of mods) {
    let md = mod.metadata;
    if (typeof mod.generateMetadata === "function") md = await mod.generateMetadata(props, Promise.resolve({ title, description }));
    if (!md || typeof md !== "object") continue;
    if (md.title !== undefined) {
      const next = titleOf(md.title, template);
      if (next !== undefined) title = next;
      if (md.title && typeof md.title === "object" && typeof md.title.template === "string") template = md.title.template;
    }
    if (md.description !== undefined) description = md.description;
  }
  return { title, description };
}

export function renderMetadata({ title, description }) {
  return createElement(
    Fragment,
    null,
    createElement("meta", { charSet: "utf-8" }),
    createElement("meta", { name: "viewport", content: "width=device-width, initial-scale=1" }),
    title !== undefined ? createElement("title", null, title) : null,
    description ? createElement("meta", { name: "description", content: description }) : null,
  );
}
