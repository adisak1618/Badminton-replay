// "☆ Replay" (D16, ux-design.md S3d): marks the point for a slow replay in the video made after the match. One tap
// marks it, another takes the mark back; it never scores. Shown beside "↶ Undo point" above the why-was-this-point-won
// popup, on its own for a few seconds after a point when no popup opens, and as the star in the rally list.

export function ReplayPill({ on, onToggle, label, testid }: { on: boolean; onToggle: () => void; label?: string; testid: string }) {
  return (
    <button
      className={`btn min-h-10 rounded-full border px-4 text-sm shadow-[0_2px_12px_rgb(0_0_0/0.6)] ${on ? 'border-amber/70 bg-amber/15 font-semibold text-amber' : 'border-line bg-btn'}`}
      aria-pressed={on}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      data-testid={testid}
    >
      {on ? '★ Replay ✓' : '☆ Replay'}
      {label && <span className="ml-1.5 font-normal text-mut">{label}</span>}
    </button>
  );
}

/** The rally list's star: the same mark, one per row. */
export function ReplayStar({ on, onToggle, n }: { on: boolean; onToggle: () => void; n: number }) {
  return (
    <button
      className={`btn btn-ghost min-h-9 w-9 shrink-0 px-0 text-[20px] leading-none ${on ? 'text-amber' : 'text-mut'}`}
      aria-pressed={on}
      aria-label={on ? `Point ${n} has a replay: take it off` : `Give point ${n} a replay`}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      data-testid={`rally-${n}-replay`}
    >
      {on ? '★' : '☆'}
    </button>
  );
}
