import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { DynamicArtworkRenderer } from './dynamicArtworkRenderer';

export function DynamicArtworkBackdrop({
  source,
  animating,
  opacity,
  selected,
  onUnavailable,
}: {
  source: string | null;
  animating: boolean;
  opacity: number;
  selected: boolean;
  /** WebGL2 is unavailable or the context was lost; the caller switches to the static backdrop. */
  onUnavailable: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<DynamicArtworkRenderer | null>(null);
  const unavailable = useRef(onUnavailable);
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    unavailable.current = onUnavailable;
  }, [onUnavailable]);

  useLayoutEffect(() => {
    const node = canvas.current;
    if (!node) return;
    const instance = DynamicArtworkRenderer.create(node, {
      onReady: () => setReady(true),
      onFailure: () => unavailable.current(),
    });
    if (!instance) {
      unavailable.current();
      return;
    }
    renderer.current = instance;
    return () => {
      renderer.current = null;
      instance.dispose();
    };
  }, []);

  useEffect(() => renderer.current?.setArtwork(source), [source]);
  useEffect(() => renderer.current?.setPlaying(animating), [animating]);

  return (
    <canvas
      ref={canvas}
      className="lyrics-scene__dynamic-backdrop"
      data-widget="background"
      data-scene-widget="background"
      data-scene-widget-id="background"
      data-scene-widget-type="background"
      data-selected={selected || undefined}
      style={{ opacity: ready ? opacity : 0 }}
      aria-hidden="true"
    />
  );
}
