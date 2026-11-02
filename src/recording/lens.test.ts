import { describe, expect, it, vi } from 'vitest';
import { QUALITIES } from './config';
import { classifyLabel, lensOptions, openLens } from './lens';

const dev = (deviceId: string, label: string, kind = 'videoinput') => ({ deviceId, label, kind }) as MediaDeviceInfo;

const PRO = [
  dev('front', 'Front Camera'),
  dev('wide', 'Back Camera'),
  dev('ultra', 'Back Ultra Wide Camera'),
  dev('tele', 'Back Telephoto Camera'),
  dev('dual', 'Back Dual Camera'),
  dev('dualwide', 'Back Dual Wide Camera'),
  dev('triple', 'Back Triple Camera'),
  dev('mic', 'iPhone Microphone', 'audioinput'),
];

describe('lens labels', () => {
  it.each([
    ['Back Camera', 'wide'],
    ['Back Ultra Wide Camera', 'ultrawide'],
    ['Back Telephoto Camera', 'telephoto'],
    ['Back Dual Camera', 'virtual'],
    ['Back Dual Wide Camera', 'virtual'],
    ['Back Triple Camera', 'virtual'],
    ['Front Camera', 'front'],
    ['FaceTime HD Camera', 'front'],
    ['กล้องหลัง', 'wide'],
    ['กล้องด้านหลัง', 'wide'],
    ['กล้องหลังอัลตร้าไวด์', 'ultrawide'],
    ['กล้องอัลตราไวด์ด้านหลัง', 'ultrawide'],
    ['กล้องเทเลโฟโต้ด้านหลัง', 'telephoto'],
    ['กล้องคู่ด้านหลัง', 'virtual'],
    ['กล้องหน้า', 'front'],
    ['Integrated Webcam', 'unknown'],
    ['', 'unknown'],
  ])('%s is %s', (label, kind) => expect(classifyLabel(label)).toBe(kind));
});

describe('the lenses offered', () => {
  it('a three-lens iPhone: each physical lens, widest first, and no virtual camera', () => {
    expect(lensOptions(PRO)).toEqual([
      { lens: 'ultrawide', text: '0.5x', deviceId: 'ultra' },
      { lens: 'wide', text: '1x', deviceId: 'wide' },
      { lens: 'telephoto', text: 'Tele', deviceId: 'tele' },
    ]);
  });
  it('only the lenses present', () => {
    expect(lensOptions([dev('wide', 'Back Camera'), dev('ultra', 'Back Ultra Wide Camera')]).map((o) => o.text)).toEqual(['0.5x', '1x']);
  });
  it('nothing before permission (empty labels) or with no back camera', () => {
    expect(lensOptions([dev('a', ''), dev('b', '')])).toEqual([]);
    expect(lensOptions([dev('front', 'FaceTime HD Camera')])).toEqual([]);
  });
  it('unknown labels are 1x only on the default camera, even with zoom', () => {
    expect(lensOptions([dev('a', 'camera2 0'), dev('b', 'camera2 2')], { min: 1, max: 8 })).toEqual([{ lens: 'wide', text: '1x' }]);
  });
  it('a virtual camera alone is 1x without zoom', () => {
    expect(lensOptions([dev('t', 'Back Triple Camera')])).toEqual([{ lens: 'wide', text: '1x', deviceId: 't' }]);
  });
  it('a virtual or single camera with zoom offers the stops its range reaches', () => {
    expect(lensOptions([dev('t', 'Back Triple Camera')], { min: 0.5, max: 15 }).map((o) => [o.text, o.deviceId, o.zoom])).toEqual([
      ['0.5x', 't', 0.5],
      ['1x', 't', 1],
      ['2x', 't', 2],
    ]);
    expect(lensOptions([dev('b', 'Back Camera')], { min: 1, max: 5 }).map((o) => o.text)).toEqual(['1x', '2x']);
  });
});

