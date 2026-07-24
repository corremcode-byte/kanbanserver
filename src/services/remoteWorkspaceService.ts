import { AuthenticatedRequest } from '../middleware/auth';
import { User } from '../models';
import { generateRdpFile } from '../utils/generateRdpFile';
import { validateConnectionInput, ConnectionInput } from '../utils/remoteConnectionValidation';

/**
 * req.user (populated by the `authenticate` middleware) only carries role/identity
 * fields, not the full permissions document — so access is checked against the
 * database, same as every other module-permission check in this codebase
 * (see middleware/permissions.ts).
 */
export async function hasModuleAccess(user: AuthenticatedRequest['user']): Promise<boolean> {
  if (!user?._id) return false;
  if (user.role === 'superadmin') return true;

  const dbUser = await User.findById(user._id).select('permissions.modules.remoteWorkspace');
  return dbUser?.permissions?.modules?.remoteWorkspace?.view === true;
}

// Only 'manual' exists today. Once saved server profiles (RemoteServers
// collection) exist, add a `{ kind: 'profile'; profileId: string }` variant
// here and resolve it to the same { ip, port, username } shape before
// calling generateRdpFile — the controller and route don't need to change.
export type ConnectionTarget = { kind: 'manual' } & ConnectionInput;

export interface ConnectionFile {
  filename: string;
  content: string;
}

export class InvalidConnectionInputError extends Error {
  constructor(public errors: string[]) {
    super(errors.join(', '));
    this.name = 'InvalidConnectionInputError';
  }
}

export function buildConnectionFile(target: ConnectionTarget): ConnectionFile {
  const result = validateConnectionInput(target);
  if (!result.valid || !result.normalized) {
    throw new InvalidConnectionInputError(result.errors);
  }

  const content = generateRdpFile(result.normalized);
  return { filename: 'workspace.rdp', content };
}

export const remoteWorkspaceService = { hasModuleAccess, buildConnectionFile };
