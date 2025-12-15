# KurisuAssistant Qt Client

A desktop chat client for KurisuAssistant built with PyQt6.

## Features

- 🔐 User authentication (login/registration)
- 💬 Real-time streaming chat responses
- 📋 Conversation management (create, view, delete)
- 🖼️ Image attachment support
- 🤖 Multiple LLM model selection
- 📦 Chunk-based message management for efficient token usage
- 🎨 Clean and intuitive Qt-based UI

## Prerequisites

- Python 3.10 or higher
- KurisuAssistant server running (default: http://localhost:15597)

## Installation

1. Clone the repository:
```bash
cd D:\Programming\KurisuAssistant-Client-Windows
```

2. Create a virtual environment (recommended):
```bash
python -m venv venv
```

3. Activate the virtual environment:
   - Windows:
     ```bash
     venv\Scripts\activate
     ```
   - Linux/Mac:
     ```bash
     source venv/bin/activate
     ```

4. Install dependencies:
```bash
pip install -r requirements.txt
```

## Configuration

Edit `config.py` to change the server URL and other settings:

```python
API_BASE_URL = "http://localhost:15597"  # Change to your server URL
```

## Running the Application

```bash
python main.py
```

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
├── main.py                 # Entry point
├── api_client.py          # API communication layer
├── login_window.py        # Login/registration UI
├── main_window.py         # Main application window
├── chat_widget.py         # Chat interface component
├── config.py              # Configuration settings
├── requirements.txt       # Python dependencies
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
2. The server URL in `config.py` is correct
3. Your firewall allows the connection

### Module Import Errors

Make sure you've installed all dependencies:
```bash
pip install -r requirements.txt
```

### Qt Platform Plugin Error

If you get a Qt platform plugin error, try:
```bash
pip install --force-reinstall PyQt6
```

## Development

### Adding New Features

1. API endpoints: Add methods to `api_client.py`
2. UI components: Create new widgets in separate files
3. Configuration: Add settings to `config.py`

### Code Style

- Follow PEP 8 guidelines
- Use type hints where possible
- Document functions with docstrings

## License

See LICENSE file for details.

## Support

For issues and questions, please refer to the main KurisuAssistant repository.
