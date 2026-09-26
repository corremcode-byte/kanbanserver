// Project notification preferences (Settings → Notifications → Project
// notifications). Two layers:
//   • category switches (invitations, added to project, tasks assigned, task
//     messages, task moved) — all on by default;
//   • per-project mute ("Manage individual projects") — a muted project sends
//     no project notifications at all, overriding the switches.
// A notification that isn't allowed is not created, pushed or toasted.
// Email has its own settings and is not affected.

export const PROJECT_NOTIFICATION_CATEGORIES = [
  'invitations',
  'addedToProject',
  'tasksAssigned',
  'taskMessages',
  'taskMoved',
] as const;

export type ProjectNotificationCategory = typeof PROJECT_NOTIFICATION_CATEGORIES[number];
export type ProjectNotificationSwitches = Record<ProjectNotificationCategory, boolean>;

export const PROJECT_NOTIFICATION_DEFAULTS: ProjectNotificationSwitches = {
  invitations: true,
  addedToProject: true,
  tasksAssigned: true,
  taskMessages: true,
  taskMoved: true,
};

/** Notification.type → category. Types not listed here are never filtered. */
export const PROJECT_CATEGORY_BY_TYPE: Readonly<Record<string, ProjectNotificationCategory>> = {
  project_invitation: 'invitations',
  project_added: 'addedToProject',
  task_assigned: 'tasksAssigned',
  task_chat_message: 'taskMessages',
};

export const MAX_MUTED_PROJECTS = 1000;
const OBJECT_ID_RE = /^[a-f\d]{24}$/i;

export interface ProjectNotificationSettingsLike {
  projectNotifications?: Partial<Record<ProjectNotificationCategory, boolean | undefined>> | null;
  mutedProjects?: unknown[] | null;
}

const idString = (v: unknown): string => {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && '_id' in (v as Record<string, unknown>)) return String((v as { _id: unknown })._id);
  return String(v);
};

/** Whether a user wants a notification of this category (optionally for this project). */
export function allowsProjectNotification(
  settings: ProjectNotificationSettingsLike | null | undefined,
  category: ProjectNotificationCategory,
  projectId?: unknown,
): boolean {
  if (settings?.projectNotifications?.[category] === false) return false;
  const pid = idString(projectId);
  if (pid && Array.isArray(settings?.mutedProjects)) {
    if (settings!.mutedProjects!.some((id) => idString(id) === pid)) return false;
  }
  return true;
}

/** Validate a partial switches update and merge it onto the current value. */
export function mergeProjectNotificationUpdate(
  input: unknown,
  current: Partial<ProjectNotificationSwitches> | null | undefined,
): { value: ProjectNotificationSwitches } | { error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'projectNotifications must be an object' };
  }
  const value: ProjectNotificationSwitches = { ...PROJECT_NOTIFICATION_DEFAULTS };
  for (const key of PROJECT_NOTIFICATION_CATEGORIES) {
    if (typeof current?.[key] === 'boolean') value[key] = current[key]!;
  }
  for (const [key, v] of Object.entries(input as Record<string, unknown>)) {
    if (!(PROJECT_NOTIFICATION_CATEGORIES as readonly string[]).includes(key)) {
      return { error: `Unknown project notification setting: ${key}` };
    }
    if (typeof v !== 'boolean') return { error: `${key} must be a boolean` };
    value[key as ProjectNotificationCategory] = v;
  }
  return { value };
}

/** Validate the full list of muted project ids (replaces the stored list). */
export function validateMutedProjects(input: unknown): { value: string[] } | { error: string } {
  if (!Array.isArray(input)) return { error: 'mutedProjects must be a list of project ids' };
  if (input.length > MAX_MUTED_PROJECTS) return { error: `At most ${MAX_MUTED_PROJECTS} projects can be muted` };
  if (!input.every((id) => typeof id === 'string' && OBJECT_ID_RE.test(id))) {
    return { error: 'mutedProjects must contain valid project ids' };
  }
  return { value: [...new Set(input as string[])] };
}
