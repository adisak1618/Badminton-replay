// The camera role: C1/C3 over one long-lived controller, C2 pairing, and C4. The controller follows the camera's
// own match for up to two paired scoreboards (MatchHub, D14), or this phone's own match (Demo score). A camera
// that was paired before rejoins by itself (R-PAIR-8).
import { useEffect, useState, useSyncExternalStore } from 'react';
import { keepScreenOn } from '../../device/wakeLock';
import type { LocalSource } from '../../link/local';
import { cameraPairing } from '../../pairing/live';
import { CameraScreen } from './CameraScreen';
import { cameraController, demoSource } from './live';
import { PairPanel } from './PairPanel';
import { mismatchText, pairErrorText } from '../pairText';
import { Recordings } from './Recordings';

export function CameraRole({ onLeave, onUpdate }: { onLeave: () => void; onUpdate: (() => void) | null }) {
  const [ctrl] = useState(cameraController);
  const [pairing] = useState(cameraPairing);
  const slots = useSyncExternalStore(pairing.subscribe, pairing.getSnapshot);
  const [demo, setDemo] = useState<LocalSource | null>(() => (ctrl.scoreSource.kind === 'local' ? demoSource() : null));
  const [screen, setScreen] = useState<'camera' | 'recordings'>('camera');
  const [pairOpen, setPairOpen] = useState(false);

  useEffect(() => {
    pairing.rejoin();
    if (!demo) ctrl.setSource(pairing.hub);
    // Only on entering the role.
  }, []);

  // While C2 is open, a free slot shows a code: the first one, then a fresh one for the second scoreboard once
  // the first is linked. Not after an error: "Try again" asks for that.
  useEffect(() => {
    if (!pairOpen) return;
    const settled = slots.slots.every((s) => !s.busy && !s.room && !s.error && !s.mismatch && (s.state === 'unpaired' || s.everOpened));
    if (settled && pairing.free()) pairing.pairNext();
  }, [pairOpen, slots]);

  const toggleDemo = () => {
    const next = demo ? null : demoSource();
    ctrl.setSource(next ?? pairing.hub);
    setDemo(next);
  };

  const pair = () => {
    setPairOpen(true);
    if (!demo) ctrl.setSource(pairing.hub);
  };

  const closePair = () => {
    pairing.cancelCodes();
    setPairOpen(false);
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
  const ended = slots.slots.find((s) => s.mismatch || s.error?.kind === 'expired');
  return (
    <CameraScreen
      ctrl={ctrl}
      demo={demo}
      slots={slots}
      onToggleDemo={toggleDemo}
      onPair={pair}
      onUnpair={(i) => (i == null ? pairing.unpairAll() : pairing.unpair(i))}
      pairNote={!pairOpen && !!ended && (ended.mismatch ? mismatchText(ended.mismatch) : pairErrorText(ended.error!, 'camera'))}
      c2={pairOpen && <PairPanel slots={slots} onNewCode={() => pairing.pairNext()} onUnpair={(i) => pairing.unpair(i)} onClose={closePair} onUpdate={onUpdate} />}
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
