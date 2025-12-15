"""Chat interface widget."""

from PySide6.QtWidgets import (
    QWidget,
    QVBoxLayout,
    QHBoxLayout,
    QTextEdit,
    QPushButton,
    QLabel,
    QComboBox,
    QScrollArea,
    QFileDialog,
    QMessageBox,
)
from PySide6.QtCore import Qt, QThread, Signal, QTimer
from PySide6.QtGui import QTextCursor
from typing import Optional, List
import markdown2
from api_client import APIClient


class ChatStreamWorker(QThread):
    """Worker thread for handling streaming chat responses."""

    message_chunk = Signal(dict)
    finished = Signal()
    error = Signal(str)

    def __init__(
        self,
        api_client: APIClient,
        conversation_id: int,
        text: str,
        model_name: str,
        chunk_id: Optional[int] = None,
        images: Optional[List[bytes]] = None,
    ):
        super().__init__()
        self.api_client = api_client
        self.conversation_id = conversation_id
        self.text = text
        self.model_name = model_name
        self.chunk_id = chunk_id
        self.images = images

    def run(self):
        """Run the streaming chat request."""
        try:
            for data in self.api_client.chat_stream(
                self.conversation_id,
                self.text,
                self.model_name,
                self.chunk_id,
                self.images,
            ):
                if "error" in data:
                    self.error.emit(data["error"])
                    return
                self.message_chunk.emit(data)
            self.finished.emit()
        except Exception as e:
            self.error.emit(str(e))


