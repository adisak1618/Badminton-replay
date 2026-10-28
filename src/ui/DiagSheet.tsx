// ⋯ › Pairing diagnostics: this phone's pairing log (pairing/diag.ts) under a one-line summary to read out,
// with Copy and Share. Nothing leaves the phone unless the user copies or shares it.
import { useState, useSyncExternalStore } from 'react';
import { entryLine } from '../pairing/diag';
import { pairingDiag } from '../pairing/live';
import type { Role } from '../protocol/messages';

function useDiag(role: Role) {
  const diag = pairingDiag(role);
  const snap = useSyncExternalStore(diag.subscribe, diag.getSnapshot);
  return { diag, snap };
}

export function DiagSheet({ role, onClose }: { role: Role; onClose: () => void }) {
  const { diag, snap } = useDiag(role);
  const [note, setNote] = useState<string | null>(null);
  const canShare = typeof navigator.share === 'function';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(diag.report());
      setNote('Copied ✓ Paste it into a message.');
    } catch {
      setNote(canShare ? 'Copy did not work here: use Share.' : 'Copy did not work here: select the log below and copy it.');
    }
  };
  const share = async () => {
    try {
      await navigator.share({ title: 'Pairing diagnostics', text: diag.report() });
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') setNote('Share did not work here: use Copy.');
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-3" onClick={onClose}>
      <div
        className="sheet pad-safe-x flex max-h-full w-[min(720px,100%)] flex-col gap-3 p-3"
        role="dialog"
        aria-label="Pairing diagnostics"
        onClick={(e) => e.stopPropagation()}
      >
        <b className="text-lg">Pairing diagnostics</b>
        <p className="rounded-lg bg-pan2 px-3 py-2 font-semibold break-words" data-testid="diag-summary">
          {diag.summary()}
        </p>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-pri px-6" onClick={() => void copy()}>
            Copy
          </button>
          {canShare && (
            <button className="btn btn-ghost px-6" onClick={() => void share()}>
              Share
            </button>
          )}
          <button className="btn btn-ghost" onClick={() => diag.clear()}>
            Clear
          </button>
          <button className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
        {note && (
          <p className="text-sm" role="status">
            {note}
          </p>
        )}
        <p className="text-sm text-mut">Kept on this phone only; Copy or Share sends it where you choose.</p>
        <pre className="min-h-24 flex-1 overflow-auto rounded-lg bg-black/40 p-2 text-xs break-all whitespace-pre-wrap select-text" data-testid="diag-log">
          {snap.entries.length ? snap.entries.map(entryLine).join('\n') : 'Nothing logged yet.'}
        </pre>
      </div>
    </div>
  );
}

/** The summary as a small chip on the pairing screens; tapping it opens the full log. */
export function DiagChip({ role }: { role: Role }) {
  const { diag } = useDiag(role);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="self-start rounded-lg bg-pan2 px-3 py-1.5 text-left text-xs text-mut"
        onClick={() => setOpen(true)}
        data-testid="diag-chip"
      >
        {diag.summary()} · <u>details</u>
      </button>
      {open && <DiagSheet role={role} onClose={() => setOpen(false)} />}
    </>
  );
}
