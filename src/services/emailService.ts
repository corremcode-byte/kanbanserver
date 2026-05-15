import nodemailer, { Transporter } from 'nodemailer';
import { logger } from '../utils/logger';

interface EmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
}

interface ProjectNotification {
  projectName: string;
  projectId: string;
  creatorName: string;
  creatorEmail: string;
}

interface TaskNotification {
  taskTitle: string;
  taskId: string;
  projectName: string;
  projectId: string;
  assignedByName: string;
  dueDate?: Date;
  priority: string;
}

interface TaskReminderNotification {
  taskTitle: string;
  taskId: string;
  projectName: string;
  projectId: string;
  dueDate: Date | null;
  priority: string;
}

class EmailService {
  private transporter: Transporter | null = null;
  private isConfigured: boolean = false;
  private initPromise: Promise<void> | null = null;
  private lastInitError: string | null = null;

  constructor() {
    // Delay initialization to allow dotenv to load first
    // Initialize on first use instead
  }

  private async initialize() {
    // If already successfully configured, skip
    if (this.isConfigured && this.transporter) return;

    // If an init is in-flight, wait for it
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.doInitialize().finally(() => {
      // Always clear the promise so a failed init will retry on next call
      if (!this.isConfigured) {
        this.initPromise = null;
      }
    });
    return this.initPromise;
  }

  private async doInitialize() {
    try {
      const {
        EMAIL_SERVICE,
        EMAIL_HOST,
        EMAIL_PORT,
        EMAIL_USER,
        EMAIL_PASS,
      } = process.env;

      if (!EMAIL_USER || !EMAIL_PASS) {
        this.lastInitError = 'EMAIL_USER or EMAIL_PASS not set in environment';
        logger.warn(`Email service: ${this.lastInitError}`);
        return;
      }

      // Build transporter
      if (EMAIL_SERVICE === 'gmail') {
        this.transporter = nodemailer.createTransport({
          service: 'gmail',
          auth: { user: EMAIL_USER, pass: EMAIL_PASS }
        });
      } else if (EMAIL_HOST && EMAIL_PORT) {
        const port = parseInt(EMAIL_PORT, 10);
        this.transporter = nodemailer.createTransport({
          host: EMAIL_HOST,
          port,
          secure: port === 465,
          auth: { user: EMAIL_USER, pass: EMAIL_PASS },
          tls: { rejectUnauthorized: false },
        });
      } else {
        this.transporter = nodemailer.createTransport({
          service: 'gmail',
          auth: { user: EMAIL_USER, pass: EMAIL_PASS }
        });
      }

      // Verify SMTP connection
      await this.transporter.verify();
      this.isConfigured = true;
      this.lastInitError = null;
      logger.info(`Email service initialized — host: ${EMAIL_HOST || 'gmail'}, user: ${EMAIL_USER}`);
    } catch (error: any) {
      this.lastInitError = error?.message || String(error);
      this.transporter = null;
      this.isConfigured = false;
      logger.error(`Email service init failed: ${this.lastInitError}`);
    }
  }

  /** Expose status for the debug endpoint */
  getStatus() {
    return {
      isConfigured: this.isConfigured,
      lastInitError: this.lastInitError,
      host: process.env.EMAIL_HOST || '(gmail)',
      port: process.env.EMAIL_PORT || '587',
      user: process.env.EMAIL_USER || '(not set)',
    };
  }

  private async sendEmail(options: EmailOptions): Promise<boolean> {
    await this.initialize();

    if (!this.isConfigured || !this.transporter) {
      logger.warn(`Email send skipped — service not configured. Last error: ${this.lastInitError ?? 'unknown'}`);
      return false;
    }

    try {
      const from = process.env.EMAIL_FROM || process.env.EMAIL_USER;
      const recipients = Array.isArray(options.to) ? options.to.join(', ') : options.to;

      await this.transporter.sendMail({
        from: `"Kanban" <${from}>`,
        to: recipients,
        subject: options.subject,
        text: options.text,
        html: options.html
      });

      logger.info(`Email sent successfully to: ${recipients}`);
      return true;
    } catch (error: any) {
      const msg = error?.message || String(error);
      logger.error(`Failed to send email to ${Array.isArray(options.to) ? options.to.join(', ') : options.to}: ${msg}`);
      this.lastInitError = msg; // surface it via getStatus()
      return false;
    }
  }

