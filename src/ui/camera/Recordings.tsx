// C4 recordings and export (R-REC-6, R-EXP-1 to 3): each recorded match with size and duration, shared as
// the bundle (video segments + match.json) through the share sheet, or downloaded; delete with a confirm
// and the storage figure before and after.
import { useCallback, useEffect, useState } from 'react';
import { APP_BUILD } from '../../build';
import { reduce } from '../../engine';
import { buildBundle, exportFileName, bundleName, type MatchBundle } from '../../recording/bundle';
import { MATCHES_DIR } from '../../recording/meta';
import { segmentMs } from '../../recording/session';
import { deleteRecording, listRecordings, storageFigures, type StorageFigures, type StoredRecording } from '../../recording/storage';
import { WriterClient } from '../../recording/writerClient';
import { elapsed } from '../format';
import { bytes, when } from './format';
import { RenderSheet } from './RenderSheet';
import { Studio } from './Studio';
import { thisDevice } from './live';

interface Row {
  rec: StoredRecording;
  title: string;
  result: string;
  durationMs: number;
  size: number;
  videos: File[];
  json: File;
  jsonText: string;
  bundle: MatchBundle;
}

function toRow(rec: StoredRecording): Row {
  const { meta, log } = rec;
  const bundle = buildBundle({ meta, log, app: APP_BUILD, now: Date.now() });
  const cfg = log?.config;
  let result = '';
  if (cfg && log) {
    const s = reduce(cfg, log.events);
    result =
      s.phase === 'matchOver'
        ? s.winner
          ? `${cfg.teams[s.winner].name} won ${s.games.A}-${s.games.B}`
          : `draw ${s.games.A}-${s.games.B}`
        : `game ${s.game}: ${s.score.A}-${s.score.B} (games ${s.games.A}-${s.games.B})`;
  }
  const videos = meta.segments.flatMap((seg) => {
    const f = rec.files.get(seg.file);
    return f ? [new File([f], exportFileName(meta.createdAt, seg.file), { type: seg.mimeType.split(';')[0] })] : [];
  });
  const jsonText = JSON.stringify(bundle, null, 1);
  return {
    rec,
    title: cfg ? `${cfg.teams.A.name} vs ${cfg.teams.B.name}` : meta.matchId ? 'Recording (score log missing)' : 'Recording without score',
    result,
    durationMs: meta.segments.reduce((a, s) => a + segmentMs(s, s.endedAt ?? s.startedAt), 0),
    size: meta.segments.reduce((a, s) => a + s.bytes, 0),
    videos,
    json: new File([jsonText], `${bundleName(meta.createdAt)}-match.json`, { type: 'application/json' }),
    jsonText,
    bundle,
  };
}

/** Write match.json next to the video in OPFS (§6.7) with a short-lived worker; best effort. */
function storeBundleJson(id: string, text: string): void {
  try {
    const w = new Worker(new URL('../../recording/opfs.worker.ts', import.meta.url), { type: 'module' });
    void new WriterClient(w).put([MATCHES_DIR, id], 'match.json', text).finally(() => w.terminate());
  } catch {
    // the shared files are what matters
  }
}

