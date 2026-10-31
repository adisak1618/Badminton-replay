// What the video made after the match draws over each frame (D16), with the same overlay code the camera burns in live:
//  - live frames: a recorded segment already shows the panel, the logo and maybe the table; the render adds or updates
//    the stats table and the end-of-game card from the tags as they are now (tags added after the match count from
//    their point, retro.ts). An imported file (D17) has nothing burned in, so the render draws the whole overlay.
//  - replay frames: the recording's own panel of that moment is under a dark plate; the panel frozen at the score after
//    the point with "REPLAY ×0.5" in its badge slot goes on top; the frozen table too.
//  - the BWF card turning in and out, over everything.
import type { MatchConfig, MatchEvent, Team } from '../engine';
import {
  DEFAULT_THEME,
  OverlayClock,
  PANEL,
  cardPlace,
  cardShown,
  drawEndCard,
  drawOverlay,
  drawPanelPlate,
  drawReplayBadge,
  drawReplayCard,
  drawStatsTable,
  endCardSize,
  overlayLayout,
  panelMaxHeight,
  panelScale,
  panelSize,
  statsTableSize,
  type Box,
  type Corner,
  type EndCard,
  type OverlayModel,
  type ReplayFrame,
  type ReplayPlan,
  type StatsOptions,
} from '../overlay';
import type { MatchBundle } from '../recording/bundle';
import { union, type Segment } from '../recording/session';
import { retroTags } from './retro';
import { cameraTime } from './timeline';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** What the render adds: the stats table (a team, or none) and the end-of-game card; absent = as the segment recorded. */
export interface PaintOptions {
  table?: { team: Team; opp: boolean } | null;
  card?: boolean;
}

export class FramePainter {
  readonly W: number;
  readonly H: number;
  private readonly u: number;
  private readonly cfg: MatchConfig;
  private readonly events: MatchEvent[];
  private readonly original: readonly MatchEvent[];
  private readonly stats: StatsOptions;
  private readonly clock = new OverlayClock();
  private readonly origClock = new OverlayClock();
  private readonly corner: Corner;
  private readonly offsetMs: number;

  constructor(
    bundle: MatchBundle,
    private readonly seg: Segment,
    private readonly burned: boolean,
    o: PaintOptions = {},
  ) {
    if (!bundle.config) throw new Error('no match to draw');
    this.cfg = bundle.config;
    this.original = bundle.events;
    this.events = retroTags(bundle.events);
    this.W = seg.width || 1920;
    this.H = seg.height || 1080;
    this.u = panelScale(this.H, seg.overlay.size ?? 'medium');
    this.corner = seg.overlay.corner ?? 'tl';
    this.offsetMs = bundle.clock?.offsetMs ?? 0;
    const rec = seg.overlay.stats;
    const table = o.table !== undefined ? o.table : rec && rec.team !== 'off' ? { team: rec.team, opp: rec.opp } : null;
    this.stats = { table, card: o.card ?? rec?.card ?? false };
  }

  private model(clock: OverlayClock, events: readonly MatchEvent[], src: number, stats: StatsOptions): OverlayModel | null {
    return clock.at(this.cfg, events, cameraTime(this.seg, src), {
      delayMs: this.seg.overlay.delayMs ?? 0,
      offsetMs: this.offsetMs,
      mirrored: this.seg.overlay.mirrored ?? false,
      stale: false,
      stats,
    });
  }

  private layout(ctx: Ctx, m: OverlayModel, scoreSize: { w: number; h: number } | null, card: EndCard | null) {
    const logo = this.seg.overlay.logo;
    const lay = overlayLayout(this.W, this.H, {
      scoreCorner: this.corner,
      score: scoreSize,
      scoreMaxH: panelMaxHeight(this.u),
      logo: logo && logo.box.h ? { corner: logo.corner, size: logo.size, aspect: logo.box.w / logo.box.h } : null,
      table: m.table && !card ? { place: this.seg.overlay.stats?.place ?? 'auto', ...statsTableSize(ctx as CanvasRenderingContext2D, m.table, this.u) } : null,
    });
    return lay;
  }

  /** The panel's boxes the recording burned in between recording ms `from` and `to` (the replay window). */
  burnedPanel(from: number, to: number): Box | null {
    const b = this.seg.overlay.boxes;
    if (!b.length) return this.seg.overlay.box.w ? this.seg.overlay.box : null;
    const a = cameraTime(this.seg, from);
    const z = cameraTime(this.seg, to);
    let acc: Box | null = null;
    b.forEach((x, i) => {
      const until = b[i + 1]?.at ?? Infinity;
      if (x.at <= z && until >= a) acc = acc ? union(acc, x.box) : x.box;
    });
    return acc ?? b[b.length - 1].box;
  }

  /**
   * Draw the overlays for one output frame: `live` is the recording ms of the live picture (for a replay piece, the
   * paused frame), `f` the replay graphics at this time, `plan` the replay they belong to.
   */
  paint(ctx: Ctx, live: number, f: ReplayFrame, plan: ReplayPlan | null, pauseAt: number | null): void {
    const c = ctx as CanvasRenderingContext2D;
    const T = { now: 0, motion: this.seg.overlay.motion ?? 'full' } as { now: number; motion: 'full' | 'light' | 'none' };
    const at = f.on && pauseAt != null ? pauseAt : live;
    const m = this.model(this.clock, this.events, at, this.stats);
    if (!m) return;
    T.now = this.clock.cutoff;
    // The card: the summary as it is now, and over a card the recording showed at that moment, the same card again.
    let card = m.card && cardShown(m.card, T.now, T.motion) ? m.card : null;
    if (!card && this.burned && this.stats.card) {
      const o = this.model(this.origClock, this.original, at, this.stats);
      if (o?.card && cardShown(o.card, this.origClock.cutoff, T.motion)) card = o.card;
    }
    const rows = f.on ? { ...m, phase: 'playing' as const, flag: null, deuce: false } : m;
    const size = panelSize(c, rows, this.u);
    const bandH = (PANEL.bandGap + PANEL.band) * this.u;
    const bottom = this.corner === 'bl' || this.corner === 'br';
    const lay = this.layout(c, m, f.on ? { w: size.w, h: size.h + bandH } : size, card);
    if (f.on && plan) {
      const pb = lay.score!;
      if (this.burned && f.mix > 0) {
        const old = this.burnedPanel(plan.from, plan.to);
        if (old) drawPanelPlate(c, old, this.u, f.mix);
      }
      const rowsBox = { x: pb.x, y: bottom ? pb.y + bandH : pb.y, w: pb.w, h: size.h };
      drawOverlay(c, rows, rowsBox, this.u, DEFAULT_THEME, { motion: T.motion });
      const badge = { x: pb.x, y: bottom ? pb.y : pb.y + size.h + PANEL.bandGap * this.u, w: pb.w, h: PANEL.band * this.u };
      drawReplayBadge(c, badge, this.u, f, plan.speed);
    } else if (!this.burned && lay.score) drawOverlay(c, m, lay.score, this.u, DEFAULT_THEME, { ...T, bandAbove: bottom });
    if (m.table && lay.table && !card) drawStatsTable(c, m.table, lay.table, this.u, DEFAULT_THEME, T);
    if (card) drawEndCard(c, card, cardPlace(this.W, this.H, endCardSize(card, this.u), [lay.score, lay.logo]).box, DEFAULT_THEME, T);
    if (f.card != null) drawReplayCard(c, this.W, this.H, f.card, null);
  }
}
