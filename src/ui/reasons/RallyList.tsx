// Tag later (D15, ux-design.md S3e): every counted rally of the match, newest at the bottom, from the top-bar
// chip, the interval, game over, match over or the menu. An untagged row has the names inline (a name opens the
// popup's second step for it); a tagged one opens the popup to change or clear it. Each row's star gives that point a
// replay in the video made after the match (D16), also when the match does not ask why. Nothing here scores.
import { useEffect, useRef } from 'react';
import { other, type MatchConfig, type PlayerRef, type Rally, type Team } from '../../engine';
import { ReplayStar } from '../ReplayPill';
import { nameOf, tagText } from './labels';

export function RallyList({
  config,
  rallies,
  leftTeam,
  onOpen,
  onStep,
  onClose,
  reasons,
  onReplay,
}: {
  config: MatchConfig;
  rallies: readonly Rally[];
  leftTeam: Team;
  /** The match asks why each point was won (D15): rows show their tag or the names to tag it. */
  reasons: boolean;
  /** D16: mark or unmark this point for a replay. */
  onReplay: (r: Rally) => void;
  /** Open the popup for this rally, with a name already picked when one was tapped in the row. */
  onOpen: (r: Rally, hit?: PlayerRef) => void;
  /** Walk through the untagged ones in the popup. */
  onStep: (() => void) | null;
  onClose: () => void;
}) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' }); // newer browsers return a promise: never the effect's cleanup
  }, []);
  const untagged = reasons ? rallies.filter((r) => !r.tag).length : 0;
  const replays = rallies.filter((r) => r.replay).length;
  const sides = [leftTeam, other(leftTeam)];
  let game = 0;
  return (
    <div className="absolute inset-0 z-[33] flex items-stretch justify-center bg-black/70 p-2" onClick={onClose}>
      <div
        className="sheet flex w-[min(820px,100%)] flex-col gap-2 p-3"
        role="dialog"
        aria-label="Rally list"
        onClick={(e) => e.stopPropagation()}
        data-testid="rally-list"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="text-[17px] font-bold">
            Rally list{' '}
            <span className="text-[13px] font-normal text-mut">
              {untagged ? `${untagged} untagged · ` : ''}
              {replays ? `★ ${replays} replay${replays > 1 ? 's' : ''} · ` : '☆ = replay in the video · '}nothing here scores
            </span>
          </div>
          <div className="flex gap-2">
            {onStep && untagged > 0 && (
              <button className="btn btn-pri min-h-10 px-4 text-sm" onClick={onStep} data-testid="rally-step">
                Tag one by one ▸
              </button>
            )}
            <button className="btn min-h-10 px-4 text-sm" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto [touch-action:pan-y]">
          {rallies.length === 0 && <div className="py-6 text-center text-mut">No points yet.</div>}
          {rallies.map((r) => {
            const head = r.game !== game;
            game = r.game;
            return (
              <div key={r.id} className="contents">
                {head && <div className="pt-1 text-[12px] font-semibold text-mut uppercase">Game {r.game}</div>}
                <div className="flex min-h-11 items-center gap-2 rounded-lg border border-line bg-[#0f141b] px-2.5 py-1 text-[15px]" data-testid={`rally-${r.n}`}>
                  <ReplayStar on={!!r.replay} onToggle={() => onReplay(r)} n={r.n} />
                  <span className="w-9 shrink-0 font-mono text-[13px] text-mut">#{r.n}</span>
                  <span className="w-14 shrink-0 font-bold tabular-nums">
                    {r.after.A}–{r.after.B}
                  </span>
                  <span className="w-20 shrink-0 truncate font-bold" style={{ color: config.teams[r.team].color }}>
                    {config.teams[r.team].name}
                  </span>
                  {!reasons ? (
                    <span className="min-w-0 flex-1" />
                  ) : r.tag ? (
                    <>
                      <span className="min-w-0 flex-1 truncate">{tagText(config, r.tag)}</span>
                      <button className="btn btn-ghost min-h-9 px-3 text-sm" onClick={() => onOpen(r)} aria-label={`Change the tag of point ${r.n}`}>
                        ✎
                      </button>
                    </>
                  ) : (
                    <span className="flex min-w-0 flex-1 flex-wrap justify-end gap-1.5">
                      {sides.flatMap((t) =>
                        config.teams[t].players.map((_, idx) => (
                          <button
                            key={`${t}${idx}`}
                            className="min-h-9 rounded-lg border-2 px-2.5 text-[14px] font-semibold"
                            style={{ borderColor: config.teams[t].color }}
                            onClick={() => onOpen(r, { team: t, idx })}
                            data-testid={`rally-${r.n}-${t}${idx}`}
                          >
                            {nameOf(config, { team: t, idx })}
                          </button>
                        )),
                      )}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
          <div ref={end} />
        </div>
      </div>
    </div>
  );
}
