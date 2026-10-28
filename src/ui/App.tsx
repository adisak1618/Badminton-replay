// Screen flow: S0 role -> S1 setup -> S3 scoreboard, or S0 -> camera (C1/C3, C4); S0 also opens C4. An
// unfinished match resumes on launch unless this phone was last used as the camera. S2 pairing opens over S1
// or S3; a launch URL carrying a pairing code (the camera's QR read by the iPhone camera app) opens it directly,
// and a scoreboard that was paired before rejoins by itself (R-PAIR-8).
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { configFromSetup, reduce, type MatchSetup } from '../engine';
import { keepScreenOn } from '../device/wakeLock';
import { store } from '../match/live';
import { clearCurrent, loadCurrent } from '../match/persist';
import { loadPrefs, loadRole, savePrefs, saveLastSetup, saveRole, type Prefs, type Role } from '../match/prefs';
import { setUpdateWaiting } from '../pairing/diag';
import { pairingDiag, scoreboardPairing } from '../pairing/live';
import { codeFromLocation } from '../pairing/qr';
import { announce } from '../speech/announce';
import { unlockAudio } from '../speech/sound';
import { CameraRole } from './camera/CameraRole';
import { Recordings } from './camera/Recordings';
import { PairScreen } from './PairScreen';
import { RoleScreen } from './RoleScreen';
import { Scoreboard } from './Scoreboard';
import { SetupScreen } from './SetupScreen';

type Screen = 'loading' | 'role' | 'camera' | 'recordings' | 'setup' | 'board';

export function App() {
  const [screen, setScreen] = useState<Screen>('loading');
  const [resumed, setResumed] = useState(false);
  const [prefs, setPrefsState] = useState<Prefs>(loadPrefs);
  const [lastRole] = useState<Role | null>(loadRole);
  /** S2: false when closed, else the code to start with (from the launch URL) or null. */
  const [pair, setPair] = useState<string | null | false>(false);
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  useEffect(() => {
    let live = true;
    const launchCode = codeFromLocation();
    if (launchCode) {
      history.replaceState(null, '', location.pathname + location.search);
      saveRole('scoreboard');
      setPair(launchCode);
    }
    const camera = loadRole() === 'camera';
    if (!camera) scoreboardPairing().link.rejoin();
    loadCurrent()
      .then((m) => {
        if (!live) return;
        const unfinished = !!m && reduce(m.config, m.events).phase !== 'matchOver';
        if (camera) {
          if (unfinished) store.load(m); // the camera's "Demo score" carries on with this phone's own match
          setScreen('camera');
        } else if (unfinished) {
          store.load(m);
          setResumed(true);
          setScreen('board');
        } else setScreen(launchCode ? 'setup' : 'role');
      })
      .catch(() => live && setScreen(camera ? 'camera' : 'role'));
    return () => {
      live = false;
    };
  }, []);

  const setPrefs = useCallback((p: Prefs) => {
    setPrefsState(p);
    savePrefs(p);
  }, []);

  const pickRole = (r: Role) => {
    saveRole(r);
    setScreen(r === 'scoreboard' ? 'setup' : 'camera');
  };

  // Runs inside the "Start match" tap: unlocks audio, keeps the screen on, speaks "Love all, play".
  const startMatch = (setup: MatchSetup) => {
    unlockAudio();
    keepScreenOn(true);
    saveLastSetup(setup);
    announce(store.start(configFromSetup(setup)), prefs);
    void navigator.storage?.persist?.().catch(() => {});
    setResumed(false);
    setScreen('board');
  };

  const newMatch = () => {
    store.close();
    void clearCurrent().catch(() => {});
    keepScreenOn(false);
    setResumed(false);
    setScreen('setup');
  };

  const update = needRefresh ? () => void updateServiceWorker(true) : null;

  // The pairing diagnostics say when this phone still runs the older build next to a waiting update.
  useEffect(() => {
    setUpdateWaiting(needRefresh);
    if (needRefresh) pairingDiag(loadRole() === 'camera' ? 'camera' : 'scoreboard').log('app', 'a newer build is waiting: Update the app');
  }, [needRefresh]);

  const openPair = () => setPair(null);
  const overlay = pair !== false && <PairScreen initialCode={pair} onClose={() => setPair(false)} />;
  const withPair = (main: ReactNode) => (
    <>
      {main}
      {overlay}
    </>
  );

  if (screen === 'loading') return <div className="h-full bg-bg" />;
  if (screen === 'board' && snap.match && snap.state)
    return withPair(
      <Scoreboard
        store={store}
        config={snap.match.config}
        events={snap.match.events}
        state={snap.state}
        prefs={prefs}
        setPrefs={setPrefs}
        resumed={resumed}
        onContinue={() => setResumed(false)}
        onNewMatch={newMatch}
        onUpdate={update}
        onPair={openPair}
      />,
    );
  if (screen === 'camera') return <CameraRole onLeave={() => setScreen('role')} onUpdate={update} />;
  if (screen === 'recordings') return <Recordings onBack={() => setScreen('role')} />;
  if (screen === 'setup')
    return withPair(<SetupScreen onBack={() => setScreen('role')} onStart={startMatch} onUpdate={update} onPair={openPair} />);
  return <RoleScreen lastRole={lastRole} onPick={pickRole} onRecordings={() => setScreen('recordings')} onUpdate={update} />;
}
