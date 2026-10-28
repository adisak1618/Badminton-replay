// S0 role choice (R-SETUP-1), with the way to C4 on a phone that holds recordings.
import { useEffect, useState } from 'react';
import { checkSupport } from '../device/support';
import { countRecordings } from '../recording/storage';
import type { Role } from '../match/prefs';

export function UpdateBanner({ onUpdate }: { onUpdate: (() => void) | null }) {
  if (!onUpdate) return null;
  return (
    <div className="flex items-center gap-3 rounded-xl border border-line bg-pan px-3 py-2 text-sm">
      <span className="flex-1">A new version of the app is ready.</span>
      <button className="btn btn-pri" onClick={onUpdate}>
        Update now
      </button>
    </div>
  );
}

export function RoleScreen({
  lastRole,
  onPick,
  onRecordings,
  onUpdate,
}: {
  lastRole: Role | null;
  onPick: (r: Role) => void;
  onRecordings: () => void;
  onUpdate: (() => void) | null;
}) {
  const [support] = useState(() => checkSupport());
  const [recordings, setRecordings] = useState(0);
  useEffect(() => {
    void countRecordings().then(setRecordings);
  }, []);
  const roles: Array<{ role: Role; title: string; sub: string }> = [
    { role: 'scoreboard', title: 'SCOREBOARD', sub: 'at the net post' },
    { role: 'camera', title: 'CAMERA', sub: 'at the back corner' },
  ];
  const highlight = lastRole ?? 'scoreboard';
  return (
    <main className="pad-safe-x flex h-full flex-col gap-3 overflow-y-auto pt-[max(12px,env(safe-area-inset-top))] pb-[max(12px,env(safe-area-inset-bottom))]">
      <h1 className="text-center text-lg font-semibold text-mut">Badminton scoreboard</h1>
      <UpdateBanner onUpdate={onUpdate} />
      {/* Portrait: cards stacked full width, about a third of the screen each. Landscape: side by side. */}
      <div className="flex min-h-40 flex-1 gap-4 portrait:flex-col portrait:justify-center">
        {roles.map((r) => (
          <button
            key={r.role}
            onClick={() => onPick(r.role)}
            className={`flex min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-2xl border-2 px-4 py-3 text-center portrait:max-h-[32dvh] portrait:min-h-28 ${
              highlight === r.role ? 'border-pri bg-pri/15' : 'border-line bg-pan'
            }`}
          >
            <span className="text-[min(1.875rem,8vw)] leading-tight font-extrabold tracking-wide">{r.title}</span>
            <span className="text-mut">{r.sub}</span>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm text-mut">
        <span>Last time: {lastRole === 'camera' ? 'Camera' : lastRole === 'scoreboard' ? 'Scoreboard' : '-'}</span>
        {support.message && <span className="text-amber">{support.message}</span>}
        {support.ios && !support.standalone && (
          <span>Tip: Share, then "Add to Home Screen" so it runs offline and keeps the screen on.</span>
        )}
        {recordings > 0 && (
          <button className="btn btn-ghost ml-auto min-h-10 text-sm" onClick={onRecordings}>
            Recordings ({recordings}) ›
          </button>
        )}
      </div>
    </main>
  );
}
