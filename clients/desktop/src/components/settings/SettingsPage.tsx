import React from 'react';
import { Box, List, ListItemButton, ListItemIcon, ListItemText, Typography } from '@mui/material';
import {
  Person as AccountIcon,
  RecordVoiceOver as TTSIcon,
  Palette as AppearanceIcon,
  EmojiPeople as PersonasIcon,
  SmartToy as AgentsIcon,
  Extension as ToolsIcon,
  AutoFixHigh as SkillsIcon,
  FolderOpen as HostAccessIcon,
  Face as FacesIcon,
  GetApp as ExtensionsIcon,
} from '@mui/icons-material';
import { useLayoutStore } from '../../store/layoutStore';

// Lazy imports for settings sections
const AccountSection = React.lazy(() => import('./AccountSection').then(m => ({ default: m.AccountSection })));
const TTSSection = React.lazy(() => import('./TTSSection').then(m => ({ default: m.TTSSection })));
const AppearanceSection = React.lazy(() => import('./AppearanceSection').then(m => ({ default: m.AppearanceSection })));
const PersonasSection = React.lazy(() => import('./PersonasSection').then(m => ({ default: m.PersonasSection })));
const AgentsSection = React.lazy(() => import('./AgentsSection').then(m => ({ default: m.AgentsSection })));
const ToolsSection = React.lazy(() => import('./ToolsSection').then(m => ({ default: m.ToolsSection })));
const SkillsSection = React.lazy(() => import('./SkillsSection').then(m => ({ default: m.SkillsSection })));
const HostAccessSection = React.lazy(() => import('./HostAccessSection').then(m => ({ default: m.HostAccessSection })));
const FacesSection = React.lazy(() => import('./FacesSection').then(m => ({ default: m.FacesSection })));
const ExtensionsSection = React.lazy(() => import('./ExtensionsSection').then(m => ({ default: m.ExtensionsSection })));

interface SettingsItem {
  id: string;
  label: string;
  icon: React.ReactNode;
}

const SETTINGS_ITEMS: SettingsItem[] = [
  { id: 'account', label: 'Account', icon: <AccountIcon /> },
  { id: 'tts', label: 'TTS & ASR', icon: <TTSIcon /> },
  { id: 'appearance', label: 'Appearance', icon: <AppearanceIcon /> },
  { id: 'personas', label: 'Personas', icon: <PersonasIcon /> },
  { id: 'agents', label: 'Agents', icon: <AgentsIcon /> },
  { id: 'tools', label: 'Tools & MCP', icon: <ToolsIcon /> },
  { id: 'skills', label: 'Skills', icon: <SkillsIcon /> },
  { id: 'host-access', label: 'Host Access', icon: <HostAccessIcon /> },
  { id: 'faces', label: 'Face Identities', icon: <FacesIcon /> },
  { id: 'extensions', label: 'Extensions', icon: <ExtensionsIcon /> },
];

function renderSection(sectionId: string) {
  switch (sectionId) {
    case 'account': return <AccountSection />;
    case 'tts': return <TTSSection />;
    case 'appearance': return <AppearanceSection />;
    case 'personas': return <PersonasSection />;
    case 'agents': return <AgentsSection />;
    case 'mcp-servers': return <ToolsSection />; // Legacy route — redirect to merged page
    case 'tools': return <ToolsSection />;
    case 'skills': return <SkillsSection />;
    case 'host-access': return <HostAccessSection />;
    case 'faces': return <FacesSection />;
    case 'extensions': return <ExtensionsSection />;
    default: return null;
  }
}

export const SettingsPage: React.FC = () => {
  const { settingsSection, setSettingsSection } = useLayoutStore();

  return (
    <Box sx={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Settings nav sidebar */}
      <Box
        sx={{
          width: 220,
          flexShrink: 0,
          borderRight: 1,
          borderColor: 'divider',
          overflow: 'auto',
          py: 1.5,
          px: 1,
        }}
      >
        <Typography
          variant="caption"
          sx={{ px: 1.5, py: 1, display: 'block', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}
        >
          Settings
        </Typography>
        <List dense disablePadding>
          {SETTINGS_ITEMS.map((item) => (
            <ListItemButton
              key={item.id}
              selected={settingsSection === item.id}
              onClick={() => setSettingsSection(item.id)}
              sx={{ py: 0.75, px: 1.5, borderRadius: 1 }}
            >
              <ListItemIcon sx={{ minWidth: 32, color: settingsSection === item.id ? 'info.main' : 'text.secondary' }}>
                {item.icon}
              </ListItemIcon>
              <ListItemText
                primary={item.label}
                primaryTypographyProps={{ variant: 'body2', fontWeight: settingsSection === item.id ? 600 : 400 }}
              />
            </ListItemButton>
          ))}
        </List>
      </Box>

      {/* Settings content */}
      <Box sx={{ flex: 1, overflow: 'auto', p: 3 }}>
        <React.Suspense fallback={<Box sx={{ p: 4, color: 'text.secondary' }}>Loading...</Box>}>
          {renderSection(settingsSection)}
        </React.Suspense>
      </Box>
    </Box>
  );
};
