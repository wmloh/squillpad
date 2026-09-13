import type {
  CanvasElement,
  PageManifest,
  ProfileDrawingPalettes,
  ProfileSettings,
} from "@squillpad/core-model";
import type { PageSyncClient } from "@squillpad/synchronization";

export type HierarchyCommand = Readonly<Record<string, unknown>> & { readonly action: string };

export interface Selection {
  readonly sectionId?: string;
  readonly pageId?: string;
}

export interface PageRoute extends Selection {
  readonly projectId?: string;
}

export interface PageData {
  readonly canvas: readonly CanvasElement[];
  readonly manifest: PageManifest;
  readonly markdown: Readonly<Record<string, string>>;
}

export interface LivePage {
  readonly client: PageSyncClient;
  readonly document: ReturnType<typeof import("@squillpad/synchronization").createPageDocument>;
  readonly disposeObserver: () => void;
}

export type SaveStatus = "saving" | "saved" | "error";

export interface SaveSnapshot {
  readonly status: SaveStatus;
  readonly revision: number;
  readonly dirty?: boolean;
  readonly error?: string;
}

export interface SynchronizationStatusResponse {
  readonly canonical?: Readonly<Record<string, SaveSnapshot>>;
  readonly synchronizationGeneration: string;
}

export interface StorageDiagnosticsResponse {
  readonly canonicalBytes: number;
  readonly canonicalFileCount: number;
  readonly runtimeCacheBytes: number;
  readonly runtimeCacheFileCount: number;
}

export interface RuntimeCacheCleanupResponse {
  readonly removedBytes: number;
  readonly removedFileCount: number;
}

export interface AuthenticationStatusResponse {
  readonly authenticated: boolean;
  readonly hostAuthorized: boolean;
  readonly profileSettingsAvailable?: boolean;
  readonly profileSettings?: ProfileSettings;
  readonly palmRejection?: boolean;
  readonly drawingPalettes?: ProfileDrawingPalettes;
  readonly username?: string;
  readonly toolbarHeight?: number;
}

export interface ProjectPresenceMember {
  readonly id: string;
  readonly username: string;
  readonly ipAddress: string;
}

export interface ProjectPresenceResponse {
  readonly participants: readonly ProjectPresenceMember[];
}

export type CanvasFullscreenPhase = "closed" | "opening" | "open" | "closing";
