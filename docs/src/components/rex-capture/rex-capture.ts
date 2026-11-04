import { rexScenes } from "../../config/rex-theme";
import { cloudinaryImage, cloudinarySources } from "../../images/cloudinary";
import { layoutCaptureAnnotations, setActiveCaptureAnnotation } from "./capture-annotations";

type Appearance = "dark" | "light";

const previewSizes =
  "(min-width: 90rem) 72rem, (min-width: 64rem) calc(100vw - 16rem), (min-width: 48rem) calc(100vw - 10rem), calc(100vw - 5rem)";

function initFigure(root: HTMLElement): void {
  const surface = root.querySelector<HTMLElement>("[data-capture-surface]");
  if (!surface) {
    return;
  }

  const image = surface.querySelector<HTMLImageElement>("[data-rex-image]")!;
  const enlarge = surface.querySelector<HTMLAnchorElement>("[data-rex-enlarge]")!;
  const tablist = surface.querySelector<HTMLElement>("[data-rex-tablist]")!;
  const tabs = [...surface.querySelectorAll<HTMLButtonElement>("[data-rex-tab]")];
  const modes = [...root.querySelectorAll<HTMLButtonElement>("[data-rex-mode]")];

  let sceneId = rexScenes[0]!.id;
  let appearance: Appearance = "dark";

  const currentScene = () => rexScenes.find((scene) => scene.id === sceneId) ?? rexScenes[0]!;

  function render(): void {
    const scene = currentScene();
    const source = scene.images[appearance]!;
    image.srcset = cloudinarySources(source);
    image.src = cloudinaryImage(source, 1280);
    image.alt = `The Zinn theme in Rex, ${scene.label} scene, ${appearance} mode`;
    enlarge.href = source;
    enlarge.dataset.lightboxTitle = `Zinn theme in Rex · ${scene.label} · ${appearance}`;

    for (const tab of tabs) {
      const selected = tab.dataset.rexTab === sceneId;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    for (const mode of modes) {
      mode.setAttribute("aria-pressed", String(mode.dataset.rexMode === appearance));
    }
    setActiveCaptureAnnotation(root, sceneId);
    layoutCaptureAnnotations(root);
  }

  function select(next: string): void {
    if (next === sceneId) {
      return;
    }
    sceneId = next;
    render();
  }

  for (const tab of tabs) {
    tab.addEventListener("pointerenter", () => select(tab.dataset.rexTab!));
    tab.addEventListener("focus", () => select(tab.dataset.rexTab!));
    tab.addEventListener("click", () => select(tab.dataset.rexTab!));
  }

  // Arrow keys stay on the tablist instead of moving the page.
  tablist.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") {
      return;
    }
    event.preventDefault();
    const index = tabs.findIndex((tab) => tab.dataset.rexTab === sceneId);
    const step = event.key === "ArrowRight" ? 1 : -1;
    tabs[(index + step + tabs.length) % tabs.length]!.focus();
  });

  for (const mode of modes) {
    mode.addEventListener("click", () => {
      const next = mode.dataset.rexMode as Appearance;
      if (next === appearance) {
        return;
      }
      appearance = next;
      render();
    });
  }

  render();

  new ResizeObserver(() => layoutCaptureAnnotations(root)).observe(surface);
}

function warmCaptures(): void {
  for (const scene of rexScenes) {
    for (const source of Object.values(scene.images)) {
      if (!source) {
        continue;
      }
      const preview = new Image();
      preview.sizes = previewSizes;
      preview.srcset = cloudinarySources(source);
      preview.src = cloudinaryImage(source, 1280);
      preview.decode().catch(() => {});
    }
  }
}

export function initRexCaptures(): void {
  for (const figure of document.querySelectorAll<HTMLElement>("[data-rex-figure]")) {
    initFigure(figure);
  }

  // Warm every capture once the first image is in, so a hover swap paints from cache.
  const firstImage = document.querySelector<HTMLImageElement>("[data-rex-image]");
  if (firstImage?.complete && firstImage.naturalWidth > 0) {
    warmCaptures();
  } else {
    firstImage?.addEventListener("load", warmCaptures, { once: true });
    firstImage?.addEventListener("error", warmCaptures, { once: true });
  }
}
