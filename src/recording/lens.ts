// Which back lens records (iOS 17+ lists each one as its own video input; older iOS has one "Back Camera" with zoom).
// Labels are empty until the first permission grant, and iOS localises them, so the first open of a session may
// have to use the default camera to learn the labels and then reopen on the chosen lens.
import type { Lens, QualitySpec } from './config';

export type LensKind = Lens | 'virtual' | 'front' | 'unknown';

/** What iOS calls a camera, in English or Thai. A dual or triple camera is virtual: it switches lenses by itself. */
export function classifyLabel(label: string): LensKind {
  const l = label.toLowerCase();
  if (/front|facetime|หน้า/.test(l)) return 'front';
  if (/dual|triple|คู่|สาม/.test(l)) return 'virtual';
  if (/ultra\s*wide|อัลตร|มุมกว้างพิเศษ/.test(l)) return 'ultrawide';
  if (/tele|เทเล/.test(l)) return 'telephoto';
  if (/back|rear|หลัง|wide|ไวด์/.test(l)) return 'wide';
  return 'unknown';
}

export interface LensOption {
  lens: Lens;
  text: string;
  /** Absent: the default camera (no labelled device for this lens). */
  deviceId?: string;
  /** Reached by zooming this device rather than by opening a lens of its own. */
  zoom?: number;
}

type DeviceLike = Pick<MediaDeviceInfo, 'kind' | 'deviceId' | 'label'>;
export interface ZoomRange {
  min: number;
  max: number;
}

const ZOOM_STOPS: Array<[Lens, number, string]> = [
  ['ultrawide', 0.5, '0.5x'],
  ['wide', 1, '1x'],
  ['telephoto', 2, '2x'],
];

/** The lenses to offer, widest first; empty when the labels are not known yet or no back camera is listed. */
export function lensOptions(devices: DeviceLike[], zoom: ZoomRange | null = null): LensOption[] {
  const back = devices
    .filter((d) => d.kind === 'videoinput' && d.label)
    .map((d) => ({ id: d.deviceId, kind: classifyLabel(d.label) }))
    .filter((d) => d.kind !== 'front');
  if (!back.length) return [];
  const idOf = (k: LensKind) => back.find((d) => d.kind === k)?.id;
  const ultrawide = idOf('ultrawide');
  const telephoto = idOf('telephoto');
  const wide = idOf('wide');
  if (ultrawide || telephoto) {
    const options: LensOption[] = [{ lens: 'wide', text: '1x', deviceId: wide }];
    if (ultrawide) options.unshift({ lens: 'ultrawide', text: '0.5x', deviceId: ultrawide });
    // Not a number: the optical factor differs by model (2x to 5x) and the label does not say.
    if (telephoto) options.push({ lens: 'telephoto', text: 'Tele', deviceId: telephoto });
    return options;
  }
  const only = wide ?? idOf('virtual');
  if (!only) return [{ lens: 'wide', text: '1x' }]; // unknown labels: not known to be lenses of one iPhone
  if (!zoom || back.some((d) => d.kind === 'unknown')) return [{ lens: 'wide', text: '1x', deviceId: only }];
  return ZOOM_STOPS.filter(([, z]) => z === 1 || (z >= zoom.min && z <= zoom.max)).map(([lens, z, text]) => ({ lens, text, deviceId: only, zoom: z }));
}

export function zoomRange(track: MediaStreamTrack | undefined): ZoomRange | null {
  const z = (track?.getCapabilities?.() as { zoom?: Partial<ZoomRange> } | undefined)?.zoom;
  return z && typeof z.min === 'number' && typeof z.max === 'number' ? { min: z.min, max: z.max } : null;
}

const LENS_NAME: Record<Lens, string> = { ultrawide: 'The 0.5x lens', wide: 'The 1x lens', telephoto: 'The telephoto lens' };

export interface OpenedLens {
  stream: MediaStream;
  options: LensOption[];
  /** The lens the stream really shows, which is what the segment records. */
  active: Lens;
  /** Set when the stream is not quite what was asked for. */
  notice: string | null;
}

type MediaDevicesLike = {
  getUserMedia(c: MediaStreamConstraints): Promise<MediaStream>;
  enumerateDevices(): Promise<DeviceLike[]>;
};

const stopAll = (s: MediaStream) => s.getTracks().forEach((t) => t.stop());

/** Open the chosen lens at the chosen quality (§6.1); a lens that cannot be opened falls back to the default camera. */
export async function openLens(md: MediaDevicesLike, want: Lens, q: QualitySpec, audio: boolean): Promise<OpenedLens> {
  let notice: string | null = null;
  const open = (deviceId?: string) => {
    const ideal = { width: { ideal: q.width }, height: { ideal: q.height }, frameRate: { ideal: q.fps } };
    return md.getUserMedia({
      video: deviceId ? { deviceId: { exact: deviceId }, ...ideal } : { facingMode: { ideal: 'environment' }, ...ideal },
      audio: audio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
    });
  };
  const openExact = async (deviceId: string) => {
    try {
      return await open(deviceId);
    } catch (err) {
      const name = (err as DOMException)?.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') throw err;
      notice = `${LENS_NAME[want]} could not start at this quality: using the default camera.`;
      return open();
    }
  };
  const list = async (s: MediaStream | null) => lensOptions(await md.enumerateDevices().catch(() => []), zoomRange(s?.getVideoTracks()[0]));

  const known = (await list(null)).find((o) => o.lens === want)?.deviceId;
  let stream = known ? await openExact(known) : await open();
  let options = await list(stream);
  let pick = options.find((o) => o.lens === want);
  // Only now are the labels known on a first open. iOS needs the old stream stopped first, or it mutes the new one's source.
  if (!notice && pick?.deviceId && stream.getVideoTracks()[0]?.getSettings().deviceId !== pick.deviceId) {
    stopAll(stream);
    stream = await openExact(pick.deviceId);
    options = await list(stream);
    pick = options.find((o) => o.lens === want);
  }
  const track = stream.getVideoTracks()[0];
  const seen = classifyLabel(track?.label ?? '');
  let active: Lens = seen === 'ultrawide' || seen === 'telephoto' ? seen : 'wide';
  if (!notice && pick) {
    active = pick.lens;
    if (pick.zoom && pick.zoom !== 1) {
      try {
        await track.applyConstraints({ advanced: [{ zoom: pick.zoom } as MediaTrackConstraintSet] });
      } catch {
        active = 'wide';
        notice = `${LENS_NAME[want]} could not be reached by zooming: using 1x.`;
      }
    }
  } else if (!notice && want !== 'wide') {
    notice = `${LENS_NAME[want]} is not on this camera: using 1x.`;
  }
  // The size constraints are only `ideal`, so a lens short of the chosen quality opens anyway, smaller.
  const { width = 0, height = 0 } = track?.getSettings() ?? {};
  if (!notice && width && Math.max(width, height) < q.width) notice = `${LENS_NAME[active]} gives ${Math.max(width, height)}×${Math.min(width, height)} here, below ${q.height}p: the video is upscaled.`;
  return { stream, options, active, notice };
}
