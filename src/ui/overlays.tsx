// S3a interval, S3b game over / change ends, S3c match over. They cover the tap zones only; the Undo band
// below stays usable.
import { useState, type PointerEvent as ReactPointerEvent } from 'react';
import { other, totalPoints, type MatchConfig, type MatchState, type Team } from '../engine';
import { clock, playerName } from './format';

export function IntervalOverlay({
  config,
  s,
  now,
  onDismiss,
}: {
  config: MatchConfig;
  s: MatchState;
  now: number;
  onDismiss: () => void;
}) {
  const [downId, setDownId] = useState<number | null>(null);
  const L = s.leftTeam;
  const R = other(L);
  const left = (s.phaseSince ?? now) + config.intervalMs.midGame - now;
  // Any tap dismisses it and nothing else; the next tap scores (R-SCORE-4).
  const up = (e: ReactPointerEvent) => {
    if (downId !== e.pointerId) return;
    setDownId(null);
    onDismiss();
  };
  return (
    <div
      className="overlay zone"
      role="dialog"
      aria-label="Interval"
      onPointerDown={(e) => setDownId(e.pointerId)}
      onPointerUp={up}
      onPointerCancel={() => setDownId(null)}
    >
      <div className="text-[44px] font-extrabold">
        INTERVAL <span className="tabular-nums">{clock(left)}</span>
      </div>
      <div className="text-[22px]">
        {config.teams[L].name} {s.score[L]} – {s.score[R]} {config.teams[R].name}
      </div>
      {s.pendingSwap && <div className="text-[22px] font-semibold text-amber">CHANGE ENDS when play resumes</div>}
      <span className="btn btn-pri px-8">Resume</span>
      <div className="text-mut">any tap resumes, nothing is scored</div>
    </div>
  );
}

export function GameOverOverlay({
  config,
  s,
  now,
  onUndo,
  onStart,
}: {
  config: MatchConfig;
  s: MatchState;
  now: number;
  onUndo: () => void;
  onStart: (serverIdx?: number, receiverIdx?: number) => void;
}) {
  const w = s.lastGameWinner as Team;
  const l = other(w);
  const g = s.completed[s.completed.length - 1];
  // Doubles: the winners may pick who serves and the others who receives; defaults are the right-court players.
  const [pick, setPick] = useState({ serve: s.pos[w].right, receive: s.pos[l].right });
  const left = (s.phaseSince ?? now) + config.intervalMs.betweenGames - now;
  const choose = (k: 'serve' | 'receive', team: Team) => (
    <span className="flex items-center gap-2">
      <span className="lab">
        {k === 'serve' ? 'Serves' : 'Receives'} ({config.teams[team].name})
      </span>
      <span className="seg" role="group" aria-label={k === 'serve' ? 'server' : 'receiver'}>
        {[0, 1].map((i) => (
          <button key={i} type="button" aria-pressed={pick[k] === i} onClick={() => setPick({ ...pick, [k]: i })}>
            {playerName(config, team, i)}
          </button>
        ))}
      </span>
    </span>
  );
  return (
    <div className="overlay" role="dialog" aria-label="Game over">
      <div className="text-[40px] leading-tight font-extrabold">
        GAME {s.game} TO {config.teams[w].name} &nbsp;{g[w]} – {g[l]}
      </div>
      <div className="text-[22px]">
        games {config.teams.A.name} {s.games.A} – {s.games.B} {config.teams.B.name}
      </div>
      <div className="text-mut">
        Change ends · {config.teams[w].name} serves first · interval <span className="tabular-nums">{clock(left)}</span>
      </div>
      {s.doubles && (
        <div className="flex flex-wrap justify-center gap-x-6 gap-y-2">
          {choose('serve', w)}
          {choose('receive', l)}
        </div>
      )}
      <div className="flex gap-3">
        <button className="btn btn-ghost" onClick={onUndo}>
          ↶ Undo last point
        </button>
        <button
          className="btn btn-pri px-6"
          onClick={() => (s.doubles ? onStart(pick.serve, pick.receive) : onStart())}
        >
          START GAME {s.game + 1}
        </button>
      </div>
    </div>
  );
}

export function MatchOverOverlay({
  config,
  s,
  start,
  end,
  onUndo,
  onNewMatch,
}: {
  config: MatchConfig;
  s: MatchState;
  start: number;
  end: number;
  onUndo: () => void;
  onNewMatch: () => void;
}) {
  const pts = totalPoints(s.completed);
  const minutes = Math.max(1, Math.round((end - start) / 60_000));
  const title = s.winner
    ? `${config.teams[s.winner].name} WINS ${s.games[s.winner]} – ${s.games[other(s.winner)]}`
    : `DRAW ${s.games.A} – ${s.games.B}`;
  // Ended from the menu mid-game: show the game in progress too.
  const unfinished =
    s.completed.length < s.game && s.score.A + s.score.B > 0 ? `  ·  unfinished ${s.score.A}–${s.score.B}` : '';
  return (
    <div className="overlay" role="dialog" aria-label="Match over">
      <div className="text-[44px] font-extrabold" data-testid="match-result">
        {title}
      </div>
      <div className="text-[22px] tabular-nums">
        {s.completed.map((g) => `${g.A}-${g.B}`).join('   ')}
        {unfinished}
        {!s.winner && s.completed.length > 0 && `  ·  points ${pts.A}–${pts.B}`}
      </div>
      <div className="text-mut">
        {config.teams.A.name} vs {config.teams.B.name} · {minutes} min
      </div>
      <div className="flex gap-3">
        <button className="btn btn-ghost" onClick={onUndo}>
          ↶ Undo
        </button>
        <button className="btn btn-pri px-6" onClick={onNewMatch}>
          New match
        </button>
      </div>
    </div>
  );
}
