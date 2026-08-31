import type { ChatSendIntent } from '../../lib/chat-input/chat-input.component';

export interface ThreadComposerHandlers {
  text(value: Extract<ChatSendIntent, { kind: 'text' }>): void;
  image(value: Extract<ChatSendIntent, { kind: 'image' }>): void;
  file(value: Extract<ChatSendIntent, { kind: 'file' }>): void;
  nativeFiles(value: Extract<ChatSendIntent, { kind: 'native-files' }>): void;
  link(value: Extract<ChatSendIntent, { kind: 'link' }>): void;
  contact(value: Extract<ChatSendIntent, { kind: 'contact' }>): void;
  paste(value: Extract<ChatSendIntent, { kind: 'paste' }>): void;
  audio(value: Extract<ChatSendIntent, { kind: 'audio' }>): void;
}

/** Routes composer intents without coupling the composer surface to send implementations. */
export class ThreadComposerController {
  constructor(private readonly handlers: ThreadComposerHandlers) {}

  dispatch(intent: ChatSendIntent): void {
    switch (intent.kind) {
      case 'text':
        return this.handlers.text(intent);
      case 'image':
        return this.handlers.image(intent);
      case 'file':
        return this.handlers.file(intent);
      case 'native-files':
        return this.handlers.nativeFiles(intent);
      case 'link':
        return this.handlers.link(intent);
      case 'contact':
        return this.handlers.contact(intent);
      case 'paste':
        return this.handlers.paste(intent);
      case 'audio':
        return this.handlers.audio(intent);
    }
  }
}
