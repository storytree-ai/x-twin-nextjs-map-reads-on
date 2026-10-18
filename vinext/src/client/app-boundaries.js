"use client";
/**
 * Client boundaries the App Router puts around route segments: error.tsx,
 * not-found/forbidden/unauthorized, redirects, and the segments a layout
 * sees through useSelectedLayoutSegment(s).
 */
import { Component, createElement, useContext, useEffect } from "react";
import { AppRouterContext, PathnameContext, LayoutSegmentsContext } from "../shims/internal/app-contexts.js";
import { httpFallbackStatus, redirectInfo, isNavigationError } from "../shims/internal/navigation-errors.js";

class HttpFallbackBoundaryInner extends Component {
  constructor(props) {
    super(props);
    this.state = { status: null, error: null, pathname: props.pathname };
  }
  static getDerivedStateFromError(error) {
    return { status: httpFallbackStatus(error), error };
  }
  static getDerivedStateFromProps(props, state) {
    if (props.pathname !== state.pathname) return { status: null, error: null, pathname: props.pathname };
    return null;
  }
  render() {
    const { status, error } = this.state;
    if (error && status === null) throw error;
    if (status !== null) {
      const fallback = status === 404 ? this.props.notFound : status === 403 ? this.props.forbidden : this.props.unauthorized;
      if (fallback !== undefined && fallback !== null) return fallback;
      throw Object.assign(new Error(`NEXT_HTTP_ERROR_FALLBACK;${status}`), { digest: `NEXT_HTTP_ERROR_FALLBACK;${status}` });
    }
    return this.props.children;
  }
}

/** Renders the segment's not-found (or forbidden/unauthorized) fallback when a child throws one. */
export function HttpFallbackBoundary(props) {
  const pathname = useContext(PathnameContext);
  return createElement(HttpFallbackBoundaryInner, { ...props, pathname });
}

class ErrorBoundaryInner extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, pathname: props.pathname };
    this.reset = () => this.setState({ error: null });
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  static getDerivedStateFromProps(props, state) {
    if (props.pathname !== state.pathname) return { error: null, pathname: props.pathname };
    return null;
  }
  render() {
    if (this.state.error) {
      if (isNavigationError(this.state.error)) throw this.state.error;
      return createElement(this.props.errorComponent, { error: this.state.error, reset: this.reset });
    }
    return this.props.children;
  }
}

/** error.tsx: renders the segment's error component when a child throws. */
export function ErrorBoundary(props) {
  const pathname = useContext(PathnameContext);
  return createElement(ErrorBoundaryInner, { ...props, pathname });
}

function Redirect({ url, type, onArrived }) {
  const router = useContext(AppRouterContext);
  useEffect(() => {
    const target = new URL(url, window.location.href);
    const here = window.location;
    // Already there (a server action's redirect, which the router has followed).
    if (target.origin === here.origin && target.pathname === here.pathname && target.search === here.search) {
      onArrived();
      return;
    }
    if (!router) {
      window.location.replace(url);
      return;
    }
    // Render again once there, even if the target redirected back to this pathname.
    Promise.resolve(router[type === "push" ? "push" : "replace"](url)).then(onArrived);
  }, [router, url, type, onArrived]);
  return null;
}

class RedirectBoundaryInner extends Component {
  constructor(props) {
    super(props);
    this.state = { redirect: null, error: null, pathname: props.pathname };
    this.arrived = () => this.setState({ redirect: null, error: null });
  }
  static getDerivedStateFromError(error) {
    return { redirect: redirectInfo(error), error };
  }
  static getDerivedStateFromProps(props, state) {
    if (props.pathname !== state.pathname) return { redirect: null, error: null, pathname: props.pathname };
    return null;
  }
  render() {
    if (this.state.error && !this.state.redirect) throw this.state.error;
    if (this.state.redirect) return createElement(Redirect, { ...this.state.redirect, onArrived: this.arrived });
    return this.props.children;
  }
}

/** Follows redirect() thrown while rendering in the browser. */
export function RedirectBoundary({ children }) {
  const pathname = useContext(PathnameContext);
  return createElement(RedirectBoundaryInner, { pathname }, children);
}

/** Provides the segments below a layout to useSelectedLayoutSegment(s). */
export function LayoutSegments({ segments, children }) {
  return createElement(LayoutSegmentsContext.Provider, { value: segments }, children);
}
