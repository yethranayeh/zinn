import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = import.meta.dir;
const requireDocs = createRequire(join(root, "../../docs/package.json"));

async function compilePanel(temporary: string) {
  const { build } = await import(pathToFileURL(requireDocs.resolve("astro")).href);
  const { default: tailwindcss } = await import(
    pathToFileURL(requireDocs.resolve("@tailwindcss/vite")).href
  );
  const output = join(temporary, "site");
  const publicDirectory = join(temporary, "public");

  mkdirSync(publicDirectory);

  await build({
    root: join(root, "../.."),
    srcDir: join(root, "src/inspector"),
    outDir: output,
    publicDir: publicDirectory,
    configFile: false,
    output: "static",
    cacheDir: join(temporary, "astro-cache"),
    devToolbar: { enabled: false },
    logLevel: "error",
    build: { inlineStylesheets: "always" },
    vite: {
      cacheDir: join(temporary, "vite-cache"),
      plugins: [tailwindcss()],
      resolve: {
        alias: [
          { find: "tailwindcss", replacement: requireDocs.resolve("tailwindcss/index.css") },
          {
            find: /^astro(?:\/.*)?$/,
            replacement: "$&",
            customResolver: (specifier: string) => requireDocs.resolve(specifier),
          },
        ],
      },
    },
  });
}

export async function buildPanel() {
  const temporary = mkdtempSync(join(tmpdir(), "zinn-codex-panel-"));
  try {
    symlinkSync(join(root, "../../docs/node_modules"), join(temporary, "node_modules"), "junction");
    // Isolate Astro's cwd-based prerender output.
    // https://github.com/withastro/astro/blob/astro%407.3.5/packages/astro/src/core/build/common.ts
    const compiler = Bun.spawn([process.execPath, import.meta.filename, temporary], {
      cwd: temporary,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(compiler.stdout).text(),
      new Response(compiler.stderr).text(),
      compiler.exited,
    ]);

    if (exitCode !== 0) {
      throw new Error(stderr || stdout || "Panel compilation failed.");
    }

    const output = join(temporary, "site");
    let html = readFileSync(join(output, "index.html"), "utf8");
    html = html.replace(/<link\b[^>]*rel="stylesheet"[^>]*>/g, (tag) => {
      const href = tag.match(/href="([^"]+)"/)![1]!;
      return `<style>${readFileSync(join(output, href), "utf8")}</style>`;
    });

    const scripts: string[] = [];
    html = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/g, (_tag, attributes, content) => {
      const source = attributes.match(/\bsrc="([^"]+)"/)?.[1];
      if (source) {
        scripts.push(join(output, source));
      } else {
        const script = join(output, `inline-${scripts.length}.js`);
        writeFileSync(script, content);
        scripts.push(script);
      }
      return "";
    });

    scripts.push(join(root, "src/inspector/widget.ts"));

    const entry = join(temporary, "browser.ts");
    writeFileSync(entry, scripts.map((script) => `import ${JSON.stringify(script)};`).join("\n"));

    const browser = await Bun.build({
      entrypoints: [entry],
      target: "browser",
      minify: true,
      metafile: true,
    });

    if (!browser.success || browser.outputs.length !== 1) {
      throw new Error(browser.logs.join("\n") || "Expected one bundled panel script.");
    }

    const javascript = (await browser.outputs[0]!.text()).replaceAll("</script", "<\\/script");
    html = html.replace("</body>", () => `<script type="module">${javascript}</script></body>`);

    const cssUrls = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].flatMap(([, css]) =>
      [...css!.matchAll(/url\(\s*["']?([^)'"\s]+)/g)].map(([, url]) => url!),
    );
    const hasExternalAsset = /<(?:link|script|img|source)\b[^>]*(?:src|href)=/.test(html);
    const hasExternalCss = cssUrls.some((url) => !url.startsWith("data:") && !url.startsWith("#"));

    if (hasExternalAsset || hasExternalCss) {
      throw new Error("The panel must contain all of its runtime assets.");
    }

    return {
      html,
      inputs: Object.keys(browser.metafile?.inputs ?? {}),
      cssPackage: requireDocs.resolve("tailwindcss/package.json"),
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await compilePanel(process.argv[2]!);
}
