// The optional channel or show logo: decoded once, downscaled so drawing it every frame stays cheap, and
// kept as a PNG (transparency survives) on this device.
export interface Logo {
  image: CanvasImageSource;
  width: number;
  height: number;
}

const MAX_SIDE = 640;
export const LOGO_TYPES = 'image/png,image/jpeg,image/svg+xml,image/webp';

function loadImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('This image could not be read.'));
    img.src = url;
  }).finally(() => URL.revokeObjectURL(url));
}

/** Decode a picked file (PNG, JPEG, SVG, WebP) into a logo no larger than 640 px, plus the PNG to store. */
export async function prepareLogo(file: Blob): Promise<{ logo: Logo; png: Blob }> {
  const img = await loadImage(file);
  // An SVG without width/height reports 0: give it a square canvas.
  const w0 = img.naturalWidth || 512;
  const h0 = img.naturalHeight || 512;
  const k = Math.min(1, MAX_SIDE / Math.max(w0, h0));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w0 * k));
  c.height = Math.max(1, Math.round(h0 * k));
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  const png = await new Promise<Blob>((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('This image could not be converted.'))), 'image/png'),
  );
  return { logo: { image: c, width: c.width, height: c.height }, png };
}

/** A stored logo back into something drawable. */
export async function decodeLogo(png: Blob): Promise<Logo> {
  const img = await loadImage(png);
  return { image: img, width: img.naturalWidth, height: img.naturalHeight };
}
