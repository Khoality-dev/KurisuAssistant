import React from 'react';

const ICON_SIZE = 18;

const FolderIcon: React.FC<{ open?: boolean }> = ({ open }) => (
  <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 18 18" fill="none">
    {open ? (
      <path
        d="M2 5.5C2 4.67 2.67 4 3.5 4H7l1.5 1.5H14.5C15.33 5.5 16 6.17 16 7V7.5H5.5L3 13.5V5.5Z M3 13.5L5.5 7.5H16L13.5 13.5H3Z"
        fill="#F59E0B"
        stroke="#D97706"
        strokeWidth="0.5"
      />
    ) : (
      <path
        d="M2 5C2 4.17 2.67 3.5 3.5 3.5H7L8.5 5H14.5C15.33 5 16 5.67 16 6.5V13C16 13.83 15.33 14.5 14.5 14.5H3.5C2.67 14.5 2 13.83 2 13V5Z"
        fill="#F59E0B"
        stroke="#D97706"
        strokeWidth="0.5"
      />
    )}
  </svg>
);

const TypeScriptIcon: React.FC = () => (
  <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 18 18" fill="none">
    <rect x="2" y="2" width="14" height="14" rx="2" fill="#3178C6" />
    <text x="9" y="12.5" textAnchor="middle" fill="white" fontSize="8" fontWeight="bold" fontFamily="sans-serif">TS</text>
  </svg>
);

const JavaScriptIcon: React.FC = () => (
  <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 18 18" fill="none">
    <rect x="2" y="2" width="14" height="14" rx="2" fill="#F7DF1E" />
    <text x="9" y="12.5" textAnchor="middle" fill="#1A1A1A" fontSize="8" fontWeight="bold" fontFamily="sans-serif">JS</text>
  </svg>
);

const PythonIcon: React.FC = () => (
  <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 18 18" fill="none">
    <rect x="2" y="2" width="14" height="14" rx="2" fill="#3776AB" />
    <text x="9" y="12.5" textAnchor="middle" fill="white" fontSize="8" fontWeight="bold" fontFamily="sans-serif">PY</text>
  </svg>
);

const JsonIcon: React.FC = () => (
  <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 18 18" fill="none">
    <rect x="2" y="2" width="14" height="14" rx="2" stroke="#A3A3A3" strokeWidth="1" />
    <text x="9" y="12" textAnchor="middle" fill="#A3A3A3" fontSize="6.5" fontWeight="bold" fontFamily="monospace">{'{}'}</text>
  </svg>
);

const MarkdownIcon: React.FC = () => (
  <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 18 18" fill="none">
    <rect x="2" y="2" width="14" height="14" rx="2" stroke="#6B7280" strokeWidth="1" />
    <text x="9" y="12.5" textAnchor="middle" fill="#6B7280" fontSize="9" fontWeight="bold" fontFamily="sans-serif">M</text>
  </svg>
);

const HtmlIcon: React.FC = () => (
  <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 18 18" fill="none">
    <rect x="2" y="2" width="14" height="14" rx="2" fill="#E34F26" />
    <text x="9" y="12" textAnchor="middle" fill="white" fontSize="6" fontWeight="bold" fontFamily="monospace">{'<>'}</text>
  </svg>
);

const CssIcon: React.FC = () => (
  <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 18 18" fill="none">
    <rect x="2" y="2" width="14" height="14" rx="2" fill="#1572B6" />
    <text x="9" y="12" textAnchor="middle" fill="white" fontSize="6.5" fontWeight="bold" fontFamily="monospace">#</text>
  </svg>
);

const ImageIcon: React.FC = () => (
  <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 18 18" fill="none">
    <rect x="2" y="2" width="14" height="14" rx="2" stroke="#22C55E" strokeWidth="1" />
    <circle cx="7" cy="7" r="1.5" fill="#22C55E" />
    <path d="M2 12L6 8.5L9 11L12 8L16 12V14C16 15.1 15.1 16 14 16H4C2.9 16 2 15.1 2 14V12Z" fill="#22C55E" opacity="0.6" />
  </svg>
);

const ConfigIcon: React.FC = () => (
  <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 18 18" fill="none">
    <rect x="2" y="2" width="14" height="14" rx="2" stroke="#8B5CF6" strokeWidth="1" />
    <path d="M5 6H13M5 9H11M5 12H9" stroke="#8B5CF6" strokeWidth="1" strokeLinecap="round" />
  </svg>
);

const DefaultFileIcon: React.FC = () => (
  <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 18 18" fill="none">
    <path
      d="M4 2.5H11L14 5.5V15C14 15.28 13.78 15.5 13.5 15.5H4C3.72 15.5 3.5 15.28 3.5 15V3C3.5 2.72 3.72 2.5 4 2.5Z"
      stroke="#9CA3AF"
      strokeWidth="1"
      fill="none"
    />
    <path d="M11 2.5V5.5H14" stroke="#9CA3AF" strokeWidth="1" fill="none" />
  </svg>
);

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico']);
const CONFIG_EXTENSIONS = new Set(['.yaml', '.yml', '.toml', '.ini', '.env', '.conf', '.cfg']);

const DriveIcon: React.FC = () => (
  <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 18 18" fill="none">
    <rect x="3" y="4" width="12" height="10" rx="1.5" fill="#6B7280" opacity="0.15" stroke="#6B7280" strokeWidth="1"/>
    <rect x="5" y="7" width="8" height="1.5" rx="0.5" fill="#6B7280"/>
    <circle cx="12" cy="11" r="1" fill="#22C55E"/>
  </svg>
);

export function getFileIcon(name: string, type: 'file' | 'directory', isOpen?: boolean, isDrive?: boolean): React.ReactNode {
  if (isDrive) {
    return <DriveIcon />;
  }
  if (type === 'directory') {
    return <FolderIcon open={isOpen} />;
  }

  const lower = name.toLowerCase();
  const dotIdx = lower.lastIndexOf('.');
  const ext = dotIdx !== -1 ? lower.slice(dotIdx) : '';

  // TypeScript
  if (ext === '.ts' || ext === '.tsx') return <TypeScriptIcon />;

  // JavaScript
  if (ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') return <JavaScriptIcon />;

  // Python
  if (ext === '.py' || ext === '.pyw') return <PythonIcon />;

  // JSON
  if (ext === '.json' || ext === '.jsonc') return <JsonIcon />;

  // Markdown
  if (ext === '.md' || ext === '.mdx') return <MarkdownIcon />;

  // HTML
  if (ext === '.html' || ext === '.htm') return <HtmlIcon />;

  // CSS
  if (ext === '.css' || ext === '.scss' || ext === '.less') return <CssIcon />;

  // Image
  if (IMAGE_EXTENSIONS.has(ext)) return <ImageIcon />;

  // Config
  if (CONFIG_EXTENSIONS.has(ext)) return <ConfigIcon />;

  return <DefaultFileIcon />;
}
