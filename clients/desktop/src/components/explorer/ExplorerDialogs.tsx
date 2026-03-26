/**
 * Dialogs for the file explorer.
 * - Rename dialog: rename a file or folder
 * - New item dialog: create a new file or folder
 */

import React from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Button,
} from '@mui/material';

interface ExplorerDialogsProps {
  // Rename dialog
  renaming: { path: string; name: string } | null;
  renameValue: string;
  onRenameValueChange: (value: string) => void;
  onRenameSubmit: () => void;
  onRenameCancel: () => void;
  // New item dialog
  newItemType: 'file' | 'folder' | null;
  newItemName: string;
  onNewItemNameChange: (value: string) => void;
  onCreateFile: () => void;
  onCreateFolder: () => void;
  onNewItemCancel: () => void;
}

export const ExplorerDialogs: React.FC<ExplorerDialogsProps> = ({
  renaming,
  renameValue,
  onRenameValueChange,
  onRenameSubmit,
  onRenameCancel,
  newItemType,
  newItemName,
  onNewItemNameChange,
  onCreateFile,
  onCreateFolder,
  onNewItemCancel,
}) => {
  return (
    <>
      {/* Rename dialog */}
      <Dialog open={renaming !== null} onClose={onRenameCancel} maxWidth="xs" fullWidth>
        <DialogTitle>Rename</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            value={renameValue}
            onChange={(e) => onRenameValueChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') onRenameSubmit(); if (e.key === 'Escape') onRenameCancel(); }}
            size="small"
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={onRenameCancel}>Cancel</Button>
          <Button onClick={onRenameSubmit} variant="contained">Rename</Button>
        </DialogActions>
      </Dialog>

      {/* New file/folder dialog */}
      <Dialog open={newItemType !== null} onClose={onNewItemCancel} maxWidth="xs" fullWidth>
        <DialogTitle>New {newItemType === 'folder' ? 'Folder' : 'File'}</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            placeholder={newItemType === 'folder' ? 'folder-name' : 'filename.txt'}
            value={newItemName}
            onChange={(e) => onNewItemNameChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { newItemType === 'folder' ? onCreateFolder() : onCreateFile(); }
              if (e.key === 'Escape') onNewItemCancel();
            }}
            size="small"
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={onNewItemCancel}>Cancel</Button>
          <Button onClick={newItemType === 'folder' ? onCreateFolder : onCreateFile} variant="contained">Create</Button>
        </DialogActions>
      </Dialog>
    </>
  );
};
