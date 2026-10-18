/**
 * CommonJS interop for app code: `require("x")` in ES modules becomes a
 * hoisted import, and CommonJS files (module.exports / exports.x) get an
 * ES default export.
 */

const REQUIRE_RE = /\brequire\(\s*(["'])([^"'\n]+)\1\s*\)/g;
const ESM_RE = /^\s*(import\s[^(]|import\{|export\s|export\{)/m;
const CJS_EXPORTS_RE = /\b(module\.exports|exports\.[A-Za-z_$][\w$]*)\s*=/;

export function transformCjs(code) {
  const hasRequire = /\brequire\s*\(/.test(code);
  const hasCjsExports = CJS_EXPORTS_RE.test(code);
  if (!hasRequire && !hasCjsExports) return null;
  const isEsm = ESM_RE.test(code);

  const imports = [];
  const seen = new Map();
  let out = code.replace(REQUIRE_RE, (_m, _q, spec) => {
    if (!seen.has(spec)) {
      const name = `__vinext_require_${seen.size}`;
      seen.set(spec, name);
      imports.push(`import * as ${name} from ${JSON.stringify(spec)};`);
    }
    return `__vinext_interop(${seen.get(spec)})`;
  });
  if (imports.length === 0 && (isEsm || !hasCjsExports)) return null;

  let header = imports.join("\n");
  if (imports.length) {
    header +=
      "\nfunction __vinext_interop(ns) { if (ns && typeof ns === 'object' && 'default' in ns) { const keys = Object.keys(ns).filter((k) => k !== 'default' && k !== '__esModule'); if (keys.length === 0) return ns.default; } return ns; }";
  }
  if (!isEsm && hasCjsExports) {
    header += "\nconst module = { exports: {} }; let exports = module.exports;";
    out += "\nexport default module.exports;";
  }
  return header + "\n" + out;
}
