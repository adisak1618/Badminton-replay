// Why was this point won (D15, ux-design.md S3d): design B as the captain approved it. The point is already
// counted; this only tags it. Step 1 asks who hit the last shot, names grouped by side with serve and receive
// badges; a name on the side that won the point saves a winner at once, a name on the side that lost asks
// forced or unforced. Then the optional extras (shot, assist, forced by) stay EXTRAS_MS with a Skip button.
// Every choice is saved the moment it is made (a chip appends a newer tag), so closing never loses one.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { SHOTS, other, sameRef, type MatchConfig, type PlayerRef, type Rally, type Shot, type TagBody, type Team } from '../../engine';
import { ReplayPill } from '../ReplayPill';
import { useNow } from '../useNow';
import { HOW_LABEL, SHOT_LABEL, nameOf, tagText } from './labels';

/** How long the optional extras stay after a choice: the captain's 10 s (from 3 s), with Skip to close at once. */
export const EXTRAS_MS = 10_000;

type Stage = { k: 'who' } | { k: 'kind'; hit: PlayerRef } | { k: 'extra' };

export function TagSheet({
  config,
  rally,
  leftTeam,
  live,
  closeAfterMs,
  onTag,
  onClear,
  onClose,
  onUndo,
  next,
  initialHit,
  replay,
}: {
  config: MatchConfig;
  rally: Rally;
  /** The team on the left of the screen: its names sit on the left. */
  leftTeam: Team;
  /** Right after the tap (closes by itself) rather than from the rally list. */
  live: boolean;
  /** Live and untagged: close after this long; 0 = never. */
  closeAfterMs: number;
  onTag: (t: TagBody) => void;
  onClear: () => void;
  onClose: (reason: 'done' | 'later' | 'timeout' | 'outside') => void;
  /** Live only: take the point back (Undo stays one tap away). */
  onUndo?: () => void;
  /** The rally list's "next untagged": shown once this one is tagged. */
  next?: (() => void) | null;
  /** A name already tapped in the rally list: step 1 is done. */
  initialHit?: PlayerRef;
  /** D16, right after the tap: "☆ Replay" beside "↶ Undo point" marks this point for a replay. */
  replay?: { on: boolean; onToggle: () => void };
}) {
  const [stage, setStage] = useState<Stage>({ k: 'who' });
  const [deadline, setDeadline] = useState<number | null>(() => (live && closeAfterMs > 0 && !rally.tag ? Date.now() + closeAfterMs : null));
  const [span, setSpan] = useState(closeAfterMs);
  const now = useNow(200, deadline !== null);
  const tag = rally.tag;

  const arm = (ms: number) => {
    setDeadline(Date.now() + ms);
    setSpan(ms);
  };
  // Choices restart the extras window; from the list nothing closes by itself unless something was chosen.
  const save = (t: TagBody) => {
    onTag(t);
    setStage({ k: 'extra' });
    arm(EXTRAS_MS);
  };
  const extras = stage.k === 'extra';
  const closed = useRef(false);
  const close = (reason: Parameters<typeof onClose>[0]) => {
    if (closed.current) return;
    closed.current = true;
    onClose(reason);
  };
  useEffect(() => {
    if (deadline !== null && now >= deadline) close(extras ? 'done' : 'timeout');
  });

  const won = rally.team;
  const lost = other(won);
  const players = (t: Team): PlayerRef[] => config.teams[t].players.map((_, idx) => ({ team: t, idx }));
  const pick = (hit: PlayerRef) => {
    if (hit.team === won) save({ type: 'tag', point: rally.id, how: 'winner', hit });
    else {
      setStage({ k: 'kind', hit });
      if (live && closeAfterMs > 0) arm(closeAfterMs);
    }
  };
  const serveFault = rally.served.team === lost;
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !initialHit) return;
    started.current = true;
    pick(initialHit);
  });

  const left = leftTeam;
  const column = (t: Team) => (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2 text-[13px] font-semibold" style={{ color: config.teams[t].color }}>
        <span className="truncate">
          {config.teams[t].name} {t === won ? 'won the point' : 'lost it'}
        </span>
        <span className="shrink-0 font-normal text-mut">{t === won ? '→ winner · 1 tap' : '→ forced / unforced'}</span>
      </div>
      {players(t).map((r) => (
        <NameButton key={r.idx} config={config} r={r} badge={sameRef(r, rally.served) ? 'serve' : sameRef(r, rally.received) ? 'receive' : null} onPick={() => pick(r)} />
      ))}
    </div>
  );

  let body: ReactNode;
  let title: ReactNode;
  if (stage.k === 'who') {
    title = 'Who hit the last shot?';
    body = (
      <>
        <div className="flex gap-3">
          {column(left)}
          {column(other(left))}
        </div>
        {!tag && (
          // Saved as a tag.clear: the point counts as dealt with, so the summary in the video need not wait for it.
          <div className="flex justify-end">
            <button className="btn btn-ghost min-h-10 px-3 text-sm" onClick={onClear} data-testid="tag-none">
              No tag for this point
            </button>
          </div>
        )}
        {serveFault && (
          <div className="flex justify-end">
            <button
              className="btn min-h-10 rounded-full border border-amber/60 bg-amber/10 px-4 text-[15px] text-amber"
              onClick={() => {
                onTag({ type: 'tag', point: rally.id, how: 'unforced', hit: rally.served, shot: 'serve' });
                close('done');
              }}
              data-testid="tag-serve-fault"
            >
              ⚡ Serve fault · {nameOf(config, rally.served)}
            </button>
          </div>
        )}
      </>
    );
  } else if (stage.k === 'kind') {
    const hit = stage.hit;
    title = `${nameOf(config, hit)}'s error: forced or unforced?`;
    body = (
      <div className="flex gap-3">
        <BigChoice
          testid="tag-forced"
          tone="amber"
          title="Forced"
          note="under pressure: off a smash, kill or fast drive, or stretched"
          onPick={() => save({ type: 'tag', point: rally.id, how: 'forced', hit })}
        />
        <BigChoice
          testid="tag-unforced"
          tone="red"
          title="Unforced"
          note="had time and still missed · when in doubt"
          onPick={() => save({ type: 'tag', point: rally.id, how: 'unforced', hit })}
        />
      </div>
    );
  } else if (tag) {
    const set = (patch: Partial<TagBody>) => save({ ...tag, ...patch });
    const finisher = tag.how === 'winner' ? tag.hit : tag.how === 'forced' ? tag.forcedBy : undefined;
    title = (
      <>
        <span className="text-ok">✓</span> {nameOf(config, tag.hit)} · {HOW_LABEL[tag.how]}
      </>
    );
    body = (
      <>
        <ChipRow label="Shot (optional)">
          {SHOTS.map((s: Shot) => (
            <Chip key={s} on={tag.shot === s} onClick={() => set({ shot: tag.shot === s ? undefined : s })} testid={`tag-shot-${s}`}>
              {SHOT_LABEL[s]}
            </Chip>
          ))}
        </ChipRow>
        {tag.how === 'forced' && (
          <ChipRow label="Forced by (optional)">
            {players(won).map((r) => (
              <Chip
                key={r.idx}
                on={sameRef(tag.forcedBy, r)}
                color={config.teams[won].color}
                onClick={() => set({ forcedBy: sameRef(tag.forcedBy, r) ? undefined : r, assist: undefined })}
                testid={`tag-forcedby-${r.idx}`}
              >
                {nameOf(config, r)}
              </Chip>
            ))}
          </ChipRow>
        )}
        {config.doubles && finisher && (
          <ChipRow label="Set up by (assist, optional)">
            <Chip
              on={!!tag.assist}
              color={config.teams[won].color}
              onClick={() => set({ assist: tag.assist ? undefined : { team: finisher.team, idx: 1 - finisher.idx } })}
              testid="tag-assist"
            >
              {tag.assist ? '✓' : '+'} {nameOf(config, { team: finisher.team, idx: 1 - finisher.idx })} set it up
            </Chip>
            <span className="text-[12px] text-mut">played the side’s shot before the last one</span>
          </ChipRow>
        )}
      </>
    );
  }

  const remaining = deadline === null ? null : Math.max(0, deadline - now);
  const touched = !!tag && (tag.shot || tag.assist || tag.forcedBy);
  return (
    <div className="absolute inset-0 z-[35] flex flex-col bg-black/60" onClick={() => close('outside')} data-testid="tag-backdrop">
      {(onUndo || replay) && (
        <div className="flex h-12 shrink-0 items-center justify-center gap-2">
          {onUndo && (
            <button
              className="btn min-h-10 rounded-full border border-line bg-btn px-4 text-sm shadow-[0_2px_12px_rgb(0_0_0/0.6)]"
              onClick={(e) => {
                e.stopPropagation();
                onUndo();
              }}
            >
              ↶ Undo point
            </button>
          )}
          {replay && <ReplayPill on={replay.on} onToggle={replay.onToggle} testid="tag-replay" />}
        </div>
      )}
      <div
        className="sheet slide-up mx-2 mt-auto mb-2 flex min-h-0 flex-col gap-2 overflow-y-auto p-3"
        role="dialog"
        aria-label="Why was this point won"
        onClick={(e) => e.stopPropagation()}
        data-testid="tag-sheet"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 truncate text-[19px] font-bold" data-testid="tag-title">
            {title}
            <span className="ml-2 text-[13px] font-normal text-mut">
              point {rally.n} · {config.teams.A.name} {rally.after.A}–{rally.after.B} {config.teams.B.name}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {remaining !== null && <Ring frac={span ? remaining / span : 0} label={Math.ceil(remaining / 1000)} />}
            {stage.k !== 'who' && (
              <button className="btn btn-ghost min-h-10 px-3 text-sm" onClick={() => setStage({ k: 'who' })}>
                ‹ Back
              </button>
            )}
            {!live && tag && stage.k === 'who' && (
              <button className="btn btn-ghost min-h-10 px-3 text-sm" onClick={onClear} data-testid="tag-clear">
                Clear tag
              </button>
            )}
            {extras ? (
              next && !live ? (
                <button className="btn btn-pri min-h-10 px-4 text-sm" onClick={next} data-testid="tag-next">
                  Next untagged ▸
                </button>
              ) : (
                <button className="btn btn-pri min-h-10 px-4 text-sm" onClick={() => close('done')} data-testid="tag-skip">
                  {touched ? 'Done ✓' : 'Skip ▸'}
                </button>
              )
            ) : (
              <button className="btn min-h-10 px-4 text-sm" onClick={() => close('later')} data-testid="tag-later">
                {live ? 'Later' : 'Close'}
              </button>
            )}
          </div>
        </div>
        {tag && stage.k === 'who' && <div className="text-[13px] text-amber">now: {tagText(config, tag)}</div>}
        {body}
      </div>
    </div>
  );
}

