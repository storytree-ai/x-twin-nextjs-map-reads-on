"use client";
/**
 * next/form: a <form> whose GET submissions to a URL navigate the client
 * router (search params built from its fields) instead of loading a document.
 * Other submissions (a function action, POST, another target or origin,
 * files) are the browser's or React's.
 */
import { createElement, forwardRef } from "react";
import { useRouter } from "./navigation.js";
import { formSubmitUrl } from "./internal/form-url.js";

const Form = forwardRef(function Form({ action, replace = false, scroll = true, prefetch: _prefetch, onSubmit, ...props }, ref) {
  const router = useRouter();
  if (typeof action !== "string") return createElement("form", { ...props, action, onSubmit, ref });

  function handleSubmit(event) {
    onSubmit?.(event);
    if (event.defaultPrevented) return;
    const form = event.currentTarget;
    const button = event.nativeEvent?.submitter || null;
    const attr = (name) => (button && button.hasAttribute(name) ? button.getAttribute(name) : undefined);
    const href = formSubmitUrl({
      action,
      method: form.getAttribute("method") ?? undefined,
      target: form.getAttribute("target") ?? undefined,
      submitter: button && { formAction: attr("formaction"), formMethod: attr("formmethod"), formTarget: attr("formtarget") },
      fields: [...new FormData(form, button)],
      base: window.location.href,
    });
    if (href === null) return;
    event.preventDefault();
    router[replace ? "replace" : "push"](href, { scroll });
  }

  return createElement("form", { ...props, action, onSubmit: handleSubmit, ref });
});

export default Form;
