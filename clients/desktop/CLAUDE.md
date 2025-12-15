# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

KurisuAssistant-Client-Windows is a desktop Qt-based client for the KurisuAssistant voice AI platform. Built with PySide6, it provides a chat interface for interacting with the LLM backend, supporting text and image messages, conversation management, and real-time streaming responses.

## Architecture

### Application Structure

```
KurisuAssistant-Client-Windows/
├── main.py                 # Application entry point
├── login_window.py         # Authentication UI
├── main_window.py          # Main window with conversation list
├── chat_widget.py          # Chat interface with message streaming
├── api_client.py           # HTTP client for backend API
├── config.py               # Application configuration
└── requirements.txt        # Python dependencies
```

### Key Components

#### `main.py`
- Application entry point
- Initializes QApplication
- Shows LoginWindow on startup
- Transitions to MainWindow after successful authentication

#### `login_window.py`
- Login/registration forms
- Token-based authentication flow
- Validates credentials against backend `/login` endpoint
- Stores auth token for subsequent requests

#### `main_window.py`
- Main application window with two-panel layout:
  - **Left Panel**: Conversation list with New/Delete buttons
  - **Right Panel**: Active ChatWidget
- Manages conversation selection and navigation
- Handles conversation list refresh via `conversation_list_changed` signal

#### `chat_widget.py`
- Core chat interface with:
  - Message history display (markdown-rendered)
  - Text input field
  - Model selector dropdown
  - Image attachment support
  - Send button
- **Streaming Architecture**:
  - `ChatStreamWorker`: QThread worker for async streaming
  - Parses newline-delimited JSON responses
  - Emits `message_chunk` signals for UI updates
- **Typewriter Effect**:
  - Letter-by-letter display using QTimer (20ms per character = 50 chars/sec)
  - Buffers incoming chunks and displays progressively
  - Smooth visual feedback during streaming
- **Signal**: `conversation_list_changed` - emitted when conversation is auto-created or needs refresh

#### `api_client.py`
- Centralized HTTP client using `requests` library
- **Request Handler Pattern**:
  - `RequestHandler` class wraps all HTTP operations
  - Automatic retry logic with exponential backoff
  - Handles streaming and non-streaming responses
- **Key Methods**:
  - `login()`, `register()`: Authentication
  - `get_conversations()`: List user conversations
  - `get_conversation(id)`: Fetch conversation messages
  - `chat_stream()`: Stream chat responses (supports `conversation_id=None` for auto-creation)
  - `delete_conversation(id)`: Delete conversation
  - `get_user_profile()`, `update_user_profile()`: User settings management

#### `config.py`
- Application-wide constants
- Server endpoint configuration
- UI dimensions and chat settings
- Default: `http://localhost:15597`

## API Integration

### Authentication Flow

```python
# 1. User logs in
response = api_client.login(username, password)
# Returns: {"access_token": "...", "token_type": "bearer"}

# 2. Token stored in api_client.token
# 3. All subsequent requests include: Authorization: Bearer <token>
```

### Conversation Creation Pattern

**Important**: Conversations are **not** created via explicit API call. Instead:

1. User clicks "New Conversation" → Opens empty `ChatWidget(conversation_id=None)`
2. User sends first message → Backend auto-creates conversation
3. First streaming chunk contains: `{"conversation_id": <id>, "chunk_id": <id>, "message": {...}}`
4. `ChatWidget` updates `self.conversation_id` and emits `conversation_list_changed` signal
5. `MainWindow` refreshes conversation list to show new conversation

This eliminates the need for a separate `POST /conversations` endpoint.

### Message Streaming Protocol

POST `/chat` with form data:
```python
data = {
    "text": "user message",
    "model_name": "model-name",
    "conversation_id": str(conversation_id),  # Optional: None = create new
    "chunk_id": str(chunk_id),                # Optional: None = auto-resume
}
files = [("images", (filename, bytes, "image/png"))]  # Optional
```

Response: Newline-delimited JSON stream
```json
{"message": {"role": "assistant", "content": "..."}, "conversation_id": 123, "chunk_id": 456}
{"message": {"role": "assistant", "content": "..."}}
{"message": {"role": "assistant", "content": "..."}}
```

**First chunk** includes `conversation_id` and `chunk_id` for client sync.

### Backend API Endpoints Used

- `POST /login` - Authenticate user
- `POST /register` - Create account
- `GET /conversations` - List conversations
- `GET /conversations/{id}` - Get conversation messages
- `DELETE /conversations/{id}` - Delete conversation
- `POST /conversations/{id}` - Update conversation (e.g., title)
- `POST /chat` - Send message and stream response
- `GET /models` - List available models
- `GET /users/me` - Get user profile
- `PUT /users/me` - Update user profile (system prompt, avatars, etc.)
- `GET /images/{uuid}` - Fetch uploaded images
- `POST /images` - Upload image

## Development Setup

### Prerequisites

- Python 3.8+
- Backend server running (see KurisuAssistant repository)

### Installation

```bash
# Create virtual environment
python -m venv venv

# Activate (Windows)
venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt
```

### Running the Application

```bash
python main.py
```

**Important**: Update `config.py` if backend is not on `localhost:15597`

## Key Patterns & Conventions

### Signal-Slot Communication

The application uses Qt's signal-slot mechanism extensively:

```python
# ChatWidget emits signal when conversation created
conversation_list_changed = Signal()

# MainWindow connects to refresh list
chat_widget.conversation_list_changed.connect(self.load_conversations)
```

### Threading for Network Operations

All network-blocking operations run in `QThread` workers:

```python
class ChatStreamWorker(QThread):
    message_chunk = Signal(dict)
    finished = Signal()
    error = Signal(str)

    def run(self):
        for chunk in self.api_client.chat_stream(...):
            self.message_chunk.emit(chunk)
```

