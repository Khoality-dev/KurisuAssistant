# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

KurisuAssistant-Client-Windows is a modern desktop client for the KurisuAssistant AI platform. Built with React, Electron, TypeScript, Material-UI, and Framer Motion, it provides a rich chat interface with smooth animations for interacting with the LLM backend, supporting text and image messages, conversation management, user settings with avatar uploads, and real-time streaming responses with visual typing indicators.

## Tech Stack

- **Frontend Framework**: React 18 with TypeScript
- **Desktop Platform**: Electron 28
- **UI Library**: Material-UI (MUI) v5
- **Animation**: Framer Motion
- **State Management**: Zustand
- **HTTP Client**: Axios
- **Build Tool**: Vite
- **Markdown Rendering**: react-markdown

## Architecture

### Application Structure

```
KurisuAssistant-Client-Windows/
├── electron/               # Electron main process
│   ├── main.ts            # Electron entry point, window management
│   └── preload.ts         # Preload script for security (context bridge)
├── src/                    # React application source
│   ├── api/               # API client layer
│   │   ├── client.ts      # Axios HTTP client with streaming support
│   │   └── types.ts       # TypeScript interfaces for API responses
│   ├── components/        # React components
│   │   ├── LoginWindow.tsx    # Authentication UI with tabs
│   │   ├── MainWindow.tsx     # Main layout with sidebar
│   │   ├── ChatWidget.tsx     # Chat interface with streaming
│   │   └── MessageBubble.tsx  # Individual message bubble component
│   ├── hooks/             # Custom React hooks
│   │   └── useTTS.ts      # TTS audio synthesis and playback hook
│   ├── store/             # Zustand state management
│   │   ├── authStore.ts       # Authentication state & actions
│   │   └── conversationStore.ts # Conversation & message state
│   ├── theme/             # Material-UI theming
│   │   └── theme.ts       # ChatGPT-inspired theme configuration
│   ├── utils/             # Utility functions
│   │   └── storage.ts     # localStorage wrapper for token and settings persistence
│   ├── config.ts          # App configuration (API URL)
│   ├── App.tsx            # Root component with theme provider
│   └── main.tsx           # React entry point
├── public/                # Static assets
├── index.html             # HTML entry point
├── package.json           # Dependencies and npm scripts
├── tsconfig.json          # TypeScript configuration
├── vite.config.ts         # Vite + Electron plugin configuration
└── README.md              # User documentation
```

### Key Components

#### `electron/main.ts`
- Electron main process entry point
- Creates browser window (1200x800, min 800x600)
- Loads Vite dev server in development or bundled HTML in production
- Handles app lifecycle (quit, activate, window-all-closed)
- Security: contextIsolation enabled, nodeIntegration disabled

#### `electron/preload.ts`
- Exposes safe APIs to renderer process via contextBridge
- Currently minimal (only exposes platform info)
- Future: Can add IPC handlers for gRPC communication

#### `src/App.tsx`
- Root React component
- Conditional rendering: LoginWindow vs MainWindow based on auth state
- Wraps app with Material-UI ThemeProvider
- Applies CssBaseline for consistent styling

#### `src/components/LoginWindow.tsx`
- Tabbed interface (Login / Register) using MUI Tabs
- Material-UI form components (TextField, Button)
- Framer Motion `MotionPaper` with fade-in animation
- Calls `authStore.login()` or `authStore.register()`
- Purple gradient background for visual appeal
- Error handling with MUI Alert component

#### `src/components/MainWindow.tsx`
- Main layout with Material-UI permanent Drawer (280px sidebar)
- **Left Drawer**:
  - User info display
  - New conversation button (green)
  - Delete conversation button (red, disabled when no selection)
  - Logout button (top-right)
  - Scrollable conversation list with AnimatePresence
- **Right Panel**: ChatWidget component
- Loads conversations on mount
- Handles conversation selection/deletion
- Error alerts at top of panel

#### `src/components/ChatWidget.tsx`
- Three-section layout:
  1. **Top bar**: Model selector (MUI Select) with reload button to refresh available models
  2. **Messages area**: Scrollable chat history with Framer Motion animations
  3. **Input area**: Multi-line TextField + Attach button + Send button
