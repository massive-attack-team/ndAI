// node build.mjs            one-off build into dist/
// node build.mjs --watch    rebuild on change (reload the extension in chrome://extensions)
// node build.mjs --serve    rebuild on change + serve the preview page (PORT=… to override 8787)
import * as esbuild from "esbuild";

const serve = process.argv.includes("--serve");
const watch = serve || process.argv.includes("--watch");

const common = {
  outdir: "dist", bundle: true, logLevel: "info", sourcemap: watch ? "inline" : false,
  // Defaults to the hosted demo API for the submission period, so a plain
  // `npm run build` with no env var is correct for every surface (real
  // extension, preview page) without remembering to set anything - repeated
  // "forgot the env var" mismatches were costing more than they were worth.
  // NDAI_API_URL=http://127.0.0.1:8000 npm run build to point at your own
  // local detector.main instead.
  define: { __NDAI_API_URL__: JSON.stringify(process.env.NDAI_API_URL || "https://ndai-449222277673.europe-west1.run.app") },
};

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
