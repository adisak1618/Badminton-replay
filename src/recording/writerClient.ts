// Main-thread side of the recording worker: requests with ids, replies matched back. Appends are posted
// without waiting (the buffer is transferred, not copied); a failed append is reported once via onFailure.
import { NOT_OPEN, type WriterBody, type WriterReply } from './writer';

type Port = Pick<Worker, 'postMessage'> & { onmessage: ((e: MessageEvent<WriterReply>) => void) | null };

export class WriterClient {
  private nextId = 1;
  private pending = new Map<number, (r: WriterReply) => void>();
  /** Bytes in the open video file, as the worker last reported. */
  bytes = 0;
  onFailure: (r: WriterReply & { ok: false }) => void = () => {};
  onBytes: (bytes: number) => void = () => {};

  constructor(private readonly port: Port) {
    port.onmessage = (e) => this.reply(e.data);
  }

  private reply(r: WriterReply): void {
    if (r.op === 'append' || r.op === 'open' || r.op === 'close') {
      this.bytes = r.bytes;
      this.onBytes(r.bytes);
    }
    if (!r.ok && r.op === 'append' && r.error !== NOT_OPEN) this.onFailure(r);
    const done = this.pending.get(r.id);
    this.pending.delete(r.id);
    done?.(r);
  }

  private send(body: WriterBody, transfer: Transferable[] = []): Promise<WriterReply> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.port.postMessage({ ...body, id }, transfer);
    });
  }

  open(dir: string[], file: string): Promise<WriterReply> {
    this.bytes = 0;
    return this.send({ op: 'open', dir, file });
  }

  append(buf: ArrayBuffer): Promise<WriterReply> {
    return this.send({ op: 'append', buf }, [buf]);
  }

  close(): Promise<WriterReply> {
    return this.send({ op: 'close' });
  }

  put(dir: string[], file: string, text: string): Promise<WriterReply> {
    return this.send({ op: 'put', dir, file, text });
  }
}
