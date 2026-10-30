import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { EVENTS } from "./src/hooks/observe";
import { INSPECTOR_VERSION } from "./src/runtime";

const root = import.meta.dir;
export async function build(output = join(root, "dist")) {
  const plugin = join(output, "plugins/zinn");
  mkdirSync(join(plugin, "hooks"), { recursive: true });
  mkdirSync(join(output, ".agents/plugins"), { recursive: true });
  const bundledPackages = new Set<string>();

  for (const [entry, target, filename] of [
    ["hooks/hook.ts", "node", "hook.mjs"],
    ["inspector/server.ts", "node", "server.mjs"],
    ["inspector/launcher.ts", "node", "launcher.mjs"],
    ["inspector/widget.ts", "browser", "widget.js"],
  ] as const) {
    const result = await Bun.build({
      entrypoints: [join(root, "src", entry)],
      target,
      minify: true,
      metafile: true,
    });

    if (!result.success || result.outputs.length !== 1) {
      throw new Error(result.logs.join("\n") || "Expected a single bundled integration asset.");
    }

    writeFileSync(join(plugin, filename), await result.outputs[0]!.text());
    for (const input of Object.keys(result.metafile?.inputs ?? {})) {
      if (!input.includes("node_modules/")) {
        continue;
      }

      let directory = dirname(resolve(input));
      while (dirname(directory) !== directory) {
        const manifest = join(directory, "package.json");
        if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name) {
          break;
        }

        directory = dirname(directory);
      }
      bundledPackages.add(directory);
    }
  }

  const script = await Bun.file(join(plugin, "widget.js")).text();
  const html = await Bun.file(join(root, "src/inspector/index.html")).text();

  writeFileSync(
    join(plugin, "widget.html"),
    html.replace(
      "<!-- WIDGET -->",
      () => `<script type="module">${script.replaceAll("</script", "<\\/script")}</script>`,
    ),
  );
  rmSync(join(plugin, "widget.js"));

  const json = (path: string, value: unknown) =>
    writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
  json(join(plugin, "plugin.json"), {
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "zinn",
    version: INSPECTOR_VERSION,
    description: "Experimental local task inspection and execution identity for Codex desktop.",
    extensions: {
      "com.openai": {
        hooks: "./hooks/hooks.json",
        interface: {
          displayName: "Zinn",
          shortDescription: "Inspect local Zinn tasks",
          developerName: "Zinn",
          websiteURL: "https://zinn.sh/integrations/codex",
        },
      },
    },
  });
  json(join(plugin, "mcp.json"), {
    $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers: {
      zinn: {
        type: "stdio",
        command: "node",
        args: ["${PLUGIN_ROOT}/launcher.mjs"],
        cwd: "${PLUGIN_ROOT}",
      },
    },
  });
  json(join(plugin, "hooks/hooks.json"), {
    description: "Observe task references and supply execution identity for direct Zinn commands.",
    hooks: Object.fromEntries(
      EVENTS.map((event) => [
        event,
        [
          {
            ...(event === "PreToolUse" || event === "PostToolUse"
              ? { matcher: "^(Bash|Agent|collaborationspawn_agent|spawn_agent)$" }
              : {}),
            hooks: [
              {
                type: "command",
                command: 'node "${PLUGIN_ROOT}/hook.mjs"',
                timeout: 3,
                statusMessage: `Zinn: ${event}`,
              },
            ],
          },
        ],
      ]),
    ),
  });
  json(join(output, ".agents/plugins/marketplace.json"), {
    name: "zinn",
    interface: { displayName: "Zinn" },
    plugins: [
      {
        name: "zinn",
        source: { source: "local", path: "./plugins/zinn" },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Productivity",
      },
    ],
  });
  copyFileSync(join(root, "LICENSE"), join(plugin, "LICENSE"));
  copyFileSync(join(root, "README.md"), join(plugin, "README.md"));

  const notices: string[] = [];
  for (const directory of [...bundledPackages].sort()) {
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    const files = readdirSync(directory).filter((file) => /^(licen[sc]e|notice)(\.|$)/i.test(file));

    if (files.length === 0) {
      throw new Error(`Missing license notice for ${manifest.name}.`);
    }

    notices.push(
      `${manifest.name} ${manifest.version}\n${files.map((file) => readFileSync(join(directory, file), "utf8")).join("\n")}`,
    );
  }

  writeFileSync(join(plugin, "THIRD_PARTY_NOTICES.txt"), notices.join("\n\n---\n\n") + "\n");
  return { output, plugin, version: INSPECTOR_VERSION };
}

if (import.meta.main) {
  const output = process.argv[2] === undefined ? join(root, "dist") : resolve(process.argv[2]!);

  if (process.argv[2] === undefined) {
    rmSync(output, { recursive: true, force: true });
  } else if (readdirSync(output).length !== 0) {
    throw new Error("The output directory must be empty.");
  }

  console.log(JSON.stringify(await build(output)));
}
