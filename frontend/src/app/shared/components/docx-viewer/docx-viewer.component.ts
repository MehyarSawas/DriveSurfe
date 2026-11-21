import { Component, input, OnChanges, SimpleChanges, ElementRef, ViewChild, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { renderAsync } from 'docx-preview';

@Component({
  selector: 'ds-docx-viewer',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="docx-scroll">
      @if (loading()) {
        <div class="docx-spinner-wrap"><div class="docx-spinner"></div></div>
      }
      @if (error()) {
        <div class="docx-error">{{ error() }}</div>
      }
      <div class="docx-body" #bodyEl></div>
    </div>
  `,
  styles: [`
    :host { display: block; width: 100%; height: 100%; }

    .docx-scroll {
      width: 100%;
      height: 100%;
      overflow: auto;
      background: #404040;
      display: flex;
      justify-content: center;
    }

    .docx-spinner-wrap {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: none;
    }

    .docx-spinner {
      width: 36px;
      height: 36px;
      border: 3px solid rgba(255,255,255,0.2);
      border-top-color: rgba(255,255,255,0.8);
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
    }

    @keyframes spin { to { transform: rotate(360deg); } }

    .docx-error {
      color: rgba(255,255,255,0.6);
      padding: 40px;
      text-align: center;
    }

    .docx-body {
      padding: 16px 0;

      /* docx-preview renders each page as its own section with a realistic
         paper width/shadow — just let it size itself, we only scroll around it. */
      :host ::ng-deep .docx-wrapper > section {
        margin-bottom: 16px !important;
      }
    }
  `],
})
export class DocxViewerComponent implements OnChanges {
  readonly fileId = input.required<string>();

  @ViewChild('bodyEl') bodyEl!: ElementRef<HTMLDivElement>;

  readonly loading = signal(false);
  readonly error = signal('');

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['fileId']) this.render();
  }

  private async render(): Promise<void> {
    this.loading.set(true);
    this.error.set('');

    await new Promise(r => setTimeout(r, 0));
    if (!this.bodyEl) return;
    this.bodyEl.nativeElement.innerHTML = '';

    try {
      const response = await fetch(`/api/files/${this.fileId()}/download`);
      if (!response.ok) throw new Error(`download failed: ${response.status}`);
      const blob = await response.blob();
      await renderAsync(blob, this.bodyEl.nativeElement, this.bodyEl.nativeElement);
    } catch {
      this.error.set('Could not load document');
    } finally {
      this.loading.set(false);
    }
  }
}
