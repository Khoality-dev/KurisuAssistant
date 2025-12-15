"""Main chat window with conversation list."""

from typing import Optional
from PySide6.QtWidgets import (
    QMainWindow,
    QWidget,
    QVBoxLayout,
    QHBoxLayout,
    QListWidget,
    QListWidgetItem,
    QPushButton,
    QLabel,
    QMessageBox,
    QSplitter,
)
from PySide6.QtCore import Qt
from PySide6.QtGui import QFont
from api_client import APIClient
from chat_widget import ChatWidget
from config import APP_NAME, WINDOW_WIDTH, WINDOW_HEIGHT


class MainWindow(QMainWindow):
    """Main application window."""

    def __init__(self, api_client: APIClient):
        super().__init__()
        self.api_client = api_client
        self.current_chat_widget: Optional[ChatWidget] = None
        self.init_ui()
        self.load_conversations()

    def init_ui(self):
        """Initialize the user interface."""
        self.setWindowTitle(f"{APP_NAME} - {self.api_client.username}")
        self.setMinimumSize(WINDOW_WIDTH, WINDOW_HEIGHT)

        # Central widget
        central_widget = QWidget()
        self.setCentralWidget(central_widget)

        main_layout = QHBoxLayout()
        central_widget.setLayout(main_layout)

        # Left panel: Conversation list
        left_panel = QWidget()
        left_layout = QVBoxLayout()
        left_panel.setLayout(left_layout)
        left_panel.setMaximumWidth(300)

        # User info and new conversation button
        user_label = QLabel(f"👤 {self.api_client.username}")
        user_font = QFont()
        user_font.setPointSize(12)
        user_font.setBold(True)
        user_label.setFont(user_font)
        left_layout.addWidget(user_label)

        self.new_conv_button = QPushButton("➕ New Conversation")
        self.new_conv_button.setMinimumHeight(40)
        self.new_conv_button.clicked.connect(self.create_new_conversation)
        left_layout.addWidget(self.new_conv_button)

        # Conversation list
        conversations_label = QLabel("Conversations")
        left_layout.addWidget(conversations_label)

        self.conversation_list = QListWidget()
        self.conversation_list.itemClicked.connect(self.conversation_selected)
        left_layout.addWidget(self.conversation_list)

        # Delete conversation button
        self.delete_button = QPushButton("🗑️ Delete Conversation")
        self.delete_button.setEnabled(False)
        self.delete_button.clicked.connect(self.delete_conversation)
        left_layout.addWidget(self.delete_button)

        # Right panel: Chat area
        self.right_panel = QWidget()
        self.right_layout = QVBoxLayout()
        self.right_panel.setLayout(self.right_layout)

        # Welcome message
        welcome_label = QLabel("Select a conversation or create a new one to start chatting")
        welcome_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        welcome_font = QFont()
        welcome_font.setPointSize(14)
        welcome_label.setFont(welcome_font)
        self.right_layout.addWidget(welcome_label)

        # Create splitter
        splitter = QSplitter(Qt.Orientation.Horizontal)
        splitter.addWidget(left_panel)
        splitter.addWidget(self.right_panel)
        splitter.setStretchFactor(1, 1)

        main_layout.addWidget(splitter)

    def load_conversations(self):
        """Load conversations from server."""
        self.conversation_list.clear()

        try:
            conversations = self.api_client.get_conversations()
        except Exception as e:
            QMessageBox.critical(self, "Error", f"Failed to load conversations: {str(e)}")
            return

        for conv in conversations:
            conv_id = conv.get("id")
            title = conv.get("title", "New conversation")
            chunk_count = conv.get("chunk_count", 0)

            item = QListWidgetItem(f"{title} ({chunk_count} chunks)")
            item.setData(Qt.ItemDataRole.UserRole, conv_id)
            self.conversation_list.addItem(item)

    def conversation_selected(self, item: QListWidgetItem):
        """Handle conversation selection."""
        conv_id = item.data(Qt.ItemDataRole.UserRole)
        self.load_chat(conv_id)
        self.delete_button.setEnabled(True)

    def load_chat(self, conversation_id: Optional[int]):
        """Load chat for the selected conversation or create new empty chat."""
        # Clear right panel
        while self.right_layout.count():
            child = self.right_layout.takeAt(0)
            if child.widget():
                child.widget().deleteLater()

        # Create chat widget
        self.current_chat_widget = ChatWidget(self.api_client, conversation_id)

        # Connect signal to refresh conversation list when needed
        self.current_chat_widget.conversation_list_changed.connect(self.load_conversations)

        self.right_layout.addWidget(self.current_chat_widget)

    def create_new_conversation(self):
        """Create a new conversation."""
        # Clear conversation selection
        self.conversation_list.clearSelection()
        self.delete_button.setEnabled(False)

        # Load empty chat widget (conversation will be created on first message)
        self.load_chat(None)

    def delete_conversation(self):
        """Delete the selected conversation."""
        current_item = self.conversation_list.currentItem()
        if not current_item:
            return

        conv_id = current_item.data(Qt.ItemDataRole.UserRole)

        reply = QMessageBox.question(
            self,
            "Confirm Delete",
            "Are you sure you want to delete this conversation?",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
        )

        if reply == QMessageBox.StandardButton.Yes:
            if self.api_client.delete_conversation(conv_id):
                self.load_conversations()

                # Clear chat view
                while self.right_layout.count():
                    child = self.right_layout.takeAt(0)
                    if child.widget():
                        child.widget().deleteLater()

                welcome_label = QLabel(
                    "Select a conversation or create a new one to start chatting"
                )
                welcome_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
                self.right_layout.addWidget(welcome_label)

                self.delete_button.setEnabled(False)
            else:
                QMessageBox.warning(self, "Error", "Failed to delete conversation")
