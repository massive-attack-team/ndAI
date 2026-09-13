// node build.mjs            one-off build into dist/
// node build.mjs --watch    rebuild on change (reload the extension in chrome://extensions)
// node build.mjs --serve    rebuild on change + serve the preview page (PORT=… to override 8787)
import * as esbuild from "esbuild";

const serve = process.argv.includes("--serve");
const watch = serve || process.argv.includes("--watch");

const common = { outdir: "dist", bundle: true, logLevel: "info", sourcemap: watch ? "inline" : false };

// Content scripts and the service worker can't be ES modules.
const classic = await esbuild.context({
  ...common,
  entryPoints: { content_script: "src/content_script.ts", popup: "src/popup.ts", background: "src/background.ts" },
  format: "iife",
  target: "chrome116",
  loader: { ".css": "text" }, // injected into the shadow root as a string
});

// Extension pages can be modules; review.css is emitted alongside review.js.
const pages = await esbuild.context({
  ...common,
  entryPoints: { review: "src/review/review.ts" },
  format: "esm",
  target: "chrome116",
});

if (watch) {
  await Promise.all([classic.watch(), pages.watch()]);
  if (serve) {
    const { port } = await classic.serve({ servedir: ".", port: Number(process.env.PORT) || 8787 });
    console.log(`\n  Preview: http://localhost:${port}/preview/\n`);
  }
} else {
  await Promise.all([classic.rebuild(), pages.rebuild()]);
  await Promise.all([classic.dispose(), pages.dispose()]);
}