function download(files: File[]): void {
  for (const f of files) {
    const url = URL.createObjectURL(f);
    const a = document.createElement('a');
    a.href = url;
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

const canShare = (files: File[]): boolean => {
  try {
    return typeof navigator.share === 'function' && !!navigator.canShare?.({ files });
  } catch {
    return false;
  }
};

const usage = (s: StorageFigures | null) => (s?.usage != null ? `${bytes(s.usage)} / ${bytes(s.quota)}` : '?');

export function Recordings({ onBack }: { onBack: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [storage, setStorage] = useState<StorageFigures | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [shareFailed, setShareFailed] = useState(false);
  const [rendering, setRendering] = useState<Row | null>(null);
  const [studio, setStudio] = useState<Row | null>(null);

  const load = useCallback(async () => {
    const [list, st] = await Promise.all([listRecordings(thisDevice()).catch(() => []), storageFigures()]);
    setRows(list.map(toRow));
    setStorage(st);
    return st;
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Called straight from the tap: the files are prepared already, so share() runs inside the user gesture.
  const share = (row: Row, files: File[]) => {
    storeBundleJson(row.rec.meta.id, row.jsonText);
    if (shareFailed || !canShare(files)) return download(files);
    navigator.share({ files, title: `${row.title} · ${when(row.rec.meta.createdAt)}` }).catch((err: DOMException) => {
      if (err.name === 'AbortError') return;
      setShareFailed(true);
      setNote(`Sharing failed (${err.name}). The buttons now download the files instead.`);
    });
  };

  const remove = async (row: Row) => {
    if (confirm !== row.rec.meta.id) return setConfirm(row.rec.meta.id);
    setConfirm(null);
    const before = storage;
    try {
      await deleteRecording(row.rec.meta.id);
    } catch (err) {
      return setNote(`Could not delete (${(err as Error).name}).`);
    }
    const after = await load();
    setNote(`Deleted ${row.title}. Storage used ${bytes(before?.usage)} → ${bytes(after.usage)}.`);
  };

  if (studio)
    return (
      <Studio
        rec={studio.rec}
        title={studio.title}
        onClose={() => {
          setStudio(null);
          void load();
        }}
      />
    );

  return (
    <main className="pad-safe-x flex h-full flex-col gap-2 overflow-y-auto py-2">
      <header className="flex min-h-12 items-center justify-between gap-3">
        <span className="flex items-center gap-2">
          <button className="btn btn-ghost min-h-10 px-3" onClick={onBack} aria-label="Back">
            ‹
          </button>
          <h1 className="text-lg font-bold">Recordings</h1>
        </span>
        <span className="text-sm text-mut" data-testid="usage">
          storage {usage(storage)}
          {storage?.persisted === false && <span className="text-amber"> · not persisted: export soon</span>}
        </span>
      </header>
      {note && (
        <div className="rounded-lg border border-line bg-pan px-3 py-2 text-sm" role="status">
          {note}
        </div>
      )}
      {rows == null ? (
        <p className="text-mut">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-mut">No recordings on this phone.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => {
            const { meta } = row.rec;
            const shareable = !shareFailed && canShare([...row.videos, row.json]);
            return (
              <li key={meta.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-line bg-pan px-3 py-2" data-testid="recording-row">
                <span className="w-28 text-sm text-mut">{when(meta.createdAt)}</span>
                <span className="min-w-0 flex-1">
                  <b>{row.title}</b> <span className="text-mut">{row.result}</span>
                  <br />
                  <span className="text-sm text-mut">
                    {elapsed(row.durationMs)} · {bytes(row.size)}
                    {meta.segments.length > 1 && ` · ${meta.segments.length} segments`}
                    {meta.segments.some((s) => s.endReason === 'error' || s.endReason === 'interrupted') && ' · interrupted'}
                  </span>
                </span>
                <span className="flex gap-2">
                  <button className="btn btn-pri" onClick={() => share(row, [...row.videos, row.json])} data-testid="share">
                    {shareable ? 'Share' : 'Download'}
                  </button>
                  {shareable && (
                    // The clip alone, in case the sheet offers "Save Video" only for media (assumption A5).
                    <button className="btn" onClick={() => share(row, row.videos)}>
                      Clip only
                    </button>
                  )}
                  {row.bundle.config && row.rec.log && (
                    // D16: watch the match, give any point a replay and adjust it, tag while watching (Studio).
                    <button className="btn" onClick={() => setStudio(row)} data-testid="studio-open">
                      Studio
                    </button>
                  )}
                  {row.bundle.config && (
                    // D16: the video made after the match, with the ★ points replayed (RenderSheet).
                    <button className="btn" onClick={() => setRendering(row)} data-testid="replays-video">
                      Replays video{row.bundle.replays?.length ? ` (${row.bundle.replays.length})` : ''}
                    </button>
                  )}
                  <button className={`btn ${confirm === meta.id ? 'bg-red/40' : 'btn-ghost'}`} onClick={() => void remove(row)} data-testid="delete">
                    {confirm === meta.id ? 'Tap again to delete' : 'Delete'}
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-auto text-sm text-mut">
        Share sends the finished clip and match.json to Photos, AirDrop or Files. Delete asks once.
      </p>
      {rendering && <RenderSheet rec={rendering.rec} bundle={rendering.bundle} title={rendering.title} onClose={() => setRendering(null)} />}
    </main>
  );
}
