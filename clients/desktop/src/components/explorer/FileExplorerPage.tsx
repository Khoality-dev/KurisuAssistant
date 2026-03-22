import React from 'react';
import { Box } from '@mui/material';
import { FileTreeSidebar } from './FileTreeSidebar';
import { EditorTabs } from './EditorTabs';
import { FileEditor } from './FileEditor';

export const FileExplorerPage: React.FC = () => {
  return (
    <Box sx={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Tree sidebar (left) */}
      <FileTreeSidebar />

      {/* Editor area (right) */}
      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
        <EditorTabs />
        <FileEditor />
      </Box>
    </Box>
  );
};
