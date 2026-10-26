import { describe, expect, it } from 'vitest';
import {
  applyOverride,
  builtinPresetCatalog,
  defaultLyricsPresetState,
  normalizeLyricsPresetState,
  patchFromDefinition,
  resolveLyricsPreset,
  resolvePrimaryFontSizePx,
} from './lyrics-preset';
import {
  autoPortraitScene,
  commitOrientedPreset,
  projectPresetForOrientation,
  sceneForOrientation,
} from './lyrics-scene-layout';
import { widgetEdges } from './lyrics-scene-geometry';
import { logicalSceneSize } from './lyrics-composer-view';

describe('lyrics display adaptation', () => {
  it.each(builtinPresetCatalog)(
    'stacks $id without overlapping artwork, lyrics or controls',
    (preset) => {
      const original = structuredClone(preset.scene);
      const scene = autoPortraitScene(preset.scene);
      const artwork = widgetEdges(scene.artwork);
      const metadata = widgetEdges(scene.metadata);
      const lyrics = widgetEdges(scene.lyrics);
      const transport = widgetEdges(scene.transport);
      expect(artwork.bottom).toBeLessThan(metadata.top);
      expect(metadata.bottom).toBeLessThan(lyrics.top);
      expect(lyrics.bottom).toBeLessThan(transport.top);
      expect(transport.bottom).toBeLessThan(1);
      expect(lyrics.width).toBeGreaterThan(0.75);
      expect(sceneForOrientation(preset, false)).toBe(preset.scene);
      expect(preset.scene).toEqual(original);
    },
  );

  it('bounds font size by available lyric width and preserves the user scale ratio', () => {
    const largePortrait = resolvePrimaryFontSizePx(1, 1920, 972);
    expect(largePortrait).toBeLessThan(resolvePrimaryFontSizePx(1, 1920));
    expect(largePortrait).toBeCloseTo(972 / 16);
    expect(
      resolvePrimaryFontSizePx(0.7, 1920, 972) / resolvePrimaryFontSizePx(1.4, 1920, 972),
    ).toBeCloseTo(0.5);
    expect(resolvePrimaryFontSizePx(1, 1080, 960)).toBeGreaterThan(50);
  });

  it('persists portrait edits independently through normalization and later typography changes', () => {
    const preset = builtinPresetCatalog[0]!;
    const displayed = projectPresetForOrientation(preset, true);
    const edited = {
      ...displayed,
      scene: { ...displayed.scene, lyrics: { ...displayed.scene.lyrics, x: 0.42, width: 0.8 } },
    };
    const saved = commitOrientedPreset(edited, preset, true);
    const state = applyOverride(defaultLyricsPresetState, preset.id, patchFromDefinition(saved));
    const withFont = applyOverride(state, preset.id, { typography: { fontScale: 0.8 } });
    const restored = resolveLyricsPreset(
      normalizeLyricsPresetState(JSON.parse(JSON.stringify(withFont))),
    );
    expect(restored.scene).toMatchObject(preset.scene);
    expect(sceneForOrientation(restored, true).lyrics.x).toBe(0.42);
    expect(sceneForOrientation(restored, true).lyrics.width).toBe(0.8);
    expect(restored.typography.fontScale).toBe(0.8);
    expect(commitOrientedPreset(displayed, preset, true).portraitScene).toBeUndefined();
  });

  it('fits a portrait editor frame and follows current-window orientation', () => {
    expect(logicalSceneSize('portrait')).toEqual({ width: 1080, height: 1920 });
    const current = logicalSceneSize('window', { width: 1080, height: 1920 });
    expect(current.width / current.height).toBeCloseTo(9 / 16, 2);
  });
});
