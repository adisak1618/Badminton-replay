import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CAMERA_SETTINGS } from '../recording/config';
import { loadCameraSettings, saveCameraSettings } from './prefs';

describe('camera settings', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
  });
  afterEach(() => delete (globalThis as { localStorage?: unknown }).localStorage);

  it('is full by default, keeps a saved set, and falls back to full for anything else', () => {
    expect(loadCameraSettings().overlayMotion).toBe('full');
    expect(DEFAULT_CAMERA_SETTINGS.overlayMotion).toBe('full');
    saveCameraSettings({ ...DEFAULT_CAMERA_SETTINGS, overlayMotion: 'light' });
    expect(loadCameraSettings().overlayMotion).toBe('light');
    store.set('bs.camera', JSON.stringify({ overlayMotion: 'fast' }));
    expect(loadCameraSettings().overlayMotion).toBe('full');
  });

  it('the lens is 1x by default and for settings saved before it existed, and a saved lens is kept', () => {
    expect(loadCameraSettings().lens).toBe('wide');
    store.set('bs.camera', JSON.stringify({ quality: '720p' }));
    expect(loadCameraSettings()).toMatchObject({ quality: '720p', lens: 'wide' });
    saveCameraSettings({ ...DEFAULT_CAMERA_SETTINGS, lens: 'ultrawide' });
    expect(loadCameraSettings().lens).toBe('ultrawide');
    store.set('bs.camera', JSON.stringify({ lens: 'fisheye' }));
    expect(loadCameraSettings().lens).toBe('wide');
  });
});
