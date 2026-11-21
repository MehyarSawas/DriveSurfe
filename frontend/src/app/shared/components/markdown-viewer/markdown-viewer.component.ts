import { Component, input, OnChanges, SimpleChanges, signal, computed, ElementRef, ViewChild, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import php from 'highlight.js/lib/languages/php';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import sql from 'highlight.js/lib/languages/sql';
import yaml from 'highlight.js/lib/languages/yaml';
import markdownLang from 'highlight.js/lib/languages/markdown';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import java from 'highlight.js/lib/languages/java';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import csharp from 'highlight.js/lib/languages/csharp';
import DOMPurify from 'dompurify';

// A curated allow-list, not highlight.js's full ~190-language bundle (which
// `import 'highlight.js'` would pull in wholesale) — mirrors the language
// surface PreviewComponent.TEXT_EXTENSIONS already treats as "worth
// previewing as code". Registered once at module load, shared by every
// instance of this component.
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('php', php);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('shell', bash);
hljs.registerLanguage('json', json);
hljs.registerLanguage('css', css);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('markdown', markdownLang);
hljs.registerLanguage('c', c);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('java', java);
hljs.registerLanguage('go', go);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('csharp', csharp);

// marked.use() mutates the shared module-level `marked` instance — call it
// once here (module scope), not per-component-instance, so later renders
// don't re-register the extension repeatedly.
marked.use(markedHighlight({
  langPrefix: 'hljs language-',
  highlight(code: string, lang: string): string {
    const language = hljs.getLanguage(lang) ? lang : undefined;
    return language ? hljs.highlight(code, { language }).value : hljs.highlightAuto(code).value;
  },
}));
marked.setOptions({ gfm: true, breaks: false });

@Component({
  selector: 'ds-markdown-viewer',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="md-scroll" #scrollEl>
      @if (loading()) {
        <div class="md-spinner-wrap"><div class="md-spinner"></div></div>
      }
      @if (error()) {
        <div class="md-error">{{ error() }}</div>
      }
      @if (!loading() && !error()) {
        <button class="md-toggle" (click)="showSource.set(!showSource())" [title]="showSource() ? 'Show rendered' : 'Show source'">
          @if (showSource()) {
            <svg viewBox="0 0 24 24"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zm0 12.5c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>
          } @else {
            <svg viewBox="0 0 24 24"><path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/></svg>
          }
        </button>
        @if (showSource()) {
          <pre class="md-source" #sourceEl [style.font-size.px]="BASE_FONT_SOURCE * zoom()">{{ rawText() }}</pre>
        } @else {
          <div class="md-body" #bodyEl [style.font-size.px]="BASE_FONT_RENDERED * zoom()" [innerHTML]="safeHtml()"></div>
        }
      }
    </div>
  `,
  styles: [`
    :host { display: block; width: 100%; height: 100%; }

    .md-scroll {
      position: relative;
      width: 100%;
      height: 100%;
      overflow: auto;
      background: #1e1e1e;
    }

    .md-spinner-wrap {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: none;
    }

    .md-spinner {
      width: 36px;
      height: 36px;
      border: 3px solid rgba(255,255,255,0.2);
      border-top-color: rgba(255,255,255,0.8);
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
    }

    @keyframes spin { to { transform: rotate(360deg); } }

    .md-error {
      color: rgba(255,255,255,0.6);
      padding: 40px;
      text-align: center;
    }

    .md-toggle {
      position: sticky;
      top: 10px;
      float: right;
      margin: 10px 10px 0 0;
      width: 34px;
      height: 34px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      background: rgba(0,0,0,0.5);
      z-index: 1;

      svg { width: 18px; height: 18px; fill: rgba(255,255,255,0.85); }
    }

    .md-source {
      margin: 0;
      padding: 16px 20px;
      color: #d4d4d4;
      font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .md-body {
      max-width: 780px;
      margin: 0 auto;
      padding: 24px 28px 60px;
      color: #d4d4d4;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      line-height: 1.6;
      word-break: break-word;

      :host ::ng-deep & {
        h1, h2, h3, h4, h5, h6 { color: #fff; margin: 1.2em 0 0.5em; line-height: 1.3; }
        h1 { font-size: 1.8em; border-bottom: 1px solid rgba(255,255,255,0.15); padding-bottom: 0.3em; }
        h2 { font-size: 1.5em; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 0.25em; }
        h3 { font-size: 1.25em; }
        p, ul, ol, blockquote, table { margin: 0.8em 0; }
        ul, ol { padding-left: 1.6em; }
        li { margin: 0.25em 0; }
        a { color: #58a6ff; text-decoration: none; }
        a:hover { text-decoration: underline; }
        img { max-width: 100%; border-radius: 4px; }
        blockquote {
          margin-left: 0;
          padding: 0 1em;
          color: rgba(255,255,255,0.65);
          border-left: 3px solid rgba(255,255,255,0.25);
        }
        hr { border: none; border-top: 1px solid rgba(255,255,255,0.15); margin: 1.5em 0; }
        code {
          font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
          background: rgba(255,255,255,0.08);
          padding: 0.15em 0.4em;
          border-radius: 4px;
          font-size: 0.9em;
        }
        pre {
          overflow-x: auto;
          border-radius: 6px;
          margin: 0.8em 0;

          code {
            background: none;
            padding: 0;
            border-radius: 0;
            font-size: 0.85em;
          }
        }
        table {
          border-collapse: collapse;
          width: 100%;
          font-size: 0.9em;
        }
        th, td { border: 1px solid rgba(255,255,255,0.15); padding: 6px 10px; text-align: left; }
        th { background: rgba(255,255,255,0.06); }
        input[type="checkbox"] { margin-right: 0.4em; }
      }
    }

    /* highlight.js GitHub Dark theme (node_modules/highlight.js/styles/github-dark.css),
       inlined here rather than referenced as an external stylesheet — this
       component's styles, like every other viewer in shared/components, are
       fully self-contained in the one file. */
    :host ::ng-deep .md-body pre code.hljs {
      display: block;
      overflow-x: auto;
      padding: 1em;
    }
    :host ::ng-deep .md-body code.hljs { padding: 3px 5px; }
    :host ::ng-deep .md-body .hljs { color: #c9d1d9; background: #0d1117; }
    :host ::ng-deep .md-body .hljs-doctag,
    :host ::ng-deep .md-body .hljs-keyword,
    :host ::ng-deep .md-body .hljs-meta .hljs-keyword,
    :host ::ng-deep .md-body .hljs-template-tag,
    :host ::ng-deep .md-body .hljs-template-variable,
    :host ::ng-deep .md-body .hljs-type,
    :host ::ng-deep .md-body .hljs-variable.language_ { color: #ff7b72; }
    :host ::ng-deep .md-body .hljs-title,
    :host ::ng-deep .md-body .hljs-title.class_,
    :host ::ng-deep .md-body .hljs-title.class_.inherited__,
    :host ::ng-deep .md-body .hljs-title.function_ { color: #d2a8ff; }
    :host ::ng-deep .md-body .hljs-attr,
    :host ::ng-deep .md-body .hljs-attribute,
    :host ::ng-deep .md-body .hljs-literal,
    :host ::ng-deep .md-body .hljs-meta,
    :host ::ng-deep .md-body .hljs-number,
    :host ::ng-deep .md-body .hljs-operator,
    :host ::ng-deep .md-body .hljs-variable,
    :host ::ng-deep .md-body .hljs-selector-attr,
    :host ::ng-deep .md-body .hljs-selector-class,
    :host ::ng-deep .md-body .hljs-selector-id { color: #79c0ff; }
    :host ::ng-deep .md-body .hljs-regexp,
    :host ::ng-deep .md-body .hljs-string,
    :host ::ng-deep .md-body .hljs-meta .hljs-string { color: #a5d6ff; }
    :host ::ng-deep .md-body .hljs-built_in,
    :host ::ng-deep .md-body .hljs-symbol { color: #ffa657; }
    :host ::ng-deep .md-body .hljs-comment,
    :host ::ng-deep .md-body .hljs-code,
    :host ::ng-deep .md-body .hljs-formula { color: #8b949e; }
    :host ::ng-deep .md-body .hljs-name,
    :host ::ng-deep .md-body .hljs-quote,
    :host ::ng-deep .md-body .hljs-selector-tag,
    :host ::ng-deep .md-body .hljs-selector-pseudo { color: #7ee787; }
    :host ::ng-deep .md-body .hljs-subst { color: #c9d1d9; }
    :host ::ng-deep .md-body .hljs-section { color: #1f6feb; font-weight: bold; }
    :host ::ng-deep .md-body .hljs-bullet { color: #f2cc60; }
    :host ::ng-deep .md-body .hljs-emphasis { color: #c9d1d9; font-style: italic; }
    :host ::ng-deep .md-body .hljs-strong { color: #c9d1d9; font-weight: bold; }
    :host ::ng-deep .md-body .hljs-addition { color: #aff5b4; background-color: #033a16; }
    :host ::ng-deep .md-body .hljs-deletion { color: #ffdcd7; background-color: #67060c; }
  `],
})
export class MarkdownViewerComponent implements OnChanges {
  readonly fileId = input.required<string>();
  /** Pinch-zoom: markdown reflows at any size (both rendered prose and the
   *  plain-text source view), so plain font-size scaling is enough — no
   *  scale-box/spacer needed like docx/xlsx. Same model as ds-text-viewer. */
  readonly zoom = input(1);

  @ViewChild('scrollEl') scrollEl!: ElementRef<HTMLDivElement>;
  @ViewChild('bodyEl') bodyEl!: ElementRef<HTMLDivElement>;
  @ViewChild('sourceEl') sourceEl!: ElementRef<HTMLPreElement>;

  readonly BASE_FONT_RENDERED = 15;
  readonly BASE_FONT_SOURCE = 13;

  // Text past this size isn't useful to render in full, and marked/DOMPurify
  // would be slow on it — cap it and point to downloading the rest (same
  // cap and reasoning as ds-text-viewer).
  private static readonly MAX_BYTES = 2 * 1024 * 1024;

  readonly loading = signal(false);
  readonly error = signal('');
  readonly rawText = signal('');
  readonly showSource = signal(false);

  private readonly sanitizer = inject(DomSanitizer);

  readonly safeHtml = computed<SafeHtml>(() => {
    const html = marked.parse(this.rawText(), { async: false }) as string;
    const clean = DOMPurify.sanitize(html);
    return this.sanitizer.bypassSecurityTrustHtml(clean);
  });

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['fileId']) this.load();
  }

  private activeContentEl(): HTMLElement | undefined {
    return this.showSource() ? this.sourceEl?.nativeElement : this.bodyEl?.nativeElement;
  }

  private baseFontPx(): number {
    return this.showSource() ? this.BASE_FONT_SOURCE : this.BASE_FONT_RENDERED;
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
    const content = this.activeContentEl();
    if (!scroll || !content) return;
    const rect = scroll.getBoundingClientRect();
    const curScale = parseFloat(getComputedStyle(content).fontSize) / this.baseFontPx();
    this.pinchAnchorX = (scroll.scrollLeft + (clientX - rect.left)) / curScale;
    this.pinchAnchorY = (scroll.scrollTop + (clientY - rect.top)) / curScale;
  }

  /** Called continuously while two fingers are down, so the content under
   *  the pinch midpoint stays visually fixed as it scales, and the view
   *  pans if the fingers drag — like iOS's own pinch-zoom. Sets font-size
   *  directly on the DOM (not just the `zoom` input) so scrollHeight
   *  reflects it immediately, before Angular's own change detection would
   *  otherwise catch up. */
  pinchZoomAt(newZoomInput: number, clientX: number, clientY: number): void {
    const scroll = this.scrollEl?.nativeElement;
    const content = this.activeContentEl();
    if (!scroll || !content) return;

    const rect = scroll.getBoundingClientRect();
    const viewX = clientX - rect.left;
    const viewY = clientY - rect.top;

    content.style.fontSize = `${this.baseFontPx() * newZoomInput}px`;

    const maxLeft = Math.max(scroll.scrollWidth - scroll.clientWidth, 0);
    const maxTop = Math.max(scroll.scrollHeight - scroll.clientHeight, 0);
    scroll.scrollLeft = Math.min(Math.max(this.pinchAnchorX * newZoomInput - viewX, 0), maxLeft);
    scroll.scrollTop = Math.min(Math.max(this.pinchAnchorY * newZoomInput - viewY, 0), maxTop);
  }

  /** Called by the parent right after it snaps `zoom` back to 1 at the end
   *  of a pinch gesture — returns cleanly to the top-left at the base font
   *  size instead of leaving whatever scroll position the gesture's last
   *  frame happened to leave against the *old* (different) content size. */
  resetScroll(): void {
    const scroll = this.scrollEl?.nativeElement;
    const content = this.activeContentEl();
    if (!scroll || !content) return;
    content.style.fontSize = `${this.baseFontPx()}px`;
    scroll.scrollLeft = 0;
    scroll.scrollTop = 0;
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    this.rawText.set('');
    this.showSource.set(false);

    try {
      const response = await fetch(`/api/files/${this.fileId()}/download`);
      if (!response.ok) throw new Error(`download failed: ${response.status}`);
      const blob = await response.blob();
      const truncated = blob.size > MarkdownViewerComponent.MAX_BYTES;
      const text = await (truncated ? blob.slice(0, MarkdownViewerComponent.MAX_BYTES) : blob).text();
      this.rawText.set(truncated ? `${text}\n\n… (truncated — download to see the full file)` : text);
    } catch {
      this.error.set('Could not load file');
    } finally {
      this.loading.set(false);
    }
  }
}
