import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import { ArrowUp, CornerDownRight, ImagePlus, Square, X } from 'lucide-react';
import type { ImageContent } from '@hsw-editor/omp-protocol';
import { Button } from '@/components/ui/button.tsx';
import { IconButton } from '@/components/IconButton.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import { useT } from '@/i18n/index.ts';

// Base64 of MAX_IMAGES x MAX_IMAGE_BYTES must stay under the server's 24 MiB message limit.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGES = 4;
const IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

interface Attachment {
  readonly id: number;
  readonly image: ImageContent;
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

export interface ComposerProps {
  readonly working: boolean;
  readonly disabled: boolean;
  /** Text to place in the box (restored queue, `set_editor_text`); a new `nonce` re-applies it. */
  readonly fill: { readonly text: string; readonly nonce: number } | null;
  readonly onSubmit: (
    text: string,
    images: readonly ImageContent[],
    mode: 'steer' | 'followUp',
  ) => Promise<string | null>;
  readonly onStop: () => void;
}

export function Composer({ working, disabled, fill, onSubmit, onStop }: ComposerProps) {
  const t = useT();
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<readonly Attachment[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const nextId = useRef(1);
  const input = useRef<HTMLTextAreaElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  // Derived-state pattern: apply each new fill once, during render (no effect-driven re-render).
  const [appliedFill, setAppliedFill] = useState<number | null>(null);
  if (fill !== null && fill.nonce !== appliedFill) {
    setAppliedFill(fill.nonce);
    setText((current) => (current.trim().length > 0 ? `${current}\n\n${fill.text}` : fill.text));
  }
  useEffect(() => {
    if (fill !== null) input.current?.focus();
  }, [fill]);

  const addFiles = async (files: readonly File[]): Promise<void> => {
    for (const file of files) {
      if (!IMAGE_TYPES.includes(file.type)) {
        setProblem(t('omp.composer.imageType'));
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        setProblem(t('omp.composer.imageTooBig', { mb: MAX_IMAGE_BYTES / (1024 * 1024) }));
        continue;
      }
      const data = await readAsBase64(file);
      const id = nextId.current++;
      setAttachments((current) =>
        current.length >= MAX_IMAGES
          ? current
          : [...current, { id, image: { type: 'image', data, mimeType: file.type } }],
      );
    }
  };

  const send = async (mode: 'steer' | 'followUp'): Promise<void> => {
    if (disabled || (text.trim().length === 0 && attachments.length === 0)) return;
    const message = text;
    const sent = attachments;
    const images = sent.map((attachment) => attachment.image);
    setText('');
    setAttachments([]);
    setProblem(null);
    const error = await onSubmit(message, images, mode);
    if (error !== null) {
      setText((current) => (current.length === 0 ? message : `${message}\n${current}`));
      setAttachments((current) => (current.length === 0 ? sent : current));
      setProblem(t('omp.command.failed', { error }));
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send(event.altKey ? 'followUp' : 'steer');
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = [...event.clipboardData.files].filter((file) => file.type.startsWith('image/'));
    if (files.length === 0) return;
    event.preventDefault();
    void addFiles(files);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    if (event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    void addFiles([...event.dataTransfer.files]);
  };

  return (
    <div
      className="border-t border-border p-2"
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
    >
      {attachments.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-2">
          {attachments.map((attachment) => (
            <li key={attachment.id} className="relative">
              <img
                alt=""
                className="size-14 rounded-md border border-border object-cover"
                src={`data:${attachment.image.mimeType};base64,${attachment.image.data}`}
              />
              <button
                type="button"
                aria-label={t('omp.composer.removeImage')}
                className="absolute -top-1.5 -right-1.5 grid size-4 place-items-center rounded-full bg-background text-foreground ring-1 ring-border"
                onClick={() =>
                  setAttachments((current) => current.filter((entry) => entry.id !== attachment.id))
                }
              >
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {problem !== null && <p className="mb-1 text-xs text-destructive">{problem}</p>}
      <Textarea
        ref={input}
        rows={2}
        value={text}
        disabled={disabled}
        className="max-h-48 min-h-14 resize-none text-sm"
        placeholder={working ? t('omp.composer.placeholderWorking') : t('omp.composer.placeholder')}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
      <div className="mt-1.5 flex items-center gap-1">
        <input
          ref={fileInput}
          type="file"
          accept={IMAGE_TYPES.join(',')}
          multiple
          hidden
          onChange={(event) => {
            void addFiles([...(event.target.files ?? [])]);
            event.target.value = '';
          }}
        />
        <IconButton
          label={t('omp.composer.attach')}
          disabled={disabled}
          onClick={() => fileInput.current?.click()}
        >
          <ImagePlus />
        </IconButton>
        <span className="flex-1" />
        {working && (
          <>
            <Button size="sm" variant="outline" onClick={onStop}>
              <Square className="fill-current" />
              {t('omp.composer.stop')}
            </Button>
            <IconButton
              label={t('omp.composer.queue')}
              shortcut="Alt+Enter"
              disabled={disabled}
              onClick={() => void send('followUp')}
            >
              <CornerDownRight />
            </IconButton>
          </>
        )}
        <Button
          size="sm"
          disabled={disabled || (text.trim().length === 0 && attachments.length === 0)}
          onClick={() => void send('steer')}
        >
          <ArrowUp />
          {working ? t('omp.composer.steer') : t('omp.composer.send')}
        </Button>
      </div>
    </div>
  );
}
