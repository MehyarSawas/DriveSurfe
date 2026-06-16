import { Component, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { debounceTime, distinctUntilChanged, Subject } from 'rxjs';

@Component({
  selector: 'ds-search-bar',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="search-bar">
      <svg viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
      <input
        type="search"
        placeholder="Search in Drive"
        [ngModel]="query()"
        (ngModelChange)="onInput($event)"
        (keydown.enter)="search.emit(query())"
      />
      @if (query()) {
        <button class="clear" (click)="clear()">
          <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
      }
    </div>
  `,
  styleUrls: ['./search-bar.component.scss'],
})
export class SearchBarComponent {
  readonly search = output<string>();
  readonly query = signal('');

  private subject = new Subject<string>();

  constructor() {
    this.subject.pipe(debounceTime(300), distinctUntilChanged()).subscribe(q => {
      this.search.emit(q);
    });
  }

  onInput(value: string): void {
    this.query.set(value);
    this.subject.next(value);
  }

  clear(): void {
    this.query.set('');
    this.search.emit('');
  }
}
