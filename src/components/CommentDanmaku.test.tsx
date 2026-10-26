import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultPreferences, usePreferencesStore } from '../application/preferences';
import { usePlayerStore } from '../application/player-store';
import type { LyricDocument } from '../domain/music';
import { CommentDanmaku } from './CommentDanmaku';

const document: LyricDocument = {
  songId: 'song',
  syncMode: 'line',
  metadata: { sourceLabel: 'NetEase', offsetMs: 0 },
  lines: [],
  vocalists: [],
  comments: [
    { id: '1', content: '<script>comment</script>', author: 'listener', likedCount: 1234 },
  ],
};
describe('read-only comment overlay', () => {
  beforeEach(() => {
    usePreferencesStore.setState({
      lyrics: { ...defaultPreferences.lyrics, commentDanmaku: true },
    });
    usePlayerStore.setState({ isPlaying: true });
  });
  afterEach(cleanup);
  it('renders comment text and like counts without HTML or account actions', () => {
    const { container } = render(<CommentDanmaku document={document} />);
    expect(screen.getByText('<script>comment</script>')).toBeInTheDocument();
    expect(screen.getByText('1,234')).toBeInTheDocument();
    expect(container.querySelector('script')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
  it('pauses movement with playback and honors the saved switch', () => {
    usePlayerStore.setState({ isPlaying: false });
    const { container, rerender } = render(<CommentDanmaku document={document} />);
    expect(container.querySelector('[data-paused]')).not.toBeNull();
    usePreferencesStore.setState({
      lyrics: { ...defaultPreferences.lyrics, commentDanmaku: false },
    });
    rerender(<CommentDanmaku document={document} />);
    expect(container).toBeEmptyDOMElement();
  });
  it('resumes the existing comments when playback continues', () => {
    const { container } = render(<CommentDanmaku document={document} />);
    const overlay = container.querySelector('.comment-danmaku');
    const item = container.querySelector('.comment-danmaku__item');
    expect(overlay).not.toHaveAttribute('data-paused');
    act(() => usePlayerStore.setState({ isPlaying: false }));
    expect(overlay).toHaveAttribute('data-paused');
    act(() => usePlayerStore.setState({ isPlaying: true }));
    expect(overlay).not.toHaveAttribute('data-paused');
    expect(container.querySelector('.comment-danmaku__item')).toBe(item);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
