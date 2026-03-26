import React from 'react';
import {
  Box,
  Typography,
  TextField,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Switch,
} from '@mui/material';
import {
  Badge as BadgeIcon,
  OpenInFull as OpenInFullIcon,
  CloseFullscreen as CloseFullscreenIcon,
  PsychologyAlt as PsychologyIcon,
  Save as SaveIcon,
  Extension as ExtensionIcon,
} from '@mui/icons-material';
import { ModelPicker } from '../ModelPicker';
import { ToolGroupChecklist } from './ToolGroupChecklist';
import type { ToolGroup } from './ToolGroupChecklist';
import type { Agent } from '../../api/types';

const formSectionSx = {
  p: 2.5,
  borderRadius: 2,
  border: '1px solid',
  borderColor: 'divider',
  backgroundColor: 'background.paper',
  boxShadow: 'none',
};

interface AgentFormData {
  name: string;
  system_prompt: string;
  model_name: string;
  think: boolean;
  excluded_tools: string[];
  memory: string;
  memory_enabled: boolean;
}

interface AgentEditDialogProps {
  open: boolean;
  onClose: () => void;
  formData: AgentFormData;
  setFormData: (data: AgentFormData) => void;
  selectedAgent: Agent | null;
  isAdministrator: boolean;
  isPromptEditorExpanded: boolean;
  setIsPromptEditorExpanded: (value: boolean | ((current: boolean) => boolean)) => void;
  models: Array<{ name: string; provider: string }>;
  toolGroups: ToolGroup[];
  onSave: () => void;
  onRefreshModels: () => Promise<void>;
  onSuccess: (message: string) => void;
  onError: (message: string) => void;
}

