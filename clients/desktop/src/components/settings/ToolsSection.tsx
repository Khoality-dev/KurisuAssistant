import React, { useState, useEffect } from 'react';
import {
  Box,
  Paper,
  Typography,
  Card,
  CardContent,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Chip,
  Grid,
  Button,
  CircularProgress,
} from '@mui/material';
import {
  Extension as ExtensionIcon,
  Dns as DnsIcon,
} from '@mui/icons-material';
import { motion, AnimatePresence } from 'framer-motion';
import { apiClient } from '../../api/client';
import type { Tool } from '../../api/types';
import { getClientToolsByServer } from '../../services/mcpService';

const MotionCard = motion(Card);

export const ToolsSection: React.FC = () => {
  const [tools, setTools] = useState<{ mcp: Tool[], builtin: Tool[], mcpServers: Record<string, Tool[]> }>({ mcp: [], builtin: [], mcpServers: {} });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedTool, setSelectedTool] = useState<Tool | null>(null);
  const [detailsDialogOpen, setDetailsDialogOpen] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const applyToolsResponse = async (toolsRes: { mcp_tools: Tool[]; builtin_tools: Tool[]; mcp_servers?: Record<string, Tool[]> }) => {
    const mcpServersMap: Record<string, Tool[]> = { ...(toolsRes.mcp_servers || {}) };
    const allMcpTools = [...toolsRes.mcp_tools];
    // Merge client-side MCP tools grouped by server name
    const clientGrouped = await getClientToolsByServer();
    for (const [serverName, serverTools] of Object.entries(clientGrouped)) {
      mcpServersMap[serverName] = serverTools as Tool[];
      allMcpTools.push(...(serverTools as Tool[]));
    }
    // Merge built-in client tools (host, app, browser) into the tools list
    // Fetch directly from IPC in case mcpService hasn't initialized yet
    const builtinClientTools: Tool[] = [];
    if (window.electron?.hostTools) {
      try { builtinClientTools.push(...(await window.electron.hostTools.listTools() as Tool[])); } catch {}
    }
    if (window.electron?.appTools) {
      try { builtinClientTools.push(...(await window.electron.appTools.listTools() as Tool[])); } catch {}
    }
    const mcpToolNames = new Set(allMcpTools.map(t => t.function.name));
    const serverBuiltinNames = new Set(toolsRes.builtin_tools.map(t => t.function.name));
    const clientBuiltins = builtinClientTools.filter(t =>
      !mcpToolNames.has(t.function.name) && !serverBuiltinNames.has(t.function.name)
    );
    setTools({ mcp: allMcpTools, builtin: [...toolsRes.builtin_tools, ...clientBuiltins], mcpServers: mcpServersMap });
  };

  const loadData = async () => {
    setLoading(true);
    setError('');
    try {
      const toolsRes = await apiClient.listTools();
      await applyToolsResponse(toolsRes);
    } catch (err: any) {
      setError(err.response?.data?.detail || err.message || 'Failed to load tools');
    } finally {
      setLoading(false);
    }
  };

  const handleToolClick = (tool: Tool) => {
    setSelectedTool(tool);
    setDetailsDialogOpen(true);
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      <Typography variant="h5" gutterBottom fontWeight={600}>
        Available Tools
      </Typography>

      {error && (
        <Box sx={{ mb: 2, color: 'error.main' }}>
          <Typography variant="body2">{error}</Typography>
        </Box>
      )}

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
        <Box sx={{ maxWidth: 1200, mx: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {/* MCP Server groups (grouped view) */}
          {Object.keys(tools.mcpServers).length > 0 ? (
            Object.entries(tools.mcpServers).map(([serverName, serverTools]) => (
              serverTools.length > 0 && (
                <Box key={serverName}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                    <DnsIcon fontSize="small" color="primary" />
                    <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>{serverName}</Typography>
                    <Chip label={`${serverTools.length} tools`} size="small" variant="outlined" />
                  </Box>
                  <Grid container spacing={2}>
                    <AnimatePresence>
                      {serverTools.map((tool, index) => (
                        <Grid item xs={12} sm={6} md={4} key={tool.function.name}>
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
                              '&:hover': { boxShadow: 3, transform: 'translateY(-2px)' },
                              transition: 'box-shadow 0.2s, transform 0.2s',
                            }}
                          >
                            <CardContent>
                              <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>
                                {tool.function.name}
                              </Typography>
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
                </Box>
              )
            ))
          ) : tools.mcp.length > 0 && (
            /* Fallback: flat MCP list when grouped data unavailable */
            <Box>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                <DnsIcon fontSize="small" color="primary" />
                <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>MCP Tools</Typography>
                <Chip label={`${tools.mcp.length} tools`} size="small" variant="outlined" />
              </Box>
              <Grid container spacing={2}>
                <AnimatePresence>
                  {tools.mcp.map((tool, index) => (
                    <Grid item xs={12} sm={6} md={4} key={tool.function.name}>
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
                          '&:hover': { boxShadow: 3, transform: 'translateY(-2px)' },
                          transition: 'box-shadow 0.2s, transform 0.2s',
                        }}
                      >
                        <CardContent>
                          <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>
                            {tool.function.name}
                          </Typography>
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
            </Box>
          )}

          {/* Built-in Tools */}
          {tools.builtin.length > 0 && (
            <Box>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                <ExtensionIcon fontSize="small" color="secondary" />
                <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>Built-in</Typography>
                <Chip label={`${tools.builtin.length} tools`} size="small" variant="outlined" />
              </Box>
              <Grid container spacing={2}>
                <AnimatePresence>
                  {tools.builtin.map((tool, index) => (
                    <Grid item xs={12} sm={6} md={4} key={tool.function.name}>
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
                          '&:hover': { boxShadow: 3, transform: 'translateY(-2px)' },
                          transition: 'box-shadow 0.2s, transform 0.2s',
                        }}
                      >
                        <CardContent>
                          <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>
                            {tool.function.name}
                          </Typography>
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
            </Box>
          )}
        </Box>
      )}

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
                  label={(() => {
                    const serverName = Object.entries(tools.mcpServers).find(([, serverTools]) =>
                      serverTools.some(t => t.function.name === selectedTool.function.name)
                    )?.[0];
                    return serverName || (selectedTool.built_in ? 'Built-in' : 'Native');
                  })()}
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
                    backgroundColor: (t: any) => t.palette.mode === 'light' ? '#f5f5f5' : '#1A1A1A',
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
    </Box>
  );
};
