// Proof frames for docs/video-stats/ (`pnpm frames`, e2e/frames.ts): real matches built with the engine, the overlay
// model from OverlayClock, the layout and the draw code exactly as the camera runs them, on a 1920x1080 canvas in
// Chrome with the bundled Kanit. It also checks that the font is the one drawing and that a frame depends only on its
// time. Not part of the app: e2e/frames.html imports it through the dev server.
import type { MatchConfig, MatchEvent, PlayerRef, TagBody, Team } from '../engine';
import { doublesConfig, makeConfig, Match } from '../engine/test-utils';
import { DEFAULT_THEME, drawLogo, drawOverlay, panelMaxHeight, panelSize, type Box } from './draw';
import { cardPlace, overlayLayout, panelScale, type Corner } from './layout';
import { OverlayClock, type OverlayModel, type StatsOptions } from './model';
import type { Motion } from './motion';
import { cardShown, drawEndCard, drawStatsTable, endCardSize, statsTableSize } from './table';

const W = 1920;
const H = 1080;

/** A seeded generator, so every run tags the same points the same way. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/**
 * Tag every point of the match so far that is not tagged yet, each half a second after its point, as the scoreboard's
 * popup does live: winners, forced and unforced errors, assists. The log is renumbered (the proof logs have no undo).
 */
function tagAll(m: Match, seed = 7, skip = 0.06): void {
  const r = rng(seed);
  const done = new Set(m.events.filter((e) => e.type === 'tag' || e.type === 'tag.clear').map((e) => (e as { point: string }).point));
  const players = (t: Team) => m.cfg.teams[t].players.length;
  const pick = (t: Team): PlayerRef => ({ team: t, idx: Math.floor(r() * players(t)) });
  const partner = (p: PlayerRef): PlayerRef | undefined => (m.cfg.doubles && r() < 0.35 ? { team: p.team, idx: 1 - p.idx } : undefined);
  const out: MatchEvent[] = [];
  for (const e of m.events) {
    out.push(e);
    if (e.type !== 'point' || done.has(e.id)) continue;
    const x = r();
    if (x < skip) continue;
    const won = e.team;
    const lost: Team = won === 'A' ? 'B' : 'A';
    let body: TagBody;
    if (x < 0.42) {
      const hit = pick(won);
      body = { type: 'tag', point: e.id, how: 'winner', hit, assist: partner(hit) };
    } else if (x < 0.7) {
      const by = pick(won);
      body = { type: 'tag', point: e.id, how: 'forced', hit: pick(lost), forcedBy: by, assist: partner(by) };
    } else body = { type: 'tag', point: e.id, how: 'unforced', hit: pick(lost) };
    out.push({ ...body, seq: 0, id: `${e.id}t`, at: e.at + 500, by: 'proof' } as MatchEvent);
  }
  m.events = out.map((e, i) => ({ ...e, seq: i + 1 }));
}

const on = (cfg: MatchConfig): MatchConfig => ({ ...cfg, reasons: 'endOfGame' });

/** The test log puts events a second apart; a real rally takes longer: spread them out so the card's playing time is real. */
function stretch(m: Match, every = 12_000): Match {
  const t0 = m.events[0].at;
  m.events = m.events.map((e) => ({ ...e, at: t0 + ((e.at - t0) / 1000) * every }));
  return m;
}
const named = (a: [string, string], b: [string, string]) =>
  on(
    doublesConfig({
      teams: {
        A: { name: 'A', color: 0, players: a, startRight: 0 },
        B: { name: 'B', color: 1, players: b, startRight: 0 },
      },
    }),
  );
const singles = (a: string, b: string) =>
  on(
    makeConfig({
      teams: {
        A: { name: a, color: 0, players: ['', ''], startRight: 0 },
        B: { name: b, color: 1, players: ['', ''], startRight: 0 },
      },
    }),
  );

