type Component = { folder: string; name: string; source: string };

// One entry per folder, from the file named like the folder. Globbed paths start with `prefix`
function componentsIn(files: string[], prefix: string, sourceRoot: string): Component[] {
  return files.flatMap((file) => {
    const [, folder, name] = file.slice(prefix.length).match(/^([^/]+)\/([^/]+)\.astro$/)!;
    if (name.toLowerCase() !== folder.replaceAll("-", "")) {
      return [];
    }
    return [{ folder, name, source: `${sourceRoot}/${folder}/${name}.astro` }];
  });
}

export const uiComponents = componentsIn(
  Object.keys(import.meta.glob("../src/components/ui/*/*.astro")),
  "../src/components/ui/",
  "docs/src/components/ui",
);

// Foundry-owned components that zinn.sh does not use.
export const proposedComponents = componentsIn(
  Object.keys(import.meta.glob("./proposed/*/*.astro")),
  "./proposed/",
  "docs/foundry/proposed",
);
