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
  dueDate: Date;
  priority: string;
}

class EmailService {
  private transporter: Transporter | null = null;
  private isConfigured: boolean = false;

  constructor() {
    this.initialize();
  }

  private async initialize() {
    try {
      // Check if email configuration is provided
      const {
        EMAIL_SERVICE,
        EMAIL_HOST,
        EMAIL_PORT,
        EMAIL_USER,
        EMAIL_PASS,
        EMAIL_FROM,
        APP_URL
      } = process.env;

      if (!EMAIL_USER || !EMAIL_PASS) {
        logger.warn('Email credentials not configured. Email notifications will be disabled.');
        return;
      }

      // Create transporter based on configuration
      if (EMAIL_SERVICE === 'gmail') {
        this.transporter = nodemailer.createTransport({
          service: 'gmail',
          auth: {
            user: EMAIL_USER,
            pass: EMAIL_PASS // Use App Password for Gmail
          }
        });
      } else if (EMAIL_HOST && EMAIL_PORT) {
        // Custom SMTP configuration
        const port = parseInt(EMAIL_PORT);
        this.transporter = nodemailer.createTransport({
          host: EMAIL_HOST,
          port: port,
          secure: port === 465, // true for 465 (SSL), false for other ports (STARTTLS)
          auth: {
            user: EMAIL_USER,
            pass: EMAIL_PASS
          },
          // Add these for better compatibility with various SMTP providers
          tls: {
            // Do not fail on invalid certs (some providers might have self-signed certs)
            rejectUnauthorized: false
          },
          debug: process.env.NODE_ENV === 'development', // Enable debug output in development
          logger: process.env.NODE_ENV === 'development' // Log to console in development
        });
      } else {
        // Default to Gmail if no specific config
        this.transporter = nodemailer.createTransport({
          service: 'gmail',
          auth: {
            user: EMAIL_USER,
            pass: EMAIL_PASS
          }
        });
      }

      // Verify connection
      await this.transporter.verify();
      this.isConfigured = true;
      logger.info('Email service initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize email service:', error);
      this.isConfigured = false;
    }
  }

  private async sendEmail(options: EmailOptions): Promise<boolean> {
    if (!this.isConfigured || !this.transporter) {
      logger.warn('Email service not configured. Skipping email send.');
      return false;
    }

    try {
      const from = process.env.EMAIL_FROM || process.env.EMAIL_USER;
      const recipients = Array.isArray(options.to) ? options.to.join(', ') : options.to;

      await this.transporter.sendMail({
        from: `"Asana Clone" <${from}>`,
        to: recipients,
        subject: options.subject,
        text: options.text,
        html: options.html
      });

      logger.info(`Email sent successfully to: ${recipients}`);
      return true;
    } catch (error) {
      logger.error('Failed to send email:', error);
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
              <p>This is an automated notification from Asana Clone. Please do not reply to this email.</p>
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
              <p>This is an automated notification from Asana Clone. Please do not reply to this email.</p>
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
    const dueDate = new Date(data.dueDate);
    const hoursUntilDue = Math.floor((dueDate.getTime() - now.getTime()) / (1000 * 60 * 60));
    const isOverdue = hoursUntilDue < 0;

    const urgencyText = isOverdue
      ? `<strong style="color: #dc2626;">⚠️ OVERDUE</strong>`
      : hoursUntilDue < 24
      ? `<strong style="color: #ef4444;">⏰ Due in ${hoursUntilDue} hours</strong>`
      : `<strong style="color: #f59e0b;">📅 Due in ${Math.floor(hoursUntilDue / 24)} days</strong>`;

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
              <h1>⏰ Task Deadline Reminder</h1>
            </div>
            <div class="content">
              <h2>${data.taskTitle}</h2>
              <p><strong>Project:</strong> ${data.projectName}</p>
              <p>${urgencyText}</p>
              <p><strong>Due Date:</strong> ${dueDate.toLocaleDateString()} at ${dueDate.toLocaleTimeString()}</p>
              <a href="${taskUrl}" class="button">View Task</a>
            </div>
            <div class="footer">
              <p>This is an automated reminder from Asana Clone. Please do not reply to this email.</p>
            </div>
          </div>
        </body>
      </html>
    `;

    const text = `
      Task Deadline Reminder: ${data.taskTitle}

      Project: ${data.projectName}
      ${isOverdue ? 'OVERDUE' : `Due in ${hoursUntilDue} hours`}
      Due Date: ${dueDate.toLocaleDateString()} at ${dueDate.toLocaleTimeString()}

      View task: ${taskUrl}
    `;

    return this.sendEmail({
      to: recipients,
      subject: `${isOverdue ? '⚠️ OVERDUE' : '⏰ Reminder'}: ${data.taskTitle}`,
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
              <p>This is an automated notification from Asana Clone. Please do not reply to this email.</p>
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
              <p>This is an automated notification from Asana Clone. Please do not reply to this email.</p>
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
}

// Export singleton instance
export const emailService = new EmailService();
