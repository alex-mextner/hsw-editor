import { TriangleAlert } from 'lucide-react';
import { IconButton } from '@/components/IconButton.tsx';
import { useI18n } from '@/i18n/index.ts';
import { useStore } from '@/state/react.ts';
import { invalidZonesEnabledStore } from '@/scene/invalid-zones/store.ts';

/** Top-bar switch for the red-striped invalid zones. */
export function InvalidZonesToggle() {
  const { t } = useI18n();
  const enabled = useStore(invalidZonesEnabledStore);
  return (
    <IconButton
      label={`${t('invalid.toggle')}: ${t('invalid.toggleHint')}`}
      pressed={enabled}
      onClick={() => invalidZonesEnabledStore.set(!enabled)}
    >
      <TriangleAlert />
    </IconButton>
  );
}
