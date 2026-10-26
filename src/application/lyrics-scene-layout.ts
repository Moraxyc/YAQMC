import type { LyricsPresetDefinition, LyricsSceneLayout, WidgetTransform } from './lyrics-preset';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Derive a portrait starting point without changing the saved landscape layout. */
export function autoPortraitScene(scene: LyricsSceneLayout): LyricsSceneLayout {
  const artworkHeight = scene.artwork.visible ? clamp(scene.artwork.height * 0.5, 0.14, 0.28) : 0;
  const artworkTop = 0.065;
  const metadataTop = artworkTop + artworkHeight + 0.015;
  const metadataHeight = scene.metadata.visible
    ? clamp(scene.metadata.height * 0.6, 0.055, 0.11)
    : 0;
  const lyricsTop = metadataTop + metadataHeight + 0.015;
  const lyricsBottom = scene.transport.visible ? 0.855 : 0.95;
  const box = <T extends WidgetTransform>(
    widget: T,
    top: number,
    width: number,
    height: number,
  ): T => ({
    ...widget,
    anchor: 'top-center',
    x: 0.5,
    y: top,
    width,
    height,
  });
  return {
    ...scene,
    artwork: box(
      scene.artwork,
      artworkTop,
      clamp(scene.artwork.width * 2, 0.3, 0.86),
      artworkHeight,
    ),
    metadata: box(
      scene.metadata,
      metadataTop,
      clamp(scene.metadata.width * 2.4, 0.6, 0.92),
      metadataHeight,
    ),
    lyrics: box(
      scene.lyrics,
      lyricsTop,
      clamp(scene.lyrics.width * 1.8, 0.6, 0.92),
      lyricsBottom - lyricsTop,
    ),
    transport: box(scene.transport, 0.875, clamp(scene.transport.width * 2, 0.65, 0.92), 0.095),
  };
}

export function sceneForOrientation(
  preset: LyricsPresetDefinition,
  portrait: boolean,
): LyricsSceneLayout {
  return portrait ? (preset.portraitScene ?? autoPortraitScene(preset.scene)) : preset.scene;
}

/** The editor displays one scene while history and persistence keep both orientations. */
export function projectPresetForOrientation(
  preset: LyricsPresetDefinition,
  portrait: boolean,
): LyricsPresetDefinition {
  return portrait ? { ...preset, scene: sceneForOrientation(preset, true) } : preset;
}

export function commitOrientedPreset(
  edited: LyricsPresetDefinition,
  canonical: LyricsPresetDefinition,
  portrait: boolean,
): LyricsPresetDefinition {
  if (!portrait) return edited;
  const automatic =
    !edited.portraitScene &&
    JSON.stringify(edited.scene) === JSON.stringify(autoPortraitScene(canonical.scene));
  return { ...edited, scene: canonical.scene, portraitScene: automatic ? undefined : edited.scene };
}
