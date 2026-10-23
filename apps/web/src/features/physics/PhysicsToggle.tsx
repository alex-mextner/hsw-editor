import { Gauge } from 'lucide-react';
import { IconButton } from '@/components/IconButton.tsx';
import { useI18n } from '@/i18n/index.ts';
import { physicsEnabledStore } from '@/physics/live.ts';
import { useStore } from '@/state/react.ts';

/** Top-bar switch for the amber physics marks (and the live check that feeds them). */
export function PhysicsToggle() {
  const { t } = useI18n();
  const enabled = useStore(physicsEnabledStore);
  return (
    <IconButton
      label={`${t('physics.toggle')}: ${t('physics.toggleHint')}`}
      pressed={enabled}
      onClick={() => physicsEnabledStore.set(!enabled)}
    >
      <Gauge />
    </IconButton>
  );
}