- **Streaming Implementation**:
  - Uses async generator `apiClient.chatStream()`
  - Parses newline-delimited JSON chunks (sentence-by-sentence from backend)
  - **Message Accumulation**: Sentence chunks with the same role are accumulated into a single message
  - **Role Changes**: When role changes (e.g., assistant → tool, assistant → agent), creates a new message
  - **Display Priority**: During streaming, displays content from streaming response (`streamingContent`), NOT from database
  - Message added to store with empty content initially, updated only when streaming completes
  - Displays content immediately as it streams (no artificial delay)
  - **Database Sync**: Store updated with final content only after streaming completes
  - **Typing Indicators**:
    - "{Role} is typing..." with animated bouncing dots shown **inside the message bubble** while waiting for first chunk
    - Typing indicator appears in the same message bubble that will contain the response
    - Blinking cursor shown during typing animation (first in thinking section if present, then in content)
    - "Done" indicator with checkmark icon appears when streaming completes (fades after 3 seconds)
  - **Typing Effect**: **Sequential** character-by-character display (2 chars every 20ms)
    - Thinking types out first (if present), then content types out
    - Both thinking and content are part of the same turn/message
    - Cursor appears in thinking section while thinking is typing, then moves to content section
  - **Multi-Agent Support**: Handles any role name from backend, not limited to predefined roles
- **Message Rendering**:
  - ReactMarkdown for content rendering
  - **Alignment**: User messages aligned right, all other roles aligned left
  - **Role Labels**: Automatically capitalizes role name for display (e.g., "assistant" → "Assistant")
  - User messages: white background
  - Assistant messages: light teal background
  - Tool messages: light amber background
  - Custom agent roles: default to teal background (can be customized)
  - Code blocks styled with gray background
- **Image Attachments**:
  - File input for multiple image selection
  - Chips display attached images with delete option before sending
  - Images uploaded to server first (via POST /images) to get UUIDs
  - UUIDs stored in message.images array
  - Images sent as FormData with chat request to backend
- **Image Display**:
  - User uploaded images displayed at top of message bubble
  - Images are clickable and open in new tab at full resolution
  - Assistant images rendered from markdown `![Image](/images/uuid)` syntax
  - Custom ReactMarkdown component for styling images
  - Max width 100%, max height 300px (user) / 400px (assistant)
  - Rounded corners and hover cursor for better UX
- **Infinite Scroll Pagination**:
  - Initial load shows most recent 50 messages
  - Scroll to top (within 100px) triggers `loadMoreMessages()`
  - Older messages prepended to the beginning of the messages array
  - Scroll position preserved after loading (prevents jumping)
  - Loading indicator shown at top while fetching
  - `hasMoreMessages` prevents unnecessary loading attempts
- **Auto-scroll**: Scrolls to bottom on new messages (but not when loading older messages)
- **Model Selection Persistence**: Selected model saved to localStorage and restored on app restart
- **Thinking Display**:
  - Messages with thinking content show a collapsible "Thinking" button with Psychology icon
  - Thinking section appears immediately when thinking starts streaming
  - Toggle button with ExpandMore icon that rotates when expanded
  - Thinking content hidden by default (user must click to reveal)
  - Expanded thinking shown in monospace font with light gray background
  - Max height 400px with scroll for long thinking blocks
  - Smooth expand/collapse animation with Framer Motion
  - **Sequential Typing**: Thinking types out FIRST, then content types out (both part of same message)
  - Blinking cursor appears in thinking section while it's typing
  - Displayed above main message content with separator
  - State tracked via `expandedThinking` Set (by message index)
  - Display logic: Shows if saved `message.thinking` exists OR (streaming AND `streamingThinking` has content)

#### `src/components/MessageBubble.tsx`
- Extracted component for rendering individual message bubbles
- **Props**:
  - `message`: Message data (role, content, thinking, images)
  - `index`: Message index in the list
  - `isLast`: Whether this is the last message
  - `isStreaming`: Global streaming state
  - `streamingThinking`, `streamingContent`: Full streamed data from backend
  - `displayedThinking`, `displayedContent`: Currently displayed subset (for typing effect)
  - `justFinishedStreaming`: Whether streaming just finished (for "Done" indicator)
  - `expandedThinking`: Set of indices with expanded thinking panels
  - `onToggleThinking`: Callback to toggle thinking panel expansion
  - `ttsVoice`: Optional TTS voice name for synthesis
  - `ttsLanguage`: Optional TTS language code
