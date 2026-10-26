import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCommentsPanelStore } from '../application/comments-panel-store';
import { allSongs } from '../providers/fake/fixtures';
import { CommentsButton, CommentsPanel } from './CommentsPanel';

const state = vi.hoisted(() => ({
  status: 'ready',
  items: [
    {
      id: '1',
      author: 'Listener',
      content: '<script>literal text</script>',
      likedCount: 1234,
      replyCount: 2,
    },
  ],
  total: 200,
  supportedSorts: ['hot', 'new'],
  repliesSupported: true,
  nextCursor: 'more',
  hasMore: true,
  windowStart: 0,
  error: false,
  loadingMore: false,
  loadMore: vi.fn(),
  retry: vi.fn(),
}));
const useComments = vi.hoisted(() => vi.fn());
const safeArtwork = vi.hoisted(() => vi.fn<() => string | null>(() => null));
vi.mock('../application/song-comments', () => ({ useSongComments: useComments }));
vi.mock('../application/artwork-source', () => ({ useSafeArtworkSource: safeArtwork }));

describe('comments drawer', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('defers offscreen avatar requests until the row approaches the viewport', () => {
    const callbacks: IntersectionObserverCallback[] = [];
    class Observer {
      constructor(callback: IntersectionObserverCallback) {
        callbacks.push(callback);
      }
      observe = vi.fn();
      disconnect = vi.fn();
    }
    vi.stubGlobal('IntersectionObserver', Observer);
    const avatarUrl = 'https://thirdqq.qlogo.cn/comment.jpg';
    useComments.mockReturnValue({ ...state, items: [{ ...state.items[0], avatarUrl }] });
    useCommentsPanelStore.getState().open(allSongs[0]!);
    render(<CommentsPanel />);
    expect(safeArtwork).not.toHaveBeenCalled();
    act(() =>
      callbacks[0]!(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      ),
    );
    expect(safeArtwork).toHaveBeenLastCalledWith(avatarUrl, expect.any(Object));
    act(() =>
      callbacks[0]!(
        [{ isIntersecting: false } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      ),
    );
    expect(document.querySelector('.song-comment__avatar img')).toBeNull();
  });
  beforeEach(() => {
    useCommentsPanelStore.setState({ song: null });
    useComments.mockReset().mockReturnValue(state);
    safeArtwork.mockReset().mockReturnValue(null);
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value() {
        this.setAttribute('open', '');
      },
    });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', {
      configurable: true,
      value() {
        this.removeAttribute('open');
      },
    });
  });
  it('resolves remote comment avatars through the source-scoped artwork cache', () => {
    const song = {
      ...allSongs[0]!,
      provider: { providerId: 'plugin.netease', profileId: 'work', trackId: '1' },
    };
    useCommentsPanelStore.getState().open(song);
    const avatarUrl = 'https://p1.music.126.net/avatar.jpg';
    const cached = 'data:image/jpeg;base64,AA==';
    safeArtwork.mockReturnValue(cached);
    useComments.mockReturnValue({ ...state, items: [{ ...state.items[0], avatarUrl }] });
    render(<CommentsPanel />);
    expect(safeArtwork).toHaveBeenCalledWith(avatarUrl, {
      provider: song.provider,
      pendingRemote: 'hide',
    });
    expect(document.querySelector('.song-comment__avatar img')).toHaveAttribute('src', cached);
  });
  it('opens from a song action, renders plain text and closes with Escape', () => {
    const song = allSongs[0]!;
    const { container } = render(
      <>
        <CommentsButton song={song} />
        <CommentsPanel />
      </>,
    );
    screen.getByRole('button', { name: 'Song comments' }).focus();
    fireEvent.click(screen.getByRole('button', { name: 'Song comments' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('<script>literal text</script>')).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
    expect(container.querySelector('textarea')).toBeNull();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Song comments' })).toHaveFocus();
  });
  it('switches sorting, loads more and expands replies using the comment identity', () => {
    const song = allSongs[0]!;
    useCommentsPanelStore.getState().open(song);
    render(<CommentsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Latest' }));
    expect(useComments).toHaveBeenLastCalledWith(song, true, 'new');
    fireEvent.click(screen.getByRole('button', { name: /Load more comments/ }));
    expect(state.loadMore).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'View 2 replies' }));
    expect(useComments).toHaveBeenLastCalledWith(song, true, 'new', '1');
  });
  it('offers retry on failure and a clear unsupported state', () => {
    act(() => useCommentsPanelStore.getState().open(allSongs[0]!));
    useComments.mockReturnValue({
      ...state,
      items: [],
      status: 'error',
      error: true,
      nextCursor: null,
    });
    const { rerender } = render(<CommentsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(state.retry).toHaveBeenCalled();
    useComments.mockReturnValue({ ...state, items: [], status: 'unsupported', nextCursor: null });
    rerender(<CommentsPanel />);
    expect(
      screen.getByText('This music provider does not support comments yet'),
    ).toBeInTheDocument();
  });

  it('shows the explicit reply sorting limit without suggesting a pointless retry', () => {
    useCommentsPanelStore.getState().open(allSongs[0]!);
    useComments.mockReturnValue({
      ...state,
      error: true,
      limited: true,
      status: 'error',
      items: [],
      nextCursor: null,
    });
    render(<CommentsPanel />);
    expect(screen.getByRole('alert')).toHaveTextContent('limit of 500 replies');
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });
  it('omits invalid dates while keeping valid dates and comment content visible', () => {
    useCommentsPanelStore.getState().open(allSongs[0]!);
    const invalidDates = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER,
      -8_640_000_000_000_001,
    ];
    useComments.mockReturnValue({
      ...state,
      items: [
        ...invalidDates.map((timeMs, index) => ({
          ...state.items[0],
          id: `invalid-${index}`,
          content: `comment-${index}`,
          timeMs,
        })),
        { ...state.items[0], id: 'valid', timeMs: 1_760_000_000_000 },
      ],
    });
    render(<CommentsPanel />);
    for (let index = 0; index < invalidDates.length; index++) {
      expect(screen.getByText(`comment-${index}`)).toBeInTheDocument();
    }
    expect(document.querySelectorAll('time')).toHaveLength(1);
    expect(document.querySelector('time')).toHaveAttribute('datetime', '2025-10-09T08:53:20.000Z');
  });
});
