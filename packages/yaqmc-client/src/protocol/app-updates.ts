export type AppBuildSource = 'official-release' | 'source' | 'unknown';
export type AppPackageKind = 'nsis' | 'portable' | 'AppImage' | 'managed';

export interface AppUpdateCandidate {
  id: string;
  releaseId: number;
  tag: string;
  version: string;
  releaseUrl: string;
  notes: string;
  asset?: {
    id: number;
    name: string;
    size: number;
    sha256: string;
    url: string;
    metadataUrl?: string;
  };
}

export interface AppUpdateProgress {
  transferred: number;
  total: number;
  percent: number;
}
