const componentFiles = Object.keys(import.meta.glob("../src/components/ui/*/*.astro"));

export const uiComponents = componentFiles.flatMap((file) => {
  const [, folder, name] = file.match(/ui\/([^/]+)\/([^/]+)\.astro$/)!;
  if (name.toLowerCase() !== folder) {
    return [];
  }
  return [{ folder, name, source: file.replace("../", "docs/") }];
});
