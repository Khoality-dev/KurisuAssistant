import React from 'react';
import { Alert, Box, Snackbar } from '@mui/material';
import { FileTreeSidebar } from './FileTreeSidebar';
import { EditorTabs } from './EditorTabs';
import { FileEditor } from './FileEditor';
import { FullExplorer } from './FullExplorer';
import { useExplorerStore } from '@kurisu/state';

/**
 * Why the last save failed.
 *
 * Saving is Ctrl+S with no other feedback, so a refusal that only reached the
 * console left the tab looking saved — and a drive save is refused for reasons
 * the user can act on: the drive is full, the file is gone, they are signed out.
 */
const SaveErrorNotice: React.FC = () => {
  const saveError = useExplorerStore((s) => s.saveError);
  const clearSaveError = useExplorerStore((s) => s.clearSaveError);

  return (
    <Snackbar
      open={!!saveError}
      autoHideDuration={8000}
      onClose={clearSaveError}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
    >
      <Alert onClose={clearSaveError} severity="error" variant="filled" sx={{ width: '100%' }}>
        {saveError}
      </Alert>
    </Snackbar>
  );
};

export const FileExplorerPage: React.FC = () => {
  const hasOpenFiles = useExplorerStore((s) => s.openFiles.length > 0);
  const hasDiffReview = useExplorerStore((s) => s.diffReview !== null);

  if (!hasOpenFiles && !hasDiffReview) {
    // Full explorer mode — no files open yet
    return <FullExplorer />;
  }

  // Editor mode — tree sidebar + tabs + editor
  return (
    <Box sx={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      <FileTreeSidebar />
      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
        <EditorTabs />
        <FileEditor />
      </Box>
      <SaveErrorNotice />
    </Box>
  );
};
