import { create } from 'zustand';
import type { Song } from '../domain/music';

export const useCommentsPanelStore = create<{
  song: Song | null;
  open: (song: Song) => void;
  close: () => void;
}>((set) => ({ song: null, open: (song) => set({ song }), close: () => set({ song: null }) }));
