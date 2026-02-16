import React, { useState, useEffect } from 'react';
import {
  Box,
  Paper,
  Typography,
  IconButton,
  Alert,
  Card,
  CardContent,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Chip,
  Grid,
  Tabs,
  Tab,
  Button,
  CircularProgress,
  TextField,
} from '@mui/material';
import {
  Refresh as RefreshIcon,
  Extension as ExtensionIcon,
  Dns as DnsIcon,
  CheckCircle as CheckCircleIcon,
  Cancel as CancelIcon,
  AutoFixHigh as SkillIcon,
  Add as AddIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  FileUpload as ImportIcon,
  FileDownload as ExportIcon,
} from '@mui/icons-material';
import { motion, AnimatePresence } from 'framer-motion';
import { apiClient } from '../api/client';
import type { MCPServer, Tool, Skill } from '../api/types';

const MotionCard = motion(Card);

interface TabPanelProps {
  children?: React.ReactNode;
  index: number;
  value: number;
}

function TabPanel(props: TabPanelProps) {
  const { children, value, index, ...other } = props;
  return (
    <div
      role="tabpanel"
      hidden={value !== index}
      {...other}
    >
      {value === index && <Box sx={{ p: 3 }}>{children}</Box>}
    </div>
  );
}

export const ToolsWindow: React.FC = () => {
  const [currentTab, setCurrentTab] = useState(0);
  const [mcpServers, setMcpServers] = useState<MCPServer[]>([]);
  const [tools, setTools] = useState<{ mcp: Tool[], builtin: Tool[] }>({ mcp: [], builtin: [] });
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedTool, setSelectedTool] = useState<Tool | null>(null);
  const [detailsDialogOpen, setDetailsDialogOpen] = useState(false);

  // Skill editor state
  const [skillDialogOpen, setSkillDialogOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState<Skill | null>(null);
  const [skillName, setSkillName] = useState('');
  const [skillInstructions, setSkillInstructions] = useState('');
  const [skillSaving, setSkillSaving] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    setError('');
    try {
      const [serversRes, toolsRes, skillsRes] = await Promise.all([
        apiClient.listMCPServers(),
        apiClient.listTools(),
        apiClient.listSkills(),
      ]);
      setMcpServers(serversRes.servers);
      setTools({ mcp: toolsRes.mcp_tools, builtin: toolsRes.builtin_tools });
      setSkills(skillsRes);
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || 'Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const handleToolClick = (tool: Tool) => {
    setSelectedTool(tool);
    setDetailsDialogOpen(true);
  };

  const handleNewSkill = () => {
    setEditingSkill(null);
    setSkillName('');
    setSkillInstructions('');
    setSkillDialogOpen(true);
  };

  const handleEditSkill = (skill: Skill) => {
    setEditingSkill(skill);
    setSkillName(skill.name);
    setSkillInstructions(skill.instructions);
    setSkillDialogOpen(true);
  };

  const handleSaveSkill = async () => {
    if (!skillName.trim()) return;
    setSkillSaving(true);
    try {
      if (editingSkill) {
        await apiClient.updateSkill(editingSkill.id, {
          name: skillName,
          instructions: skillInstructions,
        });
      } else {
        await apiClient.createSkill({
          name: skillName,
          instructions: skillInstructions,
        });
      }
      setSkillDialogOpen(false);
      // Reload skills
      const skillsRes = await apiClient.listSkills();
      setSkills(skillsRes);
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || 'Failed to save skill');
    } finally {
      setSkillSaving(false);
    }
  };

  const handleDeleteSkill = async (skill: Skill) => {
    try {
      await apiClient.deleteSkill(skill.id);
      setSkills(prev => prev.filter(s => s.id !== skill.id));
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || 'Failed to delete skill');
    }
  };

  const handleExportSkill = (skill: Skill) => {
    const exportData = {
      name: skill.name,
      instructions: skill.instructions,
      version: 1,
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${skill.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.skill.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportSkill = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.skill.json';
    input.multiple = true;
    input.onchange = async (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (!files) return;

      for (const file of Array.from(files)) {
        try {
          const text = await file.text();
          const data = JSON.parse(text);
          if (!data.name || typeof data.name !== 'string') {
            setError(`Invalid skill file: ${file.name} — missing "name" field`);
            continue;
          }
          await apiClient.createSkill({
            name: data.name,
            instructions: data.instructions || '',
          });
        } catch (err: any) {
          setError(err.response?.data?.detail || err.message || `Failed to import ${file.name}`);
        }
      }
      const skillsRes = await apiClient.listSkills();
      setSkills(skillsRes);
    };
    input.click();
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'available':
        return 'success';
      case 'unavailable':
        return 'error';
      default:
        return 'default';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'available':
        return <CheckCircleIcon fontSize="small" />;
      case 'unavailable':
        return <CancelIcon fontSize="small" />;
      default:
        return null;
    }
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <Paper
        elevation={0}
        sx={{
          p: 2,
          borderBottom: '1px solid',
          borderColor: 'divider',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <Typography variant="h6">Tools & Skills</Typography>
        <IconButton onClick={loadData} disabled={loading} title="Refresh">
          <RefreshIcon />
        </IconButton>
      </Paper>

      {/* Tabs */}
      <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
        <Tabs value={currentTab} onChange={(_, v) => setCurrentTab(v)}>
          <Tab icon={<DnsIcon />} iconPosition="start" label="MCP Servers" />
          <Tab icon={<ExtensionIcon />} iconPosition="start" label="Available Tools" />
          <Tab icon={<SkillIcon />} iconPosition="start" label="Skills" />
        </Tabs>
      </Box>

      {/* Content */}
      <Box sx={{ flex: 1, overflow: 'auto', backgroundColor: '#F7F7F8' }}>
        {/* Alert messages */}
        {error && (
          <Alert severity="error" sx={{ m: 3, maxWidth: 1200, mx: 'auto' }} onClose={() => setError('')}>
            {error}
          </Alert>
        )}

        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '50%' }}>
            <CircularProgress />
          </Box>
        ) : (
          <>
            {/* MCP Servers Tab */}
            <TabPanel value={currentTab} index={0}>
              {mcpServers.length === 0 ? (
                <Paper sx={{ p: 4, textAlign: 'center', maxWidth: 600, mx: 'auto' }}>
                  <Typography variant="h6" gutterBottom>
                    No MCP Servers Configured
                  </Typography>
                  <Typography color="text.secondary">
                    MCP servers are configured via config files in the backend.
                  </Typography>
                </Paper>
              ) : (
                <Grid container spacing={3} sx={{ maxWidth: 1200, mx: 'auto' }}>
                  <AnimatePresence>
                    {mcpServers.map((server, index) => (
                      <Grid item xs={12} sm={6} md={4} key={server.name}>
                        <MotionCard
                          initial={{ opacity: 0, y: 20 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -20 }}
                          transition={{ duration: 0.3, delay: index * 0.05 }}
                          sx={{
                            border: '1px solid',
                            borderColor: 'divider',
                          }}
                        >
                          <CardContent>
                            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
                              <Typography variant="h6" sx={{ fontWeight: 600 }}>
                                {server.name}
                              </Typography>
                              <Chip
                                icon={getStatusIcon(server.status)}
                                label={server.status}
                                color={getStatusColor(server.status) as any}
                                size="small"
                              />
                            </Box>
                            <Typography
                              variant="body2"
                              color="text.secondary"
                              sx={{
                                fontFamily: 'monospace',
                                fontSize: '0.75rem',
                                backgroundColor: '#f5f5f5',
                                p: 1,
                                borderRadius: 1,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {server.url || `${server.command} ${server.args.join(' ')}`}
                            </Typography>
                          </CardContent>
                        </MotionCard>
                      </Grid>
                    ))}
                  </AnimatePresence>
                </Grid>
              )}
            </TabPanel>

            {/* Available Tools Tab */}
            <TabPanel value={currentTab} index={1}>
              {tools.mcp.length === 0 && tools.builtin.length === 0 ? (
                <Paper sx={{ p: 4, textAlign: 'center', maxWidth: 600, mx: 'auto' }}>
                  <Typography variant="h6" gutterBottom>
                    No Tools Available
                  </Typography>
                  <Typography color="text.secondary">
                    Tools will appear here once MCP servers are connected or built-in tools are registered.
                  </Typography>
                </Paper>
              ) : (
                <Grid container spacing={3} sx={{ maxWidth: 1200, mx: 'auto' }}>
                  <AnimatePresence>
                    {/* MCP Tools */}
                    {tools.mcp.map((tool, index) => (
                      <Grid item xs={12} sm={6} md={4} key={`mcp-${tool.function.name}`}>
                        <MotionCard
                          initial={{ opacity: 0, y: 20 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -20 }}
                          transition={{ duration: 0.3, delay: index * 0.05 }}
                          onClick={() => handleToolClick(tool)}
                          sx={{
                            cursor: 'pointer',
                            border: '1px solid',
                            borderColor: 'divider',
                            '&:hover': {
                              boxShadow: 3,
                              transform: 'translateY(-2px)',
                            },
                            transition: 'box-shadow 0.2s, transform 0.2s',
                          }}
                        >
                          <CardContent>
                            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
                              <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                                {tool.function.name}
                              </Typography>
                              <Chip label="MCP" size="small" color="primary" variant="outlined" />
                            </Box>
                            <Typography
                              variant="body2"
                              color="text.secondary"
                              sx={{
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                display: '-webkit-box',
                                WebkitLineClamp: 3,
                                WebkitBoxOrient: 'vertical',
                                minHeight: 60,
                              }}
                            >
                              {tool.function.description || 'No description available'}
                            </Typography>
                          </CardContent>
                        </MotionCard>
                      </Grid>
                    ))}

                    {/* Built-in Tools */}
                    {tools.builtin.map((tool, index) => (
                      <Grid item xs={12} sm={6} md={4} key={`builtin-${tool.function.name}`}>
                        <MotionCard
                          initial={{ opacity: 0, y: 20 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -20 }}
                          transition={{ duration: 0.3, delay: (tools.mcp.length + index) * 0.05 }}
                          onClick={() => handleToolClick(tool)}
                          sx={{
                            cursor: 'pointer',
                            border: '1px solid',
                            borderColor: 'divider',
                            '&:hover': {
                              boxShadow: 3,
                              transform: 'translateY(-2px)',
                            },
                            transition: 'box-shadow 0.2s, transform 0.2s',
                          }}
                        >
                          <CardContent>
                            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
                              <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                                {tool.function.name}
                              </Typography>
                              {tool.built_in && <Chip label="Built-in" size="small" color="secondary" variant="outlined" />}
                            </Box>
                            <Typography
                              variant="body2"
                              color="text.secondary"
                              sx={{
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                display: '-webkit-box',
                                WebkitLineClamp: 3,
                                WebkitBoxOrient: 'vertical',
                                minHeight: 60,
                              }}
                            >
                              {tool.function.description || 'No description available'}
                            </Typography>
                          </CardContent>
                        </MotionCard>
                      </Grid>
                    ))}
                  </AnimatePresence>
                </Grid>
              )}
            </TabPanel>

            {/* Skills Tab */}
            <TabPanel value={currentTab} index={2}>
              <Box sx={{ maxWidth: 900, mx: 'auto' }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
                  <Box>
                    <Typography variant="body2" color="text.secondary">
                      Skills are instructions injected into every agent's system prompt, teaching the LLM when and how to use its capabilities.
                    </Typography>
                  </Box>
                  <Box sx={{ display: 'flex', gap: 1, ml: 2, flexShrink: 0 }}>
                    <Button
                      variant="outlined"
                      startIcon={<ImportIcon />}
                      onClick={handleImportSkill}
                    >
                      Import
                    </Button>
                    <Button
                      variant="contained"
                      startIcon={<AddIcon />}
                      onClick={handleNewSkill}
                    >
                      New Skill
                    </Button>
                  </Box>
                </Box>

                {skills.length === 0 ? (
                  <Paper sx={{ p: 4, textAlign: 'center' }}>
                    <SkillIcon sx={{ fontSize: 48, color: 'text.disabled', mb: 2 }} />
                    <Typography variant="h6" gutterBottom>
                      No Skills Defined
                    </Typography>
                    <Typography color="text.secondary" sx={{ mb: 2 }}>
                      Create skills to teach your agents new capabilities. For example, create a "Music Player" skill
                      with instructions on when and how to use the play_music tool.
                    </Typography>
                    <Button variant="outlined" startIcon={<AddIcon />} onClick={handleNewSkill}>
                      Create Your First Skill
                    </Button>
                  </Paper>
                ) : (
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <AnimatePresence>
                      {skills.map((skill, index) => (
                        <MotionCard
                          key={skill.id}
                          initial={{ opacity: 0, y: 20 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -20 }}
                          transition={{ duration: 0.3, delay: index * 0.05 }}
                          sx={{
                            border: '1px solid',
                            borderColor: 'divider',
                          }}
                        >
                          <CardContent>
                            <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                              <Box sx={{ flex: 1, mr: 2 }}>
                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                                  <SkillIcon fontSize="small" color="primary" />
                                  <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                                    {skill.name}
                                  </Typography>
                                </Box>
                                <Typography
                                  variant="body2"
                                  color="text.secondary"
                                  sx={{
                                    whiteSpace: 'pre-wrap',
                                    fontFamily: 'monospace',
                                    fontSize: '0.8rem',
                                    backgroundColor: '#f5f5f5',
                                    p: 1.5,
                                    borderRadius: 1,
                                    maxHeight: 200,
                                    overflow: 'auto',
                                  }}
                                >
                                  {skill.instructions || '(no instructions)'}
                                </Typography>
                              </Box>
                              <Box sx={{ display: 'flex', gap: 0.5, flexShrink: 0 }}>
                                <IconButton size="small" onClick={() => handleExportSkill(skill)} title="Export">
                                  <ExportIcon fontSize="small" />
                                </IconButton>
                                <IconButton size="small" onClick={() => handleEditSkill(skill)} title="Edit">
                                  <EditIcon fontSize="small" />
                                </IconButton>
                                <IconButton size="small" onClick={() => handleDeleteSkill(skill)} title="Delete" color="error">
                                  <DeleteIcon fontSize="small" />
                                </IconButton>
                              </Box>
                            </Box>
                          </CardContent>
                        </MotionCard>
                      ))}
                    </AnimatePresence>
                  </Box>
                )}
              </Box>
            </TabPanel>
          </>
        )}
      </Box>

      {/* Tool Details Dialog */}
      <Dialog
        open={detailsDialogOpen}
        onClose={() => setDetailsDialogOpen(false)}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <ExtensionIcon />
            <Typography variant="h6">{selectedTool?.function.name}</Typography>
          </Box>
        </DialogTitle>
        <DialogContent dividers>
          {selectedTool && (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {/* Source */}
              <Box>
                <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                  Source
                </Typography>
                <Chip
                  label={tools.mcp.some(t => t.function.name === selectedTool.function.name) ? 'MCP' : selectedTool.built_in ? 'Built-in' : 'Native'}
                  color={tools.mcp.some(t => t.function.name === selectedTool.function.name) ? 'primary' : 'secondary'}
                  size="small"
                />
              </Box>

              {/* Description */}
              <Box>
                <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                  Description
                </Typography>
                <Typography>
                  {selectedTool.function.description || 'No description available'}
                </Typography>
              </Box>

              {/* Parameters */}
              <Box>
                <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                  Parameters
                </Typography>
                <Paper
                  variant="outlined"
                  sx={{
                    p: 2,
                    backgroundColor: '#f5f5f5',
                    fontFamily: 'monospace',
                    fontSize: '0.85rem',
                    overflow: 'auto',
                    maxHeight: 300,
                  }}
                >
                  <pre style={{ margin: 0 }}>
                    {JSON.stringify(selectedTool.function.parameters, null, 2)}
                  </pre>
                </Paper>
              </Box>
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDetailsDialogOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>

      {/* Skill Editor Dialog */}
      <Dialog
        open={skillDialogOpen}
        onClose={() => setSkillDialogOpen(false)}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>
          {editingSkill ? 'Edit Skill' : 'New Skill'}
        </DialogTitle>
        <DialogContent dividers>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3, pt: 1 }}>
            <TextField
              label="Skill Name"
              value={skillName}
              onChange={(e) => setSkillName(e.target.value)}
              fullWidth
              placeholder="e.g., Music Player"
            />
            <TextField
              label="Instructions"
              value={skillInstructions}
              onChange={(e) => setSkillInstructions(e.target.value)}
              fullWidth
              multiline
              minRows={6}
              maxRows={16}
              placeholder={
                'Write instructions that teach the LLM how to use this capability.\n\n' +
                'Example:\n' +
                'You have access to a music player that can stream audio from YouTube.\n' +
                '- When the user asks to play a song, use the `play_music` tool.\n' +
                '- Use `music_control` to pause, resume, skip, or stop.\n' +
                '- Use `get_music_queue` to check what\'s playing.'
              }
              helperText="These instructions are injected into every agent's system prompt."
            />
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSkillDialogOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={handleSaveSkill}
            disabled={!skillName.trim() || skillSaving}
          >
            {skillSaving ? <CircularProgress size={20} /> : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>

    </Box>
  );
};
