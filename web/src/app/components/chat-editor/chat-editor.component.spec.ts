import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslocoService } from '@jsverse/transloco';
import type { Editor } from '@tiptap/core';
import { ALL_MENTION_ID } from '../../lib/message-entity';
import { InputDeviceService } from '../../services/input-device.service';
import { LanguageService } from '../../services/language.service';
import { AvatarPresentationService } from '../user-avatar/avatar-presentation.service';
import { ChatEditorComponent } from './chat-editor.component';

describe('ChatEditorComponent Tiptap integration', () => {
  async function createEditor() {
    const enterToSend = signal(true);
    TestBed.configureTestingModule({
      imports: [ChatEditorComponent],
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: TranslocoService,
          useValue: { translate: (key: string) => key },
        },
        { provide: LanguageService, useValue: { lang: signal('en') } },
        { provide: InputDeviceService, useValue: { enterToSend } },
        { provide: AvatarPresentationService, useValue: { resolve: vi.fn() } },
      ],
    });
    const fixture = TestBed.createComponent(ChatEditorComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    const component = fixture.componentInstance;
    // Exercise the real production extensions and ProseMirror paste/history pipeline,
    // rather than duplicating their configuration or mocking the document JSON.
    const editor = (component as unknown as { editor: Editor }).editor;
    expect(editor).toBeDefined();
    const html = vi.fn();
    component.html.subscribe(html);
    return { component, editor, enterToSend, html };
  }

  it('normalizes pasted HTML while retaining supported formatting and safe links', async () => {
    const { component, editor, html } = await createEditor();

    expect(
      editor.view.pasteHTML(
        '<p style="color:red" onclick="void 0">' +
          '<strong>Bold</strong> <em>italic</em> <code>code</code> ' +
          '<a href="javascript:void(0)">bad</a> ' +
          '<a href="https://example.test/path">safe</a>' +
          '<img src="data:image/png;base64," onerror="void 0">' +
          '<script>void 0</script></p><p>Next</p>',
      ),
    ).toBe(true);

    expect(component.getStorageText()).toBe('Bold italic code bad safe\nNext');
    expect(component.isEmpty()).toBe(false);
    const result = document.createElement('div');
    result.innerHTML = html.mock.lastCall![0];
    expect(result.querySelector('strong')?.textContent).toBe('Bold');
    expect(result.querySelector('em')?.textContent).toBe('italic');
    expect(result.querySelector('code')?.textContent).toBe('code');
    expect(result.querySelectorAll('a')).toHaveLength(1);
    expect(result.querySelector('a')?.getAttribute('href')).toBe(
      'https://example.test/path',
    );
    expect(
      result.querySelector('script, img, [style], [onclick], [onerror]'),
    ).toBeNull();
    expect(result.querySelector('p')).toBeNull();
    expect(result.querySelectorAll('br')).toHaveLength(1);
  });

  it('keeps pasted literal mention syntax as text even across formatting boundaries', async () => {
    const { component, editor } = await createEditor();

    editor.view.pasteHTML(
      '<p>[@<strong>Alice</strong>](somfp://user/12/alice)</p>',
    );

    expect(component.getText()).toBe('[@Alice](somfp://user/12/alice)');
    expect(component.getStorageText()).toBe(
      '\\[@Alice](somfp://user/12/alice)',
    );
    expect(editor.view.dom.querySelector('[data-type="mention"]')).toBeNull();
  });

  it('preserves atomic user and audience mentions through draft HTML restoration', async () => {
    const { component, editor, html } = await createEditor();
    editor.commands.insertContent([
      { type: 'text', text: 'Hello ' },
      { type: 'mention', attrs: { id: '12/alice', label: 'Alice' } },
      { type: 'hardBreak' },
      { type: 'mention', attrs: { id: ALL_MENTION_ID, label: 'Everyone' } },
    ]);
    const stored =
      'Hello [@Alice](somfp://user/12/alice)\n' +
      '[@Everyone](somfp://audience/all)';
    const draft = html.mock.lastCall![0] as string;

    expect(editor.schema.nodes['mention'].isAtom).toBe(true);
    expect(component.getText()).toBe('Hello @Alice\n@Everyone');
    expect(component.getStorageText()).toBe(stored);
    const chips = editor.view.dom.querySelectorAll('.cb-mention');
    expect(chips).toHaveLength(2);
    expect(chips[0].getAttribute('contenteditable')).toBe('false');
    expect(chips[0].getAttribute('data-id')).toBe('12/alice');

    component.clear();
    expect(component.isEmpty()).toBe(true);
    expect(component.getStorageText()).toBe('');
    component.setHtml(draft);

    expect(component.isEmpty()).toBe(false);
    expect(component.getStorageText()).toBe(stored);
    expect(component.getText()).toBe('Hello @Alice\n@Everyone');
    expect(editor.view.dom.querySelectorAll('.cb-mention')).toHaveLength(2);
  });

  it('undoes and redoes a rich paste without losing mention identity or update outputs', async () => {
    const { component, editor, html } = await createEditor();
    editor.view.pasteHTML(
      '<p>Hello <span data-type="mention" data-id="12/alice" ' +
        'data-label="Alice">@Alice</span><br><strong>again</strong></p>',
    );
    const stored = 'Hello [@Alice](somfp://user/12/alice)\nagain';
    const pastedHtml = html.mock.lastCall![0];
    expect(component.getStorageText()).toBe(stored);
    html.mockClear();

    expect(editor.commands.undo()).toBe(true);
    expect(component.isEmpty()).toBe(true);
    expect(component.getStorageText()).toBe('');
    expect(html).toHaveBeenLastCalledWith('');

    expect(editor.commands.redo()).toBe(true);
    expect(component.isEmpty()).toBe(false);
    expect(component.getStorageText()).toBe(stored);
    expect(html).toHaveBeenLastCalledWith(pastedHtml);
    expect(editor.view.dom.querySelector('strong')?.textContent).toBe('again');
    expect(
      editor.view.dom.querySelector('.cb-mention')?.getAttribute('data-id'),
    ).toBe('12/alice');
  });

  it('routes clipboard files to the attachment output without inserting accompanying HTML', async () => {
    const { component, editor, html } = await createEditor();
    component.insertText('Draft', false);
    html.mockClear();
    const attachmentPaste = vi.fn();
    component.attachmentPaste.subscribe(attachmentPaste);
    const clipboardData = new DataTransfer();
    clipboardData.items.add(
      new File(['image'], 'image.png', { type: 'image/png' }),
    );
    clipboardData.setData('text/html', '<p>Clipboard text</p>');
    const event = new ClipboardEvent('paste', { clipboardData });

    expect(editor.view.pasteHTML('<p>Clipboard text</p>', event)).toBe(true);

    expect(attachmentPaste).toHaveBeenCalledExactlyOnceWith(event);
    expect(component.getStorageText()).toBe('Draft');
    expect(html).not.toHaveBeenCalled();
  });

  it('sends on desktop Enter but inserts hard breaks for Shift+Enter and touch Enter', async () => {
    const { component, editor, enterToSend } = await createEditor();
    const send = vi.fn();
    component.send.subscribe(send);
    const pressEnter = (shiftKey = false) =>
      editor.view.dom.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          shiftKey,
          bubbles: true,
          cancelable: true,
        }),
      );

    pressEnter();
    expect(send).not.toHaveBeenCalled();
    component.insertText('Draft', false);
    pressEnter();
    expect(send).toHaveBeenCalledTimes(1);
    expect(component.getStorageText()).toBe('Draft');

    pressEnter(true);
    expect(component.getStorageText()).toBe('Draft\n');
    enterToSend.set(false);
    pressEnter();
    expect(component.getStorageText()).toBe('Draft\n\n');
    expect(send).toHaveBeenCalledTimes(1);
  });
});
