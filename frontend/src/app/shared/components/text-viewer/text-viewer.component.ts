import { Component, input, OnChanges, SimpleChanges, signal, computed, ElementRef, ViewChild } from '@angular/core';
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
        <div class="text-scale-box" #scaleBoxEl [style.width.px]="scaledWidth()" [style.height.px]="scaledHeight()">
          <pre class="text-content" #contentEl [style.transform]="'scale(' + scale() + ')'">{{ content() }}</pre>
        </div>
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

    /* Sized to the post-scale footprint so the scroll container's own
       scrollWidth/scrollHeight — and therefore native touch scrolling and
       pinch-to-point/drag math — stay correct at any zoom level (same
       reasoning as docx-viewer's identical .docx-scale-box). */
    .text-scale-box {
      margin: 0 auto;
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
      box-sizing: border-box;
      /* A fixed pixel width (set once in JS, see remeasure()), not
         width:100%/flex-fill: text must wrap exactly once, at a width that
         doesn't itself change as zoom changes, then get visually scaled as
         a whole — otherwise every zoom step reflows the text at a new
         effective width, which looks like continuous rewrapping instead of
         smoothly magnifying (the same bug ds-markdown-viewer had). */
      transform-origin: top left;
    }
  `],
})
export class TextViewerComponent implements OnChanges {
  readonly fileId = input.required<string>();
  /** Pinch-zoom multiplier. No fit-to-width shrink like docx/xlsx — text
   *  already wraps to any width, so `scale` is just `zoom` directly. */
  readonly zoom = input(1);

  @ViewChild('scrollEl') scrollEl!: ElementRef<HTMLDivElement>;
  @ViewChild('scaleBoxEl') scaleBoxEl!: ElementRef<HTMLDivElement>;
  @ViewChild('contentEl') contentEl!: ElementRef<HTMLPreElement>;

  // Text past this size isn't useful to read in full inline, and would be
  // slow to fetch/render — cap it and point to downloading the rest.
  private static readonly MAX_BYTES = 2 * 1024 * 1024;

  readonly loading = signal(false);
  readonly error = signal('');
  readonly content = signal('');

  private readonly naturalWidth = signal(0);
  private readonly naturalHeight = signal(0);

  readonly scale = computed(() => this.zoom());
  readonly scaledWidth = computed(() => this.naturalWidth() * this.scale());
  readonly scaledHeight = computed(() => this.naturalHeight() * this.scale());

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['fileId']) this.load();
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

  /** Called continuously while two fingers are down, so the line under the
   *  pinch midpoint stays visually fixed as the text scales, and the view
   *  pans if the fingers drag — like iOS's own pinch-zoom. Applies the new
   *  scale straight to the DOM (not just the `zoom` input signal) so
   *  scrollWidth/Height are correct immediately, before Angular's own change
   *  detection would otherwise catch up. */
  pinchZoomAt(newZoomInput: number, clientX: number, clientY: number): void {
    const scroll = this.scrollEl?.nativeElement;
    const box = this.scaleBoxEl?.nativeElement;
    const content = this.contentEl?.nativeElement;
    if (!scroll || !box || !content || !this.naturalWidth()) return;

    const rect = scroll.getBoundingClientRect();
    const viewX = clientX - rect.left;
    const viewY = clientY - rect.top;

    const w = this.naturalWidth() * newZoomInput;
    const h = this.naturalHeight() * newZoomInput;
    box.style.width = `${w}px`;
    box.style.height = `${h}px`;
    content.style.transform = `scale(${newZoomInput})`;

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
    const content = this.contentEl?.nativeElement;
    if (!scroll || !box || !content) return;
    box.style.width = `${this.naturalWidth()}px`;
    box.style.height = `${this.naturalHeight()}px`;
    content.style.transform = 'scale(1)';
    scroll.scrollLeft = 0;
    scroll.scrollTop = 0;
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    this.content.set('');
    this.naturalWidth.set(0);
    this.naturalHeight.set(0);

    try {
      const response = await fetch(`/api/files/${this.fileId()}/download`);
      if (!response.ok) throw new Error(`download failed: ${response.status}`);
      const blob = await response.blob();
      const truncated = blob.size > TextViewerComponent.MAX_BYTES;
      const text = await (truncated ? blob.slice(0, TextViewerComponent.MAX_BYTES) : blob).text();
      this.content.set(truncated ? `${text}\n\n… (truncated — download to see the full file)` : text);
      this.loading.set(false);
      await this.remeasure();
      return;
    } catch {
      this.error.set('Could not load file');
    }
    this.loading.set(false);
  }

  // scrollWidth/scrollHeight are layout properties (unaffected by the
  // `transform: none` reset just below), so this reads the text's true,
  // unscaled size regardless of whatever scale a previous file left behind.
  // Fixes the <pre>'s width (full container width — code/log text benefits
  // from more horizontal room than markdown's reading-friendly column, same
  // as this viewer's existing no-cap behavior) so it wraps exactly once at
  // a width that doesn't itself change as zoom changes.
  private async remeasure(): Promise<void> {
    await new Promise(r => setTimeout(r, 0));
    const scroll = this.scrollEl?.nativeElement;
    const content = this.contentEl?.nativeElement;
    if (!scroll || !content) return;

    content.style.transform = 'none';
    content.style.width = `${scroll.clientWidth}px`;

    const w = content.scrollWidth;
    const h = content.scrollHeight;
    if (!w || !h) return;
    this.naturalWidth.set(w);
    this.naturalHeight.set(h);
    content.style.transform = `scale(${this.scale()})`;
  }
}
