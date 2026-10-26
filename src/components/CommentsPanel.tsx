import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Heart, MessageCircle, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useCommentsPanelStore } from '../application/comments-panel-store';
import { useSongComments } from '../application/song-comments';
import { useSafeArtworkSource } from '../application/artwork-source';
import type { CommentSort, Song, SongComment } from '../domain/music';
import { IconButton } from './ui/IconButton';
import '../styles/comments.css';

function CommentAvatar({ comment, song }: { comment: SongComment; song: Song }) {
  const [failed, setFailed] = useState<string | null>(null);
  const source = useSafeArtworkSource(
    comment.avatarUrl?.startsWith('https://') ? comment.avatarUrl : null,
    { provider: song.provider, pendingRemote: 'hide' },
  );
  return source && source !== failed ? (
    <img
      src={source}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(source)}
    />
  ) : (
    Array.from(comment.author)[0] || '♪'
  );
}

function CommentRow({
  comment,
  song,
  repliesSupported,
  reply = false,
}: {
  comment: SongComment;
  song: Song;
  repliesSupported: boolean;
  reply?: boolean;
}) {
  const { t, i18n } = useTranslation('lyrics', { keyPrefix: 'comments' });
  const [expanded, setExpanded] = useState(false);
  const [replies, setReplies] = useState(false);
  const row = useRef<HTMLElement>(null);
  const [nearViewport, setNearViewport] = useState(
    () => typeof IntersectionObserver !== 'function',
  );
  useEffect(() => {
    if (!row.current) return;
    if (typeof IntersectionObserver !== 'function') return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1);
        if (entry) setNearViewport(entry.isIntersecting);
      },
      { rootMargin: '160px' },
    );
    observer.observe(row.current);
    return () => observer.disconnect();
  }, []);
  const date = typeof comment.timeMs === 'number' ? new Date(comment.timeMs) : null;
  const validDate = date && Number.isFinite(date.getTime()) ? date : null;
  return (
    <article ref={row} className={`song-comment${reply ? ' song-comment--reply' : ''}`}>
      <div className="song-comment__avatar" aria-hidden="true">
        {nearViewport ? (
          <CommentAvatar comment={comment} song={song} />
        ) : (
          Array.from(comment.author)[0] || '♪'
        )}
      </div>
      <div className="song-comment__body">
        <span className="song-comment__author">{comment.author || t('anonymous')}</span>
        <p
          className="song-comment__content"
          data-expanded={expanded || undefined}
          data-collapsible={comment.content.length > 280 || undefined}
        >
          {comment.content}
        </p>
        {comment.content.length > 280 && (
          <button
            type="button"
            className="song-comments__text-button"
            onClick={() => setExpanded(!expanded)}
          >
            {t(expanded ? 'collapse' : 'expand')}
          </button>
        )}
        {comment.replyTo && (
          <blockquote className="song-comment__quote">
            <b>{comment.replyTo.author}</b> · {comment.replyTo.content}
          </blockquote>
        )}
        <div className="song-comment__meta">
          {validDate && (
            <time dateTime={validDate.toISOString()}>
              {new Intl.DateTimeFormat(i18n.resolvedLanguage, { dateStyle: 'medium' }).format(
                validDate,
              )}
            </time>
          )}
          <span
            className="song-comment__likes"
            aria-label={t('likes', { count: comment.likedCount })}
          >
            <Heart size={13} aria-hidden="true" />
            {new Intl.NumberFormat(i18n.resolvedLanguage, { notation: 'compact' }).format(
              comment.likedCount,
            )}
          </span>
        </div>
        {!reply && repliesSupported && Boolean(comment.replyCount) && (
          <button
            type="button"
            className="song-comments__text-button song-comment__reply-toggle"
            aria-expanded={replies}
            onClick={() => setReplies(!replies)}
          >
            <span />
            {t(replies ? 'hideReplies' : 'viewReplies', { count: comment.replyCount ?? 0 })}
            <ChevronDown size={13} style={{ transform: replies ? 'rotate(180deg)' : undefined }} />
          </button>
        )}
        {replies && <CommentReplies song={song} parentId={comment.id} />}
      </div>
    </article>
  );
}

