import { Component, input, OnChanges, SimpleChanges, ElementRef, ViewChild, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { renderAsync } from 'docx-preview';

@Component({
  selector: 'ds-docx-viewer',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="docx-scroll" #scrollEl>
      @if (loading()) {
        <div class="docx-spinner-wrap"><div class="docx-spinner"></div></div>
      }
      @if (error()) {
        <div class="docx-error">{{ error() }}</div>
      }
      <div class="docx-scale-box" #scaleBoxEl [style.width.px]="scaledWidth()" [style.height.px]="scaledHeight()">
        <div class="docx-body" #bodyEl [style.transform]="'scale(' + scale() + ')'"></div>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; width: 100%; height: 100%; }

    .docx-scroll {
      width: 100%;
      height: 100%;
      overflow: auto;
      background: #404040;
    }

    /* Sized to the post-scale footprint so the scroll container's own
       scrollWidth/scrollHeight — and therefore native touch scrolling —
       stay correct at any zoom level; a bare CSS transform on .docx-body
       alone would visually resize it without changing what's scrollable.
       Centered via margin:auto (not a flex parent + justify-content:center):
       when this box is WIDER than the scroll container (zoomed in), auto
       margins resolve to 0 and its left edge sits exactly at scrollLeft 0 —
       flex centering instead shifts an overflowing item's rendered position
       by the centering amount, which the pinch-to-point scroll math in
       pinchZoomAt() below doesn't (and, short of also reading that shift
       back out, can't cleanly) account for. */
    .docx-scale-box {
      margin: 0 auto;
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
      width: max-content;
      /* Must anchor at the box's own origin: .docx-scale-box is sized to
         exactly naturalWidth*scale × naturalHeight*scale, which only lines
         up with the scaled-down content when the scale "grows" from (0,0)
         rather than from the (unscaled) horizontal center. */
      transform-origin: top left;

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
  /** Pinch-zoom multiplier on top of the fit-to-width base scale below. */
  readonly zoom = input(1);

  @ViewChild('bodyEl') bodyEl!: ElementRef<HTMLDivElement>;
  @ViewChild('scrollEl') scrollEl!: ElementRef<HTMLDivElement>;
  @ViewChild('scaleBoxEl') scaleBoxEl!: ElementRef<HTMLDivElement>;

  readonly loading = signal(false);
  readonly error = signal('');

  private readonly naturalWidth = signal(0);
  private readonly naturalHeight = signal(0);
  /** docx-preview renders at the document's real paper width (e.g. ~816px for
   *  Letter), almost always wider than a phone screen — shrink it to fit by
   *  default, like Google Drive's mobile preview, instead of starting the
   *  user off having to scroll sideways just to read a line of text. */
  private readonly baseScale = signal(1);

  readonly scale = computed(() => this.baseScale() * this.zoom());
  readonly scaledWidth = computed(() => this.naturalWidth() * this.scale());
  readonly scaledHeight = computed(() => this.naturalHeight() * this.scale());

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['fileId']) this.render();
  }

  private async render(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    this.naturalWidth.set(0);
    this.naturalHeight.set(0);
    this.baseScale.set(1);

    await new Promise(r => setTimeout(r, 0));
    if (!this.bodyEl) return;
    this.bodyEl.nativeElement.innerHTML = '';
    this.bodyEl.nativeElement.style.transform = 'none';

    try {
      const response = await fetch(`/api/files/${this.fileId()}/download`);
      if (!response.ok) throw new Error(`download failed: ${response.status}`);
      const blob = await response.blob();
      await renderAsync(blob, this.bodyEl.nativeElement, this.bodyEl.nativeElement);
      this.measure();
    } catch {
      this.error.set('Could not load document');
    } finally {
      this.loading.set(false);
    }
  }

  /** The content-space point (unscaled coordinates) that was under the
   *  fingers when the current pinch gesture began — fixed for the gesture's
   *  whole duration. Letting it move each frame (e.g. recomputing it from
   *  that frame's own clientX/Y) only ever re-anchors the zoom in place; it
   *  can't reproduce a drag, since "put the point under the current finger
   *  position back under the current finger position" is a no-op whenever
   *  the scale isn't also changing that frame. Keeping it fixed from gesture
   *  start and sliding the *target* screen position (clientX/Y) each frame
   *  instead is what makes a two-finger drag pan the view, exactly like the
   *  existing image/video/PDF pinch math this mirrors. */
  private pinchAnchorX = 0;
  private pinchAnchorY = 0;

  /** Call once when a pinch gesture starts (not on every move). */
  beginPinch(clientX: number, clientY: number): void {
    const scroll = this.scrollEl?.nativeElement;
    const box = this.scaleBoxEl?.nativeElement;
    const w0 = this.naturalWidth();
    if (!scroll || !box || !w0) return;
    const rect = scroll.getBoundingClientRect();
    const curScale = box.offsetWidth / w0;
    this.pinchAnchorX = (scroll.scrollLeft + (clientX - rect.left)) / curScale;
    this.pinchAnchorY = (scroll.scrollTop + (clientY - rect.top)) / curScale;
  }

  /** Called continuously while two fingers are down, so the content under
   *  the pinch midpoint stays visually fixed as it scales, and the view pans
   *  if the fingers drag — like iOS's own pinch-zoom. Applies the new scale
   *  straight to the DOM (not just the `zoom` input signal) so
   *  scrollWidth/Height are correct *immediately*, before Angular's own
   *  change detection would otherwise catch up; the signal write right
   *  after keeps later reactive reads (and the next normal render)
   *  consistent with it. */
  pinchZoomAt(newZoomInput: number, clientX: number, clientY: number): void {
    const scroll = this.scrollEl?.nativeElement;
    const box = this.scaleBoxEl?.nativeElement;
    const body = this.bodyEl?.nativeElement;
    if (!scroll || !box || !body || !this.naturalWidth()) return;

    const rect = scroll.getBoundingClientRect();
    const viewX = clientX - rect.left;
    const viewY = clientY - rect.top;

    const newScale = this.baseScale() * newZoomInput;
    const w = this.naturalWidth() * newScale;
    const h = this.naturalHeight() * newScale;
    box.style.width = `${w}px`;
    box.style.height = `${h}px`;
    body.style.transform = `scale(${newScale})`;

    const maxLeft = Math.max(w - scroll.clientWidth, 0);
    const maxTop = Math.max(h - scroll.clientHeight, 0);
    scroll.scrollLeft = Math.min(Math.max(this.pinchAnchorX * newScale - viewX, 0), maxLeft);
    scroll.scrollTop = Math.min(Math.max(this.pinchAnchorY * newScale - viewY, 0), maxTop);
  }

  /** Called by the parent right after it snaps `zoom` back to 1 at the end
   *  of a pinch gesture (e.g. the user pinched below the fit-to-width
   *  baseline) — returns cleanly to the top-left of the fit-to-width view
   *  instead of leaving whatever scroll position the gesture's last frame
   *  happened to leave against the *old* (different) content size, which
   *  would otherwise show up as a stray jump once the reactive `zoom` input
   *  catches up and resizes the content out from under it. */
  resetScroll(): void {
    const scroll = this.scrollEl?.nativeElement;
    const box = this.scaleBoxEl?.nativeElement;
    const body = this.bodyEl?.nativeElement;
    if (!scroll || !box || !body) return;
    const newScale = this.baseScale();
    box.style.width = `${this.naturalWidth() * newScale}px`;
    box.style.height = `${this.naturalHeight() * newScale}px`;
    body.style.transform = `scale(${newScale})`;
    scroll.scrollLeft = 0;
    scroll.scrollTop = 0;
  }

  // scrollWidth/scrollHeight are layout properties (unaffected by the
  // `transform: none` set just above), so this reads the page's true,
  // unscaled size regardless of whatever scale a previous file left behind.
  private measure(): void {
    const body = this.bodyEl?.nativeElement;
    const scroll = this.scrollEl?.nativeElement;
    if (!body || !scroll) return;
    const w = body.scrollWidth;
    const h = body.scrollHeight;
    if (!w || !h) return;
    this.naturalWidth.set(w);
    this.naturalHeight.set(h);
    this.baseScale.set(Math.min(1, scroll.clientWidth / w));
  }
}
