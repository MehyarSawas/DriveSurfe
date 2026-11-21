import { Component, input, OnChanges, SimpleChanges, signal } from '@angular/core';
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
      <div class="xlsx-scroll">
        <table class="xlsx-table">
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
  `,
  styles: [`
    :host { display: block; width: 100%; height: 100%; }

    .xlsx-wrap {
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      background: #fff;
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

  readonly loading = signal(false);
  readonly error = signal('');
  readonly sheetNames = signal<string[]>([]);
  readonly activeSheet = signal('');
  readonly grid = signal<GridCell[][]>([]);

  private workbook: XLSX.WorkBook | null = null;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['fileId']) this.load();
  }

  selectSheet(name: string): void {
    this.activeSheet.set(name);
    this.buildGrid();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    this.workbook = null;
    this.sheetNames.set([]);
    this.grid.set([]);

    try {
      const response = await fetch(`/api/files/${this.fileId()}/download`);
      if (!response.ok) throw new Error(`download failed: ${response.status}`);
      const buffer = await response.arrayBuffer();
      this.workbook = XLSX.read(buffer, { type: 'array' });
      this.sheetNames.set(this.workbook.SheetNames);
      this.activeSheet.set(this.workbook.SheetNames[0] ?? '');
      this.buildGrid();
    } catch {
      this.error.set('Could not load spreadsheet');
    } finally {
      this.loading.set(false);
    }
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