function CommentReplies({ song, parentId }: { song: Song; parentId: string }) {
  const { t } = useTranslation('lyrics', { keyPrefix: 'comments' });
  const state = useSongComments(song, true, 'new', parentId);
  return (
    <div
      className="song-comment__replies"
      aria-busy={state.status === 'loading' || state.loadingMore}
    >
      {state.windowStart > 0 && (
        <button className="song-comments__text-button" type="button" onClick={state.restart}>
          {t('backToStart')}
        </button>
      )}
      {state.items.map((comment) => (
        <CommentRow key={comment.id} comment={comment} song={song} repliesSupported={false} reply />
      ))}
      {state.status === 'loading' && (
        <p className="song-comments__status" role="status">
          {t('loading')}
        </p>
      )}
      {state.status === 'ready' && !state.items.length && (
        <p className="song-comments__status">{t('noReplies')}</p>
      )}
      {state.error ? (
        state.limited ? (
          <p className="song-comments__status" role="alert">
            {t('limited')}
          </p>
        ) : (
          <button className="song-comments__text-button" type="button" onClick={state.retry}>
            {t('retry')}
          </button>
        )
      ) : (
        state.hasMore && (
          <button
            className="song-comments__text-button"
            type="button"
            disabled={state.loadingMore}
            onClick={state.loadMore}
          >
            {t(state.loadingMore ? 'loading' : 'moreReplies')}
          </button>
        )
      )}
    </div>
  );
}

function CommentsDrawer({ song }: { song: Song }) {
  const { t } = useTranslation('lyrics', { keyPrefix: 'comments' });
  const close = useCommentsPanelStore((state) => state.close);
  const [sort, setSort] = useState<CommentSort>('hot');
  const state = useSongComments(song, true, sort);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    const previous = document.activeElement;
    node?.showModal?.();
    return () => {
      node?.close?.();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="song-comments-modal"
      aria-labelledby="song-comments-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape') {
          event.preventDefault();
          close();
        }
      }}
    >
      <section className="song-comments" aria-label={t('title')}>
        <header className="song-comments__header">
          <div>
            <h2 id="song-comments-title">
              {t('title')}
              {state.total !== null && <span>{new Intl.NumberFormat().format(state.total)}</span>}
            </h2>
            <p title={song.title}>
              {song.title} <span>· {song.artists.map((artist) => artist.name).join(' / ')}</span>
            </p>
          </div>
          <IconButton label={t('close')} onClick={close}>
            <X size={20} />
          </IconButton>
        </header>
        <nav className="song-comments__sort" aria-label={t('sort')}>
          {(['hot', 'new'] as const).map((value) => (
            <button
              type="button"
              key={value}
              aria-pressed={sort === value}
              disabled={!state.supportedSorts.includes(value)}
              onClick={() => setSort(value)}
            >
              {t(value)}
            </button>
          ))}
        </nav>
        <div key={sort} className="song-comments__list" aria-busy={state.status === 'loading'}>
          {state.windowStart > 0 && (
            <button className="song-comments__text-button" type="button" onClick={state.restart}>
              {t('backToStart')}
            </button>
          )}
          {state.status === 'loading' && (
            <div className="song-comments__skeleton" role="status" aria-label={t('loading')}>
              {[0, 1, 2, 3].map((index) => (
                <div key={index}>
                  <span />
                  <i />
                  <i />
                </div>
              ))}
            </div>
          )}
          {state.items.map((comment) => (
            <CommentRow
              key={comment.id}
              comment={comment}
              song={song}
              repliesSupported={state.repliesSupported}
            />
          ))}
          {(state.status === 'unsupported' ||
            (state.status === 'ready' && !state.items.length)) && (
            <div className="song-comments__empty">
              <MessageCircle size={36} strokeWidth={1.25} />
              <p>{t(state.status === 'unsupported' ? 'unsupported' : 'empty')}</p>
            </div>
          )}
          {state.error && (
            <div className="song-comments__status" role="alert">
              <p>{t(state.limited ? 'limited' : 'failed')}</p>
              {!state.limited && (
                <button className="button button--quiet" type="button" onClick={state.retry}>
                  {t('retry')}
                </button>
              )}
            </div>
          )}
          {!state.error && state.hasMore && (
            <button
              className="song-comments__more"
              type="button"
              disabled={state.loadingMore}
              onClick={state.loadMore}
            >
              {t(state.loadingMore ? 'loading' : 'loadMore')}
              <ChevronDown size={15} />
            </button>
          )}
        </div>
        <footer className="song-comments__footer">
          <MessageCircle size={14} />
          {t('footer')}
        </footer>
      </section>
    </dialog>
  );
}

export function CommentsPanel() {
  const song = useCommentsPanelStore((state) => state.song);
  return song
    ? createPortal(
        <CommentsDrawer
          key={`${song.provider?.providerId}:${song.provider?.profileId}:${song.id}`}
          song={song}
        />,
        document.fullscreenElement ?? document.body,
      )
    : null;
}

export function CommentsButton({
  song,
  size = 'small',
}: {
  song: Song | null;
  size?: 'small' | 'large';
}) {
  const { t } = useTranslation('lyrics', { keyPrefix: 'comments' });
  const open = useCommentsPanelStore((state) => state.open);
  return (
    <IconButton
      label={t('open')}
      size={size}
      disabled={!song}
      onClick={() => {
        if (song) open(song);
      }}
    >
      <MessageCircle size={18} />
    </IconButton>
  );
}
