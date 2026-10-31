// Screen flow: S0 role -> S1 setup -> S3 scoreboard, or S0 -> camera (C1/C3, C4); S0 also opens C4. An
// unfinished match resumes on launch unless this phone was last used as the camera. S2 pairing opens over S1
// or S3; a launch URL carrying a pairing code (the camera's QR read by the iPhone camera app) opens it directly,
// and a scoreboard that was paired before rejoins by itself (R-PAIR-8). S0 -> file picker -> S1 -> S3v scores a saved
// video (D17): the same match on this phone alone, on the video's clock; after a reload its file is picked again.
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { configFromSetup, reduce, type MatchSetup } from '../engine';
import { checkForUpdate, setRegistration } from '../device/update';
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
import { VideoBoard } from '../video/VideoBoard';
import { describeFile } from '../video/source';

type Screen = 'loading' | 'role' | 'camera' | 'recordings' | 'setup' | 'board';

export function App() {
  const [screen, setScreen] = useState<Screen>('loading');
  const [resumed, setResumed] = useState(false);
  const [prefs, setPrefsState] = useState<Prefs>(loadPrefs);
  const [lastRole] = useState<Role | null>(loadRole);
  /** S2: false when closed, else the code to start with (from the launch URL) or null. */
  const [pair, setPair] = useState<string | null | false>(false);
  /** D17: the video picked on S0 (or again on S3v-r); null for a live match, and after a reload until re-picked. */
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({ onRegisteredSW: (_url, r) => setRegistration(r) });

  // Look for a newer build whenever the app comes back to the front (an open page never looked again before).
  useEffect(() => {
    const look = () => document.visibilityState === 'visible' && checkForUpdate();
    document.addEventListener('visibilitychange', look);
    return () => document.removeEventListener('visibilitychange', look);
  }, []);

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
    setVideoFile(null);
    setScreen(r === 'scoreboard' ? 'setup' : 'camera');
  };

  // D17: a video match is this phone's alone; a pairing left from before would hand it to a camera, so it goes.
  const pickVideo = (f: File) => {
    const { link } = scoreboardPairing();
    if (link.getSnapshot().state !== 'unpaired') link.unpair();
    store.local();
    setVideoFile(f);
    setScreen('setup');
  };

  // Runs inside the "Start match" tap: unlocks audio, keeps the screen on, speaks "Love all, play".
  const startMatch = (setup: MatchSetup) => {
    unlockAudio();
    keepScreenOn(true);
    saveLastSetup(setup);
    announce(store.start(configFromSetup(setup), videoFile ? describeFile(videoFile) : undefined), prefs);
    void navigator.storage?.persist?.().catch(() => {});
    setResumed(false);
    setScreen('board');
  };

  // Paired, the camera's match stays where it is until a new one starts (from this phone or the other one).
  const newMatch = () => {
    const video = !!store.getSnapshot().match?.video;
    if (!store.paired) {
      store.close();
      void clearCurrent().catch(() => {});
    }
    keepScreenOn(false);
    setResumed(false);
    // After a video match the next one may be live or another file: back to the role screen.
    setVideoFile(null);
    setScreen(video ? 'role' : 'setup');
  };

  // A match that arrives from the camera (pairing, or started on the other scoreboard) is shown at once.
  const remoteMatch = snap.origin === 'remote' ? snap.match?.matchId : undefined;
  useEffect(() => {
    if (remoteMatch && (screen === 'setup' || screen === 'role')) {
      setResumed(false);
      setScreen('board');
    }
  }, [remoteMatch]);

  const update = needRefresh ? () => void updateServiceWorker(true) : null;

  // On the role screen nothing is live: look for a newer build, and take it at once when there is one, so the
  // first launch after a deploy does not run the old build (it did, every time: 2026-10-31 audit, BUG-2).
  useEffect(() => {
    if (screen !== 'role') return;
    if (needRefresh) void updateServiceWorker(true);
    else checkForUpdate();
  }, [screen, needRefresh]);

  // The pairing diagnostics say when this phone still runs the older build next to a waiting update.
  useEffect(() => {
    setUpdateWaiting(needRefresh);
    if (needRefresh) pairingDiag(loadRole() === 'camera' ? 'camera' : 'scoreboard').log('app', 'a newer build is waiting: Update the app');
  }, [needRefresh]);

  const openPair = () => setPair(null);
  const overlay = pair !== false && <PairScreen initialCode={pair} onUpdate={update} onClose={() => setPair(false)} />;
  const withPair = (main: ReactNode) => (
    <>
      {main}
      {overlay}
    </>
  );

  if (screen === 'loading') return <div className="h-full bg-bg" />;
  if (screen === 'board' && snap.match?.video && snap.state)
    return (
      <VideoBoard
        store={store}
        config={snap.match.config}
        events={snap.match.events}
        state={snap.state}
        video={snap.match.video}
        file={videoFile}
        onFile={setVideoFile}
        prefs={prefs}
        setPrefs={setPrefs}
        resumed={resumed}
        onContinue={() => setResumed(false)}
        onNewMatch={newMatch}
        onUpdate={update}
      />
    );
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
    return withPair(
      <SetupScreen
        onBack={() => {
          setVideoFile(null);
          setScreen('role');
        }}
        onStart={startMatch}
        onUpdate={update}
        onPair={openPair}
        video={videoFile?.name}
      />,
    );
  return <RoleScreen lastRole={lastRole} onPick={pickRole} onRecordings={() => setScreen('recordings')} onUpdate={update} onVideo={pickVideo} />;
}
