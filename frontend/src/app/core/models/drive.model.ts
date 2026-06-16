export interface FolderTreeNode {
  id: string;
  name: string;
  children: FolderTreeNode[];
}

export interface DriveUsage {
  used: number;
  total: number;
}

export type DriveProvider = 'kdrive';
