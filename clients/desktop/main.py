"""Main entry point for KurisuAssistant Qt Client."""

import sys
from typing import Optional
from PySide6.QtWidgets import QApplication
from login_window import LoginWindow
from main_window import MainWindow
from api_client import APIClient


class Application:
    """Main application controller."""

    def __init__(self):
        self.app = QApplication(sys.argv)
        self.login_window: Optional[LoginWindow] = None
        self.main_window: Optional[MainWindow] = None

    def start(self):
        """Start the application."""
        self.show_login()
        return self.app.exec()

    def show_login(self):
        """Show the login window."""
        self.login_window = LoginWindow()
        self.login_window.login_successful.connect(self.on_login_successful)
        self.login_window.show()

    def on_login_successful(self, api_client: APIClient):
        """Handle successful login."""
        self.main_window = MainWindow(api_client)
        self.main_window.show()


if __name__ == "__main__":
    app = Application()
    sys.exit(app.start())