- **Responsibilities**:
  - Renders message bubble with role-based styling
  - Handles thinking section with expand/collapse
  - Shows typing indicators and blinking cursors
  - Displays images from user or markdown
  - Shows "Done" indicator when streaming completes
  - Sequential typing effect (thinking first, then content)
  - **TTS Playback**: Speaker button for non-user messages to play/stop audio
- **TTS Integration**:
  - Uses `useTTS()` hook for audio synthesis and playback
  - Speaker button appears next to role label for assistant/tool/agent messages
  - Click to play message content as speech, click again to stop
  - Visual feedback: Icon changes from VolumeUp to Stop when playing
  - Uses configured voice and language from settings
- **Benefits**:
  - Cleaner code organization (extracted from ChatWidget)
  - Easier to maintain and test
  - Reusable message rendering logic

#### `src/components/SettingsWindow.tsx`
- Settings page for user preferences and customization
- Accessible via Settings icon in MainWindow sidebar
- **Tabbed Interface** using Material-UI Tabs:

  **Tab 1: Account Settings (Backend)**
  - Icon: AccountCircleIcon
  - **User Avatar Upload**: Upload and preview user avatar image
  - **Agent Avatar Upload**: Upload and preview agent/assistant avatar image
  - **Preferred Name**: Set how the agent should address the user
  - **System Prompt**: Custom instructions for agent behavior (multiline text area)
  - **Save Button**: "Save Account Settings" - Updates backend via `PATCH /users/me`
  - Data stored in backend database (persists across devices)

  **Tab 2: TTS Settings (Client-side)**
  - Icon: VolumeUpIcon
  - **TTS Backend**: Dropdown selector for TTS provider (gpt-sovits, index-tts, etc.)
  - **TTS Voice**: Dropdown selector for available voices (dynamically loaded from backend)
  - **TTS Language**: Text field for language code (e.g., "en", "ja", "zh")
  - **TTS Auto-Play**: Toggle switch to automatically play assistant messages
  - **Emotion Controls** (INDEX-TTS only, shown when backend is "index-tts"):
    - **Emotion Reference Audio**: Dropdown to select emotion voice from available voices
    - **Emotion Strength**: Slider (0.0 - 1.0) to control emotion intensity
    - **Infer emotion from text**: Toggle to enable text-based emotion inference
  - **Save Button**: "Save TTS Settings" - Updates localStorage only
  - Data stored in localStorage (client-specific preferences)

- **Tab Navigation**: Smooth transitions with Framer Motion animations
- **Avatar Preview**: Shows current avatar or default fallback
- **Success/Error Messages**: Material-UI Alerts displayed above tabs
- **Back Navigation**: Arrow button returns to chat interface

### Custom Hooks

#### `src/hooks/useTTS.ts`
- Custom React hook for TTS (Text-to-Speech) functionality
- **State**:
  - `isPlaying`: Boolean indicating if audio is currently playing
  - `voices`: Array of available voice names (strings) from backend
  - `backends`: Array of available TTS backend names (e.g., ["gpt-sovits", "index-tts"])
- **Methods**:
  - `speak(text, voice?, language?, backend?)`: Synthesize and play text as speech
    - Calls `apiClient.synthesize()` to get audio Blob
    - Supports backend selection (gpt-sovits, index-tts, etc.)
    - Creates Audio element and plays it
    - Manages object URL lifecycle (creation and revocation)
    - Stops previous audio if playing
  - `stop()`: Stop current audio playback
  - `loadVoices()`: Fetch available voices from backend (`GET /tts/voices`)
  - `loadBackends()`: Fetch available TTS backends from backend (`GET /tts/backends`)
- **Audio Management**:
  - Uses `useRef` for current audio element and audio URL
  - Cleanup effect on unmount to prevent memory leaks
  - Event handlers for audio end and error events
