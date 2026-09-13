// esbuild loads .css as a string (loader: { ".css": "text" }) so it can be
// injected into the shadow root instead of the host page.
declare module "*.css" {
  const css: string;
  export default css;
}
