import {
  Component, input, OnChanges, SimpleChanges,
  ElementRef, ViewChild, signal, NgZone
} from '@angular/core';
import { CommonModule } from '@angular/common';
import * as pdfjsLib from 'pdfjs-dist';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/assets/pdf.worker.min.mjs';

@Component({
  selector: 'ds-pdf-viewer',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="pdf-scroll" #scrollEl [class.zoom-locked]="zoom() > 1">
      @if (loading()) {
        <div class="pdf-spinner-wrap"><div class="pdf-spinner"></div></div>
      }
      @if (error()) {
        <div class="pdf-error">{{ error() }}</div>
      }
      <div class="pdf-pages" #pagesEl></div>
    </div>
  `,
  styles: [`
    :host { display: block; width: 100%; height: 100%; }

    .pdf-scroll {
      width: 100%;
      height: 100%;
      overflow-y: auto;
      overflow-x: hidden;
      &.zoom-locked { overflow: hidden; }
      background: #404040;
      display: flex;
      flex-direction: column;
      align-items: center;
    }

    .pdf-spinner-wrap {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: none;
    }

    .pdf-spinner {
      width: 36px;
      height: 36px;
      border: 3px solid rgba(255,255,255,0.2);
      border-top-color: rgba(255,255,255,0.8);
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
    }

    @keyframes spin { to { transform: rotate(360deg); } }

    .pdf-pages {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
      padding: 16px 0;
      width: 100%;
    }

    .pdf-error {
      color: rgba(255,255,255,0.6);
      padding: 40px;
      text-align: center;
    }

    canvas {
      display: block;
      max-width: 100%;
      box-shadow: 0 2px 12px rgba(0,0,0,0.5);
    }
  `],
})
export class PdfViewerComponent implements OnChanges {
  readonly fileId = input.required<string>();
  readonly zoom = input(1);

  @ViewChild('pagesEl') pagesEl!: ElementRef<HTMLDivElement>;

  readonly loading = signal(false);
  readonly error = signal('');

  constructor(private zone: NgZone) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['fileId']) {
      this.render();
    }
  }

  private async render(): Promise<void> {
    this.loading.set(true);
    this.error.set('');

    // Wait for view to be ready
    await new Promise(r => setTimeout(r, 0));
    if (!this.pagesEl) return;
    this.pagesEl.nativeElement.innerHTML = '';

    try {
      const response = await fetch(`/api/files/${this.fileId()}/download`);
      const buffer = await response.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;

      this.loading.set(false);

      const containerWidth = this.pagesEl.nativeElement.clientWidth - 32;
      const dpr = window.devicePixelRatio || 1;

      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const unscaled = page.getViewport({ scale: 1 });
        const scale = containerWidth / unscaled.width;
        const viewport = page.getViewport({ scale: scale * dpr });

        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        // Display at logical size so it looks correct on screen
        canvas.style.width = `${viewport.width / dpr}px`;
        canvas.style.height = `${viewport.height / dpr}px`;

        const ctx = canvas.getContext('2d')!;
        await page.render({ canvasContext: ctx, viewport, canvas }).promise;

        this.zone.run(() => this.pagesEl.nativeElement.appendChild(canvas));
      }
    } catch (e) {
      this.loading.set(false);
      this.error.set('Could not load PDF');
    }
  }
}