- **Usage**: Import and call `useTTS()` to get `{speak, stop, isPlaying, voices, loadVoices, backends, loadBackends}`

### State Management (Zustand)

#### `authStore.ts`
```typescript
{
  isAuthenticated: boolean,
  user: UserProfile | null,
  rememberMe: boolean,
  login(username, password, rememberMe): Promise<void>,
  register(username, password, email?, rememberMe?): Promise<void>,
  logout(): void,
  loadUserProfile(): Promise<void>,
  initializeAuth(): Promise<void>,
  setRememberMe(remember): void
}
```

- Stores auth token in apiClient singleton AND localStorage (if rememberMe=true)
- Token persisted across app restarts when "Remember Me" is enabled
- Auto-login on app startup via `initializeAuth()` method
- Token validation on startup ensures expired tokens are cleared

#### `conversationStore.ts`
```typescript
{
  conversations: Conversation[],
  currentConversation: Conversation | null,
  messages: Message[],
  models: string[],
  selectedModel: string,

  // Pagination state
  totalMessages: number,
  hasMoreMessages: boolean,
  messagesOffset: number,
  isLoadingMessages: boolean,

  loadConversations(): Promise<void>,
  loadConversation(id): Promise<void>,       // Loads first page (most recent 50 messages)
  loadMoreMessages(): Promise<void>,         // Loads next page of older messages
  deleteConversation(id): Promise<void>,
  createNewConversation(): void,              // Clears messages, resets pagination state
  loadModels(): Promise<void>,
  setSelectedModel(model): void,
  addMessage(message): void,
  updateLastMessage(content, thinking?, role?): void,  // For streaming updates
  setCurrentConversationId(id): Promise<void>  // After backend creates conversation, auto-refreshes list if new
}
```

- **Pagination**: Messages loaded in pages of 50, newest first
- `loadConversation()` loads most recent 50 messages (offset=0)
- `loadMoreMessages()` loads next 50 older messages (increments offset)
- `hasMoreMessages` indicates if more pages available
- `isLoadingMessages` prevents duplicate loading requests
- Messages array rebuilt on conversation selection
- `currentConversation=null` indicates new, unsaved conversation
- After first message sent, backend returns `conversation_id` and `chunk_id` in all chunks

### API Client (`src/api/client.ts`)

Built with Axios and native Fetch API in singleton pattern (`apiClient`).
- Regular API calls use Axios for convenience
- Streaming chat uses native Fetch API for better browser compatibility

**Key Methods**:

- `login(username, password)`: Returns `{access_token, token_type}`, stores token
- `register(username, password, email?)`: Same as login
- `setToken(token)`, `clearToken()`: Manage auth token
- `getConversations()`: Returns `Conversation[]`
- `getConversation(id)`: Returns `{messages: Message[]}`
- `deleteConversation(id)`: Deletes conversation
- `updateConversation(id, title)`: Updates conversation title
- **`chatStream(text, modelName, conversationId?, images?)`**:
  - Async generator yielding `StreamChunk` objects
  - Uses native Fetch API for streaming (better browser compatibility than Axios)
  - Reads response.body as ReadableStream with proper lock management
  - Parses newline-delimited JSON
  - All chunks include `conversation_id` and `chunk_id` (not just first chunk)
  - User message is NOT streamed back (backend saves directly to DB)
  - Proper error handling and reader cleanup in finally block
- `getModels()`: Returns `string[]` of available models
- `getUserProfile()`: Get user settings and profile data
- `updateUserProfile(profile)`: Update user settings (accepts Partial<UserProfile> or FormData for file uploads)
- `uploadImage(file)`: Upload image file, returns `{image_uuid, url}`
- `getImageUrl(uuid)`: Constructs full image URL from UUID for display
- **`synthesize(text, voice?, language?)`**: Synthesize speech from text, returns audio Blob
  - Calls `POST /tts` with JSON body
  - Returns audio data as Blob for playback
  - Uses Axios with `responseType: 'blob'`
- **`listVoices()`**: Get available TTS voices from backend
  - Calls `GET /tts/voices`
  - Returns `string[]` of voice names (scanned from reference/ folder)

**Error Handling**:
- Network errors caught by try/catch in components
- Displays user-facing errors via MUI Alert or QMessageBox equivalent
- Console.error for debugging

