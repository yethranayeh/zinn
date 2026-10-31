// The ui components that are read from the folders in src/components/ui
const componentFiles = Object.keys(import.meta.glob("../src/components/ui/*/*.astro"));

export const uiComponents = componentFiles.map((file) => {
  const [, folder, name] = file.match(/ui\/([^/]+)\/([^/]+)\.astro$/)!;
  return { folder, name, source: file.replace("../", "docs/") };
});
