// S4 correction (R-SCORE-7): set both scores, games and the server; swap ends and swap courts apply at once.
import { useState } from 'react';
import type { EventBody, MatchConfig, MatchState, Team } from '../engine';
import { playerName } from './format';

/** Most games each team can hold while the match is still running. */
function gamesBound(config: MatchConfig, games: Record<Team, number>, t: Team): number {
  if (config.format === 'fixed1') return 0;
  if (config.format === 'fixed2') return 1 - games[t === 'A' ? 'B' : 'A'];
  return 1;
}

export function CorrectionSheet({
  config,
  s,
  onCancel,
  onEvent,
  onApply,
}: {
  config: MatchConfig;
  s: MatchState;
  onCancel: () => void;
  onEvent: (b: EventBody) => void;
  onApply: (b: EventBody) => void;
}) {
  const [draft, setDraft] = useState(() => ({
    score: { ...s.score },
    games: {
      A: Math.min(s.games.A, gamesBound(config, { A: 0, B: s.games.B }, 'A')),
      B: Math.min(s.games.B, gamesBound(config, { A: s.games.A, B: 0 }, 'B')),
    },
    server: s.server,
    serverIdx: s.serverIdx,
  }));
  const step = (kind: 'score' | 'games', t: Team, label: string) => {
    const v = draft[kind][t];
    const max = kind === 'score' ? config.cap - 1 : gamesBound(config, draft.games, t);
    const set = (n: number) => setDraft({ ...draft, [kind]: { ...draft[kind], [t]: Math.max(0, Math.min(max, n)) } });
    return (
      <span className="flex items-center gap-2">
        <span className="lab min-w-16 text-right">{label}</span>
        <button className="btn w-11 px-0 text-xl" aria-label={`${label} minus`} onClick={() => set(v - 1)} disabled={v <= 0}>
          −
        </button>
        <b className="w-11 text-center text-[28px] tabular-nums" data-testid={`correct-${kind}-${t}`}>
          {v}
        </b>
        <button className="btn w-11 px-0 text-xl" aria-label={`${label} plus`} onClick={() => set(v + 1)} disabled={v >= max}>
          +
        </button>
      </span>
    );
  };
  const servers: Array<[Team, number]> = config.doubles
    ? [
        ['A', 0],
        ['A', 1],
        ['B', 0],
        ['B', 1],
      ]
    : [
        ['A', 0],
        ['B', 0],
      ];
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/70 p-2">
      <div className="sheet flex max-h-full w-[min(680px,100%)] flex-col gap-2 overflow-y-auto px-4 py-3" role="dialog" aria-label="Correct score">
        <div className="flex items-center">
          <b className="flex-1 text-lg">Correct score</b>
          <button className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {step('score', 'A', config.teams.A.name)}
          {step('score', 'B', config.teams.B.name)}
        </div>
        {config.format !== 'fixed1' && (
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            {step('games', 'A', `games ${config.teams.A.name}`)}
            {step('games', 'B', `games ${config.teams.B.name}`)}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <span className="lab">Server</span>
          <span className="seg" role="group" aria-label="server">
            {servers.map(([t, i]) => (
              <button
                key={`${t}${i}`}
                type="button"
                aria-pressed={draft.server === t && draft.serverIdx === i}
                onClick={() => setDraft({ ...draft, server: t, serverIdx: i })}
              >
                {config.doubles ? playerName(config, t, i) : config.teams[t].name}
              </button>
            ))}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn btn-ghost" onClick={() => onEvent({ type: 'sides.swap' })}>
            Swap ends
          </button>
          {config.doubles &&
            (['A', 'B'] as const).map((t) => (
              <button key={t} className="btn btn-ghost" onClick={() => onEvent({ type: 'courts.swap', team: t })}>
                Swap courts: {config.teams[t].name}
              </button>
            ))}
          <span className="lab flex-1">Swaps apply at once.</span>
          <button
            className="btn btn-pri px-6"
            onClick={() =>
              onApply({ type: 'correct', score: draft.score, games: draft.games, server: draft.server, serverIdx: draft.serverIdx })
            }
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
