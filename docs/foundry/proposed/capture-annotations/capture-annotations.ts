export interface CaptureAnnotation {
  id: string;
  label: string;
  /** Leader start on the capture, as a percentage of its width and height. */
  x: number;
  y: number;
}

export interface CaptureAnnotationGeometry {
  /** Space above the capture for the lines and labels. */
  gutter: number;
  /** Space between the horizontal line and the top of the capture. */
  lineGap: number;
  /** Length of the horizontal line that carries the label. */
  run: number;
  /** Distance from the leader start to the diagonal. */
  inset: number;
}

export function layoutCaptureAnnotations(figure: HTMLElement): void {
  const surface = figure.querySelector<HTMLElement>("[data-capture-surface]");
  const layer = figure.querySelector<HTMLElement>("[data-capture-annotations]");
  if (!surface || !layer) {
    return;
  }

  const width = surface.clientWidth;
  const height = surface.clientHeight;
  if (width === 0 || height === 0) {
    return;
  }

  const gutter = Number(layer.dataset.captureAnnotationGutter);
  const lineGap = Number(layer.dataset.captureAnnotationLineGap);
  const run = Number(layer.dataset.captureAnnotationRun);
  const inset = Number(layer.dataset.captureAnnotationInset);
  const lineY = gutter - lineGap;

  for (const line of layer.querySelectorAll<SVGPolylineElement>("[data-capture-annotation-line]")) {
    const x = Number(line.dataset.captureAnnotationX);
    const y = Number(line.dataset.captureAnnotationY);
    const startX = width * (x / 100) + inset;
    const startY = gutter + height * (y / 100);
    const cornerX = startX - (startY - lineY);
    const endX = cornerX - run;
    line.setAttribute("points", `${startX},${startY} ${cornerX},${lineY} ${endX},${lineY}`);

    const label = layer.querySelector<HTMLElement>(
      `[data-capture-annotation-label="${line.dataset.captureAnnotationLine}"]`,
    );
    if (label) {
      label.style.left = `${endX}px`;
    }
  }
}

export function setActiveCaptureAnnotation(figure: HTMLElement, id: string): void {
  const elements = figure.querySelectorAll<HTMLElement>(
    "[data-capture-annotation-line], [data-capture-annotation-label]",
  );
  for (const element of elements) {
    const annotationId =
      element.dataset.captureAnnotationLine ?? element.dataset.captureAnnotationLabel;
    element.toggleAttribute("data-active", annotationId === id);
  }
}
