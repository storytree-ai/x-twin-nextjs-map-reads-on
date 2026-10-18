/**
 * next/og: ImageResponse, a Response with a PNG of the requested size. vinext
 * has no layout engine for the element (Next.js uses Satori); the image is
 * filled with the root element's background colour (a gradient's first).
 */
import zlib from "node:zlib";

const NAMED_COLORS = {
  black: [0, 0, 0, 255],
  white: [255, 255, 255, 255],
  red: [255, 0, 0, 255],
  green: [0, 128, 0, 255],
  blue: [0, 0, 255, 255],
  gray: [128, 128, 128, 255],
  grey: [128, 128, 128, 255],
  transparent: [0, 0, 0, 0],
};

function parseColor(value) {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  let m = /#([0-9a-f]{3,8})\b/.exec(text);
  if (m) {
    let hex = m[1];
    if (hex.length === 3 || hex.length === 4) hex = [...hex].map((c) => c + c).join("");
    if (hex.length === 6) hex += "ff";
    if (hex.length === 8) return [0, 2, 4, 6].map((i) => parseInt(hex.slice(i, i + 2), 16));
  }
  m = /rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)/.exec(text);
  if (m) {
    let alpha = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [+m[1], +m[2], +m[3], Math.round(Math.min(1, Math.max(0, alpha)) * 255)];
  }
  for (const word of text.split(/[\s,()]+/)) if (NAMED_COLORS[word]) return NAMED_COLORS[word];
  return null;
}

/** The root element's background colour, rendering function components to reach it. */
function backgroundOf(element) {
  for (let depth = 0; element && typeof element === "object" && depth < 10; depth++) {
    const props = element.props || {};
    if (typeof element.type === "function") {
      try {
        element = element.type(props);
        continue;
      } catch {
        return null;
      }
    }
    const style = props.style || {};
    return parseColor(style.backgroundColor) || parseColor(style.background) || parseColor(style.backgroundImage);
  }
  return null;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** An RGBA PNG of width x height in one colour. */
export function solidPng(width, height, [r, g, b, a]) {
  const row = Buffer.alloc(1 + width * 4);
  for (let x = 0; x < width; x++) row.set([r, g, b, a], 1 + x * 4);
  const raw = Buffer.alloc(row.length * height);
  for (let y = 0; y < height; y++) row.copy(raw, y * row.length);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export class ImageResponse extends Response {
  constructor(element, options = {}) {
    const width = Math.max(1, Math.round(options.width || 1200));
    const height = Math.max(1, Math.round(options.height || 630));
    const color = backgroundOf(element) || NAMED_COLORS.white;
    const headers = new Headers(options.headers);
    if (!headers.has("content-type")) headers.set("content-type", "image/png");
    if (!headers.has("cache-control")) {
      headers.set("cache-control", process.env.NODE_ENV === "development" ? "no-cache, no-store" : "public, immutable, no-transform, max-age=31536000");
    }
    super(solidPng(width, height, color), { status: options.status || 200, statusText: options.statusText, headers });
  }
}
