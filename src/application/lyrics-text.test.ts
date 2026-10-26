import { beforeAll, describe, expect, it } from 'vitest';
import type { LyricLine } from '../domain/music';
import { loadTraditionalLyrics, presentLyricLine } from './lyrics-text';

beforeAll(loadTraditionalLyrics);

const source: LyricLine = {
  id: 'line',
  startMs: 0,
  endMs: 2000,
  text: '头发随风飘扬 🎵',
  translation: '听见你的声音',
  romanization: 'tou fa',
  words: [
    { startMs: 0, endMs: 500, text: '头' },
    { startMs: 500, endMs: 2000, text: '发随风飘扬 🎵' },
  ],
};

describe('presentLyricLine', () => {
  it('leaves original presentation unchanged', () => {
    expect(presentLyricLine(source, 'original')).toBe(source);
  });

  it('converts across word boundaries while preserving timing, romanization, and source data', () => {
    const result = presentLyricLine(source, 'traditional');
    expect(result.text).toBe('頭髮隨風飄揚 🎵');
    expect(result.translation).toBe('聽見你的聲音');
    expect(result.words.map((word) => word.text).join('')).toBe(result.text);
    expect(result.words[1]).toEqual({ ...source.words[1], text: '髮隨風飄揚 🎵' });
    expect(result.romanization).toBe(source.romanization);
    expect(result.startMs).toBe(source.startMs);
    expect(result.endMs).toBe(source.endMs);
    expect(source.text).toBe('头发随风飘扬 🎵');
    expect(source.words[1]?.text).toBe('发随风飘扬 🎵');
  });

  it('preserves absent translations and non-Chinese text', () => {
    const result = presentLyricLine(
      { ...source, text: 'Music 🎵', translation: undefined, words: [] },
      'traditional',
    );
    expect(result.text).toBe('Music 🎵');
    expect(result.translation).toBeUndefined();
    expect(result.words).toEqual([]);
  });
});
