import { useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import { ProviderContext, ProviderRegistryContext } from './provider-context';
import type { CommentSort, Song, SongComment, SongCommentsPage } from '../domain/music';
import type { MusicProvider } from '../providers/music-provider';

type CommentsState = SongCommentsPage & {
  status: 'idle' | 'loading' | 'ready' | 'error' | 'unsupported';
  loadingMore: boolean;
  error: boolean;
  limited: boolean;
  hasMore: boolean;
  windowStart: number;
  popularItems: SongComment[];
};

const EMPTY: CommentsState = {
  items: [],
  nextCursor: null,
  total: null,
  supportedSorts: ['hot', 'new'],
  repliesSupported: false,
  status: 'idle',
  loadingMore: false,
  error: false,
  limited: false,
  hasMore: false,
  windowStart: 0,
  popularItems: [],
};

/** Shared by the drawer and lyrics overlay. At most 40 idle entries / 500 comments each. */
const caches = new WeakMap<MusicProvider, Map<string, CommentsEntry>>();

function trimIdle(cache: Map<string, CommentsEntry>) {
  let idle = [...cache.values()].filter((entry) => !entry.listeners.size).length;
  for (const [key, entry] of cache) {
    if (idle <= 40) break;
    if (!entry.listeners.size) {
      cache.delete(key);
      idle--;
    }
  }
}
class CommentsEntry {
  state: CommentsState = EMPTY;
  listeners = new Set<() => void>();
  controller: AbortController | null = null;
  retryMore = false;
  private buffered: SongComment[] = [];
  constructor(
    readonly provider: MusicProvider,
    readonly songId: string,
    readonly sort: CommentSort,
    readonly parentId?: string,
    readonly onIdle?: () => void,
  ) {}
  snapshot = () => this.state;
  update(state: CommentsState) {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size && this.controller) {
        this.controller.abort();
        this.controller = null;
        this.state = {
          ...this.state,
          status: this.state.items.length ? 'ready' : 'idle',
          loadingMore: false,
        };
      }
      if (!this.listeners.size) this.onIdle?.();
    };
  };
  load = async (more = false) => {
    if (this.controller || (more && !this.state.hasMore)) return;
    if (more && this.buffered.length) {
      this.append(this.buffered.splice(0, 20), true);
      return;
    }
    const cursor = more ? this.state.nextCursor : null;
    const controller = new AbortController();
    this.controller = controller;
    this.retryMore = more;
    this.update({
      ...this.state,
      status: more || this.state.items.length ? 'ready' : 'loading',
      loadingMore: more,
      error: false,
      limited: false,
    });
    try {
      let page: SongCommentsPage;
      if (this.provider.getComments) {
        page = await this.provider.getComments(
          { songId: this.songId, sort: this.sort, cursor, limit: 20, parentId: this.parentId },
          controller.signal,
        );
      } else {
        const document = await this.provider.getLyrics(this.songId, controller.signal);
        page = {
          items: document?.comments ?? [],
          nextCursor: null,
          total: null,
          supportedSorts: ['hot'],
          repliesSupported: false,
        };
      }
      if (controller.signal.aborted) return;
      this.buffered = page.items.slice(500);
      this.state = {
        ...this.state,
        ...page,
        items: more ? this.state.items : [],
        nextCursor: page.nextCursor === cursor ? null : page.nextCursor,
        popularItems: more ? this.state.popularItems : page.items.slice(0, 15),
        windowStart: more ? this.state.windowStart : 0,
      };
      this.append(page.items.slice(0, 500), more);
    } catch (error) {
      const unsupported =
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'unsupported-operation';
      if (!controller.signal.aborted)
        this.update({
          ...this.state,
          status: unsupported ? 'unsupported' : this.state.items.length ? 'ready' : 'error',
          loadingMore: false,
          error: !unsupported,
          limited:
            error !== null &&
            typeof error === 'object' &&
            'code' in error &&
            error.code === 'comments-limit-exceeded',
        });
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  };
  private append(rows: SongComment[], more: boolean) {
    const items = new Map<string, SongComment>();
    for (const item of [...(more ? this.state.items : []), ...rows]) items.set(item.id, item);
    const all = [...items.values()];
    const removed = Math.max(0, all.length - 500);
    const window = all.slice(removed);
    this.update({
      ...this.state,
      items: window,
      windowStart: this.state.windowStart + removed,
      hasMore: this.buffered.length > 0 || this.state.nextCursor !== null,
      status: !this.provider.getComments && !window.length ? 'unsupported' : 'ready',
      loadingMore: false,
      error: false,
      limited: false,
    });
  }
}

function entryFor(provider: MusicProvider, songId: string, sort: CommentSort, parentId?: string) {
  let cache = caches.get(provider);
  if (!cache) {
    cache = new Map();
    caches.set(provider, cache);
  }
  const key = JSON.stringify([songId, sort, parentId]);
  let entry = cache.get(key);
  if (!entry) {
    const owner = cache;
    entry = new CommentsEntry(provider, songId, sort, parentId, () => trimIdle(owner));
    cache.set(key, entry);
  }
  return entry;
}

const noopSubscribe = () => () => undefined;
const emptySnapshot = () => EMPTY;

export function useSongComments(
  song: Song | null,
  enabled: boolean,
  sort: CommentSort = 'hot',
  parentId?: string,
) {
  const active = useContext(ProviderContext);
  const registry = useContext(ProviderRegistryContext);
  const reference = song?.provider;
  const provider = reference
    ? (registry?.get(reference.providerId, reference.profileId)?.legacyProvider ??
      (active?.id === reference.providerId && active.profileId === reference.profileId
        ? active
        : null))
    : active;
  const songId = reference?.trackId ?? song?.id;
  const entry = useMemo(
    () => (enabled && provider && songId ? entryFor(provider, songId, sort, parentId) : null),
    [enabled, provider, songId, sort, parentId],
  );
  const state = useSyncExternalStore(
    entry?.subscribe ?? noopSubscribe,
    entry?.snapshot ?? emptySnapshot,
  );
  useEffect(() => {
    // Revalidate the first page on reopening; concurrent viewers share the request.
    if (entry) void entry.load();
  }, [entry]);
  const loadMore = useCallback(() => {
    void entry?.load(true);
  }, [entry]);
  const retry = useCallback(() => {
    if (entry) void entry.load(entry.retryMore);
  }, [entry]);
  const restart = useCallback(() => {
    void entry?.load();
  }, [entry]);
  return {
    ...state,
    status: enabled && !entry ? ('unsupported' as const) : state.status,
    loadMore,
    retry,
    restart,
  };
}