/** A darkened arena behind the overlay, the same in every frame: stands, red boards, a green court. */
function background(ctx: CanvasRenderingContext2D): void {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#070b1f');
  g.addColorStop(0.4, '#0d1540');
  g.addColorStop(1, '#101a3d');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 260; i++) {
    // Opaque, pixel-aligned squares, blended by hand: Chrome can round an anti-aliased or translucent edge of the
    // backdrop one level apart between two draws of the same frame, which the determinism check would count.
    const k = 0.05 + (i % 4) * 0.025;
    const mix = (c: number, base: number) => Math.round(c * k + base * (1 - k));
    ctx.fillStyle = `rgb(${mix(90 + (i % 5) * 20, 10)},${mix(110 + (i % 7) * 10, 16)},${mix(255, 52)})`;
    ctx.fillRect(((i * 977) % 1920) - 6, ((i * 431) % 330) + 14, 12, 12);
  }
  ctx.fillStyle = '#b0001b';
  ctx.fillRect(0, 352, W, 46);
  ctx.fillStyle = '#1b2a6b';
  ctx.fillRect(0, 398, W, H - 398);
  ctx.fillStyle = '#1f8f5f';
  ctx.beginPath();
  ctx.moveTo(560, 410);
  ctx.lineTo(W - 560, 410);
  ctx.lineTo(W - 110, H);
  ctx.lineTo(110, H);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(600, 430);
  ctx.lineTo(W - 600, 430);
  ctx.lineTo(W - 170, H - 30);
  ctx.lineTo(170, H - 30);
  ctx.closePath();
  ctx.moveTo(W / 2, 430);
  ctx.lineTo(W / 2, H - 30);
  ctx.stroke();
  ctx.fillStyle = 'rgba(20,20,20,0.55)';
  ctx.fillRect(360, 580, W - 720, 62);
}

