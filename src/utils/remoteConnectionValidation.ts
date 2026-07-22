import net from 'net';
import { ValidationResult } from './validation';

// RFC-1123 hostname: labels of alphanumerics/hyphens, up to 253 chars total.
const HOSTNAME_REGEX = /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

// Conservative allowlist for RDP usernames — blocks control characters
// (which could inject extra lines into the generated .rdp file) while still
// covering DOMAIN\user and user@domain formats.
const USERNAME_REGEX = /^[a-zA-Z0-9._@\\-]{1,256}$/;

export interface ConnectionInput {
  ip: string;
  port: number | string;
  username?: string;
}

export interface NormalizedConnection {
  ip: string;
  port: number;
  username?: string;
}

export function isValidHost(host: string): boolean {
  if (!host) return false;
  return net.isIP(host) !== 0 || HOSTNAME_REGEX.test(host);
}

export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

export function validateConnectionInput(
  input: ConnectionInput
): ValidationResult & { normalized?: NormalizedConnection } {
  const errors: string[] = [];

  const ip = typeof input.ip === 'string' ? input.ip.trim() : '';
  if (!ip) {
    errors.push('Server IP address or hostname is required');
  } else if (!isValidHost(ip)) {
    errors.push('Server IP address or hostname is not valid');
  }

  const port = typeof input.port === 'string' ? Number(input.port) : input.port;
  if (input.port === undefined || input.port === null || input.port === ('' as unknown)) {
    errors.push('Port is required');
  } else if (!isValidPort(port)) {
    errors.push('Port must be a number between 1 and 65535');
  }

  let username: string | undefined;
  if (input.username !== undefined && input.username !== null && input.username !== '') {
    username = String(input.username).trim();
    if (!USERNAME_REGEX.test(username)) {
      errors.push('Username contains invalid characters');
      username = undefined;
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, errors: [], normalized: { ip, port, username } };
}