## API Integration

### Authentication Flow

```typescript
// 1. User submits login form with "Remember Me" checkbox
await authStore.login(username, password, rememberMe);
// Internally:
//   - Calls apiClient.login() → POST /login
//   - Stores token in apiClient instance
//   - If rememberMe=true: Saves token to localStorage
//   - Fetches user profile → GET /users/me
//   - Sets isAuthenticated = true

// 2. All subsequent requests include header:
//    Authorization: Bearer <token>

// 3. On app startup (App.tsx useEffect):
await authStore.initializeAuth();
// Internally:
//   - Checks localStorage for saved token
//   - If found: Sets token in apiClient, verifies by fetching user profile
//   - If valid: Auto-login, user stays authenticated
//   - If invalid/expired: Clears stored token, shows login screen
```

### Token Persistence ("Remember Me")

The app implements persistent authentication via localStorage:

**Storage Layer** (`src/utils/storage.ts`):
- Encapsulates localStorage access for persistent data
- Keys: `kurisu_auth_token`, `kurisu_remember_me`, `kurisu_selected_model`, `kurisu_tts_backend`, `kurisu_tts_voice`, `kurisu_tts_language`, `kurisu_tts_auto_play`, `kurisu_tts_emo_audio`, `kurisu_tts_emo_alpha`, `kurisu_tts_use_emo_text`
- **Auth Methods**: `setToken()`, `getToken()`, `clearToken()`, `setRememberMe()`, `getRememberMe()`
- **Model Selection Methods**: `setSelectedModel()`, `getSelectedModel()`
- **TTS Settings Methods**: `setTTSBackend()`, `getTTSBackend()`, `setTTSVoice()`, `getTTSVoice()`, `setTTSLanguage()`, `getTTSLanguage()`, `setTTSAutoPlay()`, `getTTSAutoPlay()`
- **TTS Emotion Settings Methods** (INDEX-TTS): `setTTSEmotionAudio()`, `getTTSEmotionAudio()`, `setTTSEmotionAlpha()`, `getTTSEmotionAlpha()`, `setTTSUseEmotionText()`, `getTTSUseEmotionText()`

**Auth Store** (`src/store/authStore.ts`):
- `rememberMe` state tracked in Zustand store
- `login()` and `register()` accept `rememberMe: boolean` parameter
- Token saved to localStorage only if `rememberMe=true`
- `initializeAuth()` method loads token on app startup
- Token validation: Attempts to fetch user profile to verify token is still valid
- Auto-clears invalid/expired tokens from storage

**UI Components**:
- `LoginWindow`: "Remember Me" checkbox (default: checked)
- `App.tsx`: Shows loading spinner during `initializeAuth()` on startup
- Seamless auto-login if valid token exists

**Security Notes**:
- Tokens stored in localStorage (accessible to renderer process only)
- No XSS risk in Electron with contextIsolation enabled
- Tokens validated on each app startup (not blindly trusted)
- User can opt out via unchecking "Remember Me"

### Image Handling Workflow

**User uploads images:**
1. User selects images via file input in ChatWidget
2. Images shown as preview chips with delete option
3. On send: Images uploaded one by one via `POST /images`
4. Server returns `{image_uuid, url}` for each image
5. UUIDs stored in `message.images` array
6. Original File objects sent to backend via chat request (FormData)
7. User message rendered with image previews at top of bubble

**Assistant returns images:**
1. Backend includes images as markdown: `![Image](/images/uuid)`
2. ReactMarkdown renders images with custom component
3. Images displayed inline with message content
4. Click to open full resolution in new tab

### Conversation Creation Pattern

**Important**: Conversations are NOT created via explicit `POST /conversations` call.

**Flow**:
1. User clicks "New Conversation" → `createNewConversation()` → Clears messages, sets `currentConversation=null`
2. User types message → Clicks Send
3. `chatStream()` called with `conversationId=null`
4. Backend auto-creates conversation on first message
5. First streaming chunk contains: `{conversation_id: 123, chunk_id: 456, message: {...}}`
6. ChatWidget calls `setCurrentConversationId(123)` which:
   - Searches for conversation in current list
   - If not found (new conversation), automatically calls `loadConversations()` to refresh sidebar
   - Sets `currentConversation` to the newly created conversation

