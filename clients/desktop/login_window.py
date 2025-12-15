"""Login/Registration window for KurisuAssistant."""

from PySide6.QtWidgets import (
    QWidget,
    QVBoxLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QMessageBox,
    QTabWidget,
    QGroupBox,
)
from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QFont
from api_client import APIClient
from config import APP_NAME, DEFAULT_SERVER_HOST, DEFAULT_SERVER_PORT


class LoginWindow(QWidget):
    """Login and registration window."""

    login_successful = Signal(APIClient)

    def __init__(self):
        super().__init__()
        self.api_client = None  # Will be created after server config is set
        self.init_ui()

    def init_ui(self):
        """Initialize the user interface."""
        self.setWindowTitle(f"{APP_NAME} - Login")
        self.setMinimumWidth(400)
        self.setMinimumHeight(300)

        layout = QVBoxLayout()
        layout.setContentsMargins(40, 40, 40, 40)
        layout.setSpacing(20)

        # Title
        title_label = QLabel(APP_NAME)
        title_font = QFont()
        title_font.setPointSize(24)
        title_font.setBold(True)
        title_label.setFont(title_font)
        title_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(title_label)

        # Server configuration group
        server_group = QGroupBox("Server Configuration")
        server_layout = QHBoxLayout()

        self.server_host = QLineEdit()
        self.server_host.setPlaceholderText("Server IP/Host")
        self.server_host.setText(DEFAULT_SERVER_HOST)
        self.server_host.setMinimumHeight(30)

        self.server_port = QLineEdit()
        self.server_port.setPlaceholderText("Port")
        self.server_port.setText(str(DEFAULT_SERVER_PORT))
        self.server_port.setMinimumHeight(30)
        self.server_port.setMaximumWidth(100)

        self.test_connection_button = QPushButton("Test Connection")
        self.test_connection_button.setMinimumHeight(30)
        self.test_connection_button.setMaximumWidth(150)
        self.test_connection_button.clicked.connect(self.handle_test_connection)

        server_layout.addWidget(QLabel("Host:"))
        server_layout.addWidget(self.server_host)
        server_layout.addWidget(QLabel("Port:"))
        server_layout.addWidget(self.server_port)
        server_layout.addWidget(self.test_connection_button)

        server_group.setLayout(server_layout)
        layout.addWidget(server_group)

        # Tab widget for login/register
        self.tabs = QTabWidget()

        # Login tab
        login_tab = QWidget()
        login_layout = QVBoxLayout()
        login_layout.setSpacing(15)

        self.login_username = QLineEdit()
        self.login_username.setPlaceholderText("Username")
        self.login_username.setMinimumHeight(35)

        self.login_password = QLineEdit()
        self.login_password.setPlaceholderText("Password")
        self.login_password.setEchoMode(QLineEdit.EchoMode.Password)
        self.login_password.setMinimumHeight(35)
        self.login_password.returnPressed.connect(self.handle_login)

        self.login_button = QPushButton("Login")
        self.login_button.setMinimumHeight(40)
        self.login_button.clicked.connect(self.handle_login)

        login_layout.addWidget(QLabel("Username:"))
        login_layout.addWidget(self.login_username)
        login_layout.addWidget(QLabel("Password:"))
        login_layout.addWidget(self.login_password)
        login_layout.addStretch()
        login_layout.addWidget(self.login_button)

        login_tab.setLayout(login_layout)
        self.tabs.addTab(login_tab, "Login")

        # Register tab
        register_tab = QWidget()
        register_layout = QVBoxLayout()
        register_layout.setSpacing(15)

        self.register_username = QLineEdit()
        self.register_username.setPlaceholderText("Username")
        self.register_username.setMinimumHeight(35)

        self.register_password = QLineEdit()
        self.register_password.setPlaceholderText("Password")
        self.register_password.setEchoMode(QLineEdit.EchoMode.Password)
        self.register_password.setMinimumHeight(35)

        self.register_confirm = QLineEdit()
        self.register_confirm.setPlaceholderText("Confirm Password")
        self.register_confirm.setEchoMode(QLineEdit.EchoMode.Password)
        self.register_confirm.setMinimumHeight(35)
        self.register_confirm.returnPressed.connect(self.handle_register)

        self.register_button = QPushButton("Register")
        self.register_button.setMinimumHeight(40)
        self.register_button.clicked.connect(self.handle_register)

        register_layout.addWidget(QLabel("Username:"))
        register_layout.addWidget(self.register_username)
        register_layout.addWidget(QLabel("Password:"))
        register_layout.addWidget(self.register_password)
        register_layout.addWidget(QLabel("Confirm Password:"))
        register_layout.addWidget(self.register_confirm)
        register_layout.addStretch()
        register_layout.addWidget(self.register_button)

        register_tab.setLayout(register_layout)
        self.tabs.addTab(register_tab, "Register")

        layout.addWidget(self.tabs)

        self.setLayout(layout)

    def _get_server_url(self) -> str:
        """Build server URL from host and port inputs."""
        host = self.server_host.text().strip() or DEFAULT_SERVER_HOST
        port = self.server_port.text().strip() or str(DEFAULT_SERVER_PORT)
        return f"http://{host}:{port}"

    def _create_api_client(self):
        """Create API client with current server configuration."""
        server_url = self._get_server_url()
        self.api_client = APIClient(base_url=server_url)

    def handle_test_connection(self):
        """Test server connection using health check endpoint."""
        # Validate port number
        try:
            port = int(self.server_port.text().strip())
            if port < 1 or port > 65535:
                QMessageBox.warning(self, "Error", "Port must be between 1 and 65535")
                return
        except ValueError:
            QMessageBox.warning(self, "Error", "Invalid port number")
            return

        # Validate host
        host = self.server_host.text().strip()
        if not host:
            QMessageBox.warning(self, "Error", "Please enter a server host")
            return

        self.test_connection_button.setEnabled(False)
        self.test_connection_button.setText("Testing...")

        # Create temporary API client for testing
        server_url = self._get_server_url()
        test_client = APIClient(base_url=server_url)

        # Perform health check
        if test_client.health_check():
            QMessageBox.information(
                self,
                "Success",
                f"Successfully connected to server at {server_url}\nServer is healthy and ready!",
            )
        else:
            QMessageBox.warning(
                self,
                "Connection Failed",
                f"Failed to connect to server at {server_url}\n\n"
                f"Please check:\n"
                f"1. Server is running\n"
                f"2. Host and port are correct\n"
                f"3. Firewall settings",
            )

        self.test_connection_button.setEnabled(True)
        self.test_connection_button.setText("Test Connection")

    def handle_login(self):
        """Handle login button click."""
        username = self.login_username.text().strip()
        password = self.login_password.text()

        if not username or not password:
            QMessageBox.warning(self, "Error", "Please enter username and password")
            return

        # Validate port number
        try:
            port = int(self.server_port.text().strip())
            if port < 1 or port > 65535:
                QMessageBox.warning(self, "Error", "Port must be between 1 and 65535")
                return
        except ValueError:
            QMessageBox.warning(self, "Error", "Invalid port number")
            return

        self.login_button.setEnabled(False)
        self.login_button.setText("Logging in...")

        # Create API client with current server config
        self._create_api_client()

        # Attempt login
        if self.api_client.login(username, password):
            self.login_successful.emit(self.api_client)
            self.close()
        else:
            QMessageBox.warning(self, "Error", "Login failed. Check your credentials and server address.")
            self.login_button.setEnabled(True)
            self.login_button.setText("Login")

    def handle_register(self):
        """Handle register button click."""
        username = self.register_username.text().strip()
        password = self.register_password.text()
        confirm = self.register_confirm.text()

        if not username or not password:
            QMessageBox.warning(self, "Error", "Please enter username and password")
            return

        if password != confirm:
            QMessageBox.warning(self, "Error", "Passwords do not match")
            return

        if len(password) < 4:
            QMessageBox.warning(self, "Error", "Password must be at least 4 characters")
            return

        # Validate port number
        try:
            port = int(self.server_port.text().strip())
            if port < 1 or port > 65535:
                QMessageBox.warning(self, "Error", "Port must be between 1 and 65535")
                return
        except ValueError:
            QMessageBox.warning(self, "Error", "Invalid port number")
            return

        self.register_button.setEnabled(False)
        self.register_button.setText("Registering...")

        # Create API client with current server config
        self._create_api_client()

        # Attempt registration
        if self.api_client.register(username, password):
            QMessageBox.information(
                self, "Success", "Registration successful! You can now login."
            )
            self.tabs.setCurrentIndex(0)  # Switch to login tab
            self.login_username.setText(username)
            self.register_button.setEnabled(True)
            self.register_button.setText("Register")
        else:
            QMessageBox.warning(
                self, "Error", "Registration failed. Username may already exist or server is unreachable."
            )
            self.register_button.setEnabled(True)
            self.register_button.setText("Register")
