import { Component, input, OnChanges, SimpleChanges, signal, computed, ElementRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import * as XLSX from 'xlsx';

interface GridCell {
  value: string;
  rowSpan: number;
  colSpan: number;
  skip: boolean;
}

@Component({
  selector: 'ds-xlsx-viewer',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="xlsx-wrap">
      @if (loading()) {
        <div class="xlsx-spinner-wrap"><div class="xlsx-spinner"></div></div>
      }
      @if (error()) {
        <div class="xlsx-error">{{ error() }}</div>
      }
      @if (sheetNames().length > 1) {
        <div class="xlsx-tabs">
          @for (name of sheetNames(); track name) {
            <button class="xlsx-tab" [class.active]="name === activeSheet()" (click)="selectSheet(name)">{{ name }}</button>
          }
        </div>
      }
      <div class="xlsx-scroll" #scrollEl>
        <div class="xlsx-scale-box" #scaleBoxEl [style.width.px]="scaledWidth()" [style.height.px]="scaledHeight()">
          <table class="xlsx-table" #tableEl [style.transform]="'scale(' + scale() + ')'">
            @for (row of grid(); track $index) {
              <tr>
                @for (cell of row; track $index) {
                  @if (!cell.skip) {
                    <td [attr.rowspan]="cell.rowSpan > 1 ? cell.rowSpan : null"
                        [attr.colspan]="cell.colSpan > 1 ? cell.colSpan : null">{{ cell.value }}</td>
                  }
                }
              </tr>
            }
          </table>
        </div>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; width: 100%; height: 100%; }

    .xlsx-wrap {
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      background: #fff;
      /* color is inherited, and the preview overlay around this component
         sets white text for its own dark background — without this, cell
         text inherits that white, becoming invisible on this light
         background (only the cell borders ever showed up). */
      color: rgba(0, 0, 0, 0.87);
    }

    .xlsx-spinner-wrap {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: none;
    }

    .xlsx-spinner {
      width: 36px;
      height: 36px;
      border: 3px solid rgba(0,0,0,0.15);
      border-top-color: rgba(0,0,0,0.6);
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
    }

    @keyframes spin { to { transform: rotate(360deg); } }

    .xlsx-error {
      color: rgba(0,0,0,0.6);
      padding: 40px;
      text-align: center;
    }

    .xlsx-tabs {
      display: flex;
      gap: 2px;
      padding: 6px 6px 0;
      overflow-x: auto;
      flex-shrink: 0;
      background: #f1f3f4;
    }

    .xlsx-tab {
      padding: 6px 14px;
      font-size: 13px;
      white-space: nowrap;
      border-radius: 6px 6px 0 0;
      color: rgba(0,0,0,0.6);
      background: transparent;

      &.active {
        background: #fff;
        color: rgba(0,0,0,0.87);
        font-weight: 500;
      }
    }

    .xlsx-scroll {
      flex: 1;
      overflow: auto;
    }

    .xlsx-table {
      border-collapse: collapse;
      font-size: 13px;
      width: max-content;
      transform-origin: top left;

      td {
        border: 1px solid #e0e0e0;
        padding: 4px 8px;
        white-space: pre;
        vertical-align: top;
      }
    }
  `],
})
export class XlsxViewerComponent implements OnChanges {
  readonly fileId = input.required<string>();
  /** Pinch-zoom multiplier on top of the fit-to-width base scale below. */
  readonly zoom = input(1);

  @ViewChild('scrollEl') scrollEl!: ElementRef<HTMLDivElement>;
  @ViewChild('scaleBoxEl') scaleBoxEl!: ElementRef<HTMLDivElement>;
  @ViewChild('tableEl') tableEl!: ElementRef<HTMLTableElement>;

  readonly loading = signal(false);
  readonly error = signal('');
  readonly sheetNames = signal<string[]>([]);
  readonly activeSheet = signal('');
  readonly grid = signal<GridCell[][]>([]);

  private readonly naturalWidth = signal(0);
  private readonly naturalHeight = signal(0);
  /** A wide table (many columns) renders wider than a phone screen by
   *  default — shrink it to fit, same as docx, instead of starting the user
   *  off having to scroll sideways just to read the first row. */
  private readonly baseScale = signal(1);

  readonly scale = computed(() => this.baseScale() * this.zoom());
  readonly scaledWidth = computed(() => this.naturalWidth() * this.scale());
  readonly scaledHeight = computed(() => this.naturalHeight() * this.scale());

  private workbook: XLSX.WorkBook | null = null;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['fileId']) this.load();
  }

  selectSheet(name: string): void {
    this.activeSheet.set(name);
    this.buildGrid();
    this.remeasure();
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

  /** Called continuously while two fingers are down, so the cell under the
   *  pinch midpoint stays visually fixed as the table scales, and the view
   *  pans if the fingers drag — like iOS's own pinch-zoom. Applies the new
   *  scale straight to the DOM (not just the `zoom` input signal) so
   *  scrollWidth/Height are correct immediately, before Angular's own change
   *  detection would otherwise catch up. */
  pinchZoomAt(newZoomInput: number, clientX: number, clientY: number): void {
    const scroll = this.scrollEl?.nativeElement;
    const box = this.scaleBoxEl?.nativeElement;
    const table = this.tableEl?.nativeElement;
    if (!scroll || !box || !table || !this.naturalWidth()) return;

    const rect = scroll.getBoundingClientRect();
    const viewX = clientX - rect.left;
    const viewY = clientY - rect.top;

    const newScale = this.baseScale() * newZoomInput;
    const w = this.naturalWidth() * newScale;
    const h = this.naturalHeight() * newScale;
    box.style.width = `${w}px`;
    box.style.height = `${h}px`;
    table.style.transform = `scale(${newScale})`;

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
   *  catches up and resizes the table out from under it. */
  resetScroll(): void {
    const scroll = this.scrollEl?.nativeElement;
    const box = this.scaleBoxEl?.nativeElement;
    const table = this.tableEl?.nativeElement;
    if (!scroll || !box || !table) return;
    const newScale = this.baseScale();
    box.style.width = `${this.naturalWidth() * newScale}px`;
    box.style.height = `${this.naturalHeight() * newScale}px`;
    table.style.transform = `scale(${newScale})`;
    scroll.scrollLeft = 0;
    scroll.scrollTop = 0;
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    this.workbook = null;
    this.sheetNames.set([]);
    this.grid.set([]);
    this.naturalWidth.set(0);
    this.naturalHeight.set(0);
    this.baseScale.set(1);

    try {
      const response = await fetch(`/api/files/${this.fileId()}/download`);
      if (!response.ok) throw new Error(`download failed: ${response.status}`);
      const buffer = await response.arrayBuffer();
      this.workbook = XLSX.read(buffer, { type: 'array' });
      this.sheetNames.set(this.workbook.SheetNames);
      this.activeSheet.set(this.workbook.SheetNames[0] ?? '');
      this.buildGrid();
      await this.remeasure();
    } catch {
      this.error.set('Could not load spreadsheet');
    } finally {
      this.loading.set(false);
    }
  }

  // scrollWidth/scrollHeight are layout properties (unaffected by the
  // `transform: none` reset just below), so this reads the table's true,
  // unscaled size regardless of whatever scale a previous sheet left behind.
  private async remeasure(): Promise<void> {
    this.baseScale.set(1);
    await new Promise(r => setTimeout(r, 0));
    const table = this.tableEl?.nativeElement;
    const scroll = this.scrollEl?.nativeElement;
    if (!table || !scroll) return;
    table.style.transform = 'none';
    const w = table.scrollWidth;
    const h = table.scrollHeight;
    if (!w || !h) return;
    this.naturalWidth.set(w);
    this.naturalHeight.set(h);
    this.baseScale.set(Math.min(1, scroll.clientWidth / w));
  }

  // Builds the render grid ourselves (rather than XLSX.utils.sheet_to_html)
  // because that helper embeds each cell's raw value in a `data-v="..."`
  // attribute without escaping quotes — a cell like `"><img src=x
  // onerror=...>` breaks out of the attribute and injects live markup. Plain
  // interpolation below is auto-escaped by Angular, so there's nothing to
  // sanitize.
  private buildGrid(): void {
    const wb = this.workbook;
    const name = this.activeSheet();
    if (!wb || !name) { this.grid.set([]); return; }

    const ws = wb.Sheets[name];
    const rows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, raw: false, defval: '' });
    const grid: GridCell[][] = rows.map(r => r.map(v => ({ value: v ?? '', rowSpan: 1, colSpan: 1, skip: false })));

    for (const m of ws['!merges'] ?? []) {
      for (let r = m.s.r; r <= m.e.r; r++) {
        if (!grid[r]) grid[r] = [];
        for (let c = m.s.c; c <= m.e.c; c++) {
          if (!grid[r][c]) grid[r][c] = { value: '', rowSpan: 1, colSpan: 1, skip: false };
          if (r === m.s.r && c === m.s.c) {
            grid[r][c].rowSpan = m.e.r - m.s.r + 1;
            grid[r][c].colSpan = m.e.c - m.s.c + 1;
          } else {
            grid[r][c].skip = true;
          }
        }
      }
    }

    this.grid.set(grid);
  }
}
