import { describe, expect, it } from 'vitest';
import { reduce } from '../engine';
import { doublesConfig, makeConfig, Match } from '../engine/test-utils';
import { feedbackFor, scoreCall } from './phrases';

/** Feedback for the last event of a match log. */
function last(m: Match, lang: 'en' | 'th' = 'en') {
  const prev = reduce(m.cfg, m.events.slice(0, -1));
  return feedbackFor(m.cfg, prev, m.state, m.events[m.events.length - 1], lang);
}

describe('spoken score (ux-design.md §4)', () => {
  it('calls the server score first', () => {
    const m = new Match(makeConfig()).rallies('AAABB'); // B serves at 3-2
    expect(scoreCall(m.state, 'en')).toBe('two, three');
    expect(last(m)).toEqual({ speech: 'two, three', chime: 'click' });
  });

  it('says "all" for a tie and "love" for zero', () => {
    expect(scoreCall(new Match(makeConfig()).state, 'en')).toBe('love all');
    expect(scoreCall(new Match(makeConfig()).rallies('AB').state, 'en')).toBe('one all');
    expect(scoreCall(new Match(makeConfig()).rallies('B').state, 'en')).toBe('one, love');
  });

  it('flags game point and match point umpire style', () => {
    expect(scoreCall(new Match(makeConfig()).scoreTo(20, 15).state, 'en')).toBe('twenty, game point, fifteen');
    expect(scoreCall(new Match(makeConfig({ format: 'fixed1' })).scoreTo(15, 20).state, 'en')).toBe(
      'twenty, match point, fifteen',
    );
    expect(scoreCall(new Match(makeConfig()).scoreTo(29, 29).state, 'en')).toBe('twenty-nine, game point all');
  });

  it('starts with "Love all, play" and announces later games', () => {
    const m = new Match(makeConfig());
    expect(feedbackFor(m.cfg, m.state, m.state, m.events[0], 'en').speech).toBe('Love all, play');
    m.game(21, 17, { start: false });
    expect(last(m)).toEqual({ speech: 'Game. First game to A, twenty-one, seventeen', chime: 'game' });
    m.startGame();
    expect(last(m).speech).toBe('Second game, love all, play');
  });

  it('announces the interval and the deciding-game change of ends', () => {
    const m = new Match(makeConfig()).scoreTo(11, 7);
    expect(last(m)).toEqual({ speech: 'eleven, seven, interval', chime: 'interval' });
    const d = new Match(makeConfig({ format: 'fixed1' })).scoreTo(5, 11);
    expect(last(d).speech).toBe('eleven, five, interval, change ends');
    d.endInterval();
    expect(last(d)).toEqual({ speech: 'Change ends', chime: 'ends' });
  });

  it('announces the match result and the fixed-2 draw', () => {
    const w = new Match(makeConfig()).game(21, 10).game(21, 12);
    expect(last(w).speech).toBe('Game. Second game to A, twenty-one, twelve. Match won by A, two games to love');
    const d = new Match(doublesConfig({ format: 'fixed2' })).game(21, 15).game(15, 21);
    expect(last(d).speech).toBe('Game. Second game to B, twenty-one, fifteen. Match drawn, one game all');
  });

  it('repeats the score after an undo', () => {
    const m = new Match(makeConfig()).rallies('AAB').undo();
    expect(last(m)).toEqual({ speech: 'two, love', chime: null });
  });

  it('speaks Thai when selected', () => {
    expect(scoreCall(new Match(makeConfig()).rallies('AAB').state, 'th')).toBe('1 ต่อ 2');
    expect(scoreCall(new Match(makeConfig()).state, 'th')).toBe('ศูนย์ เท่า');
    expect(scoreCall(new Match(makeConfig()).scoreTo(20, 15).state, 'th')).toBe('20 เกมพอยต์ 15');
  });
});
