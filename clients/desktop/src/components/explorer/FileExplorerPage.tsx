import React from 'react';
import { Box } from '@mui/material';
import { FileTreeSidebar } from './FileTreeSidebar';
import { EditorTabs } from './EditorTabs';
import { FileEditor } from './FileEditor';
import { FullExplorer } from './FullExplorer';
import { useExplorerStore } from '../../store/explorerStore';

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
    </Box>
  );
};
