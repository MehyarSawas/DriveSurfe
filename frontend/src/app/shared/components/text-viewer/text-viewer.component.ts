import { Component, input, OnChanges, SimpleChanges, signal, ElementRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'ds-text-viewer',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="text-wrap" #scrollEl>
      @if (loading()) {
        <div class="text-spinner-wrap"><div class="text-spinner"></div></div>
      }
      @if (error()) {
        <div class="text-error">{{ error() }}</div>
      }
      @if (!loading() && !error()) {
        <pre class="text-content" #contentEl [style.font-size.px]="13 * zoom()">{{ content() }}</pre>
      }
    </div>
  `,
  styles: [`
    :host { display: block; width: 100%; height: 100%; }

    .text-wrap {
      width: 100%;
      height: 100%;
      overflow: auto;
      background: #1e1e1e;
    }

    .text-spinner-wrap {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: none;
    }

    .text-spinner {
      width: 36px;
      height: 36px;
      border: 3px solid rgba(255,255,255,0.2);
      border-top-color: rgba(255,255,255,0.8);
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
    }

    @keyframes spin { to { transform: rotate(360deg); } }

    .text-error {
      color: rgba(255,255,255,0.6);
      padding: 40px;
      text-align: center;
    }

    .text-content {
      margin: 0;
      padding: 16px 20px;
      color: #d4d4d4;
      font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      font-size: 13px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
    }
  `],
})
export class TextViewerComponent implements OnChanges {
  readonly fileId = input.required<string>();
  /** Pinch-zoom: text reflows (pre-wrap) at any size, so plain font-size
   *  scaling is enough — no scale-box/spacer needed like docx/xlsx. */
  readonly zoom = input(1);

  @ViewChild('scrollEl') scrollEl!: ElementRef<HTMLDivElement>;
  @ViewChild('contentEl') contentEl!: ElementRef<HTMLPreElement>;

  // Text past this size isn't useful to read in full inline, and would be
  // slow to fetch/render — cap it and point to downloading the rest.
  private static readonly MAX_BYTES = 2 * 1024 * 1024;
  private static readonly BASE_FONT_PX = 13;

  readonly loading = signal(false);
  readonly error = signal('');
  readonly content = signal('');

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['fileId']) this.load();
  }

  /** Called continuously while two fingers are down, so the line under the
   *  pinch midpoint stays visually fixed as the text scales — like iOS's own
   *  pinch-zoom. Sets font-size directly on the DOM (not just the `zoom`
   *  input) so scrollHeight reflects it immediately, before Angular's own
   *  change detection would otherwise catch up. */
  pinchZoomAt(newZoomInput: number, clientX: number, clientY: number): void {
    const scroll = this.scrollEl?.nativeElement;
    const content = this.contentEl?.nativeElement;
    if (!scroll || !content) return;

    const rect = scroll.getBoundingClientRect();
    const viewX = clientX - rect.left;
    const viewY = clientY - rect.top;
    const oldScale = this.zoom();
    const contentX = (scroll.scrollLeft + viewX) / oldScale;
    const contentY = (scroll.scrollTop + viewY) / oldScale;

    content.style.fontSize = `${TextViewerComponent.BASE_FONT_PX * newZoomInput}px`;

    const maxLeft = Math.max(scroll.scrollWidth - scroll.clientWidth, 0);
    const maxTop = Math.max(scroll.scrollHeight - scroll.clientHeight, 0);
    scroll.scrollLeft = Math.min(Math.max(contentX * newZoomInput - viewX, 0), maxLeft);
    scroll.scrollTop = Math.min(Math.max(contentY * newZoomInput - viewY, 0), maxTop);
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    this.content.set('');

    try {
      const response = await fetch(`/api/files/${this.fileId()}/download`);
      if (!response.ok) throw new Error(`download failed: ${response.status}`);
      const blob = await response.blob();
      const truncated = blob.size > TextViewerComponent.MAX_BYTES;
      const text = await (truncated ? blob.slice(0, TextViewerComponent.MAX_BYTES) : blob).text();
      this.content.set(truncated ? `${text}\n\n… (truncated — download to see the full file)` : text);
    } catch {
      this.error.set('Could not load file');
    } finally {
      this.loading.set(false);
    }
  }
}
