"use client";
/**
 * next/image: an <img> with Next's attributes (lazy unless priority, fill
 * positioning, static import objects). No optimizer: src is used as is.
 */
import { createElement, forwardRef } from "react";

const Image = forwardRef(function Image(props, ref) {
  const {
    src,
    alt,
    width,
    height,
    fill,
    priority,
    quality: _quality,
    placeholder,
    blurDataURL,
    loader,
    unoptimized: _unoptimized,
    loading,
    style,
    sizes,
    onLoadingComplete,
    onLoad,
    ...rest
  } = props;
  const isStatic = src && typeof src === "object";
  const url = isStatic ? src.src : src;
  const w = width ?? (isStatic && !fill ? src.width : undefined);
  const h = height ?? (isStatic && !fill ? src.height : undefined);
  const finalSrc = loader ? loader({ src: url, width: Number(w) || 0, quality: _quality }) : url;
  const blur = placeholder === "blur" && (blurDataURL || (isStatic && src.blurDataURL));
  const finalStyle = {
    ...(fill ? { position: "absolute", height: "100%", width: "100%", inset: 0 } : {}),
    ...(blur ? { backgroundImage: `url("${blur}")`, backgroundSize: "cover" } : {}),
    color: "transparent",
    ...style,
  };
  return createElement("img", {
    ...rest,
    ref,
    alt,
    src: finalSrc,
    width: fill ? undefined : w,
    height: fill ? undefined : h,
    sizes: sizes ?? (fill ? "100vw" : undefined),
    loading: priority ? "eager" : loading || "lazy",
    fetchPriority: priority ? "high" : undefined,
    decoding: "async",
    "data-nimg": fill ? "fill" : "1",
    style: finalStyle,
    onLoad: (e) => {
      if (onLoad) onLoad(e);
      if (onLoadingComplete) onLoadingComplete(e.currentTarget);
    },
  });
});

export default Image;
