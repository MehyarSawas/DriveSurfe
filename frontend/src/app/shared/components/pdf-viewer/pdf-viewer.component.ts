import {
  Component, input, OnChanges, SimpleChanges, computed,
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
    <div class="pdf-scroll" #scrollEl>
      @if (loading()) {
        <div class="pdf-spinner-wrap"><div class="pdf-spinner"></div></div>
      }
      @if (error()) {
        <div class="pdf-error">{{ error() }}</div>
      }
      <div class="pdf-scale-box" #scaleBoxEl [style.width.px]="scaledWidth()" [style.height.px]="scaledHeight()">
        <div class="pdf-pages" #pagesEl [style.transform]="'scale(' + scale() + ')'"></div>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; width: 100%; height: 100%; }

    .pdf-scroll {
      width: 100%;
      height: 100%;
      overflow: auto;
      background: #404040;
    }

    /* Sized to the post-scale footprint so the scroll container's own
       scrollWidth/scrollHeight — and therefore native touch scrolling and
       pinch-to-point/drag panning — stay correct at any zoom level (same
       reasoning as docx-viewer's identical .docx-scale-box). Centered via
       margin:auto, not a flex parent + justify-content:center — see
       docx-viewer's .docx-scale-box comment for why that distinction
       matters once content is wider than the scroll container. */
    .pdf-scale-box {
      margin: 0 auto;
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
      width: max-content;
      /* Must anchor at the scale-box's own origin — see docx-viewer's
         identical .docx-body comment: the box is sized to exactly
         naturalWidth*scale × naturalHeight*scale, which only lines up with
         the scaled-down content when it grows from (0,0). */
      transform-origin: top left;
    }

    .pdf-error {
      color: rgba(255,255,255,0.6);
      padding: 40px;
      text-align: center;
    }

    canvas {
      display: block;
      box-shadow: 0 2px 12px rgba(0,0,0,0.5);
    }
  `],
})
export class PdfViewerComponent implements OnChanges {
  readonly fileId = input.required<string>();
  /** Pinch-zoom multiplier. No separate fit-to-width factor to track like
   *  docx/xlsx have (`baseScale`) — each page's canvas is already rendered
   *  at the resolution that makes it exactly fill the container's width at
   *  zoom 1, so the CSS scale here maps 1:1 onto the `zoom` input, same as
   *  ds-text-viewer. */
  readonly zoom = input(1);

  @ViewChild('pagesEl') pagesEl!: ElementRef<HTMLDivElement>;
  @ViewChild('scrollEl') scrollEl!: ElementRef<HTMLDivElement>;
  @ViewChild('scaleBoxEl') scaleBoxEl!: ElementRef<HTMLDivElement>;

  readonly loading = signal(false);
  readonly error = signal('');

  private readonly naturalWidth = signal(0);
  private readonly naturalHeight = signal(0);

  readonly scale = computed(() => this.zoom());
  readonly scaledWidth = computed(() => this.naturalWidth() * this.scale());
  readonly scaledHeight = computed(() => this.naturalHeight() * this.scale());

  constructor(private zone: NgZone) {}

  /** The content-space point (unscaled coordinates) that was under the
   *  fingers when the current pinch gesture began — fixed for the gesture's
   *  whole duration. See docx-viewer's identical field for why it must stay
   *  fixed rather than being recomputed every frame. */
  private pinchAnchorX = 0;
  private pinchAnchorY = 0;

  /** Call once when a pinch gesture starts (not on every move). Returns the
   *  scale actually measured off the DOM, so the caller can use this exact
   *  same number as its own "zoom at gesture start" reference — using the
   *  `zoom` input signal instead (which can lag a render behind the real
   *  DOM state) would let the two slowly diverge, the same class of bug
   *  documented on docx-viewer's identical method. No baseScale factor to
   *  divide out here (unlike docx/xlsx) — scale is just zoom directly. */
  beginPinch(clientX: number, clientY: number): number {
    const scroll = this.scrollEl?.nativeElement;
    const box = this.scaleBoxEl?.nativeElement;
    const w0 = this.naturalWidth();
    if (!scroll || !box || !w0) return 1;
    const rect = scroll.getBoundingClientRect();
    const curScale = box.offsetWidth / w0;
    this.pinchAnchorX = (scroll.scrollLeft + (clientX - rect.left)) / curScale;
    this.pinchAnchorY = (scroll.scrollTop + (clientY - rect.top)) / curScale;
    return curScale;
  }

  /** Called continuously while two fingers are down, so the point under the
   *  pinch midpoint stays visually fixed as the document scales, and the
   *  view pans if the fingers drag — like iOS's own pinch-zoom. Applies the
   *  new scale straight to the DOM (not just the `zoom` input signal) so
   *  scrollWidth/Height are correct immediately, before Angular's own change
   *  detection would otherwise catch up. */
  pinchZoomAt(newZoomInput: number, clientX: number, clientY: number): void {
    const scroll = this.scrollEl?.nativeElement;
    const box = this.scaleBoxEl?.nativeElement;
    const pages = this.pagesEl?.nativeElement;
    if (!scroll || !box || !pages || !this.naturalWidth()) return;

    const rect = scroll.getBoundingClientRect();
    const viewX = clientX - rect.left;
    const viewY = clientY - rect.top;

    const w = this.naturalWidth() * newZoomInput;
    const h = this.naturalHeight() * newZoomInput;
    box.style.width = `${w}px`;
    box.style.height = `${h}px`;
    pages.style.transform = `scale(${newZoomInput})`;

    const maxLeft = Math.max(w - scroll.clientWidth, 0);
    const maxTop = Math.max(h - scroll.clientHeight, 0);
    scroll.scrollLeft = Math.min(Math.max(this.pinchAnchorX * newZoomInput - viewX, 0), maxLeft);
    scroll.scrollTop = Math.min(Math.max(this.pinchAnchorY * newZoomInput - viewY, 0), maxTop);
  }

  /** Called by the parent right after it snaps `zoom` back to 1 at the end
   *  of a pinch gesture — returns cleanly to the top-left at the base scale
   *  instead of leaving whatever scroll position the gesture's last frame
   *  happened to leave against the *old* (different) content size. */
  resetScroll(): void {
    const scroll = this.scrollEl?.nativeElement;
    const box = this.scaleBoxEl?.nativeElement;
    const pages = this.pagesEl?.nativeElement;
    if (!scroll || !box || !pages) return;
    box.style.width = `${this.naturalWidth()}px`;
    box.style.height = `${this.naturalHeight()}px`;
    pages.style.transform = 'scale(1)';
    scroll.scrollLeft = 0;
    scroll.scrollTop = 0;
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['fileId']) {
      this.render();
    }
  }

  private async render(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    this.naturalWidth.set(0);
    this.naturalHeight.set(0);

    // Wait for view to be ready
    await new Promise(r => setTimeout(r, 0));
    if (!this.pagesEl) return;
    this.pagesEl.nativeElement.innerHTML = '';
    this.pagesEl.nativeElement.style.transform = 'none';

    try {
      const response = await fetch(`/api/files/${this.fileId()}/download`);
      const buffer = await response.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;

      this.loading.set(false);

      const containerWidth = this.scrollEl.nativeElement.clientWidth - 32;
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
      this.measure();
    } catch (e) {
      this.loading.set(false);
      this.error.set('Could not load PDF');
    }
  }

  // scrollWidth/scrollHeight are layout properties (unaffected by the
  // `transform: none` set just above render()'s page loop), so this reads
  // the real, unscaled stacked-pages size regardless of whatever scale a
  // previous file left behind.
  private measure(): void {
    const pages = this.pagesEl?.nativeElement;
    const scroll = this.scrollEl?.nativeElement;
    if (!pages || !scroll) return;
    const w = pages.scrollWidth;
    const h = pages.scrollHeight;
    if (!w || !h) return;
    this.naturalWidth.set(w);
    this.naturalHeight.set(h);
  }
}