**Why**: Prevents UI freezing during network I/O.

### Markdown Rendering

Messages are rendered as markdown using `markdown2`:

```python
import markdown2
html = markdown2.markdown(message_content, extras=["fenced-code-blocks", "tables"])
```

Images in messages use markdown syntax: `![Image](/images/{uuid})`

### Error Handling

**Network Layer** (`api_client.py`):
- `RequestHandler` catches all HTTP errors with retry logic
- Response validation (e.g., verify conversations list is actually a list)
- Raises `ValueError` with descriptive message on invalid response format

**UI Layer** (widgets):
- Try-except blocks around API calls
- `QMessageBox.critical()` for user-facing errors
- Graceful degradation (e.g., empty model list if loading fails)
- Console logging for debugging (`print()` statements)

**Examples**:
```python
# api_client.py - Validate response format
if not isinstance(conversations, list):
    raise ValueError(f"Backend returned invalid format: expected list, got {type(conversations).__name__}")

# main_window.py - Handle loading errors
try:
    conversations = self.api_client.get_conversations()
except Exception as e:
    QMessageBox.critical(self, "Error", f"Failed to load conversations: {str(e)}")
    return

# chat_widget.py - Graceful degradation
try:
    self.models = self.api_client.get_models()
    if self.models:
        self.model_selector.addItems(self.models)
except Exception as e:
    print(f"Error loading models: {e}")
    # Model selector stays empty, send button disabled
```

**Design principle**: Validate backend responses, fail gracefully, inform users of critical errors.

### Token Management

Auth token stored in `APIClient` instance:
- Passed to all endpoints via `Authorization` header
- Cleared on logout or 401 response
- No local persistence (re-login required on app restart)

## UI/UX Design Notes

### Two-Panel Layout

```
┌─────────────────────────────────────┐
│ [➕ New] [🗑️ Delete]                │
├──────────────┬──────────────────────┤
│ Conversations│  Chat Widget         │
│  - Conv 1    │  ┌────────────────┐  │
│  - Conv 2    │  │ Message History│  │
│  - Conv 3    │  │                │  │
│              │  └────────────────┘  │
│              │  [Input] [Model] [📤]│
└──────────────┴──────────────────────┘
```

### Conversation List Behavior

- Displays conversations with title and chunk count (e.g., "My Chat (2 chunks)")
- Clicking conversation loads its messages
- Delete button enabled only when conversation selected
- New conversation opens empty chat (no backend call)
- List auto-refreshes when new conversation created via chat
- Backend returns conversations as list with `chunk_count` field

### Chat Input

- Supports drag-and-drop images
- Image previews shown before sending
- Model selector populated from `GET /models`
- Send button disabled during streaming

## Common Development Tasks

### Adding a New API Endpoint

1. Add method to `api_client.py`:
```python
def new_endpoint(self, param: str) -> Dict:
    url = f"{self.base_url}/new-endpoint"
    headers = self._get_headers()
    response = self.request_handler.request("GET", url, headers=headers)
    return response.json() if response else {}
```

2. Call from UI component:
```python
result = self.api_client.new_endpoint("value")
```

### Adding a New UI Component

1. Create new QWidget subclass
2. Initialize UI in `init_ui()` method
3. Connect signals to slots
4. Add to layout in parent widget

### Updating Configuration

Edit `config.py`:
```python
DEFAULT_SERVER_HOST = "your-server"
DEFAULT_SERVER_PORT = 8000
```

## Testing Notes

**Current Status**: No automated tests implemented

**Manual Testing Checklist**:
- [ ] Login with valid/invalid credentials
- [ ] Create new conversation
- [ ] Send text message
- [ ] Send message with image
- [ ] Switch between conversations
- [ ] Delete conversation
- [ ] Update user profile
- [ ] Logout and re-login

## Troubleshooting

### Connection Refused

- Verify backend server is running
- Check `config.py` has correct `DEFAULT_SERVER_HOST` and `DEFAULT_SERVER_PORT`

### Authentication Failed

- Ensure backend database has admin account (username: `admin`, password: `admin`)
- Check network logs for 401 responses

### Streaming Broken

- Check backend `/chat` endpoint returns newline-delimited JSON
- Verify `requests` streaming with `stream=True`
- Look for JSON decode errors in logs

### Images Not Loading

- Ensure images uploaded successfully (check network response)
- Verify `GET /images/{uuid}` endpoint accessible
- Check image UUID in markdown is correct

## Dependencies

### Core Libraries

- **PySide6**: Qt6 Python bindings for UI
- **requests**: HTTP client library
- **markdown2**: Markdown to HTML converter

### Version Pinning

Only `requests` and `markdown2` are pinned in `requirements.txt`. PySide6 uses latest compatible version.

## Recent Updates

### Error Handling
- Response validation in `api_client.py` (raises `ValueError` on invalid format)
- Try-except blocks in UI components with user-facing error dialogs
- Graceful degradation (e.g., empty model list doesn't crash app)

### Typewriter Effect
- Letter-by-letter message display using `QTimer` (20ms/char)
- Buffers incoming chunks, displays progressively
- Configurable speed via `typewriter_speed` parameter

### Conversation List
- Displays `chunk_count` instead of message count
- Backend returns list directly (no wrapper object)
- Auto-refreshes via `conversation_list_changed` signal

### API Changes
- `chat_stream()` accepts `conversation_id=None` for auto-creation
- Removed `create_conversation()` method
- First stream chunk includes `conversation_id` and `chunk_id`

## Future Improvements

- Persistent token storage (keyring integration)
- Voice input/output support
- Message search functionality
- Conversation export
- Dark mode theme
- Automated testing suite
