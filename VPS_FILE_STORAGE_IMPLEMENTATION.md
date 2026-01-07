# VPS File Storage Implementation

## Overview
Successfully migrated from Firebase Storage to VPS filesystem storage for handling file uploads. This implementation stores uploaded files directly on the VPS (or local storage for testing) and serves them via Express static middleware.

## What Changed

### 1. Upload Middleware ([src/middleware/upload.ts](src/middleware/upload.ts))
- **Before**: Used `multer.memoryStorage()` to store files in memory for Firebase upload
- **After**: Uses `multer.diskStorage()` to save files directly to the VPS filesystem
- **Directories created**:
  - `uploads/task-attachments/` - for task file attachments
  - `uploads/chat-attachments/` - for chat message files
- **Filename format**: `{timestamp}-{uuid}-{sanitized-basename}.{ext}`

### 2. Upload Controller ([src/controllers/uploadController.ts](src/controllers/uploadController.ts))
- **Removed**: Firebase Storage bucket dependencies
- **Added**: Filesystem operations using Node.js `fs` and `path` modules
- **Functions updated**:
  - `uploadTaskAttachment()`: Saves file to disk and returns public URL
  - `deleteTaskAttachment()`: Deletes file from filesystem
  - `uploadChatAttachment()`: Saves chat files to disk and returns public URL
- **URL format**: `{BASE_URL}/uploads/{task-attachments|chat-attachments}/{filename}`

### 3. Static File Serving ([src/app.ts](src/app.ts))
- **Added**: Express static middleware to serve uploaded files
- **Route**: `/uploads` serves files from the `uploads/` directory
- **Access**: Files are publicly accessible via HTTP URLs

### 4. Upload Routes ([src/routes/uploadRoutes.ts](src/routes/uploadRoutes.ts))
- **Added**: Chat attachment upload route
- **Route**: `POST /api/upload/chat/:groupId`
- **Existing routes**:
  - `POST /api/upload/task/:taskId` - Upload task attachment
  - `GET /api/upload/task/:taskId/attachments` - Get task attachments
  - `DELETE /api/upload/task/:taskId/attachment/:attachmentId` - Delete attachment

### 5. Git Configuration ([.gitignore](.gitignore))
- **Created**: New `.gitignore` file for the server
- **Added**: `uploads/` directory to prevent committing user-uploaded files

## How It Works

### Task File Upload Flow
1. User uploads file via frontend to `POST /api/upload/task/{taskId}`
2. Multer middleware saves file to `uploads/task-attachments/` directory
3. Controller generates public URL: `{API_URL}/uploads/task-attachments/{filename}`
4. Attachment metadata saved to task document in MongoDB
5. File accessible via the public URL

### Chat File Upload Flow
1. User uploads file via chat to `POST /api/upload/chat/{groupId}`
2. Multer middleware saves file to `uploads/chat-attachments/` directory
3. Controller generates public URL: `{API_URL}/uploads/chat-attachments/{filename}`
4. Frontend receives attachment URL to include in chat message
5. File accessible via the public URL

## Environment Configuration

### API_URL Environment Variable
Set this in your `.env` file to ensure correct file URLs:

**For local development**:
```env
API_URL=http://localhost:4001
```

**For VPS deployment**:
```env
API_URL=https://your-vps-domain.com:4001
# or
API_URL=https://api.yourdomain.com
```

If `API_URL` is not set, the server will auto-detect from the request.

## Testing

### Local Testing
1. Start the server: `npm run dev`
2. Upload a file to a task or chat
3. Files will be saved to `kanbanserver1/uploads/`
4. Access files at `http://localhost:4001/uploads/task-attachments/{filename}`

### VPS Testing
1. Deploy server to VPS
2. Ensure `API_URL` environment variable is set correctly
3. Upload files via the application
4. Files stored in `/path/to/server/uploads/` on VPS
5. Access files at `https://your-vps.com:4001/uploads/...`

## File Structure
```
kanbanserver1/
├── src/
│   ├── middleware/
│   │   └── upload.ts           # Multer disk storage configuration
│   ├── controllers/
│   │   └── uploadController.ts # VPS filesystem upload handlers
│   ├── routes/
│   │   └── uploadRoutes.ts     # Upload API routes
│   └── app.ts                  # Express app with static file serving
├── uploads/                    # Created automatically (in .gitignore)
│   ├── task-attachments/       # Task files
│   └── chat-attachments/       # Chat files
└── .gitignore                  # Ignores uploads directory
```

## Features

### Supported File Types
- **Images**: JPEG, PNG, GIF, WebP, SVG, BMP, TIFF, ICO
- **Documents**: PDF, Word, Excel, PowerPoint, OpenOffice, RTF
- **Text**: Plain text, CSV, Markdown
- **Archives**: ZIP, RAR, 7Z, TAR, GZIP
- **Code**: JavaScript, JSON, HTML, CSS, XML, Python, Java, C, C++, TypeScript
- **Media**: MP4, MPEG, QuickTime, AVI, WebM (video), MP3, WAV, OGG (audio)

### File Size Limit
- Maximum: 50MB per file

### Security
- **Authentication required**: All upload routes require valid JWT token
- **Permission checks**:
  - Task uploads: Only project owners, managers, and members
  - Chat uploads: Only chat group members
- **File deletion**: Only owner, manager, or original uploader can delete

## Benefits Over Firebase Storage

1. **No external dependencies**: No Firebase SDK or bucket configuration needed
2. **Cost**: Free storage on your VPS (no Firebase Storage fees)
3. **Control**: Full control over file storage and management
4. **Simplicity**: Straightforward filesystem operations
5. **Local testing**: Works seamlessly in local development
6. **Debugging**: Easy to inspect and manage uploaded files

## Deployment Notes

### VPS Deployment Checklist
- [ ] Set `API_URL` environment variable to your VPS domain
- [ ] Ensure `uploads/` directory has proper write permissions
- [ ] Configure reverse proxy (Nginx/Apache) to serve static files efficiently (optional)
- [ ] Set up file size limits in reverse proxy if needed
- [ ] Consider implementing file cleanup for deleted tasks/chats
- [ ] Set up regular backups of the `uploads/` directory

### Nginx Configuration (Optional - for better performance)
```nginx
location /uploads/ {
    alias /path/to/kanbanserver1/uploads/;
    expires 30d;
    add_header Cache-Control "public, immutable";
}
```

## Troubleshooting

### Files not uploading
- Check that `uploads/` directory exists and has write permissions
- Verify `API_URL` is set correctly in `.env`
- Check server logs for error messages

### Files not accessible
- Verify Express static middleware is configured in `app.ts`
- Check firewall allows access to your API port
- Ensure file URLs are correct format

### File URLs incorrect
- Set `API_URL` environment variable explicitly
- Check that base URL matches your deployment domain

## Future Enhancements (Optional)

1. **File compression**: Compress images before storing
2. **Virus scanning**: Integrate antivirus scanning for uploads
3. **CDN integration**: Serve files via CDN for better performance
4. **Cleanup jobs**: Automatically delete orphaned files
5. **Storage quotas**: Implement per-user or per-project storage limits
6. **Cloud storage**: Option to use S3/Azure Blob as alternative to VPS disk