class ChatWidget(QWidget):
    """Chat interface widget."""

    conversation_list_changed = Signal()  # Emitted when conversation list needs refresh

    def __init__(self, api_client: APIClient, conversation_id: Optional[int] = None):
        super().__init__()
        self.api_client = api_client
        self.conversation_id = conversation_id
        self.current_chunk_id: Optional[int] = None
        self.models: List[str] = []
        self.stream_worker: Optional[ChatStreamWorker] = None
        self.current_assistant_message = ""
        self.image_paths: List[str] = []

        # Typewriter effect variables
        self.typewriter_buffer = ""  # Full buffered content from stream
        self.typewriter_displayed = ""  # Content displayed so far
        self.typewriter_timer = QTimer()
        self.typewriter_timer.timeout.connect(self._typewriter_tick)
        self.typewriter_speed = 20  # milliseconds per character

        self.init_ui()
        self.load_models()
        if self.conversation_id is not None:
            self.load_conversation()

    def init_ui(self):
        """Initialize the user interface."""
        layout = QVBoxLayout()
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(10)

        # Model selector
        model_layout = QHBoxLayout()
        model_label = QLabel("Model:")
        self.model_selector = QComboBox()
        self.model_selector.setMinimumWidth(200)
        model_layout.addWidget(model_label)
        model_layout.addWidget(self.model_selector)
        model_layout.addStretch()
        layout.addLayout(model_layout)

        # Chat display
        self.chat_display = QTextEdit()
        self.chat_display.setReadOnly(True)
        self.chat_display.setMinimumHeight(400)
        layout.addWidget(self.chat_display)

        # Image attachments display
        self.image_label = QLabel("No images attached")
        self.image_label.setVisible(False)
        layout.addWidget(self.image_label)

        # Input area
        input_layout = QHBoxLayout()

        self.input_text = QTextEdit()
        self.input_text.setPlaceholderText("Type your message here...")
        self.input_text.setMaximumHeight(100)

        self.attach_button = QPushButton("📎 Attach Image")
        self.attach_button.setMaximumWidth(150)
        self.attach_button.clicked.connect(self.attach_image)

        self.send_button = QPushButton("Send")
        self.send_button.setMinimumWidth(100)
        self.send_button.setMinimumHeight(40)
        self.send_button.clicked.connect(self.send_message)

        input_layout.addWidget(self.input_text)
        input_layout.addWidget(self.attach_button)
        input_layout.addWidget(self.send_button)
        layout.addLayout(input_layout)

        self.setLayout(layout)

    def load_models(self):
        """Load available models from server."""
        try:
            self.models = self.api_client.get_models()
            if self.models:
                self.model_selector.addItems(self.models)
        except Exception as e:
            print(f"Error loading models: {e}")

    def load_conversation(self):
        """Load existing conversation messages."""
        try:
            data = self.api_client.get_conversation(self.conversation_id)
            if data:
                messages = data.get("messages", [])
                self.chat_display.clear()

                for msg in messages:
                    role = msg.get("role")
                    content = msg.get("content", "")

                    if role == "user":
                        self.append_user_message(content)
                    elif role == "assistant":
                        self.append_assistant_message(content)
        except Exception as e:
            print(f"Error loading conversation: {e}")
            self.chat_display.clear()

    def append_user_message(self, text: str):
        """Append user message to chat display."""
        self.chat_display.append(f'<div style="background-color: #e3f2fd; padding: 10px; border-radius: 10px; margin: 5px;"><b>You:</b><br>{self.format_message(text)}</div>')
        self.chat_display.moveCursor(QTextCursor.MoveOperation.End)

    def append_assistant_message(self, text: str):
        """Append assistant message to chat display."""
        self.chat_display.append(f'<div style="background-color: #f5f5f5; padding: 10px; border-radius: 10px; margin: 5px;"><b>Assistant:</b><br>{self.format_message(text)}</div>')
        self.chat_display.moveCursor(QTextCursor.MoveOperation.End)

    def update_assistant_message(self, text: str):
        """Update the current assistant message being streamed."""
        # Remove last message
        cursor = self.chat_display.textCursor()
        cursor.movePosition(QTextCursor.MoveOperation.End)
        cursor.select(QTextCursor.SelectionType.BlockUnderCursor)
        cursor.removeSelectedText()
        cursor.deletePreviousChar()

        # Add updated message
        self.append_assistant_message(text)

    def format_message(self, text: str) -> str:
        """Format message text (convert markdown to HTML)."""
        # Simple markdown conversion
        html = markdown2.markdown(text, extras=["fenced-code-blocks", "break-on-newline"])
        return html

    def attach_image(self):
        """Open file dialog to attach images."""
        file_paths, _ = QFileDialog.getOpenFileNames(
            self,
            "Select Images",
            "",
            "Images (*.png *.jpg *.jpeg *.bmp *.gif)",
        )

        if file_paths:
            self.image_paths.extend(file_paths)
            self.image_label.setText(f"{len(self.image_paths)} image(s) attached")
            self.image_label.setVisible(True)

    def send_message(self):
        """Send message to the API."""
        text = self.input_text.toPlainText().strip()
        if not text:
            return

        model = self.model_selector.currentText()
        if not model:
            QMessageBox.warning(self, "Error", "Please select a model")
            return

        # Disable input
        self.input_text.setEnabled(False)
        self.send_button.setEnabled(False)
        self.attach_button.setEnabled(False)

        # Display user message
        self.append_user_message(text)
        self.input_text.clear()

        # Load images if attached
        images = []
        if self.image_paths:
            for path in self.image_paths:
                try:
                    with open(path, "rb") as f:
                        images.append(f.read())
                except Exception as e:
                    print(f"Error loading image {path}: {e}")

            self.image_paths.clear()
            self.image_label.setVisible(False)

        # Start streaming worker
        self.current_assistant_message = ""

        # Reset typewriter state
        self.typewriter_timer.stop()
        self.typewriter_buffer = ""
        self.typewriter_displayed = ""

        self.stream_worker = ChatStreamWorker(
            self.api_client,
            self.conversation_id,
            text,
            model,
            self.current_chunk_id,
            images if images else None,
        )
        self.stream_worker.message_chunk.connect(self.handle_message_chunk)
        self.stream_worker.finished.connect(self.handle_stream_finished)
        self.stream_worker.error.connect(self.handle_stream_error)
        self.stream_worker.start()

    def _typewriter_tick(self):
        """Display one more character from the typewriter buffer."""
        if self.typewriter_displayed < self.typewriter_buffer:
            # Add one more character
            self.typewriter_displayed = self.typewriter_buffer[:len(self.typewriter_displayed) + 1]
            self.update_assistant_message(self.typewriter_displayed)
        else:
            # All content displayed, stop timer
            self.typewriter_timer.stop()

    def handle_message_chunk(self, data: dict):
        """Handle incoming message chunk from stream."""
        # Update conversation_id from first response (when creating new conversation)
        if "conversation_id" in data and self.conversation_id is None:
            self.conversation_id = data["conversation_id"]
            self.conversation_list_changed.emit()

        # Update chunk_id from first response
        if "chunk_id" in data:
            self.current_chunk_id = data["chunk_id"]

        message = data.get("message", {})
        content = message.get("content", "")

        if content:
            self.current_assistant_message += content
            self.typewriter_buffer += content

            # Start typewriter if not already running
            if not self.typewriter_timer.isActive():
                self.typewriter_timer.start(self.typewriter_speed)

    def handle_stream_finished(self):
        """Handle stream completion."""
        # Wait for typewriter to finish before re-enabling input
        # Stop the timer and display all remaining content immediately
        self.typewriter_timer.stop()
        if self.typewriter_buffer:
            self.typewriter_displayed = self.typewriter_buffer
            self.update_assistant_message(self.typewriter_displayed)

        # Re-enable input
        self.input_text.setEnabled(True)
        self.send_button.setEnabled(True)
        self.attach_button.setEnabled(True)
        self.input_text.setFocus()

    def handle_stream_error(self, error: str):
        """Handle stream error."""
        # Stop typewriter on error
        self.typewriter_timer.stop()

        QMessageBox.warning(self, "Error", f"Chat error: {error}")
        self.input_text.setEnabled(True)
        self.send_button.setEnabled(True)
        self.attach_button.setEnabled(True)
