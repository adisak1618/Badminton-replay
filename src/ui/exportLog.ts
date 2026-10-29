// The scoreboard's own match.json (R-EXP-1): the match this phone shows, with the stats when it asked why points
// were won (D15), through the share sheet, else downloaded (R-EXP-2). Called from the tap that asked for it.
import { APP_BUILD } from '../build';
import type { MatchConfig, MatchEvent } from '../engine';
import { deviceId } from '../match/prefs';
import { buildLogBundle, bundleName } from '../recording/bundle';

export async function exportLog(m: { matchId: string; config: MatchConfig; events: MatchEvent[]; createdAt: number }): Promise<void> {
  const bundle = buildLogBundle({
    matchId: m.matchId,
    config: m.config,
    events: m.events,
    scoreboard: { id: deviceId(), ua: navigator.userAgent },
    app: APP_BUILD,
    now: Date.now(),
  });
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
