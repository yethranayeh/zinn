import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

type Scheme = "light" | "dark";

interface Texture {
  name: string;
  id: string;
  frames: Record<Scheme, string>;
  properties: Record<string, unknown>;
}

interface ThemeSource {
  version: string;
  description: string;
  minVersion: string;
  colors: Record<Scheme, Record<string, string>>;
  textures: Record<string, Texture>;
}

const schemes: Array<Scheme> = ["light", "dark"];
const root = import.meta.dir;
const source = join(root, "theme");
const out = join(root, "dist");
const theme: ThemeSource = await Bun.file(join(source, "theme.json")).json();

const lightKeys = Object.keys(theme.colors.light).sort().join();
const darkKeys = Object.keys(theme.colors.dark).sort().join();
if (lightKeys !== darkKeys) {
  throw new Error("theme.json: light and dark colors must use the same keys");
}

/** The manifest for one texture, with the scheme colors and its frame image. */
function manifest(texture: Texture) {
  const scheme = (scheme: Scheme) => ({
    colors: theme.colors[scheme],
    images: { additional_backgrounds: [texture.frames[scheme]] },
    properties: texture.properties,
  });

  return {
    manifest_version: 3,
    name: texture.name,
    version: theme.version,
    description: theme.description,
    icons: { "48": "icon.svg", "96": "icon.svg" },
    browser_specific_settings: {
      gecko: { id: texture.id, strict_min_version: theme.minVersion },
    },
    theme: scheme("light"),
    dark_theme: scheme("dark"),
  };
}

await rm(out, { recursive: true, force: true });

for (const [key, texture] of Object.entries(theme.textures)) {
  const slug = `zinn-${key}`;
  const dir = join(out, slug);
  await mkdir(dir, { recursive: true });

  for (const scheme of schemes) {
    const frame = texture.frames[scheme];
    await cp(join(source, "textures", key, frame), join(dir, frame));
  }
  await cp(join(source, "icon.svg"), join(dir, "icon.svg"));
  await Bun.write(join(dir, "manifest.json"), `${JSON.stringify(manifest(texture), null, "\t")}\n`);

  const xpi = join(out, `${slug}-${theme.version}.xpi`);
  const files = ["manifest.json", "icon.svg", texture.frames.light, texture.frames.dark];
  const zip = Bun.spawnSync({ cmd: ["zip", "-X", "-q", xpi, ...files], cwd: dir });
  if (zip.exitCode !== 0) {
    throw new Error(`zip failed for ${slug}: ${zip.stderr.toString()}`);
  }

  console.log(`${slug}: ${dir}`);
  console.log(`${slug}: ${xpi}`);
}
