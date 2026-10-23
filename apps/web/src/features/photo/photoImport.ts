/**
 * Getting a wall photo into the editor: file chooser, drop and paste all end in `importPhotoFile`, which
 * uploads (the server normalises orientation and converts HEIC/AVIF), then opens photo mode on the new photo.
 */
import { createValueStore } from '#state-backend';
import { api, ApiError, NetworkError } from '@/api/http.ts';
import { notify } from '@/features/notices/notices.ts';
import { t } from '@/i18n/index.ts';
import { applyUploadedWall, sessionStore } from '@/wall/session.ts';
import { enterPhotoMode } from '@/state/photo.ts';

export type ImportState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'uploading'; readonly name: string; readonly fraction: number }
  /** All bytes are on the server, which is rotating/converting the image. */
  | { readonly phase: 'processing'; readonly name: string };

export const importStore = createValueStore<ImportState>({ phase: 'idle' });

const IMAGE_EXTENSIONS = /\.(jpe?g|png|webp|avif|heic|heif)$/i;
const IMAGE_TYPES: Readonly<Record<string, true>> = {
  'image/jpeg': true,
  'image/png': true,
  'image/webp': true,
  'image/avif': true,
  'image/heic': true,
  'image/heif': true,
};

/** Phones often send HEIC with an empty MIME type, so the extension counts too. */
export function isSupportedImage(file: Pick<File, 'name' | 'type'>): boolean {
  return IMAGE_TYPES[file.type.toLowerCase()] === true || IMAGE_EXTENSIONS.test(file.name);
}

/** The first supported image among dropped/pasted files. */
export function firstImage(files: Iterable<File>): File | null {
  for (const file of files) if (isSupportedImage(file)) return file;
  return null;
}

function reasonOf(error: unknown): string {
  if (error instanceof ApiError || error instanceof NetworkError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/** Uploads one photo and makes it the backdrop. Resolves when done; failures become a notice, never a throw. */
export async function importPhotoFile(file: File): Promise<void> {
  const wallId = sessionStore.get()?.wallId ?? null;
  if (wallId === null || importStore.get().phase !== 'idle') return;
  if (!isSupportedImage(file)) {
    notify('error', t('photo.unsupported', { name: file.name }));
    return;
  }
  importStore.set({ phase: 'uploading', name: file.name, fraction: 0 });
  try {
    const { photoId, wall } = await api.uploadPhoto(wallId, file, ({ loaded, total }) => {
      importStore.set(
        loaded >= total
          ? { phase: 'processing', name: file.name }
          : { phase: 'uploading', name: file.name, fraction: loaded / total },
      );
    });
    // The answer carries the wall that contains the photo; photo mode must not open before the session has it.
    if (applyUploadedWall(wall)) enterPhotoMode(photoId, { calibrated: false });
    notify('info', t('photo.imported', { name: file.name }));
  } catch (error) {
    notify('error', t('photo.importFailed', { reason: reasonOf(error) }));
  } finally {
    importStore.set({ phase: 'idle' });
  }
}

/**
 * Opens the system file chooser (camera roll on phones) and imports the chosen photo. The input stays in the
 * document until the chooser closes, which also lets automation drive it.
 */
export function choosePhotoFile(): void {
  document.querySelector('input[data-photo-chooser]')?.remove();
  const input = document.createElement('input');
  input.type = 'file';
  input.hidden = true;
  input.dataset['photoChooser'] = '';
  input.accept = 'image/jpeg,image/png,image/webp,image/avif,image/heic,image/heif,.heic,.heif';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.remove();
    if (file) void importPhotoFile(file);
  });
  input.addEventListener('cancel', () => input.remove());
  document.body.append(input);
  input.click();
}
