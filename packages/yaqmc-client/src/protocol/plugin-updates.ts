export type PluginReleaseChannel = 'stable' | 'beta' | 'nightly';
export interface PluginReleaseInfo {
  channel: PluginReleaseChannel;
  buildId: string;
  releaseSequence: number;
}
export interface PluginUpdatePolicy {
  sourceId: string | null;
  channel: PluginReleaseChannel;
  automatic: boolean;
  bound: boolean;
  lastCheckMs: number;
  lastResult: string | null;
  failedSha256: string | null;
}
export interface PluginUpdateSource {
  id: string;
  pluginId: string;
  name: string;
  repository: string;
  feedUrl: string;
  keyId: string;
  publicKey: string;
  downloadOrigins: string[];
}
export interface PluginAvailableRelease extends PluginReleaseInfo {
  releaseId: string;
  sourceId: string;
  pluginId: string;
  version: string;
  sha256: string;
  size: number;
  url: string;
  expiresAtMs: number;
}
export interface PluginUpdateInfo {
  policy: PluginUpdatePolicy;
  sources: PluginUpdateSource[];
  available: PluginAvailableRelease[];
}
export interface PluginUpdatePolicyRequest {
  pluginId: string;
  sourceId: string | null;
  channel: PluginReleaseChannel;
  automatic: boolean;
  confirmSource?: boolean;
}
export interface PluginUpdatePrepareRequest {
  pluginId?: string;
  path?: string;
  releaseId?: string;
  unpacked?: boolean;
}
export interface PluginUpdateApplyRequest {
  operationId: string;
  grant?: string[];
  confirm?: boolean;
  stopUsing?: boolean;
  automatic?: boolean;
}
export interface PluginUpdatePreview {
  pluginId: string;
  providerIds: string[];
  name: string;
  currentVersion: string | null;
  expectedGeneration: number | null;
  version: string;
  currentSha256: string | null;
  sha256: string;
  release: PluginReleaseInfo | null;
  permissions: string[];
  grantedPermissions: string[];
  addedPermissions: string[];
  removedPermissions: string[];
  sessionChanges: string[];
  confirmations: string[];
  trustedSource: string | null;
  enabled: boolean;
  needsRenderer: boolean;
  hasScript: boolean;
}
export interface PluginUpdateOperation {
  operationId: string;
  pluginId: string | null;
  phase: string;
  preview: PluginUpdatePreview | null;
  downloadedBytes: number;
  totalBytes: number | null;
  error: string | null;
  runtimeChanged: boolean;
}
export interface PluginUpdateRuntimeReadyRequest {
  operationId: string;
  sha256: string;
  stage: 'quiescing' | 'validating';
  error?: string;
}
