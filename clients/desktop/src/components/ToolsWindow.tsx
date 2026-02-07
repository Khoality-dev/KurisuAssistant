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
} from '@mui/material';
import {
  Refresh as RefreshIcon,
  Extension as ExtensionIcon,
  Dns as DnsIcon,
  CheckCircle as CheckCircleIcon,
  Cancel as CancelIcon,
} from '@mui/icons-material';
import { motion, AnimatePresence } from 'framer-motion';
import { apiClient } from '../api/client';
import type { MCPServer, Tool } from '../api/types';

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedTool, setSelectedTool] = useState<Tool | null>(null);
  const [detailsDialogOpen, setDetailsDialogOpen] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    setError('');
    try {
      const [serversRes, toolsRes] = await Promise.all([
        apiClient.listMCPServers(),
        apiClient.listTools(),
      ]);
      setMcpServers(serversRes.servers);
      setTools({ mcp: toolsRes.mcp_tools, builtin: toolsRes.builtin_tools });
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
                              {server.command} {server.args.join(' ')}
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
                              <Chip label="Built-in" size="small" color="secondary" variant="outlined" />
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
                  label={tools.mcp.some(t => t.function.name === selectedTool.function.name) ? 'MCP' : 'Built-in'}
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
    </Box>
  );
};
