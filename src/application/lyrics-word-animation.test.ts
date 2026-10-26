import { afterEach, describe, expect, it, vi } from 'vitest';
import { installWordAnimation, normalizeWordAnimation } from './lyrics-word-animation';
import { builtinPresetCatalog, normalizeLyricsPresetState } from './lyrics-preset';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

const frames = [
  { offset: 0 },
  { offset: 0.5, y: -0.12, scale: 1.08, rotate: -3, glow: 0.1 },
  { offset: 1 },
];

describe('plugin lyric word animation', () => {
  it('bounds declarative frames and drops malformed timelines', () => {
    expect(normalizeWordAnimation({ keyframes: frames })?.keyframes[1]?.y).toBe(-0.12);
    const extreme = normalizeWordAnimation({
      keyframes: [{ offset: 0, y: -100, scale: 50, rotate: 900, glow: 10 }, { offset: 1 }],
    });
    expect(extreme?.keyframes[0]).toMatchObject({ y: -0.5, scale: 1.5, rotate: 30, glow: 0.5 });
    for (const keyframes of [
      [{ offset: 0.2 }, { offset: 1 }],
      [{ offset: 0 }, { offset: 0 }],
      [{ offset: 0 }, { offset: NaN }, { offset: 1 }],
      Array(9).fill({ offset: 0 }),
    ]) {
      expect(normalizeWordAnimation({ keyframes })).toBeUndefined();
    }
  });

  it('keeps plugin word animation in normalized and copied scene definitions', () => {
    const preset = builtinPresetCatalog[0]!;
    const state = normalizeLyricsPresetState({
      custom: [
        {
          ...preset,
          id: 'custom.motion',
          scene: {
            ...preset.scene,
            lyrics: {
              ...preset.scene.lyrics,
              wordAnimation: { keyframes: frames, easing: 'ease-out' },
            },
          },
        },
      ],
    });
    expect(state.custom[0]?.scene.lyrics.wordAnimation?.keyframes).toHaveLength(3);
    expect(state.custom[0]?.scene.lyrics.wordAnimation?.easing).toBe('ease-out');
  });

  it('replaces only word motion, preserves masks and timing, and restores effects on removal', () => {
    let tick: FrameRequestCallback = () => undefined;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      tick = callback;
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    class Effect {
      target: HTMLElement;
      frames: Keyframe[] = [{ transform: 'translateY(0px)' }, { transform: 'translateY(-0.05em)' }];
      easing = 'ease-out';
      constructor(target: HTMLElement) {
        this.target = target;
      }
      getKeyframes() {
        return this.frames;
      }
      setKeyframes(next: Keyframe[]) {
        this.frames = next;
      }
      getTiming() {
        return { duration: 2000, delay: 300, easing: this.easing };
      }
      updateTiming(next: { easing: string }) {
        this.easing = next.easing;
      }
    }
    vi.stubGlobal('KeyframeEffect', Effect);
    const root = document.createElement('div');
    const word = document.createElement('span');
    root.append(word);
    document.body.append(root);
    const float = new Effect(word);
    const glow = new Effect(word);
    const mask = new Effect(word);
    const original = float.frames;
    const animations = [
      { id: 'float-word', effect: float, currentTime: 450, playState: 'paused' },
      { id: 'emphasize-word-test-0', effect: glow },
      { id: 'mask-word', effect: mask },
    ];
    Object.defineProperty(root, 'getAnimations', { value: () => animations });
    const cleanup = installWordAnimation(root, normalizeWordAnimation({ keyframes: frames })!);
    tick(0);
    expect(float.frames[1]?.transform).toContain('rotate(-3deg)');
    expect(float.getTiming()).toMatchObject({ duration: 2000, delay: 300, easing: 'linear' });
    expect(animations[0]).toMatchObject({ currentTime: 450, playState: 'paused' });
    expect(glow.frames[0]?.transform).toBe('none');
    expect(mask.frames).toEqual(original);
    expect(word).toHaveAttribute('data-yaqmc', 'lyric-word');
    cleanup();
    expect(float.frames).toBe(original);
    expect(float.easing).toBe('ease-out');
    expect(word).not.toHaveAttribute('data-yaqmc');
  });
});
