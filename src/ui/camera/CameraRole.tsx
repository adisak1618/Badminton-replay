// The camera role: C1/C3 over one long-lived controller, C2 pairing, and C4. The controller follows the paired
// scoreboard (PeerSource), this phone's own match (Demo score), or nothing (not paired). A camera that was
// paired before rejoins by itself (R-PAIR-8).
import { useEffect, useState, useSyncExternalStore } from 'react';
import { keepScreenOn } from '../../device/wakeLock';
import type { LocalSource } from '../../link/local';
import { cameraPairing } from '../../pairing/live';
import { CameraScreen } from './CameraScreen';
import { cameraController, demoSource, notPaired } from './live';
import { PairPanel } from './PairPanel';
import { mismatchText, pairErrorText } from '../pairText';
import { Recordings } from './Recordings';

export function CameraRole({ onLeave, onUpdate }: { onLeave: () => void; onUpdate: (() => void) | null }) {
  const [ctrl] = useState(cameraController);
  const [pairing] = useState(cameraPairing);
  const l = useSyncExternalStore(pairing.link.subscribe, pairing.link.getSnapshot);
  const [demo, setDemo] = useState<LocalSource | null>(() => (ctrl.scoreSource.kind === 'local' ? demoSource() : null));
  const [screen, setScreen] = useState<'camera' | 'recordings'>('camera');
  const [pairOpen, setPairOpen] = useState(false);

  const follow = (d: LocalSource | null) => ctrl.setSource(d ?? (pairing.link.paired || l.room ? pairing.source : notPaired()));

  useEffect(() => {
    if (pairing.link.rejoin() && !demo) ctrl.setSource(pairing.source);
    // Only on entering the role.
  }, []);

  const toggleDemo = () => {
    const next = demo ? null : demoSource();
    follow(next);
    setDemo(next);
  };

  const pair = () => {
    setPairOpen(true);
    if (!demo) ctrl.setSource(pairing.source);
    void pairing.link.pair();
  };

  const unpair = () => {
    pairing.link.unpair();
    if (!demo) ctrl.setSource(notPaired());
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
      paired={pairing.link.paired}
      onToggleDemo={toggleDemo}
      onPair={pair}
      onUnpair={unpair}
      pairNote={!pairOpen && (l.mismatch ? mismatchText(l.mismatch) : l.error?.kind === 'expired' ? pairErrorText(l.error) : null)}
      c2={pairOpen && <PairPanel l={l} onNewCode={() => void pairing.link.pair()} onClose={() => setPairOpen(false)} />}
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
