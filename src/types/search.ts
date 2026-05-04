export interface SearchHit {
  /** Absolute path of the folder this bundle lives in. */
  folder_path: string;
  bundle_id: string;
  base_name: string;
  /** Hamming distance from the target hash. 0 = identical, lower is better. */
  distance: number;
  /** Absolute path to a file we can use as the visual representative. */
  thumbnail_source?: string;
}

export interface SearchResults {
  hits: SearchHit[];
  /** How many `.photoorg/index.json` files we opened. */
  folders_scanned: number;
  /** Of those, how many contained at least one bundle with a phash —
   *  pre-phash scans are subtracted to surface the "needs re-scan" hint. */
  folders_with_phash: number;
  /** Total bundles encountered across all scanned folders. */
  bundles_total: number;
}
