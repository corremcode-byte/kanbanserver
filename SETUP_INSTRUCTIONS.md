# Setup Instructions for File Upload Feature

## Required Dependencies

The file upload feature requires the `multer` package for handling multipart/form-data.

### Installation

Run the following command in the `server` directory:

```bash
npm install multer
npm install --save-dev @types/multer
```

## Environment Variables

Make sure to add the following to your `.env` file:

```env
# Firebase Storage (optional - defaults to project_id.appspot.com)
FIREBASE_STORAGE_BUCKET=your-project-id.appspot.com
```

## Firebase Storage Setup

1. Go to Firebase Console > Storage
2. Click "Get Started" if Storage is not enabled
3. Set up security rules (for development):

```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /task-attachments/{taskId}/{fileName} {
      // Allow read for authenticated users
      allow read: if request.auth != null;
      // Allow write for authenticated users
      allow write: if request.auth != null;
    }
  }
}
```

4. For production, you can make files public or use more restrictive rules

## Features Implemented

### Backend API Endpoints

1. **POST /api/upload/task/:taskId**
   - Upload a file attachment to a task
   - Requires authentication
   - Max file size: 10MB
   - Supported formats: Images, PDFs, Office documents, text files, archives, code files

2. **GET /api/upload/task/:taskId/attachments**
   - Get all attachments for a task
   - Requires authentication

3. **DELETE /api/upload/task/:taskId/attachment/:attachmentId**
   - Delete an attachment
   - Only owner, manager, or uploader can delete
   - Requires authentication

### Database Schema

Task model now includes:
```typescript
attachments: [{
  id: string;
  name: string;
  url: string;
  type: string;
  size: number;
  uploadedBy: ObjectId (ref: User);
  uploadedAt: Date;
}]
```

### Reminder Frequency

Task model also includes custom reminder frequencies:
```typescript
reminderFrequency: 'none' | '1hour' | '3hours' | '12hours' | '24hours'
lastReminderSent: Date
```

The cron service will respect these frequencies when sending deadline reminders.

## Testing

You can test the file upload with curl:

```bash
curl -X POST http://localhost:4001/api/upload/task/TASK_ID \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "file=@/path/to/your/file.pdf"
```

Or use Postman/Insomnia:
- Method: POST
- URL: http://localhost:4001/api/upload/task/:taskId
- Headers: Authorization: Bearer <token>
- Body: form-data with key "file" and value as file upload
