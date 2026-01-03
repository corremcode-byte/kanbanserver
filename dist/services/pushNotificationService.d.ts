export interface PushSubscription {
    endpoint: string;
    keys: {
        p256dh: string;
        auth: string;
    };
}
export interface PushNotificationPayload {
    title: string;
    body: string;
    icon?: string;
    badge?: string;
    data?: {
        url?: string;
        taskId?: string;
        projectId?: string;
        [key: string]: any;
    };
    tag?: string;
    requireInteraction?: boolean;
}
declare class PushNotificationService {
    sendToSubscription(subscription: PushSubscription, payload: PushNotificationPayload): Promise<boolean>;
    sendToUser(userId: string, payload: PushNotificationPayload): Promise<{
        sent: number;
        failed: number;
    }>;
    sendToUsers(userIds: string[], payload: PushNotificationPayload): Promise<{
        sent: number;
        failed: number;
    }>;
    sendTaskAssignedNotification(userId: string, taskTitle: string, assignerName: string, projectId: string, taskId: string): Promise<void>;
    sendTaskMovedNotification(userId: string, taskTitle: string, fromList: string, toList: string, movedByName: string, projectId: string, taskId: string): Promise<void>;
    getVapidPublicKey(): string;
}
export declare const pushNotificationService: PushNotificationService;
export {};
//# sourceMappingURL=pushNotificationService.d.ts.map