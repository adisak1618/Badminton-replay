// C4 → "Replays video" (D16, ux-design.md C5): the video made after the match on the camera phone. The marked replays
// go in with the BWF card, and the stats table and the end-of-game card are drawn from the tags as they are now (tags
// added after the match count from their point). It renders in parts and saves its progress, so leaving the app or a
// locked screen only stops it: Continue picks up at the first part not finished.
import { useEffect, useRef, useState } from 'react';
import { keepScreenOn } from '../../device/wakeLock';
import { reasonsOn, type Team } from '../../engine';
import type { MatchBundle } from '../../recording/bundle';
import type { StoredRecording } from '../../recording/storage';
import type { JobState, RenderOptions, RenderProgress } from '../../render/job';
import { bytes } from './format';

type Phase = { k: 'idle' } | { k: 'running'; p: RenderProgress | null; started: number } | { k: 'done'; files: File[] } | { k: 'stopped'; why: string } | { k: 'error'; why: string };

const mmss = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}`;

export function RenderSheet({ rec, bundle, title, onClose }: { rec: StoredRecording; bundle: MatchBundle; title: string; onClose: () => void }) {
  const cfg = bundle.config;
  const segs = bundle.recording?.segments ?? [];
  const marks = bundle.replays?.length ?? 0;
  const first = rec.meta.segments[0];
  const reasons = !!cfg && reasonsOn(cfg);
  const [replays, setReplays] = useState(marks > 0);
  const [table, setTable] = useState<'off' | Team>(first?.overlay.stats?.team ?? 'off');
  const [card, setCard] = useState<boolean>(first?.overlay.stats?.card ?? false);
  const [phase, setPhase] = useState<Phase>({ k: 'idle' });
  const [saved, setSaved] = useState<JobState | null>(null);
  const abort = useRef<AbortController | null>(null);
  const now = Date.now();

  const options = (): RenderOptions => ({
    replays,
    blend: true,
    table: reasons ? (table === 'off' ? null : { team: table, opp: first?.overlay.stats?.opp ?? true }) : null,
    card: reasons && card,
  });
  const files = () => new Map(rec.meta.segments.flatMap((s) => (rec.files.has(s.file) ? [[s.index, rec.files.get(s.file)!] as const] : [])));

  // A render saved earlier: how far it got.
  useEffect(() => {
    void import('../../render/store').then(async ({ OpfsRenderStore }) => {
      const st = new OpfsRenderStore(rec.meta.id);
      setSaved(await st.readJob());
      st.dispose();
    });
  }, [rec.meta.id]);

  // Leaving the app stops the render cleanly (iOS would freeze it mid-part); Continue resumes it.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') abort.current?.abort();
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, []);

  const start = async () => {
    const ctl = new AbortController();
    abort.current = ctl;
    setPhase({ k: 'running', p: null, started: Date.now() });
    keepScreenOn(true, 'render');
    const [{ renderMatch, NotEnoughSpace }, { OpfsRenderStore }] = await Promise.all([import('../../render/job'), import('../../render/store')]);
    const store = new OpfsRenderStore(rec.meta.id);
    try {
      const out = await renderMatch(bundle, files(), store, options(), { signal: ctl.signal, onProgress: (p) => setPhase((ph) => (ph.k === 'running' ? { ...ph, p } : ph)) });
      const done: File[] = [];
      for (const o of out) {
        const b = await store.read(o.name);
        if (b) done.push(new File([b], `${title.replace(/[^\w-]+/g, '-')}-${o.name}`, { type: 'video/mp4' }));
      }
      setPhase({ k: 'done', files: done });
      setSaved(await store.readJob());
    } catch (err) {
      const e = err as Error;
      if (e.name === 'AbortError') setPhase({ k: 'stopped', why: 'Stopped. Tap Continue to pick up where it left off.' });
      else if (e instanceof NotEnoughSpace) setPhase({ k: 'error', why: `Not enough space on this phone: it needs ${bytes(e.needed)}, ${bytes(e.free)} is free. Export and delete an older match first.` });
      else setPhase({ k: 'error', why: `The video could not be made (${e.message}). Tap Continue to try again from the last finished part.` });
      setSaved(await store.readJob());
    } finally {
      keepScreenOn(false, 'render');
      store.dispose();
      abort.current = null;
    }
  };

  const share = async (fs: File[]) => {
    try {
      if (navigator.canShare?.({ files: fs })) return void (await navigator.share({ files: fs, title }));
    } catch (err) {
      if ((err as DOMException).name === 'AbortError') return;
    }
    for (const f of fs) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(f);
      a.download = f.name;
      a.click();
    }
  };

  const discard = async () => {
    const { OpfsRenderStore } = await import('../../render/store');
    const st = new OpfsRenderStore(rec.meta.id);
    await st.clear();
    st.dispose();
    setSaved(null);
    setPhase({ k: 'idle' });
  };

  const partsDone = saved ? saved.segments.reduce((a, s) => a + (s.final ? s.parts : s.done.length), 0) : 0;
  const partsAll = saved ? saved.segments.reduce((a, s) => a + s.parts, 0) : 0;
  const finished = !!saved && saved.segments.every((s) => s.final);
  const running = phase.k === 'running';
  const p = running ? phase.p : null;
  const pct = p ? Math.min(100, Math.round((p.doneMs / Math.max(1, p.totalMs)) * 100)) : 0;
  const eta = p && running && p.doneMs > 0 ? ((Date.now() - phase.started) / p.doneMs) * (p.totalMs - p.doneMs) : null;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-3" onClick={running ? undefined : onClose}>
      <div className="sheet flex max-h-full w-[min(640px,100%)] flex-col gap-3 overflow-y-auto p-4" role="dialog" aria-label="Replays video" onClick={(e) => e.stopPropagation()} data-testid="render-sheet">
        <div className="flex items-center justify-between gap-2">
          <b className="text-lg">Replays video · {title}</b>
          {!running && (
            <button className="btn btn-ghost min-h-10 px-3" onClick={onClose}>
              Close
            </button>
          )}
        </div>
        <p className="text-sm text-mut">
          A new video of the whole match{marks ? ` with ${marks} replay${marks > 1 ? 's' : ''} (★ points) slowed down after their point` : ''}. Every frame is made again on this
          phone: keep the app open with the screen on and the phone plugged in. Leaving the app stops it; Continue picks up from there. The recording itself is not changed.
        </p>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={replays} disabled={!marks || running} onChange={(e) => setReplays(e.target.checked)} data-testid="render-replays" />
          Replays ({marks} marked{marks ? '' : ': mark points with ★ in the rally list'})
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-mut">Player stats table</span>
          {(['off', 'A', 'B'] as const).map((t) => (
            <button key={t} className={`btn min-h-9 px-3 text-sm ${table === t ? 'btn-pri' : ''}`} disabled={!reasons || running} onClick={() => setTable(t)}>
              {t === 'off' ? 'Off' : (cfg?.teams[t].name ?? t)}
            </button>
          ))}
          <label className="ml-2 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={card} disabled={!reasons || running} onChange={(e) => setCard(e.target.checked)} />
            End-of-game summary
          </label>
        </div>
        {!reasons && <p className="text-sm text-mut">This match did not record why points were won, so no stats can be drawn.</p>}
        {segs.length > 1 && <p className="text-sm text-mut">{segs.length} segments: one video each.</p>}

        {running && (
          <div className="flex flex-col gap-1" data-testid="render-progress">
            <div className="h-3 overflow-hidden rounded bg-btn">
              <div className="h-full bg-pri" style={{ width: `${pct}%` }} />
            </div>
            <span className="text-sm">
              {p ? (p.phase === 'join' ? 'Joining the parts…' : `${pct}% · part ${p.part + 1} of ${p.parts}`) : 'Starting…'}
              {eta != null && ` · about ${mmss(eta)} left`} · {mmss(now - phase.started)} so far
            </span>
          </div>
        )}
        {(phase.k === 'stopped' || phase.k === 'error') && (
          <p className={`text-sm ${phase.k === 'error' ? 'text-red' : 'text-amber'}`} role="status">
            {phase.why}
          </p>
        )}
        {!running && saved && !finished && partsDone > 0 && (
          <p className="text-sm text-mut">
            {partsDone} of {partsAll} parts already made.
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          {running ? (
            <button className="btn" onClick={() => abort.current?.abort()} data-testid="render-stop">
              Stop
            </button>
          ) : phase.k === 'done' ? (
            <>
              <button className="btn btn-pri" onClick={() => void share(phase.files)} data-testid="render-share">
                Share video
              </button>
              <button className="btn btn-ghost" onClick={() => void discard()}>
                Delete it
              </button>
            </>
          ) : (
            <>
              <button className="btn btn-pri" onClick={() => void start()} data-testid="render-start">
                {finished ? 'Open the made video' : saved && partsDone > 0 ? 'Continue' : 'Make video'}
              </button>
              {saved && (
                <button className="btn btn-ghost" onClick={() => void discard()}>
                  Delete the made video
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
