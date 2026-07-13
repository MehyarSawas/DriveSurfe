import { Component, ElementRef, ViewChild, computed, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { debounceTime, distinctUntilChanged, Subject } from 'rxjs';

export interface SearchFilters {
  modifiedFrom: string;   // yyyy-mm-dd (inclusive) or ''
  modifiedTo: string;     // yyyy-mm-dd (inclusive) or ''
  types: string[];        // category keys: folder|image|video|audio|document
}

@Component({
  selector: 'ds-search-bar',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="search-bar" [class.focused]="focused()" [class.filter-active]="hasFilters()">
      <svg class="search-icon" viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
      <input
        #inputEl
        type="text"
        [placeholder]="folderOnly() ? 'Search in ' + folderName() : 'Search in Drive'"
        [ngModel]="query()"
        (ngModelChange)="onInput($event)"
        (focus)="focused.set(true)"
        (blur)="onBlur()"
        (keydown.enter)="onEnter()"
        (keydown.escape)="inputEl.blur()"
      />
      @if (query()) {
        <button class="clear" (mousedown)="$event.preventDefault()" (click)="clear()">
          <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
      }
      <div class="filter-wrap">
        <button class="filter-btn" [class.active]="hasFilters()"
          (mousedown)="$event.preventDefault()"
          (click)="toggleDropdown($event)"
          title="Search filters">
          <svg viewBox="0 0 24 24"><path d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z"/></svg>
          @if (filterCount() > 0) { <span class="filter-badge">{{ filterCount() }}</span> }
        </button>
        @if (dropdownOpen()) {
          <div class="filter-dropdown" (click)="$event.stopPropagation()">
            @if (folderScopeAvailable()) {
              <div class="filter-section">
                <label class="filter-option" (click)="toggleFolderOnly()">
                  <span class="option-icon">
                    <svg viewBox="0 0 24 24"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
                  </span>
                  <span class="option-label">Only in {{ folderName() }}</span>
                  <span class="custom-checkbox" [class.checked]="folderOnly()">
                    @if (folderOnly()) {
                      <svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                    }
                  </span>
                </label>
              </div>
            }

            <div class="filter-section">
              <div class="filter-heading">Modified</div>
              <div class="date-row">
                <label class="date-field">
                  <span>From</span>
                  <input type="date" [ngModel]="dateFrom()" [max]="dateTo() || null"
                         (ngModelChange)="onDateFrom($event)" />
                </label>
                <label class="date-field">
                  <span>To</span>
                  <input type="date" [ngModel]="dateTo()" [min]="dateFrom() || null"
                         (ngModelChange)="onDateTo($event)" />
                </label>
              </div>
            </div>

            <div class="filter-section">
              <div class="filter-heading">File type</div>
              @for (opt of TYPE_OPTIONS; track opt.key) {
                <label class="filter-option" (click)="toggleType(opt.key)">
                  <span class="option-label">{{ opt.label }}</span>
                  <span class="custom-checkbox" [class.checked]="selectedTypes().has(opt.key)">
                    @if (selectedTypes().has(opt.key)) {
                      <svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                    }
                  </span>
                </label>
              }
            </div>

            @if (hasFilters()) {
              <button class="clear-filters" (click)="clearFilters()">Clear filters</button>
            }
            <button class="apply-filters" (click)="applyNow()">Apply filters</button>
          </div>
        }
      </div>
    </div>
  `,
  styleUrls: ['./search-bar.component.scss'],
  host: { '(document:click)': 'onDocClick()' },
})
export class SearchBarComponent {
  @ViewChild('inputEl') inputEl!: ElementRef<HTMLInputElement>;

  readonly folderId = input<string>('');
  readonly folderName = input<string>('My Drive');
  readonly search = output<{ query: string; folderId?: string; folderName?: string }>();
  readonly filtersChange = output<SearchFilters>();
  /** Explicit "Apply filters" — runs the search even with an empty keyword
   *  (so filters alone can drive a drive-wide search). */
  readonly apply = output<{ query: string; folderId?: string; folderName?: string }>();

  readonly TYPE_OPTIONS = [
    { key: 'folder',   label: 'Folders' },
    { key: 'image',    label: 'Images' },
    { key: 'video',    label: 'Videos' },
    { key: 'audio',    label: 'Audio' },
    { key: 'document', label: 'Documents' },
  ] as const;

  readonly query = signal('');
  readonly folderOnly = signal(false);
  readonly dateFrom = signal('');
  readonly dateTo = signal('');
  readonly selectedTypes = signal<Set<string>>(new Set());
  readonly dropdownOpen = signal(false);
  readonly focused = signal(false);

  /** The folder-scope toggle only makes sense inside a real folder. */
  readonly folderScopeAvailable = computed(() =>
    !!this.folderId() && !this.folderId().startsWith('__'));

  readonly filterCount = computed(() =>
    (this.folderOnly() ? 1 : 0) +
    (this.dateFrom() || this.dateTo() ? 1 : 0) +
    this.selectedTypes().size);

  readonly hasFilters = computed(() => this.filterCount() > 0);

  private subject = new Subject<string>();

  constructor() {
    this.subject.pipe(debounceTime(500), distinctUntilChanged()).subscribe(() => {
      this.emitSearch();
    });
  }

  onDocClick(): void { this.dropdownOpen.set(false); }

  onInput(value: string): void {
    this.query.set(value);
    this.subject.next(value);
  }

  onBlur(): void {
    this.focused.set(false);
    // NB: don't close the dropdown here — the date pickers inside it steal
    // focus from the input, and closing on blur would dismiss them.
  }

  onEnter(): void {
    this.emitSearch();
    this.inputEl.nativeElement.blur();
  }

  emitSearch(): void {
    const q = this.query();
    if (q.length > 0 && q.length < 3) return;
    this.search.emit(this.folderOnly() && this.folderScopeAvailable()
      ? { query: q, folderId: this.folderId(), folderName: this.folderName() }
      : { query: q });
  }

  private emitFilters(): void {
    this.filtersChange.emit({
      modifiedFrom: this.dateFrom(),
      modifiedTo: this.dateTo(),
      types: [...this.selectedTypes()],
    });
  }

  toggleDropdown(e: Event): void {
    e.stopPropagation();
    this.dropdownOpen.update(v => !v);
  }

  toggleFolderOnly(): void {
    this.folderOnly.update(v => !v);
    if (this.query()) this.emitSearch();
  }

  applyNow(): void {
    const q = this.query();
    this.apply.emit(this.folderOnly() && this.folderScopeAvailable()
      ? { query: q, folderId: this.folderId(), folderName: this.folderName() }
      : { query: q });
    this.dropdownOpen.set(false);
    this.inputEl?.nativeElement.blur();
  }

  onDateFrom(value: string): void { this.dateFrom.set(value ?? ''); this.emitFilters(); }
  onDateTo(value: string): void { this.dateTo.set(value ?? ''); this.emitFilters(); }

  toggleType(key: string): void {
    this.selectedTypes.update(s => {
      const next = new Set(s);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
    this.emitFilters();
  }

  clearFilters(): void {
    const hadFolderOnly = this.folderOnly();
    this.folderOnly.set(false);
    this.dateFrom.set('');
    this.dateTo.set('');
    this.selectedTypes.set(new Set());
    this.emitFilters();
    if (hadFolderOnly && this.query()) this.emitSearch(); // scope changed → re-search
  }

  clear(): void {
    this.query.set('');
    this.search.emit({ query: '' });
  }

  clearSilent(): void {
    this.query.set('');
    this.folderOnly.set(false);
    this.dateFrom.set('');
    this.dateTo.set('');
    this.selectedTypes.set(new Set());
    this.dropdownOpen.set(false);
    this.emitFilters();
  }
}
