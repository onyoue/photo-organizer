export interface RawDeveloperEntry {
  name: string;
  path: string;
}

export interface AppSettings {
  raw_developers?: RawDeveloperEntry[];
  active_raw_developer_index?: number;
  /** Legacy single-path field — read-migrated by the backend on load. */
  raw_developer_path?: string;
}