### Message Streaming Protocol

**POST /chat** with FormData:
```typescript
const formData = new FormData();
formData.append('text', userMessage);
formData.append('model_name', selectedModel);
if (conversationId) formData.append('conversation_id', conversationId.toString());
// Note: chunk_id is no longer sent by client - backend manages chunks automatically
images.forEach(img => formData.append('images', img));
```

**Response**: Newline-delimited JSON stream
```json
{"message": {"role": "assistant", "content": "", "thinking": "Let me think about this..."}, "conversation_id": 123, "chunk_id": 456}
{"message": {"role": "assistant", "content": "", "thinking": " The answer is..."}, "conversation_id": 123, "chunk_id": 456}
{"message": {"role": "assistant", "content": "Hello"}, "conversation_id": 123, "chunk_id": 456}
{"message": {"role": "assistant", "content": " world"}, "conversation_id": 123, "chunk_id": 456}
{"message": {"role": "assistant", "content": "!"}, "conversation_id": 123, "chunk_id": 456}
{"done": true}
```

**Important**:
- User message is NOT streamed back to client (saved to DB only)
- All response chunks include `conversation_id` and `chunk_id`
- Backend sends sentence-chunked assistant responses
- Final chunk contains `{"done": true}` to signal completion
- **Thinking content** (if present) is streamed progressively as separate chunks with empty content
- Both thinking and content are streamed in real-time as they arrive from the LLM

**Client-side handling**:
```typescript
for await (const chunk of apiClient.chatStream(...)) {
  // Handle conversation creation (ID in every chunk now)
  if (chunk.conversation_id && !streamConversationId) {
    streamConversationId = chunk.conversation_id;
    setActiveConversationId(chunk.conversation_id);
    // Auto-refreshes conversation list if this is a new conversation
    setCurrentConversationId(chunk.conversation_id).catch(console.error);
  }

  // Handle streaming completion
  if (chunk.done) {
    // Update store with final content and thinking
    updateLastMessage(accumulatedContent, accumulatedThinking || undefined);
    setJustFinishedStreaming(true);
    break;
  }

  // Accumulate content
  if (chunk.message?.content) {
    accumulatedContent += chunk.message.content;
    scheduleStreamUpdate(accumulatedContent, accumulatedThinking);
  }

  // Accumulate thinking progressively as it streams
  if (chunk.message?.thinking) {
    accumulatedThinking += chunk.message.thinking;
    scheduleStreamUpdate(accumulatedContent, accumulatedThinking);
  }
}
```

### Backend API Endpoints

- `POST /login` - Authenticate, returns JWT token
- `POST /register` - Create account, returns JWT token
- `GET /conversations` - List user's conversations (returns array directly)
- `GET /conversations/{id}` - Get messages for conversation
- `DELETE /conversations/{id}` - Delete conversation
- `POST /conversations/{id}` - Update conversation (e.g., title)
- `POST /chat` - Send message, stream response (FormData with text, model_name, conversation_id?, images? - chunk_id auto-managed by backend)
- `GET /models` - List available LLM models (returns `{models: string[]}`)
- `GET /users/me` - Get user profile
- `PUT /users/me` - Update user profile (system_prompt, avatars, etc.)
- `GET /images/{uuid}` - Fetch uploaded image
- `POST /images` - Upload image, returns `{uuid}`

## Material-UI Theme (`src/theme/theme.ts`)

### Color Palette

- **Primary**: `#10A37F` (ChatGPT teal)
- **Background**: `#F7F7F8` (chat area), `#FFFFFF` (paper/cards)
- **Text**: `#0D0D0D` (primary), `#565869` (secondary)
- **Divider**: `#E5E5E5`
- **Error**: `#EF4444` (red for delete button)

### Typography

- **Font**: "Segoe UI", Roboto, "Helvetica Neue", sans-serif
- **Sizes**: 14px base, buttons 0.875rem, headings 1.25-2rem
- **Button text**: No transform (textTransform: 'none')

### Component Customizations

