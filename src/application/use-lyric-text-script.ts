import { useEffect, useState } from 'react';
import { loadTraditionalLyrics, traditionalLyricsReady } from './lyrics-text';
import { usePreferencesStore, type LyricDisplaySettings } from './preferences';
import { logger } from './logger';

export function useLyricTextScript(): LyricDisplaySettings['chineseScript'] {
  const script = usePreferencesStore((state) => state.lyrics.chineseScript);
  const [ready, setReady] = useState(traditionalLyricsReady);
  useEffect(() => {
    if (script !== 'traditional' || ready) return;
    let active = true;
    void loadTraditionalLyrics()
      .then(() => {
        if (active) setReady(true);
      })
      .catch((error: unknown) => {
        logger.warn('lyrics.script.load', 'Failed to load Traditional Chinese lyrics conversion', {
          error: String(error),
        });
      });
    return () => {
      active = false;
    };
  }, [ready, script]);
  return script === 'traditional' && ready ? 'traditional' : 'original';
}
