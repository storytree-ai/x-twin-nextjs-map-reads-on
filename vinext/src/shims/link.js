import { createElement, forwardRef } from "react";
import Router from "./router.js";
import { formatHref } from "./internal/url.js";

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
  const hrefStr = formatHref(href);
  const asStr = as === undefined || as === null ? hrefStr : formatHref(as);

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
        preventDefault() {
          prevented = true;
        },
      });
      if (prevented) return;
    }
    Router[replace ? "replace" : "push"](hrefStr, asStr, { shallow, scroll, locale });
  }

  return createElement("a", { ...rest, ref, href: asStr, onClick: handleClick }, children);
});

export default Link;
