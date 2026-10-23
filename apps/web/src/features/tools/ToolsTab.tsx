import { useStore } from '@/state/react.ts';
import { ToolDetail } from './ToolDetail.tsx';
import { ToolLibraryPanel } from './ToolLibraryPanel.tsx';
import { closePhotoWizard, closeToolDetail, toolsPanelStore } from './store.ts';
import { PhotoToolsWizard } from './wizard/PhotoToolsWizard.tsx';

/** Body of the Tools tab: the library list, or the detail page of the opened tool, plus the photo wizard. */
export function ToolsTab() {
  const { view, wizardOpen } = useStore(toolsPanelStore);
  return (
    <>
      {view.page === 'detail' ? (
        <ToolDetail entryKey={view.entryKey} onBack={closeToolDetail} />
      ) : (
        <ToolLibraryPanel />
      )}
      {wizardOpen ? <PhotoToolsWizard onClose={closePhotoWizard} /> : null}
    </>
  );
}
