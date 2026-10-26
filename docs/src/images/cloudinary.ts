export function cloudinaryImage(source: string, width: number): string {
  return source.replace("/image/upload/", `/image/upload/f_auto,q_auto,w_${width}/`);
}

export function cloudinarySources(source: string): string {
  return [640, 1280, 1920, 2840]
    .map((width) => `${cloudinaryImage(source, width)} ${width}w`)
    .join(", ");
}
