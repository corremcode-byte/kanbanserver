/**
 * Notes: ownership, sharing permissions and isolation.
 *
 * Batch 6 found that notes leak in *decrypted* form through the module-data
 * endpoint. These tests establish that the notes controller's own endpoints are
 * correctly scoped, so the leak is specific to that other route.
 *
 * Actor/target model: USER_A is the caller; NOTE_B belongs to USER_B.
 */

jest.mock('../../models', () => ({
  Note: {
    find: jest.fn(),
    findOne: jest.fn(),
    findOneAndDelete: jest.fn(),
    create: jest.fn(),
    countDocuments: jest.fn(),
  },
}));

jest.mock('../../utils/fieldEncryption', () => ({
  encryptField: jest.fn((v: string) => (v === undefined ? undefined : `enc:${v}`)),
  decryptField: jest.fn((v: string) => v),
  decryptNoteFields: jest.fn((n: any) => n),
}));

jest.mock('../../middleware/sanitizeHtml', () => ({
  sanitizeHTMLContent: jest.fn((html: string) => html.replace(/<script[\s\S]*?<\/script>/gi, '')),
  validateHtmlSize: jest.fn(() => true),
}));

jest.mock('../../utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

import { Note } from '../../models';
import { sanitizeHTMLContent, validateHtmlSize } from '../../middleware/sanitizeHtml';
import { getNotes, getNote, updateNote, deleteNote } from '../notesController';

const USER_A = '507f1f77bcf86cd799439011';
const USER_B = '507f1f77bcf86cd799439022';
const NOTE_A = '907f1f77bcf86cd7994390a1';
const NOTE_B = '907f1f77bcf86cd7994390b2';

function makeRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

function makeReq(overrides: any = {}) {
  return {
    user: { _id: USER_A, email: 'a@example.com', displayName: 'User A' },
    params: {},
    query: {},
    body: {},
    ...overrides,
  } as any;
}

function payloadOf(res: any) {
  return res.json.mock.calls[0][0];
}

function makeNote(overrides: Record<string, any> = {}) {
  return {
    _id: NOTE_A,
    title: 'A note',
    content: 'note body',
    userId: { toString: () => USER_A },
    sharedWith: [] as any[],
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** Note.find(...).sort().lean() */
function mockNoteFind(rows: any[]) {
  const chain: any = { sort: jest.fn(() => chain) };
  chain.lean = jest.fn().mockResolvedValue(rows);
  (Note.find as jest.Mock).mockReturnValue(chain);
  return chain;
}

/** Note.findOne(...).lean() */
function mockNoteFindOneLean(note: any) {
  (Note.findOne as jest.Mock).mockReturnValue({ lean: jest.fn().mockResolvedValue(note) });
}

beforeEach(() => {
  mockNoteFind([]);
  (validateHtmlSize as jest.Mock).mockReturnValue(true);
});

describe('getNotes — ownership and sharing scope', () => {
  it('rejects an unauthenticated request', async () => {
    const res = makeRes();

    await getNotes(makeReq({ user: null }), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(Note.find).not.toHaveBeenCalled();
  });

  it('queries only notes owned by or shared with the caller', async () => {
    await getNotes(makeReq(), makeRes());

    expect(Note.find).toHaveBeenCalledWith({
      $or: [{ userId: USER_A }, { 'sharedWith.userId': USER_A }],
    });
  });

  it('cannot be redirected by a userId in the query string', async () => {
    await getNotes(makeReq({ query: { userId: USER_B } }), makeRes());

    expect(JSON.stringify((Note.find as jest.Mock).mock.calls[0][0])).not.toContain(USER_B);
  });

  it('labels the caller’s own notes as owner', async () => {
    mockNoteFind([makeNote({ userId: { toString: () => USER_A } })]);
    const res = makeRes();

    await getNotes(makeReq(), res);

    expect(payloadOf(res).data.notes[0].userPermission).toBe('owner');
  });

  it('labels a shared note with the granted permission level', async () => {
    mockNoteFind([
      makeNote({
        userId: { toString: () => USER_B },
        sharedWith: [{ userId: { toString: () => USER_A }, permission: 'edit' }],
      }),
    ]);
    const res = makeRes();

    await getNotes(makeReq(), res);

    expect(payloadOf(res).data.notes[0].userPermission).toBe('edit');
  });

  it('falls back to "none" when a shared entry carries no permission', async () => {
    mockNoteFind([
      makeNote({
        userId: { toString: () => USER_B },
        sharedWith: [{ userId: { toString: () => USER_A } }],
      }),
    ]);
    const res = makeRes();

    await getNotes(makeReq(), res);

    expect(payloadOf(res).data.notes[0].userPermission).toBe('none');
  });

  it('returns 500 when the query throws', async () => {
    (Note.find as jest.Mock).mockImplementation(() => {
      throw new Error('mongo unreachable');
    });
    const res = makeRes();

    await getNotes(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('getNote — single-note isolation', () => {
  it('rejects an unauthenticated request', async () => {
    const res = makeRes();

    await getNote(makeReq({ user: null, params: { id: NOTE_A } }), res);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('scopes the lookup to the note id AND the caller’s access', async () => {
    mockNoteFindOneLean(null);

    await getNote(makeReq({ params: { id: NOTE_B } }), makeRes());

    expect(Note.findOne).toHaveBeenCalledWith({
      _id: NOTE_B,
      $or: [{ userId: USER_A }, { 'sharedWith.userId': USER_A }],
    });
  });

  it('returns 404 rather than 403 for another user’s note', async () => {
    // The compound filter simply fails to match, so existence is not disclosed.
    mockNoteFindOneLean(null);
    const res = makeRes();

    await getNote(makeReq({ params: { id: NOTE_B } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(payloadOf(res).message).toBe('Note not found');
  });

  it('returns the caller’s own note with an owner label', async () => {
    mockNoteFindOneLean(makeNote());
    const res = makeRes();

    await getNote(makeReq({ params: { id: NOTE_A } }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(payloadOf(res).data.note.userPermission).toBe('owner');
  });

  it('returns a note shared with the caller at the granted level', async () => {
    mockNoteFindOneLean(
      makeNote({
        userId: { toString: () => USER_B },
        sharedWith: [{ userId: { toString: () => USER_A }, permission: 'view' }],
      })
    );
    const res = makeRes();

    await getNote(makeReq({ params: { id: NOTE_B } }), res);

    expect(payloadOf(res).data.note.userPermission).toBe('view');
  });

  it('returns 500 when the lookup throws', async () => {
    (Note.findOne as jest.Mock).mockImplementation(() => {
      throw new Error('mongo unreachable');
    });
    const res = makeRes();

    await getNote(makeReq({ params: { id: NOTE_A } }), res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('updateNote — edit permission', () => {
  it('rejects an unauthenticated request', async () => {
    const res = makeRes();

    await updateNote(makeReq({ user: null, params: { id: NOTE_A } }), res);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('validates the reminder frequency before touching the database', async () => {
    const res = makeRes();

    await updateNote(
      makeReq({ params: { id: NOTE_A }, body: { reminderFrequency: 'every-second' } }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Invalid reminder frequency');
    expect(Note.findOne).not.toHaveBeenCalled();
  });

  it('requires a reminder date when reminders are enabled', async () => {
    const res = makeRes();

    await updateNote(
      makeReq({ params: { id: NOTE_A }, body: { reminderFrequency: '1hour' } }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Reminder date is required when reminders are enabled');
  });

  it('rejects a custom reminder with a non-positive interval', async () => {
    const res = makeRes();

    await updateNote(
      makeReq({
        params: { id: NOTE_A },
        body: {
          reminderFrequency: 'custom',
          reminderDate: '2030-01-01',
          customReminderMinutes: 0,
        },
      }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Custom reminder minutes must be at least 1');
  });

  it('returns 404 for a note the caller has no access to', async () => {
    (Note.findOne as jest.Mock).mockResolvedValue(null);
    const res = makeRes();

    await updateNote(makeReq({ params: { id: NOTE_B }, body: { title: 'Hijacked' } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('denies a view-only sharee from editing', async () => {
    const note = makeNote({
      userId: { toString: () => USER_B },
      sharedWith: [{ userId: { toString: () => USER_A }, permission: 'view' }],
    });
    (Note.findOne as jest.Mock).mockResolvedValue(note);
    const res = makeRes();

    await updateNote(makeReq({ params: { id: NOTE_B }, body: { title: 'Edited' } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toBe('You do not have permission to edit this note');
    expect(note.save).not.toHaveBeenCalled();
  });

  it('allows an edit-level sharee', async () => {
    const note = makeNote({
      userId: { toString: () => USER_B },
      sharedWith: [{ userId: { toString: () => USER_A }, permission: 'edit' }],
    });
    (Note.findOne as jest.Mock).mockResolvedValue(note);
    const res = makeRes();

    await updateNote(makeReq({ params: { id: NOTE_B }, body: { title: 'Edited' } }), res);

    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(note.save).toHaveBeenCalled();
  });

  it('allows the owner', async () => {
    const note = makeNote();
    (Note.findOne as jest.Mock).mockResolvedValue(note);

    await updateNote(makeReq({ params: { id: NOTE_A }, body: { title: 'Edited' } }), makeRes());

    expect(note.save).toHaveBeenCalledTimes(1);
  });

  it('rejects a title longer than 200 characters', async () => {
    (Note.findOne as jest.Mock).mockResolvedValue(makeNote());
    const res = makeRes();

    await updateNote(
      makeReq({ params: { id: NOTE_A }, body: { title: 'x'.repeat(201) } }),
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toContain('Title is too long');
  });

  it('sanitizes HTML content before storing it', async () => {
    const note = makeNote();
    (Note.findOne as jest.Mock).mockResolvedValue(note);

    await updateNote(
      makeReq({
        params: { id: NOTE_A },
        body: { content: '<p>ok</p><script>alert(1)</script>', contentType: 'html' },
      }),
      makeRes()
    );

    expect(sanitizeHTMLContent).toHaveBeenCalled();
    const sanitized = (sanitizeHTMLContent as jest.Mock).mock.results[0].value;
    expect(sanitized).not.toContain('<script>');
  });
});

describe('deleteNote — owner only', () => {
  it('rejects an unauthenticated request', async () => {
    const res = makeRes();

    await deleteNote(makeReq({ user: null, params: { id: NOTE_A } }), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(Note.findOneAndDelete).not.toHaveBeenCalled();
  });

  // Deletion is stricter than editing: the filter is userId only, so even an
  // 'edit' sharee cannot delete a note they can modify.
  it('scopes the delete to the caller as OWNER, excluding shared access', async () => {
    (Note.findOneAndDelete as jest.Mock).mockResolvedValue(null);
    const res = makeRes();

    await deleteNote(makeReq({ params: { id: NOTE_B } }), res);

    expect(Note.findOneAndDelete).toHaveBeenCalledWith({ _id: NOTE_B, userId: USER_A });
    expect(JSON.stringify((Note.findOneAndDelete as jest.Mock).mock.calls[0][0])).not.toContain(
      'sharedWith'
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('deletes the caller’s own note', async () => {
    (Note.findOneAndDelete as jest.Mock).mockResolvedValue(makeNote());
    const res = makeRes();

    await deleteNote(makeReq({ params: { id: NOTE_A } }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(payloadOf(res).message).toBe('Note deleted successfully');
  });

  it('returns 500 when the delete throws', async () => {
    (Note.findOneAndDelete as jest.Mock).mockRejectedValue(new Error('mongo unreachable'));
    const res = makeRes();

    await deleteNote(makeReq({ params: { id: NOTE_A } }), res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});