function NameButton({ config, r, badge, onPick }: { config: MatchConfig; r: PlayerRef; badge: 'serve' | 'receive' | null; onPick: () => void }) {
  const color = config.teams[r.team].color;
  return (
    <button
      className="relative flex min-h-14 items-center justify-center rounded-xl border-2 px-3 text-[24px] font-bold text-fg active:brightness-125"
      style={{ borderColor: color, background: `${color}26` }}
      onClick={onPick}
      data-testid={`tag-who-${r.team}${r.idx}`}
    >
      <span className="truncate">{nameOf(config, r)}</span>
      {badge && <span className="absolute top-1 right-2 rounded bg-black/40 px-1.5 text-[11px] font-semibold text-[#e6eaf0]">{badge}</span>}
    </button>
  );
}

function BigChoice({ title, note, tone, onPick, testid }: { title: string; note: string; tone: 'amber' | 'red'; onPick: () => void; testid: string }) {
  return (
    <button
      className={`flex min-h-20 flex-1 flex-col items-center justify-center gap-0.5 rounded-xl border-2 bg-btn px-3 active:brightness-125 ${tone === 'amber' ? 'border-amber' : 'border-red'}`}
      onClick={onPick}
      data-testid={testid}
    >
      <span className="text-[24px] font-bold">{title}</span>
      <span className="text-[12px] text-mut">{note}</span>
    </button>
  );
}

function ChipRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-[12px] text-mut">{label}</span>
      {children}
    </div>
  );
}

function Chip({ on, color, onClick, children, testid }: { on: boolean; color?: string; onClick: () => void; children: ReactNode; testid?: string }) {
  return (
    <button
      className={`min-h-9 rounded-full border px-3 text-[14px] ${on ? 'border-pri bg-pri font-semibold' : 'border-btn bg-pan2'}`}
      style={!on && color ? { borderColor: `${color}99` } : undefined}
      aria-pressed={on}
      onClick={onClick}
      data-testid={testid}
    >
      {children}
    </button>
  );
}

function Ring({ frac, label }: { frac: number; label: number }) {
  const p = Math.round(Math.max(0, Math.min(1, frac)) * 100);
  return (
    <span className="grid size-9 place-items-center rounded-full" style={{ background: `conic-gradient(var(--color-amber) 0 ${p}%, var(--color-btn) 0)` }} aria-label={`${label} s`}>
      <span className="grid size-7 place-items-center rounded-full bg-pan text-[13px] font-bold text-amber tabular-nums">{label}</span>
    </span>
  );
}
