// The camera role: C1/C3 over one long-lived controller, and C4. Pairing (C2) arrives in phase 2b; until
// then the camera follows either nothing (not paired) or this phone's own match (Demo score).
import { useState } from 'react';
import { keepScreenOn } from '../../device/wakeLock';
import type { LocalSource } from '../../link/local';
import { CameraScreen } from './CameraScreen';
import { cameraController, demoSource, notPaired } from './live';
import { Recordings } from './Recordings';

export function CameraRole({ onLeave, onUpdate }: { onLeave: () => void; onUpdate: (() => void) | null }) {
  const [ctrl] = useState(cameraController);
  const [demo, setDemo] = useState<LocalSource | null>(() => (ctrl.scoreSource.kind === 'local' ? demoSource() : null));
  const [screen, setScreen] = useState<'camera' | 'recordings'>('camera');

  const toggleDemo = () => {
    const next = demo ? null : demoSource();
    ctrl.setSource(next ?? notPaired());
    setDemo(next);
  };

  const leave = () => {
    if (ctrl.recording) return;
    ctrl.stopCamera();
    keepScreenOn(false);
    onLeave();
  };

  if (screen === 'recordings')
    return (
      <Recordings
        onBack={() => {
          setScreen('camera');
          void ctrl.refreshStorage(true);
        }}
      />
    );
  return (
    <CameraScreen
      ctrl={ctrl}
      demo={demo}
      onToggleDemo={toggleDemo}
      onRecordings={() => {
        ctrl.stopCamera();
        keepScreenOn(false);
        setScreen('recordings');
      }}
      onLeave={leave}
      onUpdate={onUpdate}
    />
  );
}
