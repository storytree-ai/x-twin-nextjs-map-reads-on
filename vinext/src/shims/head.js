import { Children, Fragment, isValidElement, useContext, useEffect, useRef } from "react";
import { HeadManagerContext } from "./internal/contexts.js";

const ATTR_NAMES = {
  className: "class",
  htmlFor: "for",
  charSet: "charset",
  httpEquiv: "http-equiv",
  crossOrigin: "crossorigin",
  referrerPolicy: "referrerpolicy",
  fetchPriority: "fetchpriority",
  noModule: "nomodule",
  itemProp: "itemprop",
  hrefLang: "hreflang",
  imageSrcSet: "imagesrcset",
  imageSizes: "imagesizes",
};
const VOID = new Set(["meta", "link", "base"]);
const META_KEYS = ["name", "httpEquiv", "charSet", "itemProp", "property"];

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function flatten(children, out = []) {
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    if (child.type === Fragment) flatten(child.props.children, out);
    else if (typeof child.type === "string") out.push(child);
  });
  return out;
}

function textOf(children) {
  let text = "";
  Children.forEach(children, (c) => {
    if (typeof c === "string" || typeof c === "number") text += c;
  });
  return text;
}

/** Keep the last title, last meta per name/property, last element per key. */
export function __dedupeHead(elements) {
  const seen = new Set();
  const out = [];
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    let id = null;
    if (el.key != null && !String(el.key).startsWith(".")) id = `key:${el.key}`;
    else if (el.type === "title" || el.type === "base") id = el.type;
    else if (el.type === "meta") {
      for (const k of META_KEYS) {
        if (el.props[k] !== undefined) {
          id = k === "charSet" ? "meta:charSet" : `meta:${k}:${el.props[k]}`;
          break;
        }
      }
    }
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    out.unshift(el);
  }
  return out;
}

/** Serialize a head element (title, meta, link, script, style, ...) to HTML. */
export function __headElementToHTML(el) {
  const tag = el.type;
  let attrs = " data-vinext-head=\"\"";
  let inner = "";
  for (const [key, value] of Object.entries(el.props)) {
    if (key === "children" || key === "dangerouslySetInnerHTML") continue;
    if (value === undefined || value === null || value === false || typeof value === "function") continue;
    const name = ATTR_NAMES[key] || key;
    attrs += value === true ? ` ${name}` : ` ${name}="${escapeHtml(value)}"`;
  }
  if (VOID.has(tag)) return `<${tag}${attrs}/>`;
  if (el.props.dangerouslySetInnerHTML) inner = el.props.dangerouslySetInnerHTML.__html || "";
  else if (tag === "script" || tag === "style") inner = textOf(el.props.children);
  else inner = escapeHtml(textOf(el.props.children));
  return `<${tag}${attrs}>${inner}</${tag}>`;
}

export function __headToHTML(elements) {
  return __dedupeHead(elements).map(__headElementToHTML).join("");
}

// Fallback collector for servers rendering outside a HeadManagerContext.
let ssrElements = [];
export function resetSSRHead() {
  ssrElements = [];
}
export function getSSRHeadHTML() {
  return __headToHTML(ssrElements);
}

// Client: every mounted <Head> in mount order; flushed to document.head.
const mounted = new Map();
let nextId = 0;
let scheduled = false;

function flushClientHead() {
  scheduled = false;
  const all = [];
  for (const children of mounted.values()) all.push(...flatten(children));
  const elements = __dedupeHead(all);
  for (const node of document.head.querySelectorAll("[data-vinext-head]")) node.remove();
  const tpl = document.createElement("template");
  tpl.innerHTML = elements.map(__headElementToHTML).join("");
  const title = elements.find((e) => e.type === "title");
  if (title) document.title = textOf(title.props.children);
  document.head.appendChild(tpl.content);
}

function scheduleFlush() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(flushClientHead);
}

export default function Head({ children }) {
  const collector = useContext(HeadManagerContext);
  const idRef = useRef(null);
  if (typeof window === "undefined") {
    if (collector) collector.add(flatten(children));
    else ssrElements.push(...flatten(children));
  }
  useEffect(() => {
    if (idRef.current === null) idRef.current = nextId++;
    mounted.set(idRef.current, children);
    scheduleFlush();
  });
  useEffect(
    () => () => {
      mounted.delete(idRef.current);
      scheduleFlush();
    },
    [],
  );
  return null;
}
