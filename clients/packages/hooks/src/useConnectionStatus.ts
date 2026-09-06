import { useState, useEffect } from 'react';
import { wsManager, ConnectionStatus } from '@kurisu/api';

export function useConnectionStatus(): ConnectionStatus {
  const [status, setStatus] = useState<ConnectionStatus>(wsManager.connectionStatus);

  useEffect(() => {
    return wsManager.onStatusChange(setStatus);
  }, []);

  return status;
}
