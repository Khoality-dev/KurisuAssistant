import React from 'react';
import { Box, Paper, Typography, Button } from '@mui/material';
import { SmartToy as AssistantIcon } from '@mui/icons-material';

/**
 * Shown when the server refuses a turn with `NO_MODEL_SELECTED`.
 *
 * A new account's `assistants.model_name` is NULL — provisioning cannot choose a
 * model — so the very first message has nothing to run on. That is a setup step
 * with a one-click fix, not a fault, which is why it is a bar above the composer
 * in the shape of `ToolApprovalBar` rather than the six-second red toast every
 * other error gets. The failure it replaces read as "the software is broken"
 * (#149).
 */
interface NoModelPromptProps {
  /** Opens Settings → Assistant, where the model picker is. */
  onChooseModel: () => void;
  onDismiss: () => void;
}

export const NoModelPrompt: React.FC<NoModelPromptProps> = ({ onChooseModel, onDismiss }) => (
  <Paper
    elevation={3}
    sx={{ p: 2, borderTop: '2px solid', borderColor: 'info.main' }}
  >
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
      <AssistantIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        No model selected
      </Typography>
    </Box>

    <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5 }}>
      Your assistant has no model to answer with yet. Pick one in
      Settings&nbsp;→&nbsp;Assistant, then send again — your text is back in the box
      below. Any attachments will need adding again.
    </Typography>

    <Box sx={{ display: 'flex', gap: 1 }}>
      <Button size="small" variant="contained" color="info" onClick={onChooseModel}>
        Choose a model
      </Button>
      <Button size="small" color="inherit" onClick={onDismiss}>
        Not now
      </Button>
    </Box>
  </Paper>
);