  /**
   * Send project creation notification to members and managers
   */
  async sendProjectCreatedNotification(
    recipients: string[],
    data: ProjectNotification
  ): Promise<boolean> {
    if (recipients.length === 0) return false;

    const appUrl = process.env.APP_URL || 'http://localhost:3000';
    const projectUrl = `${appUrl}/projects/${data.projectId}`;

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background-color: #3b82f6; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
            .content { background-color: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px; }
            .button { display: inline-block; padding: 12px 24px; background-color: #3b82f6; color: white; text-decoration: none; border-radius: 6px; margin-top: 20px; }
            .footer { text-align: center; margin-top: 20px; color: #6b7280; font-size: 12px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>🎉 New Project Created</h1>
            </div>
            <div class="content">
              <h2>${data.projectName}</h2>
              <p>You've been added to a new project by <strong>${data.creatorName}</strong> (${data.creatorEmail}).</p>
              <p>Click the button below to view the project and start collaborating:</p>
              <a href="${projectUrl}" class="button">View Project</a>
            </div>
            <div class="footer">
              <p>This is an automated notification from Kanban. Please do not reply to this email.</p>
            </div>
          </div>
        </body>
      </html>
    `;

    const text = `
      New Project Created: ${data.projectName}

      You've been added to a new project by ${data.creatorName} (${data.creatorEmail}).

      View project: ${projectUrl}
    `;

    return this.sendEmail({
      to: recipients,
      subject: `New Project: ${data.projectName}`,
      html,
      text
    });
  }

  /**
   * Send task assignment notification
   */
  async sendTaskAssignedNotification(
    recipients: string[],
    data: TaskNotification
  ): Promise<boolean> {
    if (recipients.length === 0) return false;

    const appUrl = process.env.APP_URL || 'http://localhost:3000';
    const taskUrl = `${appUrl}/projects/${data.projectId}?tab=tasks`;

    const dueDateText = data.dueDate ?
      `<p><strong>Due Date:</strong> ${new Date(data.dueDate).toLocaleDateString()}</p>` : '';

    const priorityColor = {
      low: '#10b981',
      medium: '#f59e0b',
      high: '#ef4444',
      critical: '#dc2626'
    }[data.priority] || '#6b7280';

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background-color: #10b981; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
            .content { background-color: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px; }
            .button { display: inline-block; padding: 12px 24px; background-color: #10b981; color: white; text-decoration: none; border-radius: 6px; margin-top: 20px; }
            .priority { display: inline-block; padding: 4px 12px; border-radius: 12px; color: white; font-size: 12px; font-weight: bold; }
            .footer { text-align: center; margin-top: 20px; color: #6b7280; font-size: 12px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>📋 New Task Assigned</h1>
            </div>
            <div class="content">
              <h2>${data.taskTitle}</h2>
              <p><strong>Project:</strong> ${data.projectName}</p>
              <p><strong>Assigned by:</strong> ${data.assignedByName}</p>
              <p><strong>Priority:</strong> <span class="priority" style="background-color: ${priorityColor}">${data.priority.toUpperCase()}</span></p>
              ${dueDateText}
              <a href="${taskUrl}" class="button">View Task</a>
            </div>
            <div class="footer">
              <p>This is an automated notification from Kanban. Please do not reply to this email.</p>
            </div>
          </div>
        </body>
      </html>
    `;

    const text = `
      New Task Assigned: ${data.taskTitle}

      Project: ${data.projectName}
      Assigned by: ${data.assignedByName}
      Priority: ${data.priority.toUpperCase()}
      ${data.dueDate ? `Due Date: ${new Date(data.dueDate).toLocaleDateString()}` : ''}

      View task: ${taskUrl}
    `;

    return this.sendEmail({
      to: recipients,
      subject: `New Task: ${data.taskTitle}`,
      html,
      text
    });
  }

  /**
   * Send task deadline reminder
   */
  async sendTaskDeadlineReminder(
    recipients: string[],
    data: TaskReminderNotification
  ): Promise<boolean> {
    if (recipients.length === 0) return false;

    const appUrl = process.env.APP_URL || 'http://localhost:3000';
    const taskUrl = `${appUrl}/projects/${data.projectId}?tab=tasks`;

    const now = new Date();
    const hasDueDate = data.dueDate !== null;
    const dueDate = hasDueDate ? new Date(data.dueDate!) : null;

    let urgencyText: string;
    let subjectPrefix: string;
    let dueDateLine: string;

    if (!hasDueDate || !dueDate) {
      urgencyText = `<strong style="color: #6b7280;">📋 Scheduled Reminder</strong>`;
      subjectPrefix = '⏰ Reminder';
      dueDateLine = '<p><strong>Due Date:</strong> Not set</p>';
    } else {
      const hoursUntilDue = Math.floor((dueDate.getTime() - now.getTime()) / (1000 * 60 * 60));
      const isOverdue = hoursUntilDue < 0;
      urgencyText = isOverdue
        ? `<strong style="color: #dc2626;">⚠️ OVERDUE</strong>`
        : hoursUntilDue < 24
        ? `<strong style="color: #ef4444;">⏰ Due in ${hoursUntilDue} hour${hoursUntilDue === 1 ? '' : 's'}</strong>`
        : `<strong style="color: #f59e0b;">📅 Due in ${Math.floor(hoursUntilDue / 24)} day${Math.floor(hoursUntilDue / 24) === 1 ? '' : 's'}</strong>`;
      subjectPrefix = isOverdue ? '⚠️ OVERDUE' : '⏰ Reminder';
      dueDateLine = `<p><strong>Due Date:</strong> ${dueDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</p>`;
    }

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background-color: #ef4444; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
            .content { background-color: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px; }
            .button { display: inline-block; padding: 12px 24px; background-color: #ef4444; color: white; text-decoration: none; border-radius: 6px; margin-top: 20px; }
            .footer { text-align: center; margin-top: 20px; color: #6b7280; font-size: 12px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>⏰ Task Reminder</h1>
            </div>
            <div class="content">
              <h2>${data.taskTitle}</h2>
              <p><strong>Project:</strong> ${data.projectName}</p>
              <p>${urgencyText}</p>
              ${dueDateLine}
              <a href="${taskUrl}" class="button">View Task</a>
            </div>
            <div class="footer">
              <p>This is an automated reminder from Kanban. Please do not reply to this email.</p>
            </div>
          </div>
        </body>
      </html>
    `;

    const text = `Task Reminder: ${data.taskTitle}\nProject: ${data.projectName}\n${dueDate ? `Due: ${dueDate.toLocaleString()}` : 'No due date set'}\n\nView task: ${taskUrl}`;

    return this.sendEmail({
      to: recipients,
      subject: `${subjectPrefix}: ${data.taskTitle}`,
      html,
      text
    });
  }

  /**
   * Send project invitation
   */
  async sendProjectInvitation(
    recipient: string,
    data: {
      projectName: string;
      projectDescription?: string;
      inviterName: string;
      role: string;
      invitationUrl: string;
      expiresAt: Date;
    }
  ): Promise<boolean> {
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background-color: #8b5cf6; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
            .content { background-color: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px; }
            .button { display: inline-block; padding: 12px 24px; background-color: #8b5cf6; color: white; text-decoration: none; border-radius: 6px; margin-top: 20px; }
            .info-box { background-color: #ede9fe; padding: 15px; border-radius: 6px; margin: 15px 0; }
            .footer { text-align: center; margin-top: 20px; color: #6b7280; font-size: 12px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>🎯 Project Invitation</h1>
            </div>
            <div class="content">
              <p>Hello!</p>
              <p><strong>${data.inviterName}</strong> has invited you to join the project:</p>
              <h2>${data.projectName}</h2>
              ${data.projectDescription ? `<p>${data.projectDescription}</p>` : ''}
              <div class="info-box">
                <p><strong>Your Role:</strong> ${data.role}</p>
                <p><strong>Invitation Expires:</strong> ${new Date(data.expiresAt).toLocaleDateString()}</p>
              </div>
              <p>Click the button below to accept this invitation and start collaborating:</p>
              <a href="${data.invitationUrl}" class="button">Accept Invitation</a>
              <p style="margin-top: 20px; font-size: 14px; color: #6b7280;">
                Or copy and paste this link into your browser:<br>
                <a href="${data.invitationUrl}">${data.invitationUrl}</a>
              </p>
            </div>
            <div class="footer">
              <p>This invitation will expire on ${new Date(data.expiresAt).toLocaleDateString()}.</p>
              <p>This is an automated notification from Kanban. Please do not reply to this email.</p>
            </div>
          </div>
        </body>
      </html>
    `;

    const text = `
      Project Invitation

      ${data.inviterName} has invited you to join the project: ${data.projectName}

      ${data.projectDescription || ''}

      Your Role: ${data.role}
      Invitation Expires: ${new Date(data.expiresAt).toLocaleDateString()}

      Accept invitation: ${data.invitationUrl}

      This invitation will expire on ${new Date(data.expiresAt).toLocaleDateString()}.
    `;

    return this.sendEmail({
      to: recipient,
      subject: `You're invited to join ${data.projectName}`,
      html,
      text
    });
  }

  /**
   * Send notification when invitation is accepted
   */
  async sendInvitationAcceptedNotification(
    recipient: string,
    data: {
      projectName: string;
      memberName: string;
      memberEmail: string;
      role: string;
    }
  ): Promise<boolean> {
    const appUrl = process.env.APP_URL || 'http://localhost:3000';
    const projectsUrl = `${appUrl}/projects`;

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background-color: #10b981; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
            .content { background-color: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px; }
            .button { display: inline-block; padding: 12px 24px; background-color: #10b981; color: white; text-decoration: none; border-radius: 6px; margin-top: 20px; }
            .footer { text-align: center; margin-top: 20px; color: #6b7280; font-size: 12px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>✅ Invitation Accepted</h1>
            </div>
            <div class="content">
              <p>Good news!</p>
              <p><strong>${data.memberName}</strong> (${data.memberEmail}) has accepted your invitation to join:</p>
              <h2>${data.projectName}</h2>
              <p><strong>Role:</strong> ${data.role}</p>
              <p>They can now start collaborating on the project.</p>
              <a href="${projectsUrl}" class="button">View Projects</a>
            </div>
            <div class="footer">
              <p>This is an automated notification from Kanban. Please do not reply to this email.</p>
            </div>
          </div>
        </body>
      </html>
    `;

    const text = `
      Invitation Accepted

      ${data.memberName} (${data.memberEmail}) has accepted your invitation to join:
      ${data.projectName}

      Role: ${data.role}

      View projects: ${projectsUrl}
    `;

    return this.sendEmail({
      to: recipient,
      subject: `${data.memberName} joined ${data.projectName}`,
      html,
      text
    });
  }

  /**
   * Send password reset email
   */
  async sendPasswordResetEmail(
    recipient: string,
    data: {
      userName: string;
      resetLink: string;
      expiresInMinutes?: number;
    }
  ): Promise<boolean> {
    const expiryTime = data.expiresInMinutes || 60;

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background-color: #ef4444; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
            .content { background-color: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px; }
            .button { display: inline-block; padding: 12px 24px; background-color: #ef4444; color: white; text-decoration: none; border-radius: 6px; margin-top: 20px; }
            .warning-box { background-color: #fef2f2; border-left: 4px solid #ef4444; padding: 15px; margin: 15px 0; }
            .footer { text-align: center; margin-top: 20px; color: #6b7280; font-size: 12px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>🔐 Password Reset Request</h1>
            </div>
            <div class="content">
              <p>Hello ${data.userName},</p>
              <p>We received a request to reset your password for your Kanban account.</p>
              <p>Click the button below to reset your password:</p>
              <a href="${data.resetLink}" class="button">Reset Password</a>
              <div class="warning-box">
                <p><strong>⚠️ Security Notice:</strong></p>
                <ul style="margin: 5px 0; padding-left: 20px;">
                  <li>This link will expire in ${expiryTime} minutes</li>
                  <li>If you didn't request this reset, please ignore this email</li>
                  <li>Never share this link with anyone</li>
                </ul>
              </div>
              <p style="margin-top: 20px; font-size: 14px; color: #6b7280;">
                Or copy and paste this link into your browser:<br>
                <a href="${data.resetLink}">${data.resetLink}</a>
              </p>
            </div>
            <div class="footer">
              <p>This link will expire in ${expiryTime} minutes.</p>
              <p>This is an automated notification from Kanban. Please do not reply to this email.</p>
            </div>
          </div>
        </body>
      </html>
    `;

    const text = `
      Password Reset Request

      Hello ${data.userName},

      We received a request to reset your password for your Kanban account.

      Click the link below to reset your password:
      ${data.resetLink}

      SECURITY NOTICE:
      - This link will expire in ${expiryTime} minutes
      - If you didn't request this reset, please ignore this email
      - Never share this link with anyone

      This is an automated notification from Kanban. Please do not reply to this email.
    `;

    return this.sendEmail({
      to: recipient,
      subject: 'Reset Your Password - Kanban',
      html,
      text
    });
  }

  /**
   * Send task moved to list notification
   */
  async sendTaskMovedToListNotification(
    recipients: string[],
    data: {
      taskTitle: string;
      taskId: string;
      projectName: string;
      projectId: string;
      listTitle: string;
      movedByName: string;
      priority: string;
    }
  ): Promise<boolean> {
    if (!recipients || recipients.length === 0) {
      return false;
    }

    const appUrl = process.env.APP_URL || 'http://localhost:3000';
    const taskUrl = `${appUrl}/projects/${data.projectId}`;

    const priorityColors: { [key: string]: string } = {
      low: '#10B981',
      medium: '#F59E0B',
      high: '#EF4444',
      critical: '#DC2626'
    };

    const priorityColor = priorityColors[data.priority.toLowerCase()] || '#6B7280';

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background-color: #8B5CF6; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
            .content { background-color: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px; }
            .button { display: inline-block; padding: 12px 24px; background-color: #8B5CF6; color: white; text-decoration: none; border-radius: 6px; margin-top: 20px; }
            .priority { display: inline-block; padding: 4px 12px; border-radius: 4px; color: white; font-size: 12px; font-weight: bold; }
            .list-badge { display: inline-block; padding: 6px 16px; background-color: #E0E7FF; color: #4C1D95; border-radius: 6px; font-weight: bold; margin: 10px 0; }
            .footer { text-align: center; margin-top: 20px; color: #6b7280; font-size: 12px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>📋 Task Moved to Your List</h1>
            </div>
            <div class="content">
              <h2>${data.taskTitle}</h2>
              <p><strong>Project:</strong> ${data.projectName}</p>
              <p><strong>Moved by:</strong> ${data.movedByName}</p>
              <p><strong>Priority:</strong> <span class="priority" style="background-color: ${priorityColor}">${data.priority.toUpperCase()}</span></p>
              <div class="list-badge">📌 ${data.listTitle}</div>
              <p>A task has been moved to <strong>${data.listTitle}</strong>, a list you're assigned to monitor. You can view the task details and take action if needed.</p>
              <a href="${taskUrl}" class="button">View Task</a>
            </div>
            <div class="footer">
              <p>This is an automated notification from Kanban. Please do not reply to this email.</p>
            </div>
          </div>
        </body>
      </html>
    `;

    const text = `
      Task Moved to Your List: ${data.taskTitle}

      Project: ${data.projectName}
      Moved by: ${data.movedByName}
      List: ${data.listTitle}
      Priority: ${data.priority}

      A task has been moved to ${data.listTitle}, a list you're assigned to monitor.

      View task: ${taskUrl}

      This is an automated notification from Kanban. Please do not reply to this email.
    `;

    return this.sendEmail({
      to: recipients,
      subject: `Task moved to ${data.listTitle} - ${data.projectName}`,
      html,
      text
    });
  }

  /**
   * Test email configuration
   */
  async sendTestEmail(to: string): Promise<boolean> {
    return this.sendEmail({
      to,
      subject: 'Asana Clone - Email Test',
      html: '<h1>Email Service Working!</h1><p>Your email configuration is working correctly.</p>',
      text: 'Email Service Working! Your email configuration is working correctly.'
    });
  }

  /**
   * Send notification when a user is directly added to a project
   */
  async sendMemberAddedNotification(
    recipient: string,
    data: {
      projectName: string;
      projectDescription?: string;
      addedByName: string;
      role: string;
      projectUrl: string;
    }
  ): Promise<boolean> {
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background-color: #8b5cf6; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
            .content { background-color: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px; }
            .button { display: inline-block; padding: 12px 24px; background-color: #8b5cf6; color: white; text-decoration: none; border-radius: 6px; margin-top: 20px; }
            .info-box { background-color: #ede9fe; padding: 15px; border-radius: 6px; margin: 15px 0; }
            .footer { text-align: center; margin-top: 20px; color: #6b7280; font-size: 12px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>🎯 Added to Project</h1>
            </div>
            <div class="content">
              <p>Hello!</p>
              <p><strong>${data.addedByName}</strong> has added you to the project:</p>
              <h2>${data.projectName}</h2>
              ${data.projectDescription ? `<p>${data.projectDescription}</p>` : ''}
              <div class="info-box">
                <p><strong>Your Role:</strong> ${data.role}</p>
              </div>
              <p>You can now access this project and start collaborating with your team.</p>
              <a href="${data.projectUrl}" class="button">View Project</a>
              <p style="margin-top: 20px; font-size: 14px; color: #6b7280;">
                Or copy and paste this link into your browser:<br>
                <a href="${data.projectUrl}">${data.projectUrl}</a>
              </p>
            </div>
            <div class="footer">
              <p>This is an automated notification from Kanban. Please do not reply to this email.</p>
            </div>
          </div>
        </body>
      </html>
    `;

    const text = `
      Added to Project

      ${data.addedByName} has added you to the project: ${data.projectName}

      ${data.projectDescription || ''}

      Your Role: ${data.role}

      You can now access this project and start collaborating with your team.

      View project: ${data.projectUrl}
    `;

    return this.sendEmail({
      to: recipient,
      subject: `You've been added to ${data.projectName}`,
      html,
      text
    });
  }
  async sendFollowUpNotification(
    recipients: string[],
    data: {
      taskTitle: string;
      taskId: string;
      projectName: string;
      projectId: string;
      requestedByName: string;
      dueDate?: Date;
      priority?: string;
    }
  ): Promise<boolean> {
    if (recipients.length === 0) return false;

    const appUrl = process.env.APP_URL || 'http://localhost:3000';
    const taskUrl = `${appUrl}/projects/${data.projectId}?tab=tasks`;

    const dueDateText = data.dueDate
      ? `<p><strong>Due Date:</strong> ${new Date(data.dueDate).toLocaleDateString()}</p>` : '';

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background-color: #f59e0b; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
            .content { background-color: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px; }
            .button { display: inline-block; padding: 12px 24px; background-color: #f59e0b; color: white; text-decoration: none; border-radius: 6px; margin-top: 20px; }
            .footer { text-align: center; margin-top: 20px; color: #6b7280; font-size: 12px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>🔔 Follow-Up Reminder</h1>
            </div>
            <div class="content">
              <p>Hello!</p>
              <p><strong>${data.requestedByName}</strong> is following up on your task:</p>
              <h2>${data.taskTitle}</h2>
              <p><strong>Project:</strong> ${data.projectName}</p>
              ${dueDateText}
              <a href="${taskUrl}" class="button">View Task</a>
            </div>
            <div class="footer">
              <p>This is an automated notification from Kanban. Please do not reply to this email.</p>
            </div>
          </div>
        </body>
      </html>
    `;

    const text = `
Follow-Up Reminder: ${data.taskTitle}

${data.requestedByName} is following up on your task.

Project: ${data.projectName}
${data.dueDate ? `Due Date: ${new Date(data.dueDate).toLocaleDateString()}` : ''}

View task: ${taskUrl}
    `;

    return this.sendEmail({
      to: recipients,
      subject: `Follow-Up: ${data.taskTitle}`,
      html,
      text
    });
  }
}

// Export singleton instance
export const emailService = new EmailService();