- **Buttons**: 8px border-radius, 12px vertical padding, no shadow (elevation 0)
- **TextFields**: 8px border-radius, white background, teal border on focus
- **Papers**: 12px border-radius, subtle shadow (elevation 1)
- **ListItemButton** (conversations): 8px border-radius, 4px margin, selected = light teal bg + left border

### Design Tokens

- **Spacing**: 8px base unit (MUI default)
- **Border Radius**: 8px (buttons, inputs), 12px (papers)

## Framer Motion Animations

### LoginWindow
```typescript
<MotionPaper
  initial={{ opacity: 0, y: 20 }}
  animate={{ opacity: 1, y: 0 }}
  transition={{ duration: 0.5 }}
>
```
- Fade in + slide up on mount

### MainWindow - Conversation List
```typescript
<AnimatePresence>
  {conversations.map(conv => (
    <MotionListItemButton
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.2 }}
    />
  ))}
</AnimatePresence>
```
- Slide in from left on add
- Slide out to left on delete
- AnimatePresence handles exit animations

### ChatWidget - Messages
```typescript
<AnimatePresence>
  {messages.map((msg, i) => (
    <MotionBox
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3 }}
    />
  ))}
</AnimatePresence>
```
- Fade in + slide up on new message
- Smooth exit animation

### Streaming Display with Sequential Typing Effect
- **Sequential Typing Animation**: Character-by-character display (2 chars every 20ms)
  - **Thinking types first**, then **content types second** (both part of same turn/message)
  - Single interval controls both, sequentially
- **Visual Indicators**:
  - Bouncing dots "{Role} is typing..." shown inside message bubble before any content appears
  - Blinking cursor appears in **thinking section** while thinking is typing
  - Once thinking is fully displayed, cursor moves to **content section** during content typing
  - Cursor only shows in the section actively being typed
- **Real-time**: Backend streams sentence-by-sentence, client displays with sequential typing animation
- **State Management**:
  - `streamingThinking`: Full thinking received from backend
  - `streamingContent`: Full content received from backend
  - `displayedThinking`: Subset of thinking currently displayed (grows first during typing)
  - `displayedContent`: Subset of content currently displayed (grows after thinking is done)
  - Single interval (`typingIntervalRef`) controls sequential typing of both
- CSS animations:
  ```css
  /* Blinking cursor */
  animation: blink 1s infinite
  @keyframes blink: 0%, 49% { opacity: 1 } | 50%, 100% { opacity: 0 }

  /* Bouncing dots */
  animation: bounce 1.4s infinite ease-in-out
  @keyframes bounce: 0%, 80%, 100% { scale(0), opacity: 0.5 } | 40% { scale(1), opacity: 1 }
  ```

## Development Workflow

### Running the App

**Development**:
```bash
npm run electron:dev
```
- Starts Vite dev server on `http://localhost:5173`
- Launches Electron window
- Hot reload enabled for React code
- DevTools open by default

**Production Build**:
```bash
npm run electron:build
```
- Runs TypeScript compiler
- Builds React app with Vite
- Packages Electron app with electron-builder
- Output: `release/` directory with distributable

### Project Setup

```bash
npm install
```

**Dependencies**:
- React, React-DOM
- Material-UI (`@mui/material`, `@emotion/react`, `@emotion/styled`)
- MUI Icons (`@mui/icons-material`)
- Framer Motion
- Zustand
- Axios
- react-markdown
- Electron, Vite, TypeScript (dev dependencies)

### File Conventions

- **Components**: PascalCase `.tsx` files in `src/components/`
- **Stores**: camelCase `.ts` files in `src/store/` (e.g., `authStore.ts`)
- **Types**: Centralized in `src/api/types.ts`
- **Config**: Single `src/config.ts` for app-wide constants

### Code Style

- **TypeScript**: Strict mode enabled
- **React**: Functional components with hooks (no class components)
- **State**: Zustand for global state, useState for local component state
- **Styling**: Material-UI `sx` prop (avoid inline styles or CSS files)
- **Animations**: Framer Motion for all transitions (avoid CSS animations)
- **Error Handling**: Try/catch around async calls, display errors with MUI Alert

## Common Development Tasks

### Adding a New API Endpoint

