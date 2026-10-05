export type FilterFieldType = 'string' | 'list' | 'number' | 'date';
export type FilterJoin = 'and' | 'or';

export interface FilterCondition {
  join: FilterJoin;
  field: string;
  operator: string;
  value: string;
}

export interface ProcessorFilter {
  conditions: FilterCondition[];
}

export interface MailProcessor {
  id: string;
  name: string;
  enabled: boolean;
  /** Stop evaluating later processors once this one matches. */
  stop: boolean;
  processor: string;
  filter: ProcessorFilter;
  settings: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export type SettingType = 'text' | 'template' | 'folder' | 'multiselect' | 'checkbox';

export interface SettingField {
  key: string;
  type: SettingType;
  label: string;
  help?: string;
  placeholder?: string;
  default?: unknown;
  required?: boolean;
  options?: { value: string; label: string }[];
}

export interface ProcessorType {
  key: string;
  label: string;
  description: string;
  settings: SettingField[];
}

export interface MailMeta {
  processors: ProcessorType[];
  filter: {
    fields: { key: string; label: string; type: FilterFieldType }[];
    operators: { key: string; label: string; types: FilterFieldType[]; needs_value: boolean }[];
  };
  variables: { token: string; description: string }[];
  webhook: { configured: boolean; path: string; max_mb: number };
}

export interface ProcessorResult {
  processor_id: string;
  name: string;
  status: 'ok' | 'skipped' | 'error';
  detail: string;
  files?: { name: string; original: string; path: string; size: number; id?: string; error?: string }[];
}

export interface MailLogEntry {
  at: string;
  email: {
    id: string; from: string; subject: string; date: string;
    attachments: { name: string; size: number; mime_type?: string; inline?: boolean }[];
  };
  results: ProcessorResult[];
}

/** Sample email for dry-run tests from the settings page. */
export interface TestEmail {
  from: string;
  to: string;
  subject: string;
  date: string;
  labels: string[];
  attachments: { name: string; mime_type: string }[];
}
