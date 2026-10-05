import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule, Location } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { MailProcessorService } from '../../core/services/mail-processor.service';
import {
  FilterCondition, MailLogEntry, MailMeta, MailProcessor, ProcessorResult, ProcessorType, SettingField, TestEmail,
} from '../../core/models/mail-processor.model';
import { DriveFile, HOME_FOLDER_ID } from '../../core/models/drive-file.model';
import { FolderPickerComponent } from '../../shared/components/folder-picker/folder-picker.component';

interface FolderValue { id: string; name: string; }

/**
 * Settings page for inbound-email processors: each record = processor type
 * + optional filter + processor-specific settings. The settings form is
 * generated from the schema the backend publishes (`/api/mail/meta`), so a
 * new processor class needs no frontend changes.
 *
 * The draft is a plain mutable object bound with ngModel (zone change
 * detection re-renders it) — far simpler than a signal per nested field.
 */
@Component({
  selector: 'ds-mail-processors',
  standalone: true,
  imports: [CommonModule, FormsModule, FolderPickerComponent],
  templateUrl: './mail-processors.component.html',
  styleUrls: ['./mail-processors.component.scss'],
})
export class MailProcessorsComponent implements OnInit {
  private api = inject(MailProcessorService);
  private router = inject(Router);
  private location = inject(Location);

  readonly homeFolderId = HOME_FOLDER_ID;
  readonly meta = signal<MailMeta | null>(null);
  readonly processors = signal<MailProcessor[]>([]);
  readonly loading = signal(true);
  readonly loadError = signal('');

  readonly draft = signal<MailProcessor | null>(null);
  readonly saving = signal(false);
  readonly deleting = signal(false);
  /** Two-step delete — native confirm() is suppressed in some webviews/PWAs and silently returns false. */
  readonly confirmingDelete = signal(false);
  readonly formError = signal('');

  /** Settings field key whose folder picker is open. */
  readonly pickingFolder = signal<string | null>(null);

  readonly testOpen = signal(false);
  readonly testing = signal(false);
  readonly testResults = signal<ProcessorResult[] | null>(null);
  readonly testError = signal('');
  testEmail: TestEmail & { attachmentNames: string } = this.blankTestEmail();

  readonly log = signal<MailLogEntry[]>([]);
  readonly logOpen = signal(false);
  readonly confirmingClear = signal(false);
  readonly copied = signal(false);

  readonly webhookUrl = computed(() => location.origin + (this.meta()?.webhook.path ?? '/api/hooks/gmail'));

  /** Template input the variable chips insert into (last focused). */
  private activeTemplate: { key: string; el: HTMLInputElement } | null = null;

  async ngOnInit(): Promise<void> {
    try {
      const [meta, processors, log] = await Promise.all([this.api.getMeta(), this.api.list(), this.api.getLog()]);
      this.meta.set(meta);
      this.processors.set(processors);
      this.log.set(log);
    } catch {
      this.loadError.set('Failed to load email processors.');
    } finally {
      this.loading.set(false);
    }
  }

  /** Back to wherever the user came from (e.g. a subfolder); My Drive if this page was opened directly. */
  goBack(): void {
    const navigationId = (this.location.getState() as { navigationId?: number } | null)?.navigationId ?? 1;
    if (navigationId > 1) {
      this.location.back();
    } else {
      this.router.navigate(['/folder', this.homeFolderId]);
    }
  }

  // ── Lookups ────────────────────────────────────────────────────────────

  typeOf(key: string): ProcessorType | undefined {
    return this.meta()?.processors.find(p => p.key === key);
  }

  fieldType(fieldKey: string) {
    return this.meta()?.filter.fields.find(f => f.key === fieldKey)?.type ?? 'string';
  }

  operatorsFor(fieldKey: string) {
    const type = this.fieldType(fieldKey);
    return this.meta()?.filter.operators.filter(o => o.types.includes(type)) ?? [];
  }

  needsValue(operator: string): boolean {
    return this.meta()?.filter.operators.find(o => o.key === operator)?.needs_value ?? true;
  }

  filterSummary(p: MailProcessor): string {
    const conds = p.filter?.conditions ?? [];
    if (!conds.length) return 'All emails';
    const meta = this.meta();
    return conds.map((c, i) => {
      const field = meta?.filter.fields.find(f => f.key === c.field)?.label ?? c.field;
      const op = meta?.filter.operators.find(o => o.key === c.operator)?.label ?? c.operator;
      const part = `${field} ${op}${this.needsValue(c.operator) ? ` "${c.value}"` : ''}`;
      return i === 0 ? part : `${c.join.toUpperCase()} ${part}`;
    }).join(' ');
  }

