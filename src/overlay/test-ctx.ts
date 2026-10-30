// A recording stand-in for CanvasRenderingContext2D in the overlay tests: every drawing call with its arguments and
// the state it was made in (fill, stroke, font, alignment, alpha). Text is `em` em per character, so a test can run
// the same draw with a wider font than the one that measured the box. Two identical call lists are identical pixels.
export interface Call {
  op: string;
  args: unknown[];
  fill: string;
  stroke: string;
  font: string;
  align: string;
  alpha: number;
}

const OPS = ['save', 'restore', 'beginPath', 'moveTo', 'lineTo', 'arc', 'arcTo', 'closePath', 'rect', 'fill', 'stroke', 'clip', 'fillRect', 'fillText', 'drawImage'];

export function fakeCtx(em = 0.6) {
  const calls: Call[] = [];
  const style = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
  const ctx = {
    fillStyle: '' as unknown,
    strokeStyle: '' as unknown,
    lineWidth: 1,
    globalAlpha: 1,
    font: '10px x',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    measureText(t: string) {
      const px = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? 10);
      return { width: t.length * px * em };
    },
    createLinearGradient(...args: number[]) {
      const stops: Array<[number, string]> = [];
      return { gradient: args, stops, addColorStop: (o: number, c: string) => void stops.push([o, c]) };
    },
  } as Record<string, unknown> & { fillStyle: unknown; strokeStyle: unknown; font: string; textAlign: string; globalAlpha: number };
  for (const op of OPS)
    ctx[op] = (...args: unknown[]) =>
      calls.push({ op, args, fill: style(ctx.fillStyle), stroke: style(ctx.strokeStyle), font: ctx.font, align: ctx.textAlign, alpha: ctx.globalAlpha });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

/** The words drawn, in order. */
export const words = (calls: readonly Call[]): string[] => calls.filter((c) => c.op === 'fillText').map((c) => String(c.args[0]));

/** Left and right ends of a fillText call, from the fake 0.6 em (or `em`) metric. */
export function textSpan(c: Call, em = 0.6): [number, number] {
  const [s, x] = c.args as [string, number];
  const w = s.length * Number(/(\d+(?:\.\d+)?)px/.exec(c.font)![1]) * em;
  return c.align === 'center' ? [x - w / 2, x + w / 2] : c.align === 'right' ? [x - w, x] : [x, x + w];
}
