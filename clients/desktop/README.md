# KurisuAssistant Desktop Client

A modern desktop chat client for KurisuAssistant built with React, Electron, TypeScript, Material-UI, and Framer Motion.

## Features

- 🔐 User authentication (login/registration)
- 💬 Real-time streaming chat responses with typewriter effect
- 📋 Conversation management (create, view, delete)
- 🖼️ Image attachment support
- 🤖 Multiple LLM model selection
- 📦 Chunk-based message management for efficient token usage
- 🎨 Modern UI with smooth animations
- 🎭 ChatGPT-inspired design with Material-UI components
- ⚡ Fast and responsive Electron desktop app

## Tech Stack

- **Frontend**: React 18 + TypeScript
- **Desktop**: Electron
- **UI Library**: Material-UI (MUI)
- **Animations**: Framer Motion
- **State Management**: Zustand
- **HTTP Client**: Axios
- **Build Tool**: Vite
- **Markdown**: react-markdown

## Prerequisites

- Node.js 18 or higher
- npm or yarn
- KurisuAssistant server running (default: http://localhost:15597)

## Installation

1. Clone the repository:
```bash
cd D:\Programming\KurisuAssistant-Client-Windows
```

2. Install dependencies:
```bash
npm install
```

## Configuration

Edit `src/config.ts` to change the server URL and other settings:

```typescript
export const config = {
  apiBaseUrl: 'http://localhost:15597',
  typewriterSpeed: 20, // milliseconds per character
};
```

## Running the Application

### Development Mode

```bash
npm run electron:dev
```

This will start the Vite dev server and launch Electron with hot-reload enabled.

### Build for Production

```bash
npm run electron:build
```

This will create a distributable application in the `release/` directory.

## Usage

### Login/Registration

1. On first launch, you'll see the login window
2. Use the "Register" tab to create a new account
3. Use the "Login" tab to sign in with existing credentials

### Chat Interface

1. **Create Conversation**: Click "➕ New Conversation" to start a new chat
2. **Select Conversation**: Click on any conversation in the list to open it
3. **Send Message**: Type your message and click "Send" or press Enter
4. **Attach Images**: Click "📎 Attach Image" to upload images with your message
5. **Select Model**: Choose your preferred LLM model from the dropdown
6. **Delete Conversation**: Select a conversation and click "🗑️ Delete Conversation"

### Features

- **Streaming Responses**: Watch as the AI generates responses in real-time
- **Conversation History**: All messages are saved and can be retrieved
- **Chunk Management**: Messages are automatically organized into chunks for efficient processing
- **Image Support**: Attach images to your messages for visual context
- **Markdown Rendering**: Messages support markdown formatting

## Project Structure

```
KurisuAssistant-Client-Windows/
├── electron/               # Electron main process
│   ├── main.ts            # Main Electron entry point
│   └── preload.ts         # Preload script
├── src/                    # React application source
│   ├── api/               # API client layer
│   │   ├── client.ts      # Axios HTTP client
│   │   └── types.ts       # TypeScript types
│   ├── components/        # React components
│   │   ├── LoginWindow.tsx
│   │   ├── MainWindow.tsx
│   │   └── ChatWidget.tsx
│   ├── store/             # Zustand state management
│   │   ├── authStore.ts
│   │   └── conversationStore.ts
│   ├── theme/             # Material-UI theme
│   │   └── theme.ts
│   ├── config.ts          # App configuration
│   ├── App.tsx            # Main App component
│   └── main.tsx           # React entry point
├── public/                # Static assets
├── index.html             # HTML entry point
├── package.json           # Node dependencies
├── tsconfig.json          # TypeScript configuration
├── vite.config.ts         # Vite build configuration
└── README.md              # This file
```

## API Integration

The client integrates with the following KurisuAssistant API endpoints:

- `POST /login` - User authentication
- `POST /register` - User registration
- `GET /conversations` - List conversations
- `POST /conversations` - Create new conversation
- `GET /conversations/{id}` - Get conversation messages
- `DELETE /conversations/{id}` - Delete conversation
- `POST /chat` - Send chat message (streaming)
- `GET /models` - Get available LLM models

## Troubleshooting

### Connection Error

If you get a connection error, make sure:
1. The KurisuAssistant server is running
2. The server URL in `src/config.ts` is correct
3. Your firewall allows the connection

### Build Errors

Make sure you've installed all dependencies:
```bash
npm install
```

If you encounter issues, try clearing the cache:
```bash
rm -rf node_modules dist dist-electron
npm install
```

## Development

### Adding New Features

1. **API endpoints**: Add methods to `src/api/client.ts`
2. **UI components**: Create new React components in `src/components/`
3. **State management**: Add new stores in `src/store/`
4. **Configuration**: Update `src/config.ts`

### Code Style

- Follow TypeScript best practices
- Use functional components with hooks
- Use Material-UI components for consistency
- Add Framer Motion animations for smooth transitions
- Keep components focused and reusable

### Future Enhancements

- **gRPC Integration**: Architecture is ready to support gRPC communication with a separate process
- **Persistent auth**: Add token storage
- **Dark mode**: Extend Material-UI theme
- **Voice support**: Add audio input/output

## License

See LICENSE file for details.

## Support

For issues and questions, please refer to the main KurisuAssistant repository.
