import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LyricPlayer } from '@applemusic-like-lyrics/react';
import type { LyricLine as AmllLyricLine, LyricLineMouseEvent } from '@applemusic-like-lyrics/core';
import { AlignLeft, Music2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  buildLyricsRenderModel,
  type RenderLyricLine,
} from '../../application/lyrics-render-model';
import {
  hideNativeLyrics,
  onNativeLyricsSeek,
  showNativeLyrics,
  updateNativeLyrics,
} from '../../application/native-lyrics-bridge';
import type {
  AmllSettings,
  LyricWordEffect,
  SecondaryLyricVisibility,
} from '../../application/preferences';
import { isAndroidRuntime } from '../../application/host-capabilities';
import { useLyricsStageStore } from '../../application/lyrics-stage-machine';
import { usePlayerStore } from '../../application/player-store';
import type { LyricDocument } from '../../domain/music';

import '@applemusic-like-lyrics/core/style.css';

function toAmllLyricLine(line: RenderLyricLine): AmllLyricLine {
  return {
    words: line.words.map((word) => ({
      startTime: word.startTimeMs,
      endTime: word.endTimeMs,
      word: word.text,
    })),
    translatedLyric: line.translatedLyric,
    romanLyric: line.romanLyric,
    startTime: line.startTimeMs,
    endTime: line.endTimeMs,
    isBG: line.isBackground,
    isDuet: line.isDuet,
  };
}

function lyricTimeMs(
  getPositionMs: () => number,
  presentationOffsetMs: number,
  document: LyricDocument,
): number {
  return Math.max(
    0,
    Math.round(getPositionMs() + presentationOffsetMs - document.metadata.offsetMs),
  );
}

