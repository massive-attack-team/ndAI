// esbuild loads .css as a string (loader: { ".css": "text" }) so it can be
// injected into the shadow root instead of the host page.
declare module "*.css" {
  const css: string;
  export default css;
}

// Injected by build.mjs's esbuild `define` (NDAI_API_URL env var at build
// time, defaults to the local detector). Only used by detector_client.ts's
// direct-fetch path, for contexts with no chrome.runtime to relay through -
// extension/preview/index.html, deployed standalone against a hosted API.
declare const __NDAI_API_URL__: string;
