// The QR code carries the room code only (the descriptions travel through the helper): an app URL whose hash
// names the code, so the in-app scanner reads it and the iPhone camera app opens the app on the pairing screen.
// Scanning uses zxing-wasm (BarcodeDetector is off by default on iOS, §9), loaded only when S2 opens, with its
// .wasm served from this origin rather than a CDN.

const CODE = /^\d{6}$/;

export const pairUrl = (code: string, origin = location.origin): string => `${origin}/#pair=${code}`;

/** The six-digit code in scanned text: a bare code or a pairing URL. */
export function codeFromText(text: string): string | null {
  const t = text.trim();
  if (CODE.test(t)) return t;
  const m = /[#&?]pair=(\d{6})(?:\D|$)/.exec(t);
  return m ? m[1] : null;
}

/** The code a launch URL asks to pair with, if any. */
export const codeFromLocation = (href = location.href): string | null => codeFromText(href);

export async function qrSvg(text: string): Promise<string> {
  const { default: QRCode } = await import('qrcode');
  return QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
}

type Reader = (img: ImageData) => Promise<string | null>;
let reader: Promise<Reader> | null = null;

/** Load the decoder once. */
export function qrReader(): Promise<Reader> {
  reader ??= (async () => {
    const [{ prepareZXingModule, readBarcodes }, { default: wasmUrl }] = await Promise.all([
      import('zxing-wasm/reader'),
      import('zxing-wasm/reader/zxing_reader.wasm?url'),
    ]);
    prepareZXingModule({
      overrides: { locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path) },
    });
    return async (img: ImageData) => {
      const [r] = await readBarcodes(img, { formats: ['QRCode'], tryHarder: true, maxNumberOfSymbols: 1 });
      return r?.isValid ? r.text : null;
    };
  })();
  reader.catch(() => (reader = null));
  return reader;
}

/** One frame of `video`, downscaled so decoding stays quick on a phone. */
export function grabFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement, maxSide = 720): ImageData | null {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return null;
  const k = Math.min(1, maxSide / Math.max(w, h));
  canvas.width = Math.round(w * k);
  canvas.height = Math.round(h * k);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}
