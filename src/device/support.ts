// Supported browsers (N-BROWSER-1, D1): Safari on iPhone, iOS 17+ in a tab, iOS 18.4+ installed to the
// Home Screen. Others see a note naming the supported ones but can carry on.

export interface Support {
  ok: boolean;
  standalone: boolean;
  ios: boolean;
  message: string | null;
}

export function isStandalone(): boolean {
  return (
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    (typeof matchMedia !== 'undefined' && matchMedia('(display-mode: standalone)').matches)
  );
}

export function checkSupport(ua = navigator.userAgent, standalone = isStandalone(), touchPoints = navigator.maxTouchPoints): Support {
  const ios = /iP(hone|od|ad)/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1);
  const supported = 'Supported: Safari on iPhone, iOS 17 or later (iOS 18.4 or later when added to the Home Screen).';
  if (!ios) return { ok: false, standalone, ios, message: `This browser is not supported. ${supported}` };
  if (/CriOS|FxiOS|EdgiOS|OPiOS|GSA\//.test(ua))
    return { ok: false, standalone, ios, message: `Open this page in Safari. ${supported}` };
  const m = /OS (\d+)[_.](\d+)/.exec(ua) ?? /Version\/(\d+)\.(\d+)/.exec(ua);
  if (m) {
    const v = Number(m[1]) + Number(m[2]) / 100;
    const need = standalone ? 18.04 : 17;
    if (v < need) return { ok: false, standalone, ios, message: `This iOS version is too old. ${supported}` };
  }
  return { ok: true, standalone, ios, message: null };
}
