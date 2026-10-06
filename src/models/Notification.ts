import mongoose, { Document, Schema } from 'mongoose';

export interface INotification extends Document {
  userId: mongoose.Types.ObjectId;
  type: 'project_invitation' | 'task_assigned' | 'project_added' | 'task_update' | 'project_update' | 'chat_message' | 'task_chat_message' | 'group_added' | 'note_reminder' | 'task_deadline_reminder' | 'confluence_mention' | 'confluence_review_requested' | 'confluence_changes_requested' | 'confluence_page_approved';
  title: string;
  message: string;
  read: boolean;
  metadata?: {
    projectId?: mongoose.Types.ObjectId;
    projectName?: string;
    taskId?: mongoose.Types.ObjectId;
    taskTitle?: string;
    invitationId?: mongoose.Types.ObjectId;
    actionBy?: mongoose.Types.ObjectId;
    actionByName?: string;
    groupId?: mongoose.Types.ObjectId;
    groupName?: string;
    messageId?: mongoose.Types.ObjectId;
    noteId?: mongoose.Types.ObjectId;
    noteTitle?: string;
    // Confluence (confluence_*): which page/comment to open. Only ever
    // created for a recipient who can access the page at that moment.
    confluencePageId?: mongoose.Types.ObjectId;
    confluenceCommentId?: mongoose.Types.ObjectId;
    confluencePageTitle?: string;
  };
  createdAt: Date;
  readAt?: Date;
}

const NotificationSchema = new Schema<INotification>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ['project_invitation', 'task_assigned', 'project_added', 'task_update', 'project_update', 'chat_message', 'task_chat_message', 'group_added', 'note_reminder', 'task_deadline_reminder', 'confluence_mention', 'confluence_review_requested', 'confluence_changes_requested', 'confluence_page_approved'],
      required: true,
    },
    title: {
      type: String,
      required: true,
    },
    message: {
      type: String,
      required: true,
    },
    read: {
      type: Boolean,
      default: false,
      index: true,
    },
    metadata: {
      projectId: { type: Schema.Types.ObjectId, ref: 'Project' },
      projectName: String,
      taskId: { type: Schema.Types.ObjectId, ref: 'Task' },
      taskTitle: String,
      invitationId: { type: Schema.Types.ObjectId, ref: 'ProjectInvitation' },
      actionBy: { type: Schema.Types.ObjectId, ref: 'User' },
      actionByName: String,
      groupId: { type: Schema.Types.ObjectId, ref: 'ChatGroup' },
      groupName: String,
      messageId: { type: Schema.Types.ObjectId, ref: 'Message' },
      noteId: { type: Schema.Types.ObjectId, ref: 'Note' },
      noteTitle: String,
      confluencePageId: { type: Schema.Types.ObjectId, ref: 'ConfluencePage' },
      confluenceCommentId: { type: Schema.Types.ObjectId, ref: 'ConfluenceComment' },
      confluencePageTitle: String,
    },
    readAt: Date,
  },
  {
    timestamps: true,
  }
);

// Index for efficient queries
NotificationSchema.index({ userId: 1, createdAt: -1 });
NotificationSchema.index({ userId: 1, read: 1 });

export const Notification = mongoose.model<INotification>('Notification', NotificationSchema);
