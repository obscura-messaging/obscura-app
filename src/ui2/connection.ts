export const CONNECTION_LABEL = {
  connected: 'Connected',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  disconnected: 'Disconnected',
} as const;

// claude: the board's green dot; other states are not designed yet
export const connectionDot = (state: keyof typeof CONNECTION_LABEL, muted: string) => (state === 'connected' ? '#22C55E' : muted);
