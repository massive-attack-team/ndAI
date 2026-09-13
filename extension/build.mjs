// node build.mjs            one-off build into dist/
// node build.mjs --watch    rebuild on change (reload the extension in chrome://extensions)
// node build.mjs --serve    rebuild on change + serve the preview page
import * as esbuild from "esbuild";

const serve = process.argv.includes("--serve");
const watch = serve || process.argv.includes("--watch");

const ctx = await esbuild.context({
  entryPoints: { content_script: "src/content_script.ts", popup: "src/popup.ts" },
  outdir: "dist",
  bundle: true,
  format: "iife", // content scripts can't be ES modules
  target: "chrome114",
  loader: { ".css": "text" },
  sourcemap: watch ? "inline" : false,
  logLevel: "info",
});

if (serve) {
  await ctx.watch();
  const { port } = await ctx.serve({ servedir: ".", port: 8787 });
  console.log(`\n  Preview: http://localhost:${port}/preview/\n`);
} else if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
