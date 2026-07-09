import { Component, inject, input, output, signal, computed, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { FileService } from '../../../core/services/file.service';
import { DriveFile, ShareLink, ShareRight } from '../../../core/models/drive-file.model';

@Component({
  selector: 'ds-share-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './share-dialog.component.html',
  styleUrls: ['./share-dialog.component.scss'],
})
export class ShareDialogComponent implements OnInit {
  private fileService = inject(FileService);

  readonly file = input.required<DriveFile>();
  readonly closed = output<void>();
  /** Emitted after create/update/delete so the parent can refresh sharedFileIds. */
  readonly changed = output<void>();

  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly deleting = signal(false);
  readonly error = signal('');
  readonly copied = signal(false);

  /** Null until the first successful create/update/fetch resolves a link. */
  readonly existingLink = signal<ShareLink | null>(null);
  readonly isEditing = computed(() => this.existingLink() !== null);

  readonly right = signal<ShareRight>('public');
  readonly password = signal('');
  readonly canDownload = signal(true);
  readonly canSeeInfo = signal(true);
  readonly canEdit = signal(false);
  readonly canComment = signal(false);
  readonly expiryDate = signal(''); // yyyy-MM-dd, empty = no expiry

  async ngOnInit(): Promise<void> {
    this.loading.set(true);
    try {
      const link = await this.fileService.getShareLink(this.file().id);
      if (link) {
        this.existingLink.set(link);
        this.right.set(link.right);
        this.canDownload.set(link.capabilities?.can_download ?? true);
        this.canSeeInfo.set(link.capabilities?.can_see_info ?? true);
        this.canEdit.set(link.capabilities?.can_edit ?? false);
        this.canComment.set(link.capabilities?.can_comment ?? false);
        if (link.valid_until) {
          this.expiryDate.set(new Date(link.valid_until * 1000).toISOString().slice(0, 10));
        }
      }
    } catch {
      // No link yet, or the lookup failed — treat as "not shared" and let
      // the user create one; errors surface again on actual create/save.
    } finally {
      this.loading.set(false);
    }
  }

  private buildOptions() {
    const r = this.right();
    return {
      right: r,
      can_download: this.canDownload(),
      can_see_info: this.canSeeInfo(),
      can_edit: this.canEdit(),
      can_comment: this.canComment(),
      ...(r === 'password' && this.password() ? { password: this.password() } : {}),
      valid_until: this.expiryDate() ? Math.floor(new Date(this.expiryDate() + 'T23:59:59').getTime() / 1000) : null,
    };
  }

  async save(): Promise<void> {
    if (this.saving()) return;
    if (this.right() === 'password' && !this.password() && !this.isEditing()) {
      this.error.set('Set a password for a password-protected link.');
      return;
    }
    this.saving.set(true);
    this.error.set('');
    try {
      if (this.isEditing()) {
        await this.fileService.updateShareLink(this.file().id, this.buildOptions());
        const refreshed = await this.fileService.getShareLink(this.file().id);
        if (refreshed) this.existingLink.set(refreshed);
      } else {
        const link = await this.fileService.createShareLink(this.file().id, this.buildOptions());
        this.existingLink.set(link);
      }
      this.changed.emit();
    } catch (e) {
      const apiMsg = (e as any)?.error?.error;
      this.error.set(apiMsg ? `Failed to save link: ${apiMsg}` : 'Failed to save the share link.');
    } finally {
      this.saving.set(false);
    }
  }

  async stopSharing(): Promise<void> {
    if (this.deleting()) return;
    this.deleting.set(true);
    this.error.set('');
    try {
      await this.fileService.deleteShareLink(this.file().id);
      this.changed.emit();
      this.closed.emit();
    } catch {
      this.error.set('Failed to stop sharing. Please try again.');
    } finally {
      this.deleting.set(false);
    }
  }

  async copyLink(): Promise<void> {
    const url = this.existingLink()?.url;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    } catch { /* clipboard unavailable — user can select the text manually */ }
  }
}
