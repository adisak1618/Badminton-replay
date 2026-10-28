// Screen flow for phase 1: S0 role -> S1 setup -> S3 scoreboard; an unfinished match resumes on launch.
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { configFromSetup, reduce, type MatchSetup } from '../engine';
import { keepScreenOn } from '../device/wakeLock';
import { store } from '../match/live';
import { clearCurrent, loadCurrent } from '../match/persist';
import { loadPrefs, loadRole, savePrefs, saveLastSetup, saveRole, type Prefs, type Role } from '../match/prefs';
import { announce } from '../speech/announce';
import { unlockAudio } from '../speech/sound';
import { CameraPlaceholder, RoleScreen } from './RoleScreen';
import { Scoreboard } from './Scoreboard';
import { SetupScreen } from './SetupScreen';

type Screen = 'loading' | 'role' | 'camera' | 'setup' | 'board';

export function App() {
  const [screen, setScreen] = useState<Screen>('loading');
  const [resumed, setResumed] = useState(false);
  const [prefs, setPrefsState] = useState<Prefs>(loadPrefs);
  const [lastRole] = useState<Role | null>(loadRole);
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  useEffect(() => {
    let live = true;
    loadCurrent()
      .then((m) => {
        if (!live) return;
        if (m && reduce(m.config, m.events).phase !== 'matchOver') {
          store.load(m);
          setResumed(true);
          setScreen('board');
        } else setScreen('role');
      })
      .catch(() => live && setScreen('role'));
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

  if (screen === 'loading') return <div className="h-full bg-bg" />;
  if (screen === 'board' && snap.match && snap.state)
    return (
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
      />
    );
  if (screen === 'camera') return <CameraPlaceholder onBack={() => setScreen('role')} onScoreboard={() => pickRole('scoreboard')} />;
  if (screen === 'setup') return <SetupScreen onBack={() => setScreen('role')} onStart={startMatch} onUpdate={update} />;
  return <RoleScreen lastRole={lastRole} onPick={pickRole} onUpdate={update} />;
}