export const AgentEditDialog: React.FC<AgentEditDialogProps> = ({
  open,
  onClose,
  formData,
  setFormData,
  selectedAgent,
  isAdministrator,
  isPromptEditorExpanded,
  setIsPromptEditorExpanded,
  models,
  toolGroups,
  onSave,
  onRefreshModels,
  onSuccess,
  onError,
}) => {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="md"
      fullWidth
      PaperProps={{ sx: { borderRadius: 3, overflow: 'hidden' } }}
    >
      <DialogTitle
        sx={{
          px: 3,
          py: 2,
          borderBottom: '1px solid',
          borderColor: 'divider',
          backgroundColor: 'background.paper',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap' }}>
          <Box>
            <Typography variant="h6">
              Edit Agent
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, maxWidth: 520 }}>
              Refine identity, prompting, tools, and memory settings.
            </Typography>
          </Box>
          <Typography variant="caption" color="text.secondary" sx={{ pt: 0.5 }}>
            {isAdministrator ? 'System agent' : 'Custom agent'}
          </Typography>
        </Box>
      </DialogTitle>
      <DialogContent sx={{ p: 3 }}>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
          <Box sx={formSectionSx}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
              <BadgeIcon fontSize="small" color="primary" />
              <Typography variant="h6">Identity</Typography>
            </Box>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <TextField
                label="Agent Name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                fullWidth
                required
                disabled={isAdministrator}
                helperText={isAdministrator ? 'Administrator name cannot be changed' : 'Display name used across the app'}
              />
              {selectedAgent?.persona && (
                <Typography variant="body2" color="text.secondary">
                  Linked persona: {selectedAgent.persona.name}
                </Typography>
              )}
            </Box>
          </Box>

          <Box sx={formSectionSx}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
              <PsychologyIcon fontSize="small" color="primary" />
              <Typography variant="h6">Behavior</Typography>
            </Box>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <Box
                sx={{
                  p: 2,
                  borderRadius: 2,
                  backgroundColor: 'background.paper',
                  border: '1px solid',
                  borderColor: 'divider',
                }}
              >
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 1,
                    flexWrap: 'wrap',
                    mb: 1.5,
                  }}
                >
                  <Box>
                    <Typography variant="body2" sx={{ fontWeight: 700 }}>
                      System Prompt
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      Define persona, boundaries, tone, and workflow expectations.
                    </Typography>
                  </Box>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography variant="caption" color="text.secondary">
                      {(isAdministrator ? 'System agent for routing conversations' : formData.system_prompt).length} chars
                    </Typography>
                    <Button
                      size="small"
                      variant="text"
                      startIcon={isPromptEditorExpanded ? <CloseFullscreenIcon /> : <OpenInFullIcon />}
                      onClick={() => setIsPromptEditorExpanded((current: boolean) => !current)}
                      disabled={isAdministrator}
                    >
                      {isPromptEditorExpanded ? 'Compact' : 'Expand'}
                    </Button>
                  </Box>
                </Box>
                <TextField
                  label={isPromptEditorExpanded ? 'Prompt Workspace' : 'System Prompt'}
                  value={isAdministrator ? 'System agent for routing conversations' : formData.system_prompt}
                  onChange={(e) => setFormData({ ...formData, system_prompt: e.target.value })}
                  multiline
                  minRows={isPromptEditorExpanded ? 12 : 6}
                  maxRows={isPromptEditorExpanded ? 20 : 10}
                  fullWidth
                  disabled={isAdministrator}
                  helperText={isAdministrator ? 'Administrator uses built-in routing logic' : 'Write instructions in plain language. Include role, response style, constraints, and when to use tools.'}
                  InputProps={{
                    sx: {
                      alignItems: 'flex-start',
                      '& textarea': {
                        fontFamily: '"Consolas", "SFMono-Regular", "Roboto Mono", monospace',
                        lineHeight: 1.6,
                      },
                    },
                  }}
                />
              </Box>
              <ModelPicker
                label="Model"
                value={formData.model_name}
                models={models}
                onChange={(model_name) => setFormData({ ...formData, model_name })}
                onRefresh={onRefreshModels}
                onSuccess={(message) => {
                  onSuccess(message);
                }}
                onError={onError}
                required
              />
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, p: 2, borderRadius: 2, backgroundColor: 'background.default', border: '1px solid', borderColor: 'divider' }}>
                <Box>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    Extended Thinking
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    Allow this agent to use longer reasoning traces when the backend supports it.
                  </Typography>
                </Box>
                <Switch checked={formData.think} onChange={(e) => setFormData({ ...formData, think: e.target.checked })} />
              </Box>
            </Box>
          </Box>

          <Box sx={formSectionSx}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
              <ExtensionIcon fontSize="small" color="primary" />
              <Typography variant="h6">Tools & Memory</Typography>
            </Box>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <Box>
                <ToolGroupChecklist
                  groups={toolGroups}
                  excludedTools={formData.excluded_tools}
                  onChange={(excluded) => setFormData({ ...formData, excluded_tools: excluded })}
                />
                <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
                  Uncheck tools this agent should not use.
                </Typography>
              </Box>
              <Box sx={{ p: 2, borderRadius: 2, backgroundColor: 'background.default', border: '1px solid', borderColor: 'divider' }}>
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2 }}>
                  <Box>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>
                      Agent Memory
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      Keep long-term notes that help this agent stay consistent over time.
                    </Typography>
                  </Box>
                  <Switch checked={formData.memory_enabled} onChange={(e) => setFormData({ ...formData, memory_enabled: e.target.checked })} />
                </Box>
                {formData.memory_enabled && (
                  <TextField
                    label="Memory"
                    value={formData.memory}
                    onChange={(e) => setFormData({ ...formData, memory: e.target.value })}
                    multiline
                    minRows={4}
                    maxRows={10}
                    fullWidth
                    placeholder="No memories yet. Memory is automatically built from conversations."
                    helperText="Auto-updated after conversations. You can also edit manually."
                    sx={{ mt: 2 }}
                  />
                )}
              </Box>
            </Box>
          </Box>
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2, borderTop: '1px solid', borderColor: 'divider', justifyContent: 'space-between' }}>
        <Typography variant="caption" color="text.secondary" sx={{ mr: 2 }}>
          Changes apply immediately after saving.
        </Typography>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="contained"
            startIcon={<SaveIcon />}
            onClick={onSave}
            disabled={!formData.name.trim() || !formData.model_name.trim()}
          >
            Save Changes
          </Button>
        </Box>
      </DialogActions>
    </Dialog>
  );
};
