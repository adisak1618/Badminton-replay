import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CAMERA_SETTINGS } from '../recording/config';
import { loadCameraSettings, saveCameraSettings } from './prefs';

describe('camera settings: the overlay motion set (C1 "Motion")', () => {
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
});
