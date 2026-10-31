// Where a render keeps its parts, its job state and the finished files on the camera phone: OPFS, next to the
// recording (matches/<id>/render/). Writes go through the recording worker's sync access handle (the only OPFS write
// path on iOS before Safari 26, recording/writer.ts); reads, removals and the free space from the main thread.
import { MATCHES_DIR } from '../recording/meta';
import { WriterClient } from '../recording/writerClient';
import type { JobState, RenderStore } from './job';

export const RENDER_DIR = 'render';
const JOB_FILE = 'job.json';
const WRITE_PIECE = 4 << 20;

async function renderDir(id: string, create: boolean): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const m = await root.getDirectoryHandle(MATCHES_DIR, { create });
    const d = await m.getDirectoryHandle(id, { create });
    return await d.getDirectoryHandle(RENDER_DIR, { create });
  } catch {
    return null;
  }
}

export class OpfsRenderStore implements RenderStore {
  private worker: Worker | null = null;
  private client: WriterClient | null = null;

  constructor(private readonly id: string) {}

  private writer(): WriterClient {
    if (!this.client) {
      this.worker = new Worker(new URL('../recording/opfs.worker.ts', import.meta.url), { type: 'module' });
      this.client = new WriterClient(this.worker);
    }
    return this.client;
  }

  private get dir(): string[] {
    return [MATCHES_DIR, this.id, RENDER_DIR];
  }

  async readJob(): Promise<JobState | null> {
    const f = await this.read(JOB_FILE);
    if (!f) return null;
    try {
      return JSON.parse(await f.text()) as JobState;
    } catch {
      return null;
    }
  }

  async writeJob(job: JobState): Promise<void> {
    const r = await this.writer().put(this.dir, JOB_FILE, JSON.stringify(job));
    if (!r.ok) throw new Error(`could not save the render's progress (${r.error})`);
  }

  async open(name: string) {
    const w = this.writer();
    const r = await w.open(this.dir, name);
    if (!r.ok) throw new Error(`could not open ${name} (${r.error})`);
    return {
      // A fragment can be many MB (the muxer's last one): sent in pieces, so no one message or write is huge.
      write: async (data: Uint8Array) => {
        for (let i = 0; i < data.byteLength; i += WRITE_PIECE) {
          const a = await w.append(data.slice(i, i + WRITE_PIECE).buffer);
          if (!a.ok) throw new Error(a.error === 'QuotaExceededError' ? 'storage is full' : `writing failed (${a.error})`);
        }
      },
      close: async () => {
        await w.close();
      },
    };
  }

  async read(name: string): Promise<Blob | null> {
    const d = await renderDir(this.id, false);
    try {
      return d ? await (await d.getFileHandle(name)).getFile() : null;
    } catch {
      return null;
    }
  }

  async remove(name: string): Promise<void> {
    const d = await renderDir(this.id, false);
    await d?.removeEntry(name).catch(() => {});
  }

  async free(): Promise<number | null> {
    const e = await navigator.storage?.estimate?.().catch(() => null);
    return e?.quota != null && e.usage != null ? e.quota - e.usage : null;
  }

  /** Every file of the render, the job state included. */
  async clear(): Promise<void> {
    const root = await renderDir(this.id, false);
    if (!root) return;
    const m = await (await navigator.storage.getDirectory()).getDirectoryHandle(MATCHES_DIR);
    await (await m.getDirectoryHandle(this.id)).removeEntry(RENDER_DIR, { recursive: true }).catch(() => {});
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = this.client = null;
  }
}
