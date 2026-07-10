export interface DriveFile {
  id: string;
  name: string;
  type: 'file' | 'dir';
  mime_type: string;
  size: number;
  modified_at: string | null;
  created_at: string | null;
  is_dir: boolean;
  is_favorite: boolean;
  parent_id: string;
  thumbnail_url: string | null;
  preview_url: string | null;
  extension: string;
  /** Only populated on the /api/shares listing — not fetched per-file elsewhere. */
  share_link?: ShareLink | null;
}

export type ShareRight = 'inherit' | 'password' | 'public';

export interface ShareLink {
  url: string | null;
  file_id: string | null;
  right: ShareRight;
  valid_until: number | null;
  created_at: number | null;
  updated_at: number | null;
  access_blocked: boolean;
  views?: number | null;
  /** Sub-fields aren't fully documented by kDrive; read whichever can_* keys exist. */
  capabilities?: {
    can_comment?: boolean;
    can_download?: boolean;
    can_edit?: boolean;
    can_request_access?: boolean;
    can_see_info?: boolean;
    can_see_stats?: boolean;
    [key: string]: unknown;
  };
}

export interface ShareLinkOptions {
  right: ShareRight;
  can_comment?: boolean;
  can_download?: boolean;
  can_edit?: boolean;
  can_request_access?: boolean;
  can_see_info?: boolean;
  can_see_stats?: boolean;
  password?: string;
  valid_until?: number | null;
}

export type SortBy = 'name' | 'last_modified_at' | 'size';
export type SortDir = 'asc' | 'desc';
export type ViewMode = 'grid' | 'grid-large' | 'list';

// kDrive personal-space root (the "private" system folder the native app hides)
export const HOME_FOLDER_ID = '5';

export interface FileListOptions {
  folderId: string;
  sortBy: SortBy;
  sortDir: SortDir;
  type?: string;
}

export interface PreviewSession {
  id: string;
  file_id: string;
  file_name: string;
  folder_id: string;
  folder_name: string;
  thumbnail_url: string | null;
  saved_at: string;
  adjacent_files?: DriveFile[];
}

export interface BreadcrumbItem {
  id: string;
  name: string;
}

/** One existing month in the media timeline, with its newest media file as cover. */
export interface MonthCover {
  key: string;   // 'YYYY-MM'
  year: number;
  month: number; // 1-12
  cover: DriveFile;
}

/** One batch of timeline month covers (newest first). The backend walks the
 *  media stream backwards a batch at a time; `complete` is false while more
 *  history remains, and `next_before` is the resume point for the next call. */
export interface MediaMonthsResponse {
  months: MonthCover[];
  next_before: number | null;
  complete: boolean;
}
