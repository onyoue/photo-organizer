export interface RawDeveloperEntry {
  name: string;
  path: string;
}

export type Decision = "ok" | "ng";

export interface GallerySettings {
  worker_url?: string;
  admin_token?: string;
  default_decision?: Decision;
}

export interface AppSettings {
  raw_developers?: RawDeveloperEntry[];
  active_raw_developer_index?: number;
  /** Legacy single-path field — read-migrated by the backend on load. */
  raw_developer_path?: string;
  gallery?: GallerySettings;
}