  // ── List actions ───────────────────────────────────────────────────────

  newProcessor(): void {
    const type = this.meta()?.processors[0];
    if (!type) return;
    const p: MailProcessor = {
      id: '', name: '', enabled: true, stop: false, processor: type.key,
      filter: { conditions: [] }, settings: {},
    };
    this.applyDefaults(p);
    this.openDraft(p);
  }

  edit(p: MailProcessor): void {
    const copy: MailProcessor = structuredClone(p);
    copy.filter ??= { conditions: [] };
    copy.settings ??= {};
    this.applyDefaults(copy);
    this.openDraft(copy);
  }

  private openDraft(p: MailProcessor): void {
    this.formError.set('');
    this.confirmingDelete.set(false);
    this.testResults.set(null);
    this.testError.set('');
    this.draft.set(p);
    window.scrollTo({ top: 0 });
  }

  cancelEdit(): void {
    this.draft.set(null);
    this.pickingFolder.set(null);
    this.confirmingDelete.set(false);
  }

  async toggleEnabled(p: MailProcessor): Promise<void> {
    try {
      const saved = await this.api.save({ ...p, enabled: !p.enabled });
      this.processors.update(list => list.map(x => x.id === saved.id ? saved : x));
    } catch (e) {
      this.loadError.set(this.apiError(e, 'Failed to update processor.'));
    }
  }

  async move(index: number, delta: number): Promise<void> {
    const list = [...this.processors()];
    const target = index + delta;
    if (target < 0 || target >= list.length) return;
    [list[index], list[target]] = [list[target], list[index]];
    this.processors.set(list);
    try {
      this.processors.set(await this.api.reorder(list.map(p => p.id)));
    } catch {
      this.loadError.set('Failed to save the new order.');
    }
  }

  // ── Editor: type + settings ────────────────────────────────────────────

  onTypeChange(p: MailProcessor): void {
    p.settings = {};
    this.applyDefaults(p);
  }

  private applyDefaults(p: MailProcessor): void {
    for (const f of this.typeOf(p.processor)?.settings ?? []) {
      if (p.settings[f.key] !== undefined) continue;
      p.settings[f.key] = f.default !== undefined ? structuredClone(f.default)
        : f.type === 'multiselect' ? []
        : f.type === 'checkbox' ? false
        : f.type === 'folder' ? { id: HOME_FOLDER_ID, name: 'My Drive' }
        : '';
    }
  }

  folderValue(p: MailProcessor, f: SettingField): FolderValue {
    return (p.settings[f.key] as FolderValue) ?? { id: HOME_FOLDER_ID, name: 'My Drive' };
  }

  onFolderPicked(p: MailProcessor, key: string, folder: DriveFile): void {
    p.settings[key] = { id: folder.id, name: folder.name };
    this.pickingFolder.set(null);
  }

  onFolderPath(p: MailProcessor, key: string, path: string): void {
    const current = p.settings[key] as FolderValue | undefined;
    if (current && path) p.settings[key] = { id: current.id, name: path };
  }

  isSelected(p: MailProcessor, f: SettingField, value: string): boolean {
    return ((p.settings[f.key] as string[]) ?? []).includes(value);
  }

  toggleOption(p: MailProcessor, f: SettingField, value: string): void {
    const cur = (p.settings[f.key] as string[]) ?? [];
    p.settings[f.key] = cur.includes(value) ? cur.filter(v => v !== value) : [...cur, value];
  }

  onTemplateFocus(key: string, event: FocusEvent): void {
    this.activeTemplate = { key, el: event.target as HTMLInputElement };
  }

  /** Insert a variable token at the caret of the last focused template field. */
  insertVariable(p: MailProcessor, f: SettingField, token: string): void {
    const value = String(p.settings[f.key] ?? '');
    const el = this.activeTemplate?.key === f.key ? this.activeTemplate.el : null;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    p.settings[f.key] = value.slice(0, start) + token + value.slice(end);
    if (el) {
      queueMicrotask(() => {
        el.focus();
        el.setSelectionRange(start + token.length, start + token.length);
      });
    }
  }

