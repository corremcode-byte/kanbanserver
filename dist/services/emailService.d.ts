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
declare class EmailService {
    private transporter;
    private isConfigured;
    constructor();
    private initialize;
    private sendEmail;
    sendProjectCreatedNotification(recipients: string[], data: ProjectNotification): Promise<boolean>;
    sendTaskAssignedNotification(recipients: string[], data: TaskNotification): Promise<boolean>;
    sendTaskDeadlineReminder(recipients: string[], data: TaskReminderNotification): Promise<boolean>;
    sendProjectInvitation(recipient: string, data: {
        projectName: string;
        projectDescription?: string;
        inviterName: string;
        role: string;
        invitationUrl: string;
        expiresAt: Date;
    }): Promise<boolean>;
    sendInvitationAcceptedNotification(recipient: string, data: {
        projectName: string;
        memberName: string;
        memberEmail: string;
        role: string;
    }): Promise<boolean>;
    sendTestEmail(to: string): Promise<boolean>;
}
export declare const emailService: EmailService;
export {};
//# sourceMappingURL=emailService.d.ts.map