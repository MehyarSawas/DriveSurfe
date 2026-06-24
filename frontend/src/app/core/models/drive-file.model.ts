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
