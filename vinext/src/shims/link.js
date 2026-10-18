"use client";
import { createElement, forwardRef, useContext } from "react";
import Router from "./router.js";
import { formatHref } from "./internal/url.js";
import { AppRouterContext } from "./internal/app-contexts.js";
import { RouterContext } from "./internal/contexts.js";

/** A relative href ("?page=2", "#top", "child") resolved against the current asPath. */
function resolveRelative(href, asPath) {
  if (!href || href.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(href) || asPath == null) return href;
  const url = new URL(href, "http://n" + asPath);
  return url.pathname + url.search + url.hash;
}

function isModifiedEvent(event) {
  const target = event.currentTarget.getAttribute("target");
  return (
    (target && target !== "_self") ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    (event.nativeEvent && event.nativeEvent.which === 2)
  );
}

const Link = forwardRef(function Link(props, ref) {
  const {
    href,
    as,
    replace,
    scroll,
    shallow,
    prefetch: _prefetch,
    passHref: _passHref,
    locale,
    legacyBehavior: _legacyBehavior,
    onNavigate,
    onClick,
    children,
    ...rest
  } = props;
  const appRouter = useContext(AppRouterContext);
  const pagesRouter = useContext(RouterContext);
  const base = appRouter ? null : pagesRouter?.asPath;
  const hrefStr = resolveRelative(formatHref(href), base);
  const asStr = as === undefined || as === null ? hrefStr : resolveRelative(formatHref(as), base);

  function handleClick(event) {
    if (onClick) onClick(event);
    if (event.defaultPrevented) return;
    if (event.button !== 0 || isModifiedEvent(event) || rest.download !== undefined) return;
    const url = new URL(asStr, window.location.href);
    if (url.origin !== window.location.origin) return;
    event.preventDefault();
    if (onNavigate) {
      let prevented = false;
      onNavigate({
        url,
        preventDefault() {
          prevented = true;
        },
      });
      if (prevented) return;
    }
    if (appRouter) appRouter[replace ? "replace" : "push"](asStr, { scroll });
    else Router[replace ? "replace" : "push"](hrefStr, asStr, { shallow, scroll, locale });
  }

  return createElement("a", { ...rest, ref, href: asStr, onClick: handleClick }, children);
});

export default Link;
