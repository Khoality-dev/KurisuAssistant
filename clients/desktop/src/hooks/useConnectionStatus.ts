import { useState, useEffect } from 'react';
import { wsManager, ConnectionStatus } from '../api/websocket';

export function useConnectionStatus(): ConnectionStatus {
  const [status, setStatus] = useState<ConnectionStatus>(wsManager.connectionStatus);

  useEffect(() => {
    return wsManager.onStatusChange(setStatus);
  }, []);

  return status;
}