1. Add TypeScript interface to `src/api/types.ts`:
```typescript
export interface NewData {
  id: number;
  name: string;
}
```

2. Add method to `src/api/client.ts`:
```typescript
async getNewData(): Promise<NewData> {
  const response = await this.client.get<NewData>('/new-endpoint', {
    headers: this.getHeaders(),
  });
  return response.data;
}
```

3. Use in component:
```typescript
const data = await apiClient.getNewData();
```

### Adding a New Component

1. Create `src/components/NewComponent.tsx`:
```typescript
import React from 'react';
import { Box, Typography } from '@mui/material';
import { motion } from 'framer-motion';

export const NewComponent: React.FC = () => {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <Box sx={{ p: 2 }}>
        <Typography>Hello World</Typography>
      </Box>
    </motion.div>
  );
};
```

2. Import and use in parent component:
```typescript
import { NewComponent } from './NewComponent';
// ...
<NewComponent />
```

### Adding State to Zustand Store

1. Edit `src/store/conversationStore.ts`:
```typescript
interface ConversationState {
  newField: string;
  setNewField: (value: string) => void;
}

export const useConversationStore = create<ConversationState>((set) => ({
  newField: '',
  setNewField: (value) => set({ newField: value }),
}));
```

2. Use in component:
```typescript
const { newField, setNewField } = useConversationStore();
```

### Customizing Theme

Edit `src/theme/theme.ts`:
```typescript
primary: {
  main: '#FF5722',  // Change to orange
},
```

All components automatically update.

## Future Enhancements

### gRPC Integration

The architecture is designed to support gRPC communication with a separate process:

**Planned Structure**:
1. Create `src/grpc/` directory for gRPC client code
2. Use `@grpc/grpc-js` for Node.js gRPC client
3. Expose gRPC methods via `electron/preload.ts` using IPC
4. Call from React components using `window.electron.grpc.method()`

**Example**:
```typescript
// electron/preload.ts
contextBridge.exposeInMainWorld('grpc', {
  callMethod: (request) => ipcRenderer.invoke('grpc-call', request),
});

// src/components/Component.tsx
const result = await (window as any).grpc.callMethod(params);
```

### Other Potential Features

- **Dark Mode**: Add theme toggle, create dark variant of MUI theme
- **Voice Support**: Integrate Web Speech API or external TTS/STT
- **Multi-window**: Support multiple chat windows
- **Settings Panel**: Add user preferences UI
- **Conversation Search**: Add search functionality to sidebar
- **Message Editing**: Allow editing sent messages
- **Export**: Export conversations to markdown/PDF

## Troubleshooting

### Streaming Not Working

- Check that backend returns `Content-Type: text/event-stream` or similar
- Verify newline-delimited JSON format
- Use browser DevTools Network tab to inspect response

### Animations Laggy

- Reduce number of animated elements
- Use `layoutId` in Framer Motion for layout animations
- Consider `useReducedMotion` hook for accessibility

### Build Errors

- Clear caches: `rm -rf node_modules dist dist-electron && npm install`
- Check TypeScript errors: `npm run build` (runs tsc)
- Ensure all dependencies installed

### Electron Window Not Opening

- Check console for errors in terminal
- Verify Vite dev server is running (http://localhost:5173)
- Check `electron/main.ts` for correct URL loading

## Testing Strategy (Future)

**Planned**:
- **Unit Tests**: Jest + React Testing Library for components
- **E2E Tests**: Playwright or Spectron for Electron app testing
- **API Mocking**: MSW (Mock Service Worker) for API tests

**Current**: Manual testing only

## Performance Considerations

- **Lazy Loading**: Consider React.lazy() for routes/modals
- **Message Virtualization**: For very long conversations, use `react-window`
- **Memoization**: Use `React.memo()` for expensive components
- **Debouncing**: Debounce search/filter inputs

## Security Notes

- **Context Isolation**: Enabled in Electron (prevents direct Node.js access from renderer)
- **No Node Integration**: Renderer process cannot use require()
- **CSP**: Consider adding Content Security Policy headers
- **Token Storage**: Currently in-memory only (no XSS risk, but not persistent)

## License

See LICENSE file for details.
