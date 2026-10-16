import React, { useCallback, useEffect, useState } from 'react';
import { Box, Button, Paper, Typography } from '@mui/material';
import type { McpServerInfo } from '@kurisu/platform';
import { resolveBridge } from '@kurisu/platform';

/**
 * What this desktop lets other programs do, and what it may launch: the MCP
 * endpoint an external client connects to, and the command lines answered
 * "Always allow" at the spawn prompt. Both are about this machine, so they sit
 * in Host Access beside the folder grants — Settings › Tools lists the
 * assistant's tools and nothing else (#360).
 */
export const DesktopProgramsPanel: React.FC = () => {
  // Its token is a credential for local code execution, so it starts hidden.
  const [mcpServerInfo, setMcpServerInfo] = useState<McpServerInfo | null>(null);
  const [tokenVisible, setTokenVisible] = useState(false);
  const [approvedSpawns, setApprovedSpawns] = useState<string[]>([]);

  useEffect(() => {
    resolveBridge().mcpServer?.getInfo()
      .then(setMcpServerInfo)
      .catch(() => setMcpServerInfo(null));
    resolveBridge().mcp?.getApprovedSpawns().then(setApprovedSpawns).catch(() => {});
  }, []);

  const rotateToken = useCallback(async () => {
    const info = await resolveBridge().mcpServer?.rotateToken();
    if (info) {
      setMcpServerInfo(info);
      setTokenVisible(true);
    }
  }, []);

  const revokeSpawn = useCallback(async (commandLine: string) => {
    const remaining = await resolveBridge().mcp?.revokeApprovedSpawn(commandLine);
    if (remaining) setApprovedSpawns(remaining);
  }, []);

  return (
    <>
      {mcpServerInfo && (
        <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 0.5 }}>
            This desktop's MCP endpoint
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
            Publishes the host and app tools to an MCP client on this machine. It listens on
            localhost only, and a client must send the token below. Anyone holding it can run
            commands here, so treat it as a password.
          </Typography>
          <Typography variant="body2" sx={{ fontFamily: 'monospace', mb: 0.75 }}>
            {mcpServerInfo.url}
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            <Typography variant="body2" sx={{ fontFamily: 'monospace', wordBreak: 'break-all', flex: 1, minWidth: 240 }}>
              Authorization: Bearer {tokenVisible ? mcpServerInfo.token : '•'.repeat(24)}
            </Typography>
            <Button size="small" onClick={() => setTokenVisible((v) => !v)}>
              {tokenVisible ? 'Hide' : 'Show'}
            </Button>
            <Button size="small" onClick={() => navigator.clipboard.writeText(mcpServerInfo.token)}>
              Copy
            </Button>
            <Button size="small" color="warning" onClick={rotateToken}>
              New token
            </Button>
          </Box>
        </Paper>
      )}

      {resolveBridge().mcp && (
        <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 0.5 }}>
            Approved programs
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: approvedSpawns.length ? 1.5 : 0 }}>
            Starting a local MCP server runs a program on this computer. Each command line is
            asked about the first time it runs; the ones you allowed permanently are listed here.
          </Typography>
          {approvedSpawns.length === 0 ? (
            <Typography variant="caption" color="text.secondary">None yet.</Typography>
          ) : (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
              {approvedSpawns.map((commandLine) => (
                <Box key={commandLine} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Typography variant="caption" sx={{ fontFamily: 'monospace', wordBreak: 'break-all', flex: 1 }}>
                    {commandLine}
                  </Typography>
                  <Button size="small" color="warning" onClick={() => revokeSpawn(commandLine)}>
                    Revoke
                  </Button>
                </Box>
              ))}
            </Box>
          )}
        </Paper>
      )}
    </>
  );
};
