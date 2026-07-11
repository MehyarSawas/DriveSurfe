import { Component, ElementRef, effect, input, output, viewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { BreadcrumbItem } from '../../../../core/models/drive-file.model';

@Component({
  selector: 'ds-breadcrumb',
  standalone: true,
  imports: [CommonModule],
  template: `
    <nav class="breadcrumb" aria-label="breadcrumb" #scroller>
      @for (item of items(); track item.id; let last = $last) {
        @if (!last) {
          <button class="crumb" (click)="navigate.emit(item)">{{ item.name }}</button>
          <span class="sep">›</span>
        } @else {
          <span class="crumb current">{{ item.name }}</span>
        }
      }
    </nav>
  `,
  styleUrls: ['./breadcrumb.component.scss'],
})
export class BreadcrumbComponent {
  readonly items = input.required<BreadcrumbItem[]>();
  readonly navigate = output<BreadcrumbItem>();
  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');

  constructor() {
    // Long paths overflow horizontally — keep the end (current folder) in
    // view whenever the path changes.
    effect(() => {
      this.items(); // track
      const el = this.scroller()?.nativeElement;
      if (el) setTimeout(() => el.scrollTo({ left: el.scrollWidth }), 0);
    });
  }
}