/** A camera that opens any listed device, or throws what `fail` says for it. */
function fakeDevices(devices: MediaDeviceInfo[], fail: (id: string | undefined) => string | null = () => null, opts: { defaultId?: string; before?: boolean; size?: [number, number]; zoom?: { min: number; max: number } } = {}) {
  const opened: Array<string | undefined> = [];
  const tracks: Array<{ stop: ReturnType<typeof vi.fn>; applyConstraints: ReturnType<typeof vi.fn> }> = [];
  let granted = !opts.before;
  const [width, height] = opts.size ?? [1920, 1080];
  return {
    opened,
    tracks,
    md: {
      enumerateDevices: async () => (granted ? devices : devices.map((d) => dev(d.deviceId, '', d.kind))),
      getUserMedia: async (c: MediaStreamConstraints) => {
        const want = ((c.video as MediaTrackConstraints).deviceId as { exact: string } | undefined)?.exact;
        opened.push(want);
        const err = fail(want);
        if (err) throw Object.assign(new Error(err), { name: err });
        granted = true;
        const id = want ?? opts.defaultId ?? 'wide';
        const track = {
          label: devices.find((d) => d.deviceId === id)?.label ?? '',
          stop: vi.fn(),
          applyConstraints: vi.fn(async () => {}),
          getSettings: () => ({ deviceId: id, width, height }),
          getCapabilities: () => (opts.zoom ? { zoom: opts.zoom } : {}),
        };
        tracks.push(track);
        return { getVideoTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
      },
    },
  };
}

describe('opening a lens', () => {
  const q = QUALITIES['1080p'];

  it('with labels known, opens the exact device once, at the chosen quality', async () => {
    const f = fakeDevices(PRO);
    const spy = vi.spyOn(f.md, 'getUserMedia');
    const r = await openLens(f.md, 'ultrawide', q, true);
    expect(f.opened).toEqual(['ultra']);
    expect(r.active).toBe('ultrawide');
    expect(r.notice).toBeNull();
    expect((spy.mock.calls[0][0].video as MediaTrackConstraints).width).toEqual({ ideal: 1920 });
  });

  it('before permission, learns the labels on the default camera, stops it, then reopens the chosen lens', async () => {
    const f = fakeDevices(PRO, () => null, { before: true });
    const r = await openLens(f.md, 'ultrawide', q, false);
    expect(f.opened).toEqual([undefined, 'ultra']);
    expect(f.tracks[0].stop).toHaveBeenCalled();
    expect(r.active).toBe('ultrawide');
  });

  it('does not reopen when the default camera already is the chosen lens', async () => {
    const f = fakeDevices(PRO, () => null, { before: true });
    await openLens(f.md, 'wide', q, false);
    expect(f.opened).toEqual([undefined]);
  });

  it('falls back to the default camera with a notice when the exact device fails', async () => {
    const f = fakeDevices(PRO, (id) => (id === 'ultra' ? 'OverconstrainedError' : null));
    const r = await openLens(f.md, 'ultrawide', q, false);
    expect(f.opened).toEqual(['ultra', undefined]);
    expect(r.active).toBe('wide');
    expect(r.notice).toMatch(/0\.5x.*default camera/);
    expect(r.options.map((o) => o.lens)).toContain('ultrawide'); // it can still be tried again
  });

  it('a refusal is not a fallback: the permission error reaches the caller', async () => {
    const f = fakeDevices(PRO, (id) => (id === 'ultra' ? 'NotAllowedError' : null));
    await expect(openLens(f.md, 'ultrawide', q, false)).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(f.opened).toEqual(['ultra']);
  });

  it('when the default camera fails too, that error reaches the caller', async () => {
    const f = fakeDevices(PRO, () => 'NotReadableError');
    await expect(openLens(f.md, 'ultrawide', q, false)).rejects.toMatchObject({ name: 'NotReadableError' });
  });

  it('a saved lens the camera does not have: 1x with a notice', async () => {
    const f = fakeDevices([dev('wide', 'Back Camera')]);
    const r = await openLens(f.md, 'telephoto', q, false);
    expect(r.active).toBe('wide');
    expect(r.notice).toMatch(/telephoto.*1x/);
  });

  it('says so when a lens delivers less than the chosen quality', async () => {
    const f = fakeDevices(PRO, () => null, { size: [1280, 720] });
    const r = await openLens(f.md, 'ultrawide', q, false);
    expect(r.active).toBe('ultrawide');
    expect(r.notice).toMatch(/1280×720.*1080p/);
  });

  it('zoom fallback: reaches the lens by applyConstraints on the one camera', async () => {
    const f = fakeDevices([dev('t', 'Back Triple Camera')], () => null, { defaultId: 't', zoom: { min: 0.5, max: 15 } });
    const r = await openLens(f.md, 'ultrawide', q, false);
    expect(f.opened).toEqual([undefined]);
    expect(f.tracks[0].applyConstraints).toHaveBeenCalledWith({ advanced: [{ zoom: 0.5 }] });
    expect(r.active).toBe('ultrawide');
    expect(r.notice).toBeNull();
  });

  it('zoom fallback: a refused zoom stays on 1x with a notice', async () => {
    const f = fakeDevices([dev('t', 'Back Triple Camera')], () => null, { defaultId: 't', zoom: { min: 0.5, max: 15 } });
    const gum = f.md.getUserMedia;
    f.md.getUserMedia = async (c) => {
      const s = await gum(c);
      (s.getVideoTracks()[0].applyConstraints as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('no'));
      return s;
    };
    const r = await openLens(f.md, 'ultrawide', q, false);
    expect(r.active).toBe('wide');
    expect(r.notice).toMatch(/zooming/);
  });
});
