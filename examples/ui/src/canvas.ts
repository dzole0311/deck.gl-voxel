/** Clears and scales an example canvas to CSS pixels, capping its backing resolution at twice the display size. */
export function clearCanvas(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
): CanvasRenderingContext2D | undefined {
  const context = canvas.getContext('2d');
  if (!context || width <= 0 || height <= 0) {
    return undefined;
  }
  const ratio = Math.min(window.devicePixelRatio, 2);
  const pixelWidth = Math.round(width * ratio),
    pixelHeight = Math.round(height * ratio);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  return context;
}
