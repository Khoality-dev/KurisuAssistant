/**
 * Context menus for the file explorer.
 * - File context menu: right-click on a file/folder entry
 * - Background context menu: right-click on empty space
 */

import React from 'react';
import {
  Menu,
  MenuItem,
  ListItemText,
  Typography,
} from '@mui/material';
import { type FileEntry } from '../../store/explorerStore';

interface ExplorerContextMenusProps {
  // File context menu
  contextMenu: { mouseX: number; mouseY: number; entry: FileEntry } | null;
  onCloseContextMenu: () => void;
  // Background context menu
  bgContextMenu: { mouseX: number; mouseY: number } | null;
  onCloseBgContextMenu: () => void;
  // State
  selectedEntries: Set<string>;
  entries: FileEntry[];
  clipboard: { path: string; name: string; cut: boolean } | null;
  hasVSCode: boolean;
  isRoot: boolean;
  currentPath: string;
  // Handlers
  onAddToChat: (entries: FileEntry[]) => void;
  onRename: (path: string, name: string) => void;
  onCopy: (path: string, name: string) => void;
  onCut: (path: string, name: string) => void;
  onDelete: (path: string) => void;
  onPaste: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
}

export const ExplorerContextMenus: React.FC<ExplorerContextMenusProps> = ({
  contextMenu,
  onCloseContextMenu,
  bgContextMenu,
  onCloseBgContextMenu,
  selectedEntries,
  entries,
  clipboard,
  hasVSCode,
  isRoot,
  currentPath,
  onAddToChat,
  onRename,
  onCopy,
  onCut,
  onDelete,
  onPaste,
  onNewFile,
  onNewFolder,
}) => {
  const handleOpenInVSCode = () => {
    if (contextMenu) {
      window.electron?.explorer?.openInVSCode(contextMenu.entry.fullPath);
      onCloseContextMenu();
    }
  };

  return (
    <>
      {/* Context menu */}
      <Menu
        open={contextMenu !== null}
        onClose={onCloseContextMenu}
        anchorReference="anchorPosition"
        anchorPosition={contextMenu ? { top: contextMenu.mouseY, left: contextMenu.mouseX } : undefined}
      >
        <MenuItem
          onClick={() => {
            if (contextMenu) {
              // Add right-clicked entry (or all selected if it's in the selection)
              const toAdd = selectedEntries.has(contextMenu.entry.fullPath)
                ? entries.filter(e => selectedEntries.has(e.fullPath))
                : [contextMenu.entry];
              onAddToChat(toAdd);
            }
            onCloseContextMenu();
          }}
          sx={{ fontSize: '0.8rem' }}
        >
          <ListItemText>
            {selectedEntries.size > 1 && contextMenu && selectedEntries.has(contextMenu.entry.fullPath)
              ? `Add ${selectedEntries.size} items to Chat`
              : 'Add to Chat'}
          </ListItemText>
          <Typography variant="caption" sx={{ ml: 2, color: 'text.secondary' }}>F3</Typography>
        </MenuItem>
        {!isRoot && (<>
        <MenuItem
          onClick={() => {
            if (contextMenu) {
              onRename(contextMenu.entry.fullPath, contextMenu.entry.name);
            }
            onCloseContextMenu();
          }}
          sx={{ fontSize: '0.8rem' }}
        >
          <ListItemText>Rename</ListItemText>
          <Typography variant="caption" sx={{ ml: 2, color: 'text.secondary' }}>F2</Typography>
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (contextMenu) onCopy(contextMenu.entry.fullPath, contextMenu.entry.name);
            onCloseContextMenu();
          }}
          sx={{ fontSize: '0.8rem' }}
        >
          <ListItemText>Copy</ListItemText>
          <Typography variant="caption" sx={{ ml: 2, color: 'text.secondary' }}>Ctrl+C</Typography>
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (contextMenu) onCut(contextMenu.entry.fullPath, contextMenu.entry.name);
            onCloseContextMenu();
          }}
          sx={{ fontSize: '0.8rem' }}
        >
          <ListItemText>Cut</ListItemText>
          <Typography variant="caption" sx={{ ml: 2, color: 'text.secondary' }}>Ctrl+X</Typography>
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (contextMenu) onDelete(contextMenu.entry.fullPath);
            onCloseContextMenu();
          }}
          sx={{ fontSize: '0.8rem', color: 'error.main' }}
        >
          <ListItemText>Delete</ListItemText>
          <Typography variant="caption" sx={{ ml: 2, color: 'text.secondary' }}>Del</Typography>
        </MenuItem>
        </>)}
        {hasVSCode && (
          <MenuItem onClick={handleOpenInVSCode} sx={{ fontSize: '0.8rem' }}>
            <ListItemText>Open with VS Code</ListItemText>
          </MenuItem>
        )}
        <MenuItem
          onClick={() => {
            if (contextMenu) {
              window.electron?.openPath(contextMenu.entry.fullPath);
              onCloseContextMenu();
            }
          }}
          sx={{ fontSize: '0.8rem' }}
        >
          <ListItemText>Open with Default App</ListItemText>
        </MenuItem>
      </Menu>

      {/* Background context menu (right-click empty space) */}
      <Menu
        open={bgContextMenu !== null}
        onClose={onCloseBgContextMenu}
        anchorReference="anchorPosition"
        anchorPosition={bgContextMenu ? { top: bgContextMenu.mouseY, left: bgContextMenu.mouseX } : undefined}
      >
        <MenuItem
          onClick={() => { onNewFile(); onCloseBgContextMenu(); }}
          sx={{ fontSize: '0.8rem' }}
        >
          <ListItemText>New File</ListItemText>
        </MenuItem>
        <MenuItem
          onClick={() => { onNewFolder(); onCloseBgContextMenu(); }}
          sx={{ fontSize: '0.8rem' }}
        >
          <ListItemText>New Folder</ListItemText>
        </MenuItem>
        {clipboard && (
          <MenuItem
            onClick={() => { onPaste(); onCloseBgContextMenu(); }}
            sx={{ fontSize: '0.8rem' }}
          >
            <ListItemText>Paste ({clipboard.name})</ListItemText>
            <Typography variant="caption" sx={{ ml: 2, color: 'text.secondary' }}>Ctrl+V</Typography>
          </MenuItem>
        )}
        {hasVSCode && currentPath && (
          <MenuItem
            onClick={() => {
              window.electron?.explorer?.openInVSCode(currentPath);
              onCloseBgContextMenu();
            }}
            sx={{ fontSize: '0.8rem' }}
          >
            <ListItemText>Open Folder in VS Code</ListItemText>
          </MenuItem>
        )}
      </Menu>
    </>
  );
};
