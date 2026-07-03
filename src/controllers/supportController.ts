import { Request, Response } from 'express';
import mongoose from 'mongoose';
import SupportTicket from '../models/SupportTicket';
import { AuthenticatedRequest } from '../middleware/auth';
import { encryptField, decryptSupportTicketFields } from '../utils/fieldEncryption';

// GET /api/support/tickets
export const getAllTickets = async (req: Request, res: Response): Promise<void> => {
  try {
    const { status, category, priority, page = '1', limit = '20' } = req.query;

    const filter: Record<string, unknown> = {};
    if (status && status !== 'all') filter.status = status;
    if (category && category !== 'all') filter.category = category;
    if (priority && priority !== 'all') filter.priority = priority;

    const pageNum = Math.max(1, parseInt(page as string, 10));
    const limitNum = Math.min(100, parseInt(limit as string, 10));
    const skip = (pageNum - 1) * limitNum;

    const [tickets, total] = await Promise.all([
      SupportTicket.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limitNum).lean(),
      SupportTicket.countDocuments(filter),
    ]);

    tickets.forEach((t: any) => decryptSupportTicketFields(t));

    res.json({ success: true, data: { tickets, total, page: pageNum, totalPages: Math.ceil(total / limitNum) } });
  } catch (error) {
    console.error('getAllTickets error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch tickets', error: (error as Error).message });
  }
};

// GET /api/support/tickets/:id
export const getTicket = async (req: Request, res: Response): Promise<void> => {
  try {
    const ticket = await SupportTicket.findById(req.params.id).lean();
    if (!ticket) { res.status(404).json({ success: false, message: 'Ticket not found' }); return; }
    decryptSupportTicketFields(ticket as any);
    res.json({ success: true, data: ticket });
  } catch (error) {
    console.error('getTicket error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch ticket', error: (error as Error).message });
  }
};

// POST /api/support/tickets
export const createTicket = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const user = req.user;
    if (!user) { res.status(401).json({ success: false, message: 'Unauthorized' }); return; }

    const { title, description, category, priority, attachments } = req.body;

    if (!title?.trim() || !description?.trim()) {
      res.status(400).json({ success: false, message: 'Title and description are required' });
      return;
    }
    if (title.trim().length > 200) {
      res.status(400).json({ success: false, message: 'Title is too long (max 200 characters)' });
      return;
    }
    if (description.trim().length > 5000) {
      res.status(400).json({ success: false, message: 'Description is too long (max 5,000 characters)' });
      return;
    }

    const ticket = new SupportTicket({
      title: title.trim(),
      description: description.trim(),
      category: category || 'question',
      priority: priority || 'medium',
      raisedBy: new mongoose.Types.ObjectId(user._id),
      raisedByName: user.displayName || user.email,
      raisedByEmail: user.email,
      attachments: attachments || [],
    });

    const ticketId = ticket._id.toString();
    ticket.title = encryptField(title.trim(), ticketId) as string;
    ticket.description = encryptField(description.trim(), ticketId) as string;

    await ticket.save();

    decryptSupportTicketFields(ticket as any);

    res.status(201).json({ success: true, data: ticket });
  } catch (error) {
    console.error('createTicket error:', error);
    res.status(500).json({ success: false, message: 'Failed to create ticket', error: (error as Error).message });
  }
};

// POST /api/support/tickets/:id/replies
export const addReply = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const user = req.user;
    if (!user) { res.status(401).json({ success: false, message: 'Unauthorized' }); return; }

    const { message, attachments } = req.body;
    if (!message?.trim()) { res.status(400).json({ success: false, message: 'Reply message is required' }); return; }
    if (message.trim().length > 5000) {
      res.status(400).json({ success: false, message: 'Reply message is too long (max 5,000 characters)' });
      return;
    }

    const ticket = await SupportTicket.findById(req.params.id);
    if (!ticket) { res.status(404).json({ success: false, message: 'Ticket not found' }); return; }
    if (ticket.status === 'closed') { res.status(400).json({ success: false, message: 'Cannot reply to a closed ticket' }); return; }

    ticket.replies.push({
      userId: new mongoose.Types.ObjectId(user._id),
      userName: user.displayName || user.email,
      userEmail: user.email,
      message: encryptField(message.trim(), ticket._id.toString()),
      attachments: attachments || [],
      createdAt: new Date(),
    } as any);

    if (ticket.status === 'open' && ticket.raisedBy.toString() !== user._id.toString()) {
      ticket.status = 'in-progress';
    }

    await ticket.save();

    decryptSupportTicketFields(ticket as any);

    res.json({ success: true, data: ticket });
  } catch (error) {
    console.error('addReply error:', error);
    res.status(500).json({ success: false, message: 'Failed to add reply', error: (error as Error).message });
  }
};

// PATCH /api/support/tickets/:id/status
export const updateStatus = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const user = req.user;
    if (!user) { res.status(401).json({ success: false, message: 'Unauthorized' }); return; }

    const { status } = req.body;
    const validStatuses = ['open', 'in-progress', 'resolved', 'closed'];
    if (!validStatuses.includes(status)) { res.status(400).json({ success: false, message: 'Invalid status' }); return; }

    const ticket = await SupportTicket.findById(req.params.id);
    if (!ticket) { res.status(404).json({ success: false, message: 'Ticket not found' }); return; }

    const isRaiser = ticket.raisedBy.toString() === user._id.toString();
    const isPrivileged = ['admin', 'manager', 'superadmin'].includes(user.role);
    if (!isRaiser && !isPrivileged) { res.status(403).json({ success: false, message: 'Not authorized' }); return; }

    ticket.status = status;
    await ticket.save();

    decryptSupportTicketFields(ticket as any);

    res.json({ success: true, data: ticket });
  } catch (error) {
    console.error('updateStatus error:', error);
    res.status(500).json({ success: false, message: 'Failed to update status', error: (error as Error).message });
  }
};
