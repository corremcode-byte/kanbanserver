export interface RdpFileInput {
  ip: string;
  port: number;
  username?: string;
}

/**
 * Builds a standard Windows .rdp file body. Never includes a password —
 * Windows prompts for credentials itself once mstsc.exe opens the connection.
 */
export function generateRdpFile({ ip, port, username }: RdpFileInput): string {
  const lines: string[] = [
    `full address:s:${ip}:${port}`,
  ];

  if (username) {
    lines.push(`username:s:${username}`);
  }

  lines.push(
    'screen mode id:i:2',
    'use multimon:i:1',
    'redirectclipboard:i:1',
    'redirectprinters:i:1',
    'redirectsmartcards:i:1',
    'audiomode:i:0',
    'redirectaudiocapture:i:0',
    'authentication level:i:2',
    'prompt for credentials:i:1',
    'enablecredsspsupport:i:1',
    'connection type:i:7',
    'networkautodetect:i:1',
    'bandwidthautodetect:i:1',
    'displayconnectionbar:i:1',
  );

  return lines.join('\r\n') + '\r\n';
}