  /** File-name variables only make sense in file-name templates. */
  variablesFor(f: SettingField) {
    const all = this.meta()?.variables ?? [];
    return f.key.includes('file') ? all : all.filter(v => !v.token.startsWith('{file:'));
  }

  // ── Editor: filter ─────────────────────────────────────────────────────

  addCondition(p: MailProcessor): void {
    p.filter.conditions.push({ join: 'and', field: 'from', operator: 'contains', value: '' });
  }

  removeCondition(p: MailProcessor, i: number): void {
    p.filter.conditions.splice(i, 1);
  }

  onFieldChange(c: FilterCondition): void {
    if (!this.operatorsFor(c.field).some(o => o.key === c.operator)) {
      c.operator = this.operatorsFor(c.field)[0]?.key ?? 'equals';
    }
  }

  valueInputType(c: FilterCondition): string {
    const t = this.fieldType(c.field);
    return t === 'number' ? 'number' : t === 'date' ? 'date' : 'text';
  }

  // ── Editor: save / delete ──────────────────────────────────────────────

  async save(): Promise<void> {
    const p = this.draft();
    if (!p || this.saving()) return;
    if (!p.name.trim()) {
      this.formError.set('Give the processor a name.');
      return;
    }
    this.saving.set(true);
    this.formError.set('');
    try {
      const saved = await this.api.save(p);
      this.processors.update(list => p.id ? list.map(x => x.id === saved.id ? saved : x) : [...list, saved]);
      this.draft.set(null);
    } catch (e) {
      this.formError.set(this.apiError(e, 'Failed to save the processor.'));
    } finally {
      this.saving.set(false);
    }
  }

  async remove(): Promise<void> {
    const p = this.draft();
    if (!p?.id || this.deleting()) return;
    if (!this.confirmingDelete()) {
      this.confirmingDelete.set(true);
      return;
    }
    this.deleting.set(true);
    try {
      await this.api.delete(p.id);
      this.processors.update(list => list.filter(x => x.id !== p.id));
      this.draft.set(null);
    } catch (e) {
      this.formError.set(this.apiError(e, 'Failed to delete the processor.'));
    } finally {
      this.deleting.set(false);
      this.confirmingDelete.set(false);
    }
  }

  // ── Dry-run test ───────────────────────────────────────────────────────

  async runTest(): Promise<void> {
    const p = this.draft();
    if (this.testing()) return;
    this.testing.set(true);
    this.testError.set('');
    this.testResults.set(null);
    const t = this.testEmail;
    const email: TestEmail = {
      from: t.from,
      to: t.to,
      subject: t.subject,
      date: t.date ? new Date(t.date).toISOString() : new Date().toISOString(),
      labels: t.labels,
      attachments: t.attachmentNames.split(',').map(n => n.trim()).filter(Boolean)
        .map(name => ({ name, mime_type: 'application/octet-stream' })),
    };
    try {
      // Editing → test the unsaved draft on its own; otherwise all saved processors.
      this.testResults.set(await this.api.test(email, p ?? undefined));
    } catch (e) {
      this.testError.set(this.apiError(e, 'Test failed.'));
    } finally {
      this.testing.set(false);
    }
  }

  private blankTestEmail(): TestEmail & { attachmentNames: string } {
    return {
      from: 'Billing <billing@example.com>', to: '', subject: 'Your invoice', date: '',
      labels: ['INBOX'], attachments: [], attachmentNames: 'invoice.pdf, logo.png',
    };
  }

  // ── Webhook + log ──────────────────────────────────────────────────────

  async copyUrl(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.webhookUrl());
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    } catch { /* clipboard unavailable — the URL is selectable */ }
  }

  async refreshLog(): Promise<void> {
    try { this.log.set(await this.api.getLog()); } catch { /* keep the old list */ }
  }

  async clearLog(): Promise<void> {
    if (!this.confirmingClear()) {
      this.confirmingClear.set(true);
      return;
    }
    try {
      await this.api.clearLog();
      this.log.set([]);
    } catch { /* ignore */ } finally {
      this.confirmingClear.set(false);
    }
  }

  logStatus(entry: MailLogEntry): 'ok' | 'error' | 'none' {
    if (!entry.results.length) return 'none';
    return entry.results.some(r => r.status === 'error') ? 'error' : 'ok';
  }

  private apiError(e: unknown, fallback: string): string {
    const msg = (e as { error?: { error?: string } })?.error?.error;
    return msg ? msg : fallback;
  }
}
