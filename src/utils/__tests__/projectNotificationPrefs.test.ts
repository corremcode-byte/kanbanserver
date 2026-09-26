import {
  allowsProjectNotification,
  mergeProjectNotificationUpdate,
  validateMutedProjects,
  PROJECT_CATEGORY_BY_TYPE,
  PROJECT_NOTIFICATION_DEFAULTS,
} from '../projectNotificationPrefs';

const P1 = '64b7f0c2a1b2c3d4e5f60718';
const P2 = '64b7f0c2a1b2c3d4e5f60719';

describe('allowsProjectNotification', () => {
  it('allows everything by default', () => {
    expect(allowsProjectNotification(undefined, 'tasksAssigned', P1)).toBe(true);
    expect(allowsProjectNotification({}, 'taskMoved')).toBe(true);
    expect(allowsProjectNotification({ projectNotifications: { tasksAssigned: true } }, 'tasksAssigned', P1)).toBe(true);
  });

  it('blocks a switched-off category only', () => {
    const s = { projectNotifications: { taskMessages: false } };
    expect(allowsProjectNotification(s, 'taskMessages', P1)).toBe(false);
    expect(allowsProjectNotification(s, 'tasksAssigned', P1)).toBe(true);
  });

  it('blocks every category for a muted project (ObjectId-like or populated values)', () => {
    const s = { mutedProjects: [{ toString: () => P1 }, P2] };
    expect(allowsProjectNotification(s, 'tasksAssigned', P1)).toBe(false);
    expect(allowsProjectNotification(s, 'taskMoved', { _id: P2 })).toBe(false);
    expect(allowsProjectNotification(s, 'tasksAssigned', '64b7f0c2a1b2c3d4e5f6071a')).toBe(true);
    expect(allowsProjectNotification(s, 'tasksAssigned', undefined)).toBe(true);
  });

  it('maps only project notification types to categories', () => {
    expect(PROJECT_CATEGORY_BY_TYPE.task_assigned).toBe('tasksAssigned');
    expect(PROJECT_CATEGORY_BY_TYPE.chat_message).toBeUndefined();
    expect(PROJECT_CATEGORY_BY_TYPE.note_reminder).toBeUndefined();
    expect(PROJECT_CATEGORY_BY_TYPE.task_deadline_reminder).toBeUndefined();
  });
});

describe('mergeProjectNotificationUpdate', () => {
  it('merges a partial update onto current values and defaults', () => {
    expect(mergeProjectNotificationUpdate({ taskMoved: false }, { invitations: false })).toEqual({
      value: { ...PROJECT_NOTIFICATION_DEFAULTS, invitations: false, taskMoved: false },
    });
  });

  it('rejects unknown keys and non-boolean values', () => {
    expect(mergeProjectNotificationUpdate({ nope: true }, undefined)).toHaveProperty('error');
    expect(mergeProjectNotificationUpdate({ taskMoved: 'no' }, undefined)).toHaveProperty('error');
    expect(mergeProjectNotificationUpdate({ taskMoved: { $ne: true } }, undefined)).toHaveProperty('error');
    expect(mergeProjectNotificationUpdate(null, undefined)).toHaveProperty('error');
    expect(mergeProjectNotificationUpdate([], undefined)).toHaveProperty('error');
  });
});

describe('validateMutedProjects', () => {
  it('accepts and de-duplicates valid ids', () => {
    expect(validateMutedProjects([P1, P2, P1])).toEqual({ value: [P1, P2] });
    expect(validateMutedProjects([])).toEqual({ value: [] });
  });

  it('rejects malformed input', () => {
    expect(validateMutedProjects('x')).toHaveProperty('error');
    expect(validateMutedProjects(['not-an-id'])).toHaveProperty('error');
    expect(validateMutedProjects([{ $gt: '' }])).toHaveProperty('error');
    expect(validateMutedProjects(new Array(1001).fill(P1))).toHaveProperty('error');
  });
});
