import type { FeatureRu } from '../keys.ts';

/** Failed model/photo loads, items whose bank element is missing, and the crash screen (ticket #51). */
export const assetsEn = {
  'asset.reason.removed': 'removed from the bank',
  'asset.reason.unavailable': 'unavailable: {reason}',
  'asset.reason.missing': 'file not found ({status})',
  'asset.reason.network': 'network error',
  'asset.reason.decode': 'file is damaged',
  'asset.reason.unknown': 'could not be loaded',

  'asset.toast.failed': '{name}: {reason}. Retrying automatically.',
  'asset.toast.failedManual': '{name}: {reason}. Automatic retries are used up.',
  'asset.toast.gone': '{name}: {reason}.',
  'asset.toast.recovered': '{name}: loaded.',
  'asset.action.report': 'Report',
  'asset.report.sentCopied': 'Report sent, details copied to the clipboard.',
  'asset.report.sent': 'Report sent.',
  'asset.report.copiedOnly':
    'The server did not take the report; details are copied, please send them on.',
  'asset.report.failed': 'Could not send the report.',

  'asset.photo': 'Photo overlay',
  'asset.placeholder.hint': '{name}: {reason}',

  'asset.missing.title': 'Model not found in the bank: {bankId}',
  'asset.missing.body':
    'The item stays on the wall exactly where it is; only its 3D model is missing. The bank may have been rebuilt without it. Check again, or report it so the element can be restored.',
  'asset.failed.title': 'Model failed to load',
  'asset.failed.body': '{reason}. The item stays on the wall as a placeholder box.',

  'app.error.title': 'Something went wrong',
  'app.error.body':
    'The editor hit an unexpected error and stopped drawing. Your wall is safe on the server. Recover redraws the editor without reloading the page.',
  'app.error.recover': 'Recover',
  'app.error.reload': 'Reload page',
  'app.error.copy': 'Copy details',
  'app.error.copied': 'Details copied',
  'app.error.details': 'Error details',

  'bank.image.generated': 'Outline generated from the footprint (no picture)',
} as const;

export const assetsRu: FeatureRu<typeof assetsEn> = {
  'asset.reason.removed': 'удалён из банка',
  'asset.reason.unavailable': 'недоступен: {reason}',
  'asset.reason.missing': 'файл не найден ({status})',
  'asset.reason.network': 'ошибка сети',
  'asset.reason.decode': 'файл повреждён',
  'asset.reason.unknown': 'не удалось загрузить',

  'asset.toast.failed': '{name}: {reason}. Повторяю автоматически.',
  'asset.toast.failedManual': '{name}: {reason}. Автоматические попытки закончились.',
  'asset.toast.gone': '{name}: {reason}.',
  'asset.toast.recovered': '{name}: загружено.',
  'asset.action.report': 'Сообщить',
  'asset.report.sentCopied': 'Отчёт отправлен, подробности скопированы в буфер обмена.',
  'asset.report.sent': 'Отчёт отправлен.',
  'asset.report.copiedOnly':
    'Сервер не принял отчёт; подробности скопированы, передайте их дальше.',
  'asset.report.failed': 'Не удалось отправить отчёт.',

  'asset.photo': 'Фото-наложение',
  'asset.placeholder.hint': '{name}: {reason}',

  'asset.missing.title': 'Модель не найдена в банке: {bankId}',
  'asset.missing.body':
    'Предмет остаётся на стене там же, где был; не хватает только его 3D-модели. Возможно, банк пересобрали без этого элемента. Проверьте ещё раз или сообщите, чтобы элемент вернули.',
  'asset.failed.title': 'Модель не загрузилась',
  'asset.failed.body': '{reason}. Предмет остаётся на стене как контурный блок.',

  'app.error.title': 'Что-то пошло не так',
  'app.error.body':
    'В редакторе произошла непредвиденная ошибка, и он перестал рисовать. Ваша стена в безопасности на сервере. «Восстановить» перерисует редактор без перезагрузки страницы.',
  'app.error.recover': 'Восстановить',
  'app.error.reload': 'Перезагрузить страницу',
  'app.error.copy': 'Скопировать детали',
  'app.error.copied': 'Детали скопированы',
  'app.error.details': 'Детали ошибки',

  'bank.image.generated': 'Контур по посадочным ячейкам (картинки нет)',
};