/** AMLL expects frequent time updates; keep this clock independent from lyric-boundary renders. */
function useAmllCurrentTime(
  document: LyricDocument | null,
  getPositionMs: () => number,
  presentationOffsetMs: number,
  timelineRevision: number,
  isPlaying: boolean,
): number {
  const current = useCallback(
    () => (document ? lyricTimeMs(getPositionMs, presentationOffsetMs, document) : 0),
    [document, getPositionMs, presentationOffsetMs],
  );
  const [currentTime, setCurrentTime] = useState(current);

  useEffect(() => {
    let frame: number | null = null;
    const update = () => setCurrentTime(current());
    const tick = () => {
      update();
      frame = window.requestAnimationFrame(tick);
    };

    update();
    if (isPlaying) frame = window.requestAnimationFrame(tick);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [current, isPlaying, timelineRevision]);

  return currentTime;
}

function useReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState(
    () =>
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  return reducedMotion;
}

function LyricsMessage({
  icon = 'lyrics',
  title,
  detail,
}: {
  icon?: 'lyrics' | 'instrumental';
  title: string;
  detail: string;
}) {
  return (
    <div className="lyrics-stage__message">
      {icon === 'instrumental' ? <Music2 size={25} /> : <AlignLeft size={25} />}
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}

function StaticLyrics({
  document,
  align,
  allowSeek,
  seek,
  presentationOffsetMs,
}: {
  document: LyricDocument;
  align: 'left' | 'center' | 'right';
  allowSeek: boolean;
  seek: (positionMs: number) => void;
  presentationOffsetMs: number;
}) {
  return (
    <div className="lyrics-stage__amll-static" data-align={align} style={{ textAlign: align }}>
      {document.lines.map((line) => (
        <button
          key={line.id}
          type="button"
          className="lyrics-stage__static-line"
          aria-label={line.text}
          aria-disabled={line.startMs === null || undefined}
          onClick={() =>
            allowSeek &&
            line.startMs !== null &&
            seek(Math.max(0, line.startMs + document.metadata.offsetMs - presentationOffsetMs))
          }
        >
          <span className="lyrics-stage__static-primary">{line.text}</span>
        </button>
      ))}
    </div>
  );
}

export function LyricsViewport({
  document,
  status,
  isPlaying: isPlayingProp,
  timelineRevision: timelineRevisionProp,
  presentationOffsetMs,
  getPositionMs,
  seek,
  translation,
  romanization,
  wordEffect,
  amll,
  followAnchor,
  align,
  songId: _songId,
  editorGesture = false,
  allowSeek = true,
  onFollowStateChange,
  layoutKey: _layoutKey,
}: {
  document: LyricDocument | null;
  status: 'idle' | 'loading' | 'ready' | 'error' | 'missing';
  isPlaying: boolean;
  timelineRevision: number;
  presentationOffsetMs: number;
  getPositionMs: () => number;
  seek: (positionMs: number) => void;
  translation: SecondaryLyricVisibility;
  romanization: SecondaryLyricVisibility;
  wordEffect: LyricWordEffect;
  amll: AmllSettings;
  followAnchor: number;
  align: 'left' | 'center' | 'right';
  songId: string | null;
  editorGesture?: boolean;
  allowSeek?: boolean;
  onFollowStateChange?: (state: 'active' | 'suspended') => void;
  layoutKey?: string;
}) {
  const { t } = useTranslation('lyrics');
  const reducedMotion = useReducedMotion();
  const runtimePlaying = usePlayerStore((state) => state.isPlaying);
  const runtimeRevision = usePlayerStore((state) => state.timelineRevision);
  const isPlaying = editorGesture ? isPlayingProp : runtimePlaying;
  const timelineRevision = editorGesture ? timelineRevisionProp : runtimeRevision;
  const currentTime = useAmllCurrentTime(
    document,
    getPositionMs,
    presentationOffsetMs,
    timelineRevision,
    isPlaying,
  );
  const model = useMemo(
    () => (document ? buildLyricsRenderModel(document, translation, romanization) : null),
    [document, romanization, translation],
  );
  const amllLines = useMemo(() => model?.lines.map(toAmllLyricLine) ?? [], [model]);
  const isAndroid = isAndroidRuntime();
  const nativeContainerRef = useRef<HTMLDivElement>(null);
  const stage = useLyricsStageStore((s) => s.stage);
  const nativeShownRef = useRef(false);

  useEffect(() => {
    if (!isAndroid || editorGesture) return;

    if (
      status !== 'ready' ||
      !document ||
      document.syncMode === 'unsynchronized' ||
      !model ||
      model.lines.length === 0 ||
      stage !== 'open'
    ) {
      nativeShownRef.current = false;
      void hideNativeLyrics();
      return;
    }

    const updateNativeOverlay = (initial: boolean) => {
      const el = nativeContainerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const bounds = {
        // The Android overlay is a sibling of the WebView. With the host in
        // edge-to-edge mode, WebView CSS viewport coordinates map directly to
        // the sibling parent's pixel origin after density conversion.
        top: Math.max(0, rect.top),
        left: Math.max(0, rect.left),
        width: rect.width,
        height: rect.height,
      };
      if (bounds.width <= 0 || bounds.height <= 0) return;

      const scene = el.closest<HTMLElement>('.lyrics-scene');
      const computed = window.getComputedStyle(el);
      const sceneComputed = scene ? window.getComputedStyle(scene) : computed;
      const fontSizePx = Number.parseFloat(computed.fontSize);
      const fontWeight = Number.parseFloat(
        sceneComputed.getPropertyValue('--lyrics-font-weight') || computed.fontWeight,
      );
      const foregroundToken = sceneComputed.getPropertyValue('--lyrics-foreground').trim();
      // `color-mix()` is intentionally resolved by the browser when possible;
      // older WebViews may leave the token untouched, in which case the host
      // falls back to its own readable foreground color.
      let foregroundColor = computed.color;
      if (foregroundToken) {
        const probe = window.document.createElement('span');
        probe.style.position = 'absolute';
        probe.style.visibility = 'hidden';
        probe.style.pointerEvents = 'none';
        probe.style.color = foregroundToken;
        scene?.appendChild(probe);
        const resolved = window.getComputedStyle(probe).color;
        probe.remove();
        if (resolved) foregroundColor = resolved;
      }
      const options = {
        align,
        followAnchor,
        enableSpring: amll.enableSpring && !reducedMotion,
        enableScale: amll.enableScale && !reducedMotion,
        enableBlur: amll.enableBlur && !reducedMotion,
        hidePassedLines: amll.hidePassedLines,
        wordFadeWidth: amll.wordFadeWidth,
        ...(Number.isFinite(fontSizePx) && fontSizePx > 0 ? { lineFontSizePx: fontSizePx } : {}),
        ...(Number.isFinite(fontWeight) && fontWeight > 0 ? { fontWeight } : {}),
        ...(foregroundColor ? { foregroundColor } : {}),
        timingOffsetMs: presentationOffsetMs - document.metadata.offsetMs,
      };

      if (initial || !nativeShownRef.current) {
        nativeShownRef.current = true;
        void showNativeLyrics(bounds, model.lines, options);
      } else {
        void updateNativeLyrics(bounds, null, options);
      }
    };

    updateNativeOverlay(true);

    const unlisten = onNativeLyricsSeek((pos) => {
      if (allowSeek) {
        seek(pos);
      }
    });

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && nativeContainerRef.current) {
      ro = new ResizeObserver(() => updateNativeOverlay(false));
      ro.observe(nativeContainerRef.current);
    }

    return () => {
      ro?.disconnect();
      unlisten();
      nativeShownRef.current = false;
      void hideNativeLyrics();
    };
  }, [
    isAndroid,
    editorGesture,
    stage,
    status,
    document,
    model,
    align,
    followAnchor,
    amll,
    reducedMotion,
    allowSeek,
    seek,
    presentationOffsetMs,
  ]);

  useEffect(() => onFollowStateChange?.('active'), [onFollowStateChange]);

  if (status === 'idle') {
    return <LyricsMessage title={t('nothingPlaying')} detail={t('nothingPlayingDetail')} />;
  }
  if (status === 'loading') {
    return <LyricsMessage title={t('loading')} detail={t('loadingDetail')} />;
  }
  if (status === 'error') {
    return <LyricsMessage title={t('unavailable')} detail={t('providerFailed')} />;
  }
  if (!document || status === 'missing') {
    return <LyricsMessage title={t('missing')} detail={t('missingDetail')} />;
  }

  if (document.syncMode === 'unsynchronized' || !model || model.lines.length === 0) {
    return (
      <StaticLyrics
        document={document}
        align={align}
        allowSeek={allowSeek}
        seek={seek}
        presentationOffsetMs={presentationOffsetMs}
      />
    );
  }

  if (isAndroid && !editorGesture) {
    return (
      <div
        ref={nativeContainerRef}
        className="lyrics-stage__amll lyrics-stage__amll--native"
        data-align={align}
        style={{ width: '100%', height: '100%', minHeight: 0 }}
      />
    );
  }

  const onLyricLineClick = (event: LyricLineMouseEvent) => {
    if (!allowSeek) return;
    const sourceIndex = model.lines[event.lineIndex]?.sourceLineIndex;
    const sourceLine = sourceIndex === undefined ? undefined : document.lines[sourceIndex];
    if (!sourceLine || sourceLine.startMs === null) return;
    seek(Math.max(0, sourceLine.startMs + document.metadata.offsetMs - presentationOffsetMs));
  };

  return (
    <div
      className="lyrics-stage__amll"
      data-align={align}
      data-follow="active"
      data-word-jump={wordEffect === 'jump' ? 'true' : 'false'}
    >
      <LyricPlayer
        className="lyrics-stage__amll-player"
        disabled={editorGesture}
        lyricLines={amllLines}
        currentTime={currentTime}
        isSeeking={false}
        playing={isPlaying}
        alignAnchor="center"
        alignPosition={Math.min(0.9, Math.max(0.1, followAnchor))}
        enableSpring={amll.enableSpring && !reducedMotion}
        enableScale={amll.enableScale && !reducedMotion}
        enableBlur={amll.enableBlur && !reducedMotion}
        hidePassedLines={amll.hidePassedLines}
        wordFadeWidth={amll.wordFadeWidth}
        onLyricLineClick={onLyricLineClick}
      />
    </div>
  );
}
