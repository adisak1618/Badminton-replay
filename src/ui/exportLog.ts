// The scoreboard's own match.json (R-EXP-1): the match this phone shows, with the stats when it asked why points
// were won (D15), through the share sheet, else downloaded (R-EXP-2). Called from the tap that asked for it. A match
// scored from a saved video (D17) exports through the recording's path with that file as its one segment, so every
// event has its place on the file (`tRec`); the video itself is never copied.
import { APP_BUILD } from '../build';
import type { MatchConfig, MatchEvent } from '../engine';
import { deviceId } from '../match/prefs';
import { buildBundle, buildLogBundle, bundleName, type MatchBundle } from '../recording/bundle';
import { importedLog, importedMeta, type VideoSource } from '../video/source';

type Exported = { matchId: string; config: MatchConfig; events: MatchEvent[]; createdAt: number; video?: VideoSource };

export function matchBundle(m: Exported, scoreboard: { id: string; ua: string }, app: string, now: number): MatchBundle {
  if (m.video)
    return buildBundle({ meta: importedMeta({ ...m, video: m.video }, scoreboard), log: importedLog(m), app, now, imported: { tapOffsetMs: m.video.tapOffsetMs } });
  return buildLogBundle({ matchId: m.matchId, config: m.config, events: m.events, scoreboard, app, now });
}

export async function exportLog(m: Exported): Promise<void> {
  const bundle = matchBundle(m, { id: deviceId(), ua: navigator.userAgent }, APP_BUILD, Date.now());
  const file = new File([JSON.stringify(bundle, null, 1)], `${bundleName(m.createdAt)}-match.json`, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: `${m.config.teams.A.name} vs ${m.config.teams.B.name}` });
      return;
    } catch (err) {
      if ((err as Error).name === 'AbortError') return; // the user closed the sheet
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
