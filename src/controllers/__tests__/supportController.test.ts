/**
 * Support tickets.
 *
 * Actor/target model: USER_A is the authenticated caller; TICKET_B was raised
 * by USER_B, an unrelated account.
 */

jest.mock('../../models/SupportTicket', () => {
  // The controller constructs a document, reads _id, mutates the encrypted
  // fields, then saves — so the constructor must return a usable instance.
  const SupportTicket: any = Object.assign(
    jest.fn().mockImplementation(function (this: any, fields: any) {
      Object.assign(this, fields);
      this._id = { toString: () => '907f1f77bcf86cd7994390e2' };
      this.attachments = fields?.attachments ?? [];
      this.replies = [];
      this.save = jest.fn().mockResolvedValue(undefined);
      return this;
    }),
    { find: jest.fn(), findById: jest.fn(), countDocuments: jest.fn() }
  );
  return { __esModule: true, default: SupportTicket, SupportTicket };
});

jest.mock('../../utils/fieldEncryption', () => ({
  encryptField: jest.fn((v: string) => (v === undefined ? undefined : `enc:${v}`)),
  decryptField: jest.fn((v: string) => v),
  decryptSupportTicketFields: jest.fn((t: any) => t),
}));

import SupportTicket from '../../models/SupportTicket';
import { encryptField } from '../../utils/fieldEncryption';
import {
  getAllTickets,
  getTicket,
  createTicket,
  addReply,
  updateStatus,
} from '../supportController';

const USER_A = '507f1f77bcf86cd799439011';
const USER_B = '507f1f77bcf86cd799439022';
const TICKET_B = '907f1f77bcf86cd7994390e2';

let consoleErrorSpy: jest.SpyInstance;

beforeAll(() => {
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  consoleErrorSpy.mockRestore();
});

function makeRes() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

/** Actor defaults to USER_A, an ordinary member. */
function makeReq(overrides: any = {}) {
  return {
    user: { _id: USER_A, email: 'a@example.com', displayName: 'User A', role: 'member' },
    params: {},
    query: {},
    body: {},
    ...overrides,
  } as any;
}

function payloadOf(res: any) {
  return res.json.mock.calls[0][0];
}

