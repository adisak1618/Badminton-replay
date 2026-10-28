import { describe, expect, it } from 'vitest';
import { NOT_OPEN, OpfsWriter, type SyncHandle, type WriterBody, type WriterRequest } from './writer';
import { WriterClient } from './writerClient';

/** A fake FileSystemSyncAccessHandle backed by a byte array, logging every call. */
class FakeHandle implements SyncHandle {
  data = new Uint8Array(0);
  log: string[] = [];
  closed = false;
  failAfterBytes = Infinity;
  write(buf: ArrayBuffer | ArrayBufferView, opts: { at?: number } = {}): number {
    if (this.closed) throw Object.assign(new Error('closed'), { name: 'InvalidStateError' });
    const b = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const at = opts.at ?? 0;
    if (at + b.byteLength > this.failAfterBytes) {
      this.log.push(`write@${at} quota`);
      throw Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
    }
    const next = new Uint8Array(Math.max(this.data.length, at + b.byteLength));
    next.set(this.data);
    next.set(b, at);
    this.data = next;
    this.log.push(`write@${at}+${b.byteLength}`);
    return b.byteLength;
  }
  truncate(n: number) {
    this.data = this.data.slice(0, n);
    this.log.push(`truncate ${n}`);
  }
  flush() {
    this.log.push('flush');
  }
  close() {
    this.closed = true;
    this.log.push('close');
  }
}

function rig(opts: { failAfterBytes?: number } = {}) {
  let t = 0;
  const files = new Map<string, FakeHandle>();
  const opens: string[] = [];
  const writer = new OpfsWriter(
    async (dir, file) => {
      await new Promise((r) => setTimeout(r, 1)); // opening is asynchronous in the real worker
      const key = [...dir, file].join('/');
      opens.push(key);
      const h = files.get(key) ?? new FakeHandle();
      h.closed = false;
      h.failAfterBytes = opts.failAfterBytes ?? Infinity;
      files.set(key, h);
      return h;
    },
    () => t,
    5000,
  );
  let id = 0;
  const send = (r: WriterBody) => writer.handle({ ...r, id: ++id } as WriterRequest);
  const chunk = (n: number, fill: number) => new Uint8Array(n).fill(fill).buffer;
  return { writer, files, opens, send, chunk, tick: (ms: number) => (t += ms) };
}

