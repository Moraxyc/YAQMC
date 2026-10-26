export interface LyricWordKeyframe {
  offset: number;
  /** Vertical displacement in em. Negative values lift the word. */
  y: number;
  scale: number;
  rotate: number;
  /** Text glow radius in em. */
  glow: number;
}

export interface LyricWordAnimation {
  keyframes: LyricWordKeyframe[];
  easing: 'linear' | 'ease-out' | 'ease-in-out';
}

export function normalizeWordAnimation(value: unknown): LyricWordAnimation | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as { keyframes?: unknown; easing?: unknown };
  if (
    !Array.isArray(source.keyframes) ||
    source.keyframes.length < 2 ||
    source.keyframes.length > 8
  )
    return undefined;
  const bounded = (value: unknown, fallback: number, min: number, max: number) =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.max(min, Math.min(max, value))
      : fallback;
  const keyframes: LyricWordKeyframe[] = [];
  for (const raw of source.keyframes) {
    if (!raw || typeof raw !== 'object') return undefined;
    const frame = raw as Record<string, unknown>;
    if (
      typeof frame.offset !== 'number' ||
      !Number.isFinite(frame.offset) ||
      frame.offset < 0 ||
      frame.offset > 1
    )
      return undefined;
    if (keyframes.length && frame.offset <= keyframes.at(-1)!.offset) return undefined;
    keyframes.push({
      offset: frame.offset,
      y: bounded(frame.y, 0, -0.5, 0.5),
      scale: bounded(frame.scale, 1, 0.5, 1.5),
      rotate: bounded(frame.rotate, 0, -30, 30),
      glow: bounded(frame.glow, 0, 0, 0.5),
    });
  }
  if (keyframes[0]!.offset !== 0 || keyframes.at(-1)!.offset !== 1) return undefined;
  return {
    keyframes,
    easing:
      source.easing === 'ease-out' || source.easing === 'ease-in-out' ? source.easing : 'linear',
  };
}

/** Adapt pinned AMLL 0.5.2 word effects; keep its clock, masks, pause and seek ownership. */
export function installWordAnimation(
  root: HTMLElement,
  definition: LyricWordAnimation,
): () => void {
  const originals = new Map<KeyframeEffect, { frames: ComputedKeyframe[]; easing: string }>();
  const targets = new Map<HTMLElement, string | null>();
  let pending: number | null = null;
  const apply = () => {
    pending = null;
    if (typeof root.getAnimations !== 'function' || typeof KeyframeEffect === 'undefined') return;
    for (const animation of root.getAnimations({ subtree: true })) {
      const effect = animation.effect;
      if (!(effect instanceof KeyframeEffect) || originals.has(effect)) continue;
      const word = animation.id === 'float-word';
      if (!word && !animation.id.startsWith('emphasize-word-')) continue;
      originals.set(effect, {
        frames: effect.getKeyframes(),
        easing: effect.getTiming().easing ?? 'linear',
      });
      effect.setKeyframes(
        word
          ? definition.keyframes.map((frame) => ({
              offset: frame.offset,
              transform: `translateY(${frame.y}em) rotate(${frame.rotate}deg) scale(${frame.scale})`,
              textShadow: frame.glow ? `0 0 ${frame.glow}em currentColor` : 'none',
            }))
          : [
              { transform: 'none', textShadow: 'none' },
              { transform: 'none', textShadow: 'none' },
            ],
      );
      if (word) {
        effect.updateTiming({ easing: definition.easing });
        if (effect.target instanceof HTMLElement) {
          targets.set(effect.target, effect.target.getAttribute('data-yaqmc'));
          effect.target.setAttribute('data-yaqmc', 'lyric-word');
        }
      }
    }
    // AMLL replaces word nodes on document/layout changes; do not retain retired songs.
    for (const effect of originals.keys()) {
      if (effect.target instanceof Element && !root.contains(effect.target))
        originals.delete(effect);
    }
    for (const target of targets.keys()) if (!root.contains(target)) targets.delete(target);
  };
  const schedule = () => {
    pending ??= requestAnimationFrame(apply);
  };
  const observer = new MutationObserver(schedule);
  observer.observe(root, { childList: true, subtree: true });
  schedule();
  return () => {
    observer.disconnect();
    if (pending !== null) cancelAnimationFrame(pending);
    for (const [effect, original] of originals) {
      effect.setKeyframes(original.frames);
      effect.updateTiming({ easing: original.easing });
    }
    for (const [target, previous] of targets) {
      if (previous === null) target.removeAttribute('data-yaqmc');
      else target.setAttribute('data-yaqmc', previous);
    }
  };
}
