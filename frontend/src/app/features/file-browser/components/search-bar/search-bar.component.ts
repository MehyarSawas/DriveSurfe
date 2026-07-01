import { Component, ElementRef, HostListener, ViewChild, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { debounceTime, distinctUntilChanged, Subject } from 'rxjs';

@Component({
  selector: 'ds-search-bar',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="search-bar" [class.focused]="focused()" [class.filter-active]="folderOnly()">
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
      @if (folderId() && folderId() !== '__trash__' && folderId() !== '__starred__') {
        <div class="filter-wrap">
          <button class="filter-btn" [class.active]="folderOnly()"
            (mousedown)="$event.preventDefault()"
            (click)="toggleDropdown($event)"
            title="Filter search scope">
            <svg viewBox="0 0 24 24"><path d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z"/></svg>
          </button>
          @if (dropdownOpen()) {
            <div class="filter-dropdown" (mousedown)="$event.preventDefault()" (click)="$event.stopPropagation()">
              <label class="filter-option" (click)="toggleFolderOnly()">
                <span class="option-icon">
                  <svg viewBox="0 0 24 24"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
                </span>
                <span class="option-label">{{ folderName() }}</span>
                <span class="custom-checkbox" [class.checked]="folderOnly()">
                  @if (folderOnly()) {
                    <svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                  }
                </span>
              </label>
            </div>
          }
        </div>
      }
    </div>
  `,
  styleUrls: ['./search-bar.component.scss'],
})
export class SearchBarComponent {
  @ViewChild('inputEl') inputEl!: ElementRef<HTMLInputElement>;

  readonly folderId = input<string>('');
  readonly folderName = input<string>('My Drive');
  readonly search = output<{ query: string; folderId?: string; folderName?: string }>();

  readonly query = signal('');
  readonly folderOnly = signal(false);
  readonly dropdownOpen = signal(false);
  readonly focused = signal(false);

  private subject = new Subject<string>();

  constructor() {
    this.subject.pipe(debounceTime(500), distinctUntilChanged()).subscribe(() => {
      this.emitSearch();
    });
  }

  @HostListener('document:click')
  onDocClick(): void { this.dropdownOpen.set(false); }

  onInput(value: string): void {
    this.query.set(value);
    this.subject.next(value);
  }

  onBlur(): void {
    this.focused.set(false);
    this.dropdownOpen.set(false);
  }

  onEnter(): void {
    this.emitSearch();
    this.inputEl.nativeElement.blur();
  }

  emitSearch(): void {
    const q = this.query();
    if (q.length > 0 && q.length < 3) return;
    this.search.emit(this.folderOnly() && this.folderId()
      ? { query: q, folderId: this.folderId(), folderName: this.folderName() }
      : { query: q });
  }

  toggleDropdown(e: Event): void {
    e.stopPropagation();
    this.dropdownOpen.update(v => !v);
  }

  toggleFolderOnly(): void {
    this.folderOnly.update(v => !v);
    this.dropdownOpen.set(false);
    if (this.query()) this.emitSearch();
  }

  clear(): void {
    this.query.set('');
    this.search.emit({ query: '' });
  }

  clearSilent(): void {
    this.query.set('');
    this.folderOnly.set(false);
  }
}
