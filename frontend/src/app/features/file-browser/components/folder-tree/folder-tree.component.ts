import { Component, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FolderTreeNode } from '../../../../core/models/drive.model';
import { BreadcrumbItem } from '../../../../core/models/drive-file.model';

@Component({
  selector: 'ds-folder-tree',
  standalone: true,
  imports: [CommonModule],
  template: `
    <ul class="tree-list">
      @for (child of tree().children; track child.id) {
        <li>
          <button
            class="tree-item"
            [class.active]="child.id === currentFolderId()"
            (click)="folderSelected.emit({ id: child.id, name: child.name })"
          >
            <span class="expand" (click)="$event.stopPropagation(); toggle(child.id)">
              {{ expanded().has(child.id) ? '▾' : '▸' }}
            </span>
            <svg viewBox="0 0 24 24"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
            {{ child.name }}
          </button>
          @if (expanded().has(child.id) && child.children.length > 0) {
            <ds-folder-tree
              [tree]="child"
              [currentFolderId]="currentFolderId()"
              (folderSelected)="folderSelected.emit($event)"
            />
          }
        </li>
      }
    </ul>
  `,
  styleUrls: ['./folder-tree.component.scss'],
})
export class FolderTreeComponent {
  readonly tree = input.required<FolderTreeNode>();
  readonly currentFolderId = input<string>('1');
  readonly folderSelected = output<BreadcrumbItem>();

  readonly expanded = signal<Set<string>>(new Set());

  toggle(id: string): void {
    this.expanded.update(set => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
}
