"use client";
/**
 * next/script. beforeInteractive scripts render into the server HTML; the
 * other strategies are added to the document after hydration (lazyOnload
 * once the page has loaded), once per id or src.
 */
import { createElement, useEffect } from "react";

const loaded = new Set();

function scriptKey(props) {
  return props.id || props.src || null;
}

function inject(props) {
  const { src, id, onLoad, onReady, onError, children, dangerouslySetInnerHTML, strategy: _s, ...attrs } = props;
  const key = scriptKey(props);
  if (key && loaded.has(key)) {
    if (onReady) onReady();
    return;
  }
  if (key) loaded.add(key);
  const el = document.createElement("script");
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false || typeof value === "function") continue;
    el.setAttribute(name === "className" ? "class" : name, value === true ? "" : String(value));
  }
  if (id) el.id = id;
  el.addEventListener("load", (e) => {
    if (onLoad) onLoad(e);
    if (onReady) onReady();
  });
  el.addEventListener("error", (e) => onError && onError(e));
  if (src) el.src = src;
  else {
    el.textContent = dangerouslySetInnerHTML?.__html ?? (typeof children === "string" ? children : "");
    if (onReady) queueMicrotask(onReady);
  }
  document.body.appendChild(el);
}

/** Load a script now (the client half of next/script). */
export function handleClientScriptLoad(props) {
  if (props.strategy === "lazyOnload" && document.readyState !== "complete") {
    window.addEventListener("load", () => inject(props), { once: true });
  } else inject(props);
}

export function initScriptLoader(scripts) {
  for (const props of scripts) handleClientScriptLoad(props);
}

export default function Script(props) {
  const { strategy = "afterInteractive" } = props;
  useEffect(() => {
    if (strategy === "beforeInteractive" || strategy === "worker") {
      const key = scriptKey(props);
      if (key) loaded.add(key);
      return;
    }
    handleClientScriptLoad(props);
    // Scripts are loaded once; prop changes do not reload them.
  }, []);
  if (strategy !== "beforeInteractive") return null;
  const { onLoad: _l, onReady: _r, onError: _e, strategy: _s, children, dangerouslySetInnerHTML, ...attrs } = props;
  const html = dangerouslySetInnerHTML?.__html ?? (typeof children === "string" ? children : undefined);
  return createElement("script", {
    ...attrs,
    ...(html !== undefined ? { dangerouslySetInnerHTML: { __html: html } } : {}),
  });
}
