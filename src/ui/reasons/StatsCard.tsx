// The "End of game" card (D15, Q4; ux-design.md S3b/S3c): why points were won, per player and per team, from the
// pure fold over the log, so every scoreboard shows the same. The team line always adds up to the score, untagged
// points included. The longest run, points won on serve and the time need no tagging.
import { useState } from 'react';
import { TEAMS, type MatchConfig, type MatchStats, type Shot, type Stats } from '../../engine';
import { elapsed, playerName } from '../format';
import { SHOT_LABEL } from './labels';

export function StatsCard({ config, stats, game, onList }: { config: MatchConfig; stats: MatchStats; game: number; onList: (() => void) | null }) {
  // 0 = the whole match; match over offers it next to each game.
  const [pick, setPick] = useState(game);
  const st: Stats | undefined = pick === 0 ? stats.match : stats.games.find((g) => g.game === pick);
  if (!st) return null;
  const choices = stats.games.length > 1 || game === 0 ? [...stats.games.map((g) => g.game), 0] : [];
  const cols = config.doubles ? (['W', 'forced', 'A', 'FE', 'UE'] as const) : (['W', 'forced', 'FE', 'UE'] as const);
  const head = { W: 'W', forced: 'Forced', A: 'A', FE: 'FE', UE: 'UE' };
  const untagged = st.rallies - st.tagged;
  return (
    <section className="sheet flex w-[min(430px,100%)] shrink-0 flex-col gap-1.5 p-3 text-left" aria-label="Why points were won" data-testid="stats-card">
      <div className="flex items-baseline justify-between gap-2">
        <b className="text-[15px]">{pick === 0 ? 'Match' : `Game ${pick}`} · why points were won</b>
        <span className="text-[12px] text-mut" data-testid="stats-tagged">
          {st.tagged}/{st.rallies} tagged
        </span>
      </div>
      {choices.length > 0 && (
        <span className="seg self-start" role="group" aria-label="game">
          {choices.map((g) => (
            <button key={g} type="button" className="!min-h-8 !px-2.5 !text-[13px]" aria-pressed={g === pick} onClick={() => setPick(g)}>
              {g === 0 ? 'Match' : `G${g}`}
            </button>
          ))}
        </span>
      )}
      <table className="w-full text-[14px] tabular-nums">
        <thead>
          <tr className="text-[11px] text-mut uppercase">
            <th className="text-left font-semibold">Player</th>
            {cols.map((c) => (
              <th key={c} className="text-right font-semibold">
                {head[c]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {TEAMS.flatMap((t) =>
            st.players[t].map((p, i) => (
              <tr key={`${t}${i}`} data-testid={`stats-${t}${i}`}>
                <td className="max-w-28 truncate font-semibold" style={{ color: config.teams[t].color }}>
                  {playerName(config, t, i)}
                </td>
                {cols.map((c) => (
                  <td key={c} className="text-right">
                    {p[c]}
                  </td>
                ))}
              </tr>
            )),
          )}
        </tbody>
      </table>
      <div className="text-[11px] text-mut">
        W winners · Forced errors they forced{config.doubles ? ' · A assists' : ''} · FE forced errors · UE unforced errors
      </div>
      {TEAMS.map((t) => {
        const x = st.teams[t];
        const shots = Object.entries(st.winnersByShot[t]) as Array<[Shot, number]>;
        return (
          <div key={t} className="text-[12.5px] leading-snug" data-testid={`stats-team-${t}`}>
            <b style={{ color: config.teams[t].color }}>{config.teams[t].name}</b> {x.won} = {x.winners} winner{x.winners === 1 ? '' : 's'} + {x.oppForced} forced + {x.oppUnforced} unforced
            {x.untagged ? ` + ${x.untagged} untagged` : ''}
            {shots.length > 0 && <span className="text-mut"> · {shots.map(([s, n]) => `${SHOT_LABEL[s].toLowerCase()} ${n}`).join(', ')}</span>}
          </div>
        );
      })}
      <div className="text-[12px] text-mut">
        Longest run {config.teams.A.name} {st.longestRun.A} · {config.teams.B.name} {st.longestRun.B} · won on serve {st.wonOnServe.A}–{st.wonOnServe.B}
        {st.durationMs > 0 && ` · ${elapsed(st.durationMs)}`}
      </div>
      {onList && (
        <button className="btn btn-ghost min-h-10 text-sm" onClick={onList} data-testid="stats-tag-points">
          🏷 {untagged ? `Tag ${untagged} untagged point${untagged === 1 ? '' : 's'}` : 'Rally list'}
        </button>
      )}
    </section>
  );
}