describe('OPFS recording worker (technical-design.md §6.4)', () => {
  it('appends chunks in order at the cursor, even when sent before the open finished', async () => {
    const r = rig();
    const replies = await Promise.all([
      r.send({ op: 'open', dir: ['matches', 'm1'], file: 'video-1.mp4' }),
      r.send({ op: 'append', buf: r.chunk(3, 1) }),
      r.send({ op: 'append', buf: r.chunk(2, 2) }),
      r.send({ op: 'append', buf: r.chunk(4, 3) }),
      r.send({ op: 'close' }),
    ]);
    expect(replies.map((x) => x.ok)).toEqual([true, true, true, true, true]);
    expect(replies.map((x) => x.bytes)).toEqual([0, 3, 5, 9, 9]);
    const h = r.files.get('matches/m1/video-1.mp4')!;
    expect([...h.data]).toEqual([1, 1, 1, 2, 2, 3, 3, 3, 3]);
    expect(h.log).toEqual(['truncate 0', 'write@0+3', 'write@3+2', 'write@5+4', 'flush', 'close']);
  });

  it('flushes every 5 s of appends, and once more on close', async () => {
    const r = rig();
    await r.send({ op: 'open', dir: ['m'], file: 'v.mp4' });
    for (let i = 0; i < 12; i++) {
      r.tick(1000); // one MediaRecorder chunk per second (R-REC-2)
      await r.send({ op: 'append', buf: r.chunk(10, i) });
    }
    const h = r.files.get('m/v.mp4')!;
    const flushAt = h.log.flatMap((l, i) => (l === 'flush' ? [h.log.slice(0, i).filter((x) => x.startsWith('write')).length] : []));
    expect(flushAt).toEqual([5, 10]); // after the 5th and the 10th second
    const closed = await r.send({ op: 'close' });
    expect(closed).toMatchObject({ ok: true, bytes: 120, flushes: 3 });
    expect(h.log.slice(-2)).toEqual(['flush', 'close']);
  });

  it('on QuotaExceededError closes the file cleanly, keeps what was written, and drops later chunks', async () => {
    const r = rig({ failAfterBytes: 25 });
    await r.send({ op: 'open', dir: ['m'], file: 'v.mp4' });
    const a = await r.send({ op: 'append', buf: r.chunk(10, 1) });
    const b = await r.send({ op: 'append', buf: r.chunk(10, 2) });
    const c = await r.send({ op: 'append', buf: r.chunk(10, 3) });
    expect([a.ok, b.ok]).toEqual([true, true]);
    expect(c).toMatchObject({ ok: false, error: 'QuotaExceededError', bytes: 20 });
    const h = r.files.get('m/v.mp4')!;
    expect(h.data.length).toBe(20);
    expect(h.log.slice(-3)).toEqual(['write@20 quota', 'flush', 'close']);
    const d = await r.send({ op: 'append', buf: r.chunk(10, 4) });
    expect(d).toMatchObject({ ok: false, error: NOT_OPEN, bytes: 20 });
    expect(await r.send({ op: 'close' })).toMatchObject({ ok: true, bytes: 20 });
  });

  it('writes a whole JSON record through its own handle, replacing the old content', async () => {
    const r = rig();
    await r.send({ op: 'open', dir: ['m'], file: 'v.mp4' });
    await r.send({ op: 'put', dir: ['m'], file: 'recording.json', text: '{"a":"long old content"}' });
    const p = await r.send({ op: 'put', dir: ['m'], file: 'recording.json', text: '{"b":1}' });
    expect(p).toMatchObject({ ok: true, bytes: 7 });
    const j = r.files.get('m/recording.json')!;
    expect(new TextDecoder().decode(j.data)).toBe('{"b":1}');
    expect(j.log.slice(-4)).toEqual(['truncate 0', 'write@0+7', 'flush', 'close']);
    // The video file is untouched and still open.
    expect((await r.send({ op: 'append', buf: r.chunk(1, 9) })).ok).toBe(true);
  });

  it('reports an open failure (no OPFS, private browsing) as an error reply', async () => {
    const w = new OpfsWriter(async () => {
      throw Object.assign(new Error('Security error'), { name: 'SecurityError' });
    });
    expect(await w.handle({ id: 1, op: 'open', dir: [], file: 'x' })).toMatchObject({ ok: false, error: 'SecurityError' });
    expect(await w.handle({ id: 2, op: 'append', buf: new ArrayBuffer(1) })).toMatchObject({ ok: false, error: NOT_OPEN });
  });
});

describe('WriterClient', () => {
  it('matches replies by id, tracks bytes and reports a failed append once', async () => {
    const r = rig({ failAfterBytes: 15 });
    const port = {
      onmessage: null as ((e: MessageEvent) => void) | null,
      postMessage(msg: WriterRequest) {
        void r.writer.handle(msg).then((reply) => port.onmessage?.({ data: reply } as MessageEvent));
      },
    };
    const client = new WriterClient(port as never);
    const failures: string[] = [];
    client.onFailure = (f) => failures.push(f.error);
    expect((await client.open(['m'], 'v.mp4')).ok).toBe(true);
    void client.append(r.chunk(10, 1));
    void client.append(r.chunk(10, 2));
    void client.append(r.chunk(10, 3));
    const closed = await client.close();
    expect(closed.bytes).toBe(10);
    expect(client.bytes).toBe(10);
    expect(failures).toEqual(['QuotaExceededError']);
  });
});
