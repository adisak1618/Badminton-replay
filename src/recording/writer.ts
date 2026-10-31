// The recording worker's logic (technical-design.md §6.4), kept free of worker globals so it is tested with
// a fake handle: one open video file appended chunk by chunk at a cursor, flushed every 5 s, closed on
// request; small whole-file writes (the JSON records) through their own short-lived handles.
// FileSystemSyncAccessHandle is the only OPFS write path on iOS before Safari 26 and exists only in
// dedicated workers, which also keeps disk I/O off the thread that draws frames.
import { FLUSH_EVERY_MS } from './config';

/** The part of FileSystemSyncAccessHandle the writer uses. */
export interface SyncHandle {
  write(buf: ArrayBuffer | ArrayBufferView, opts?: { at?: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}

export type OpenHandle = (dir: string[], file: string) => Promise<SyncHandle>;

export type WriterRequest =
  | { id: number; op: 'open'; dir: string[]; file: string }
  | { id: number; op: 'append'; buf: ArrayBuffer }
  | { id: number; op: 'close' }
  | { id: number; op: 'put'; dir: string[]; file: string; text: string };

/** A request before the client numbers it. */
export type WriterBody = WriterRequest extends infer R ? (R extends WriterRequest ? Omit<R, 'id'> : never) : never;

export type WriterReply =
  | { id: number; op: WriterRequest['op']; ok: true; bytes: number; flushes: number }
  | { id: number; op: WriterRequest['op']; ok: false; error: string; message: string; bytes: number };

/** Appends after a failure or before an open: the chunk is dropped, the error was reported once already. */
export const NOT_OPEN = 'NotOpen';

export class OpfsWriter {
  private video: SyncHandle | null = null;
  private cursor = 0;
  private lastFlush = 0;
  private flushes = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly open: OpenHandle,
    private readonly now: () => number = () => performance.now(),
    private readonly flushEveryMs = FLUSH_EVERY_MS,
  ) {}

  /** Requests run strictly one after another, so an append sent right after an open waits for it. */
  handle(req: WriterRequest): Promise<WriterReply> {
    const p = this.queue.then(() => this.run(req));
    this.queue = p.catch(() => {});
    return p;
  }

  private ok(req: WriterRequest): WriterReply {
    return { id: req.id, op: req.op, ok: true, bytes: this.cursor, flushes: this.flushes };
  }

  private fail(req: WriterRequest, err: unknown): WriterReply {
    const e = err as { name?: string; message?: string };
    return { id: req.id, op: req.op, ok: false, error: e?.name ?? 'Error', message: e?.message ?? String(err), bytes: this.cursor };
  }

  /** Flush and close the video file, keeping every byte written so far (a clean stop, §6.4). */
  private closeVideo(): void {
    const h = this.video;
    this.video = null;
    if (!h) return;
    try {
      h.flush();
      this.flushes++;
    } finally {
      h.close();
    }
  }

  private async run(req: WriterRequest): Promise<WriterReply> {
    switch (req.op) {
      case 'open':
        try {
          this.closeVideo();
          const h = await this.open(req.dir, req.file);
          h.truncate(0);
          this.video = h;
          this.cursor = 0;
          this.flushes = 0;
          this.lastFlush = this.now();
          return this.ok(req);
        } catch (err) {
          return this.fail(req, err);
        }
      case 'append': {
        if (!this.video) return this.fail(req, { name: NOT_OPEN, message: 'no open file' });
        try {
          // A write may take fewer bytes than given: the rest goes after them, never silently dropped. Chrome's
          // in-memory OPFS (a private window) stops at about 2 GB by returning its "no space" code (-8) as a byte
          // count instead of throwing: any count that cannot be real is a failure.
          const data = new Uint8Array(req.buf);
          for (let done = 0; done < data.byteLength; ) {
            const n = this.video.write(done ? data.subarray(done) : data, { at: this.cursor });
            if (!(n > 0 && n <= data.byteLength - done)) {
              throw Object.assign(new Error(`write returned ${n | 0} after ${done} of ${data.byteLength} bytes`), { name: (n | 0) === -8 ? 'QuotaExceededError' : 'ShortWrite' });
            }
            done += n;
            this.cursor += n;
          }
          const t = this.now();
          if (t - this.lastFlush >= this.flushEveryMs) {
            this.video.flush();
            this.flushes++;
            this.lastFlush = t;
          }
          return this.ok(req);
        } catch (err) {
          // QuotaExceededError (R-REC-3) or any write failure: close cleanly so what is on disk stays playable.
          try {
            this.closeVideo();
          } catch {
            // the handle may already be unusable; the error below is what matters
          }
          return this.fail(req, err);
        }
      }
      case 'close':
        try {
          this.closeVideo();
          return this.ok(req);
        } catch (err) {
          return this.fail(req, err);
        }
      case 'put': {
        let h: SyncHandle | null = null;
        try {
          h = await this.open(req.dir, req.file);
          const data = new TextEncoder().encode(req.text);
          h.truncate(0);
          const n = h.write(data, { at: 0 });
          if (n !== data.byteLength) throw new Error(`short write ${n} of ${data.byteLength}`);
          h.flush();
          return { id: req.id, op: req.op, ok: true, bytes: n, flushes: this.flushes };
        } catch (err) {
          return { ...this.fail(req, err), bytes: 0 };
        } finally {
          h?.close();
        }
      }
    }
  }
}