/** A ticket raised by USER_B. */
function makeTicketDoc(overrides: Record<string, any> = {}) {
  return {
    _id: { toString: () => TICKET_B },
    title: 'User B ticket',
    description: 'Private description',
    status: 'open',
    category: 'bug',
    priority: 'high',
    raisedBy: { toString: () => USER_B },
    raisedByName: 'User B',
    raisedByEmail: 'userb@example.com',
    replies: [] as any[],
    attachments: [] as any[],
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** SupportTicket.find(...).sort().skip().limit().lean() */
function mockFindChain(rows: any[]) {
  const chain: any = {};
  for (const method of ['sort', 'skip', 'limit']) {
    chain[method] = jest.fn(() => chain);
  }
  chain.lean = jest.fn().mockResolvedValue(rows);
  (SupportTicket.find as jest.Mock).mockReturnValue(chain);
  return chain;
}

beforeEach(() => {
  mockFindChain([]);
  (SupportTicket.countDocuments as jest.Mock).mockResolvedValue(0);
  (SupportTicket.findById as jest.Mock).mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
});

describe('getAllTickets — filtering and pagination', () => {
  it('applies no filter when nothing is requested', async () => {
    await getAllTickets(makeReq(), makeRes());

    expect(SupportTicket.find).toHaveBeenCalledWith({});
  });

  it('filters by status, category and priority', async () => {
    await getAllTickets(
      makeReq({ query: { status: 'open', category: 'bug', priority: 'high' } }),
      makeRes()
    );

    expect(SupportTicket.find).toHaveBeenCalledWith({
      status: 'open',
      category: 'bug',
      priority: 'high',
    });
  });

  it('treats the sentinel value "all" as no filter', async () => {
    await getAllTickets(
      makeReq({ query: { status: 'all', category: 'all', priority: 'all' } }),
      makeRes()
    );

    expect(SupportTicket.find).toHaveBeenCalledWith({});
  });

  it('paginates with the supplied page and limit', async () => {
    const chain = mockFindChain([]);

    await getAllTickets(makeReq({ query: { page: '3', limit: '10' } }), makeRes());

    expect(chain.skip).toHaveBeenCalledWith(20);
    expect(chain.limit).toHaveBeenCalledWith(10);
  });

  it('clamps the limit to a maximum of 100', async () => {
    const chain = mockFindChain([]);

    await getAllTickets(makeReq({ query: { limit: '5000' } }), makeRes());

    expect(chain.limit).toHaveBeenCalledWith(100);
  });

  it('clamps a page below 1 up to the first page', async () => {
    const chain = mockFindChain([]);

    await getAllTickets(makeReq({ query: { page: '-5' } }), makeRes());

    expect(chain.skip).toHaveBeenCalledWith(0);
  });

  it('returns the documented pagination envelope', async () => {
    (SupportTicket.countDocuments as jest.Mock).mockResolvedValue(45);
    const res = makeRes();

    await getAllTickets(makeReq({ query: { page: '1', limit: '20' } }), res);

    expect(payloadOf(res).data).toMatchObject({ total: 45, page: 1, totalPages: 3 });
  });

  it('returns 500 and echoes the raw error message when the query throws', async () => {
    (SupportTicket.find as jest.Mock).mockImplementation(() => {
      throw new Error('mongo down on ticket-shard-2');
    });
    const res = makeRes();

    await getAllTickets(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(payloadOf(res).error).toContain('ticket-shard-2');
  });
});

describe('getAllTickets — scope (IDOR regression)', () => {
  // SECURITY FINDING (documented, NOT fixed): getAllTickets never reads
  // req.user. There is no raisedBy filter and no role check, so any
  // authenticated user lists every ticket in the system — decrypted, and
  // including each raiser's name and email.
  it('never scopes the query to the authenticated caller', async () => {
    await getAllTickets(makeReq({ query: { status: 'open' } }), makeRes());

    const filter = (SupportTicket.find as jest.Mock).mock.calls[0][0];
    expect(filter).not.toHaveProperty('raisedBy');
    expect(JSON.stringify(filter)).not.toContain(USER_A);
  });

  it('returns another user’s tickets, with their name and email, to an ordinary member', async () => {
    mockFindChain([
      {
        _id: TICKET_B,
        title: 'User B private issue',
        raisedBy: USER_B,
        raisedByName: 'User B',
        raisedByEmail: 'userb@example.com',
      },
    ]);
    const res = makeRes();

    await getAllTickets(makeReq(), res);

    expect(payloadOf(res).data.tickets).toHaveLength(1);
    expect(payloadOf(res).data.tickets[0].raisedByEmail).toBe('userb@example.com');
  });

  it('returns the same list for a member and for an admin', async () => {
    mockFindChain([{ _id: TICKET_B, title: 'T', raisedBy: USER_B }]);
    const member = makeRes();
    await getAllTickets(makeReq(), member);

    mockFindChain([{ _id: TICKET_B, title: 'T', raisedBy: USER_B }]);
    const admin = makeRes();
    await getAllTickets(makeReq({ user: { _id: USER_A, role: 'admin' } }), admin);

    expect(payloadOf(member).data.tickets).toEqual(payloadOf(admin).data.tickets);
  });
});

describe('getTicket — ownership (IDOR regression)', () => {
  it('returns 404 for a nonexistent ticket', async () => {
    const res = makeRes();

    await getTicket(makeReq({ params: { id: TICKET_B } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(payloadOf(res).message).toBe('Ticket not found');
  });

  // SECURITY FINDING (documented, NOT fixed): getTicket looks the ticket up by
  // id alone with no ownership or role check, so any authenticated user can
  // read any ticket's full decrypted contents and reply thread.
  it('lets an unrelated member read another user’s ticket in full', async () => {
    (SupportTicket.findById as jest.Mock).mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: TICKET_B,
        title: 'User B private issue',
        description: 'Confidential detail',
        raisedBy: USER_B,
        raisedByEmail: 'userb@example.com',
        replies: [{ userEmail: 'support@example.com', message: 'internal note' }],
      }),
    });
    const res = makeRes();

    await getTicket(makeReq({ params: { id: TICKET_B } }), res);

    expect(SupportTicket.findById).toHaveBeenCalledWith(TICKET_B);
    expect(payloadOf(res).data.description).toBe('Confidential detail');
    expect(payloadOf(res).data.replies[0].message).toBe('internal note');
  });

  it('returns 500 when the lookup throws', async () => {
    (SupportTicket.findById as jest.Mock).mockImplementation(() => {
      throw new Error('mongo unreachable');
    });
    const res = makeRes();

    await getTicket(makeReq({ params: { id: TICKET_B } }), res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('createTicket — validation and ownership assignment', () => {
  it('rejects an unauthenticated request', async () => {
    const res = makeRes();

    await createTicket(makeReq({ user: null, body: { title: 'T', description: 'D' } }), res);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('requires both a title and a description', async () => {
    for (const body of [{}, { title: 'T' }, { description: 'D' }, { title: '  ', description: 'D' }]) {
      const res = makeRes();
      await createTicket(makeReq({ body }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(payloadOf(res).message).toBe('Title and description are required');
    }
  });

  it('rejects a title longer than 200 characters', async () => {
    const res = makeRes();

    await createTicket(makeReq({ body: { title: 'x'.repeat(201), description: 'D' } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toContain('Title is too long');
  });

  it('accepts a title of exactly 200 characters', async () => {
    const res = makeRes();

    await createTicket(makeReq({ body: { title: 'x'.repeat(200), description: 'D' } }), res);

    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('rejects a description longer than 5000 characters', async () => {
    const res = makeRes();

    await createTicket(makeReq({ body: { title: 'T', description: 'x'.repeat(5001) } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toContain('Description is too long');
  });

  it('attributes the ticket to the authenticated caller, ignoring a body raisedBy', async () => {
    await createTicket(
      makeReq({ body: { title: 'T', description: 'D', raisedBy: USER_B, raisedByEmail: 'spoof@x.com' } }),
      makeRes()
    );

    const constructed = (SupportTicket as unknown as jest.Mock).mock.calls[0][0];
    expect(constructed.raisedByEmail).toBe('a@example.com');
    expect(constructed.raisedByName).toBe('User A');
    expect(String(constructed.raisedBy)).toBe(USER_A);
  });

  it('defaults category to question and priority to medium', async () => {
    await createTicket(makeReq({ body: { title: 'T', description: 'D' } }), makeRes());

    const constructed = (SupportTicket as unknown as jest.Mock).mock.calls[0][0];
    expect(constructed.category).toBe('question');
    expect(constructed.priority).toBe('medium');
  });

  it('passes an unknown category straight through to the schema for validation', async () => {
    // The controller does not validate category itself; the schema enum does.
    await createTicket(
      makeReq({ body: { title: 'T', description: 'D', category: 'not-a-category' } }),
      makeRes()
    );

    expect((SupportTicket as unknown as jest.Mock).mock.calls[0][0].category).toBe('not-a-category');
  });

  it('encrypts the title and description before saving', async () => {
    const res = makeRes();

    await createTicket(makeReq({ body: { title: 'Secret title', description: 'Secret body' } }), res);

    expect(encryptField).toHaveBeenCalledWith('Secret title', expect.any(String));
    expect(encryptField).toHaveBeenCalledWith('Secret body', expect.any(String));
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('returns 500 and echoes the raw error when the save fails', async () => {
    (SupportTicket as unknown as jest.Mock).mockImplementationOnce(() => {
      throw new Error('validation failed on support-shard-1');
    });
    const res = makeRes();

    await createTicket(makeReq({ body: { title: 'T', description: 'D' } }), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(payloadOf(res).error).toContain('support-shard-1');
  });
});

describe('addReply — authorization', () => {
  it('rejects an unauthenticated request', async () => {
    const res = makeRes();

    await addReply(makeReq({ user: null, params: { id: TICKET_B }, body: { message: 'hi' } }), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(SupportTicket.findById).not.toHaveBeenCalled();
  });

  it('requires a non-empty message', async () => {
    for (const body of [{}, { message: '   ' }]) {
      const res = makeRes();
      await addReply(makeReq({ params: { id: TICKET_B }, body }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(payloadOf(res).message).toBe('Reply message is required');
    }
  });

  it('rejects a message longer than 5000 characters', async () => {
    const res = makeRes();

    await addReply(makeReq({ params: { id: TICKET_B }, body: { message: 'x'.repeat(5001) } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 404 for a nonexistent ticket', async () => {
    (SupportTicket.findById as jest.Mock).mockResolvedValue(null);
    const res = makeRes();

    await addReply(makeReq({ params: { id: TICKET_B }, body: { message: 'hi' } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('refuses to reply to a closed ticket', async () => {
    (SupportTicket.findById as jest.Mock).mockResolvedValue(makeTicketDoc({ status: 'closed' }));
    const res = makeRes();

    await addReply(makeReq({ params: { id: TICKET_B }, body: { message: 'hi' } }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(payloadOf(res).message).toBe('Cannot reply to a closed ticket');
  });

  // SECURITY FINDING (documented, NOT fixed): addReply checks only that the
  // ticket exists and is not closed. There is no ownership or role check, so
  // any authenticated user can post into any other user's ticket thread — and
  // their name and email are recorded on the reply.
  it('lets an unrelated member post a reply into another user’s ticket', async () => {
    const ticket = makeTicketDoc();
    (SupportTicket.findById as jest.Mock).mockResolvedValue(ticket);
    const res = makeRes();

    await addReply(makeReq({ params: { id: TICKET_B }, body: { message: 'injected reply' } }), res);

    expect(ticket.replies).toHaveLength(1);
    expect(ticket.replies[0].userEmail).toBe('a@example.com');
    expect(ticket.save).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalledWith(403);
  });

  it('moves an open ticket to in-progress when someone other than the raiser replies', async () => {
    const ticket = makeTicketDoc({ status: 'open' });
    (SupportTicket.findById as jest.Mock).mockResolvedValue(ticket);

    await addReply(makeReq({ params: { id: TICKET_B }, body: { message: 'hi' } }), makeRes());

    expect(ticket.status).toBe('in-progress');
  });

  it('leaves the status untouched when the raiser replies to their own ticket', async () => {
    const ticket = makeTicketDoc({ status: 'open', raisedBy: { toString: () => USER_A } });
    (SupportTicket.findById as jest.Mock).mockResolvedValue(ticket);

    await addReply(makeReq({ params: { id: TICKET_B }, body: { message: 'hi' } }), makeRes());

    expect(ticket.status).toBe('open');
  });

  it('encrypts the reply message before storing it', async () => {
    const ticket = makeTicketDoc();
    (SupportTicket.findById as jest.Mock).mockResolvedValue(ticket);

    await addReply(makeReq({ params: { id: TICKET_B }, body: { message: 'sensitive reply' } }), makeRes());

    expect(encryptField).toHaveBeenCalledWith('sensitive reply', TICKET_B);
  });

  it('defaults attachments to an empty array when none are supplied', async () => {
    const ticket = makeTicketDoc();
    (SupportTicket.findById as jest.Mock).mockResolvedValue(ticket);

    await addReply(makeReq({ params: { id: TICKET_B }, body: { message: 'hi' } }), makeRes());

    expect(ticket.replies[0].attachments).toEqual([]);
  });
});

describe('updateStatus — authorization', () => {
  it('rejects an unauthenticated request', async () => {
    const res = makeRes();

    await updateStatus(makeReq({ user: null, params: { id: TICKET_B }, body: { status: 'closed' } }), res);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('rejects a status outside the allowed set', async () => {
    for (const status of ['deleted', '', undefined, 'OPEN']) {
      const res = makeRes();
      await updateStatus(makeReq({ params: { id: TICKET_B }, body: { status } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(payloadOf(res).message).toBe('Invalid status');
    }
    expect(SupportTicket.findById).not.toHaveBeenCalled();
  });

  it('accepts each of the four valid statuses from the raiser', async () => {
    for (const status of ['open', 'in-progress', 'resolved', 'closed']) {
      const ticket = makeTicketDoc({ raisedBy: { toString: () => USER_A } });
      (SupportTicket.findById as jest.Mock).mockResolvedValue(ticket);
      const res = makeRes();

      await updateStatus(makeReq({ params: { id: TICKET_B }, body: { status } }), res);

      expect(ticket.status).toBe(status);
      expect(res.status).not.toHaveBeenCalledWith(403);
    }
  });

  it('returns 404 for a nonexistent ticket', async () => {
    (SupportTicket.findById as jest.Mock).mockResolvedValue(null);
    const res = makeRes();

    await updateStatus(makeReq({ params: { id: TICKET_B }, body: { status: 'closed' } }), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  // This is the one support handler that DOES enforce authorization.
  it('denies an unrelated member changing another user’s ticket status', async () => {
    const ticket = makeTicketDoc();
    (SupportTicket.findById as jest.Mock).mockResolvedValue(ticket);
    const res = makeRes();

    await updateStatus(makeReq({ params: { id: TICKET_B }, body: { status: 'closed' } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(payloadOf(res).message).toBe('Not authorized');
    expect(ticket.save).not.toHaveBeenCalled();
  });

  it('allows the raiser to change their own ticket status', async () => {
    const ticket = makeTicketDoc({ raisedBy: { toString: () => USER_A } });
    (SupportTicket.findById as jest.Mock).mockResolvedValue(ticket);
    const res = makeRes();

    await updateStatus(makeReq({ params: { id: TICKET_B }, body: { status: 'resolved' } }), res);

    expect(ticket.status).toBe('resolved');
    expect(ticket.save).toHaveBeenCalledTimes(1);
  });

  it('allows admin, manager and superadmin to change any ticket status', async () => {
    for (const role of ['admin', 'manager', 'superadmin']) {
      const ticket = makeTicketDoc();
      (SupportTicket.findById as jest.Mock).mockResolvedValue(ticket);
      const res = makeRes();

      await updateStatus(
        makeReq({
          params: { id: TICKET_B },
          body: { status: 'closed' },
          user: { _id: USER_A, email: 'a@example.com', displayName: 'A', role },
        }),
        res
      );

      expect(ticket.status).toBe('closed');
      expect(res.status).not.toHaveBeenCalledWith(403);
    }
  });
});
