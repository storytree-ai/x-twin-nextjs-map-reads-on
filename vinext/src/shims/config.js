/**
 * next/config: the runtime config from next.config. The server sets both
 * halves; the browser gets publicRuntimeConfig through __NEXT_DATA__.
 * Kept on globalThis so every instance of this module shares it.
 */
const KEY = Symbol.for("vinext.runtimeConfig");

export function setConfig(configValue) {
  globalThis[KEY] = configValue;
}

export default function getConfig() {
  const config = globalThis[KEY];
  return {
    serverRuntimeConfig: config?.serverRuntimeConfig || {},
    publicRuntimeConfig: config?.publicRuntimeConfig || {},
  };
}
