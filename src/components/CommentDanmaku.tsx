import type { CSSProperties } from 'react';
import { ThumbsUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { usePreferencesStore } from '../application/preferences';
import { usePlayerStore } from '../application/player-store';
import type { LyricDocument } from '../domain/music';
import { useSongComments } from '../application/song-comments';

/** Read-only popular comments; no account actions are attached to the like count. */
export function CommentDanmaku({ document }: { document: LyricDocument | null }) {
  const enabled = usePreferencesStore((state) => state.lyrics.commentDanmaku);
  const playing = usePlayerStore((state) => state.isPlaying);
  const song = usePlayerStore((state) => state.queue[state.currentIndex] ?? null);
  const state = useSongComments(song, enabled && Boolean(song));
  const { t, i18n } = useTranslation('lyrics');
  const legacy = !song || document?.songId === song.id ? document?.comments : undefined;
  const comments = (state.popularItems.length ? state.popularItems : legacy)?.slice(0, 15);
  if (!enabled || !comments?.length) return null;
  const cycle = Math.max(24, comments.length * 6);
  return (
    <aside
      className="comment-danmaku"
      aria-label={t('popularComments')}
      data-paused={!playing || undefined}
    >
      {comments.map((comment, index) => (
        <div
          className="comment-danmaku__item"
          key={comment.id}
          style={
            {
              '--comment-lane': index % 3,
              '--comment-delay': `${index * 6}s`,
              '--comment-cycle': `${cycle}s`,
            } as CSSProperties
          }
        >
          <span className="comment-danmaku__text">{comment.content}</span>
          <span
            className="comment-danmaku__likes"
            aria-label={t('commentLikes', { count: comment.likedCount })}
          >
            <ThumbsUp size={13} aria-hidden="true" />
            {new Intl.NumberFormat(i18n.resolvedLanguage).format(comment.likedCount)}
          </span>
        </div>
      ))}
    </aside>
  );
}
