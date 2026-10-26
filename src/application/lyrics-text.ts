import type { Converter } from 'opencc-js/cn2t';
import type { LyricLine } from '../domain/music';
import type { LyricDisplaySettings } from './preferences';

let traditionalConverter: ReturnType<typeof Converter> | undefined;
let traditionalLoad: Promise<void> | undefined;

export function traditionalLyricsReady(): boolean {
  return traditionalConverter !== undefined;
}

export function loadTraditionalLyrics(): Promise<void> {
  traditionalLoad ??= import('opencc-js/cn2t')
    .then(({ Converter }) => {
      traditionalConverter = Converter({ from: 'cn', to: 'tw' });
    })
    .catch((error: unknown) => {
      traditionalLoad = undefined;
      throw error;
    });
  return traditionalLoad;
}

export function presentLyricLine(
  line: LyricLine,
  script: LyricDisplaySettings['chineseScript'],
): LyricLine {
  if (script === 'original') return line;
  if (!traditionalConverter) throw new Error('Traditional lyrics converter has not loaded');
  const convert = traditionalConverter;
  const joinedWords = line.words.map((word) => word.text).join('');
  const convertedWords = convert(joinedWords);
  let offset = 0;
  return {
    ...line,
    text: convert(line.text),
    translation: line.translation == null ? line.translation : convert(line.translation),
    words: line.words.map((word) => {
      const text =
        joinedWords.length === convertedWords.length
          ? convertedWords.slice(offset, offset + word.text.length)
          : convert(word.text);
      offset += word.text.length;
      return { ...word, text };
    }),
  };
}