/** The logo slot as the camera draws a logo: an image into its box. */
function logoImage(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 400;
  c.height = 200;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(255,255,255,0.16)';
  g.fillRect(0, 0, 400, 200);
  g.strokeStyle = 'rgba(255,255,255,0.7)';
  g.lineWidth = 6;
  g.setLineDash([18, 14]);
  g.strokeRect(6, 6, 388, 188);
  g.fillStyle = 'rgba(255,255,255,0.8)';
  g.font = `700 64px ${DEFAULT_THEME.font}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('LOGO', 200, 104);
  return c;
}

interface Scene {
  m: Match;
  /** Scoreboard time of the frame; default: just after the last event, every movement settled. */
  now?: number;
  motion?: Motion;
  stats?: StatsOptions;
  stale?: boolean;
  corner?: Corner;
  logo?: Corner | null;
}

/** One frame exactly as the camera composes it (controller.ts feed + compositor.ts draw). */
export function paint(ctx: CanvasRenderingContext2D, sc: Scene): { model: OverlayModel; boxes: { score: Box | null; table: Box | null; card: Box | null } } {
  const now = sc.now ?? sc.m.events[sc.m.events.length - 1].at + 10_000;
  const motion = sc.motion ?? 'full';
  const model = new OverlayClock().at(sc.m.cfg, sc.m.events, now, { delayMs: 0, offsetMs: 0, mirrored: false, stale: !!sc.stale, stats: sc.stats })!;
  const u = panelScale(H, 'medium');
  const corner = sc.corner ?? 'tl';
  const card = cardShown(model.card, now, motion) ? model.card : null;
  const lay = overlayLayout(W, H, {
    scoreCorner: corner,
    score: panelSize(ctx, model, u),
    scoreMaxH: panelMaxHeight(u),
    logo: sc.logo === null ? null : { corner: sc.logo ?? 'tr', size: 'medium', aspect: 2 },
    table: model.table && !card ? { place: 'auto', ...statsTableSize(ctx, model.table, u) } : null,
  });
  const cardBox = card ? cardPlace(W, H, endCardSize(card, u), [lay.score, lay.logo]).box : null;
  background(ctx);
  const clock = { now, motion };
  if (lay.logo) drawLogo(ctx, logoImage(), lay.logo);
  if (lay.score) drawOverlay(ctx, model, lay.score, u, DEFAULT_THEME, { ...clock, bandAbove: corner === 'bl' || corner === 'br' });
  if (model.table && lay.table) drawStatsTable(ctx, model.table, lay.table, u, DEFAULT_THEME, clock);
  if (card && cardBox) drawEndCard(ctx, card, cardBox, DEFAULT_THEME, clock);
  return { model, boxes: { score: lay.score, table: lay.table, card: cardBox } };
}

const TABLE_A: StatsOptions = { table: { team: 'A', opp: true }, card: false };
const CARD: StatsOptions = { table: { team: 'A', opp: true }, card: true };

/** The matches the frames show. */
function matches() {
  const nokPae = () => named(['Nok', 'Pae'], ['Bank', 'Tao']);
  const gamePoint = new Match(nokPae()).scoreTo(21, 17).startGame().scoreTo(18, 20);
  tagAll(gamePoint, 3);
  const matchPoint = new Match(nokPae()).scoreTo(21, 17).startGame().scoreTo(18, 21).startGame().scoreTo(20, 18);
  tagAll(matchPoint, 5);
  const deuce = new Match(nokPae()).scoreTo(21, 17).startGame().scoreTo(20, 20);
  const interval = new Match(nokPae()).scoreTo(21, 17).startGame().scoreTo(10, 8).point('A');
  tagAll(interval, 9);
  const decider = new Match(nokPae()).scoreTo(21, 17).startGame().scoreTo(18, 21).startGame().scoreTo(10, 9).point('A');
  const gameOver = new Match(nokPae()).scoreTo(21, 17);
  tagAll(gameOver, 11, 0.05);
  const matchOver = new Match(nokPae()).scoreTo(21, 17).startGame().scoreTo(18, 21).startGame().scoreTo(22, 20);
  tagAll(matchOver, 13, 0.05);
  const draw = new Match(on(doublesConfig({ format: 'fixed2' }))).scoreTo(21, 17).startGame().scoreTo(15, 21);
  const single = new Match(singles('Kunlavut', 'Antonsen')).scoreTo(7, 5);
  tagAll(single, 17);
  const singleOver = new Match(singles('Kunlavut', 'Antonsen')).scoreTo(21, 15);
  tagAll(singleOver, 19, 0.05);
  const long = new Match(named(['Kititharakul', 'Prajongjai'], ['Puavaranukroh', 'Taerattanachai'])).scoreTo(21, 19).startGame().scoreTo(20, 19);
  tagAll(long, 23);
  const all = { gamePoint, matchPoint, deuce, interval, decider, gameOver, matchOver, draw, single, singleOver, long };
  for (const m of Object.values(all)) stretch(m);
  return all;
}

const lastAt = (m: Match) => m.events[m.events.length - 1].at;
/** Scoreboard time `ms` into the current interval or break. */
const into = (m: Match, ms: number) => m.state.phaseSince! + ms;
/** Resolve the last point (its tag is already there or "No tag"), so the end-of-game card is due. */
function resolveLast(m: Match): Match {
  const last = [...m.events].reverse().find((e) => e.type === 'point')!;
  if (!m.events.some((e) => (e.type === 'tag' || e.type === 'tag.clear') && e.point === last.id)) {
    const at = lastAt(m) + 3000; // after the stretched log, not on the helper's own clock
    m.push({ type: 'tag.clear', point: last.id });
    m.events[m.events.length - 1] = { ...m.events[m.events.length - 1], at };
  }
  return m;
}

export interface Shot {
  name: string;
  canvas: HTMLCanvasElement;
  crop?: Box;
}

export function frames(): Shot[] {
  const M = matches();
  const shots: Shot[] = [];
  const frame = (name: string, sc: Scene, crop?: 'score' | 'table' | 'card') => {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const r = paint(c.getContext('2d')!, sc);
    const b = crop ? r.boxes[crop] : null;
    shots.push({ name, canvas: c, crop: b ? { x: b.x - 16, y: b.y - 16, w: b.w + 32, h: b.h + 32 } : undefined });
    return r;
  };
  frame('panel-game-point-1080p', { m: M.gamePoint, stats: TABLE_A });
  frame('panel-interval-1080p', { m: M.interval, now: into(M.interval, 13_000), stats: TABLE_A });
  frame('panel-bottom-left-1080p', { m: M.gamePoint, stats: TABLE_A, corner: 'bl' });
  frame('table-doubles-1080p', { m: M.matchPoint, stats: TABLE_A });
  frame('table-singles-1080p', { m: M.single, stats: TABLE_A, logo: 'br' });
  frame('end-card-1080p', { m: resolveLast(M.matchOver), stats: CARD });
  frame('end-card-singles-1080p', { m: resolveLast(M.singleOver), stats: { table: null, card: true } });
  // The panel in every state, 1:1 crops for the sheet.
  const states: Array<[string, Scene]> = [
    ['playing', { m: new Match(on(doublesConfig())).scoreTo(21, 17).startGame().scoreTo(14, 12) }],
    ['game-point', { m: M.gamePoint }],
    ['match-point', { m: M.matchPoint }],
    ['deuce', { m: M.deuce }],
    ['interval', { m: M.interval, now: into(M.interval, 13_000) }],
    ['interval-change-ends', { m: M.decider, now: into(M.decider, 29_000) }],
    ['game-over-break', { m: M.gameOver, now: into(M.gameOver, 8000) }],
    ['match-over', { m: M.matchOver }],
    ['draw', { m: M.draw }],
    ['singles', { m: M.single }],
    ['long-names', { m: M.long }],
    ['link-lost', { m: M.deuce, stale: true }],
  ];
  for (const [name, sc] of states) frame(`state-${name}`, { ...sc, logo: null }, 'score');
  // Mid-animation crops: the badge wiping in, the table cell flashing, the card rising.
  const gp = M.gamePoint;
  const badgeAt = [...gp.events].reverse().find((e) => e.type === 'point')!.at;
  frame('anim-badge-180ms', { m: gp, now: badgeAt + 180, logo: null }, 'score');
  const tagAt = [...M.matchPoint.events].reverse().find((e) => e.type === 'tag')!.at;
  frame('anim-table-cell-300ms', { m: M.matchPoint, now: tagAt + 300, stats: TABLE_A, logo: null }, 'table');
  const over = M.matchOver;
  frame('anim-card-260ms', { m: over, now: lastAt(over) + 260, stats: CARD });
  return shots;
}

/** Hash of a frame's pixels. */
function hash(c: HTMLCanvasElement): string {
  const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
  let h = 2166136261;
  for (let i = 0; i < d.length; i += 4) h = Math.imul(h ^ (d[i] | (d[i + 1] << 8) | (d[i + 2] << 16)), 16777619);
  return (h >>> 0).toString(16);
}

/**
 * The font and determinism checks the PR quotes: the same time drawn after other times, or on another canvas, gives
 * the same pixels. Every canvas is CPU-backed (willReadFrequently: Chrome moves a canvas that is read back often from
 * the GPU to the CPU, and the two anti-alias a little differently) and holds an earlier frame first, as the camera's
 * canvas always does (an empty canvas is rasterised onto a little differently).
 */
export function checks() {
  const M = matches();
  const m = M.matchPoint;
  const t = [...m.events].reverse().find((e) => e.type === 'point')!.at;
  const canvas = () => {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    paint(ctx, { m, now: t - 2000, stats: TABLE_A }); // an earlier frame, as on the camera
    return { c, ctx };
  };
  const { c, ctx } = canvas();
  const at = (now: number) => {
    paint(ctx, { m, now, stats: TABLE_A });
    return hash(c);
  };
  const results: Record<string, unknown> = {};
  const mid = at(t + 150); // the new point's digit rolling, its cell flashing, the badge wiping in
  for (const other of [t + 900, t + 40, t + 5000, t - 2000]) at(other);
  results.sameFrameAfterOthers = at(t + 150) === mid;
  const other = canvas();
  paint(other.ctx, { m, now: t + 5000, stats: TABLE_A });
  paint(other.ctx, { m, now: t + 150, stats: TABLE_A });
  results.sameFrameOnAnotherCanvas = hash(other.c) === mid;
  results.midDiffersFromSettled = mid !== at(t + 10_000);
  results.settledStable = at(t + 10_000) === at(t + 10_000 + 1600); // a whole match point pulse later
  ctx.font = `600 28px ${DEFAULT_THEME.font}`;
  const thai = 'สร้างโอกาส ถูกบีบเสีย';
  const kanitW = ctx.measureText(thai).width;
  ctx.font = '600 28px sans-serif';
  const fallbackW = ctx.measureText(thai).width;
  results.kanitLoaded = document.fonts.check('600 28px Kanit', thai) && document.fonts.check('700 33px Kanit', 'GAME POINT 21');
  results.kanitWidth = Math.round(kanitW);
  results.fallbackWidth = Math.round(fallbackW);
  results.kanitDraws = Math.abs(kanitW - fallbackW) > 1;
  return results;
}
