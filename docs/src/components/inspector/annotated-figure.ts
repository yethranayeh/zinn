export interface AnnotatedFigureAnnotation {
  label: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AnnotatedFigureData {
  src: string;
  width: number;
  height: number;
  alt: string;
  caption: string;
  annotations: AnnotatedFigureAnnotation[];
}
