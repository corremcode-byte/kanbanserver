export interface TaskEventPayload {
    projectId: string;
    taskId: string;
    data?: any;
}
export interface ProjectEventPayload {
    projectId: string;
    data?: any;
}
export interface CommentEventPayload {
    projectId: string;
    taskId: string;
    commentId: string;
    data?: any;
}
export interface DocumentEventPayload {
    projectId: string;
    taskId: string;
    documentId: string;
    data?: any;
}
export interface NotificationEventPayload {
    userId: string;
    notificationId: string;
    data?: any;
}
export type ServerToClientEvents = {
    'task:created': (payload: TaskEventPayload) => void;
    'task:updated': (payload: TaskEventPayload) => void;
    'task:deleted': (payload: TaskEventPayload) => void;
    'project:updated': (payload: ProjectEventPayload) => void;
    'comment:added': (payload: CommentEventPayload) => void;
    'comment:deleted': (payload: CommentEventPayload) => void;
    'document:attached': (payload: DocumentEventPayload) => void;
    'document:removed': (payload: DocumentEventPayload) => void;
    'notification': (payload: NotificationEventPayload) => void;
};
//# sourceMappingURL=socket.d.ts.map