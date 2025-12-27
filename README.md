# Asana Clone Backend API

A comprehensive REST API and real-time backend for the Asana Clone application.

## Quick Start

1. **Install Dependencies**
```bash
cd server
npm install
```

2. **Environment Setup**
```bash
cp env.example .env
# Edit .env with your configuration
```

3. **Start Server**
```bash
npm run dev
```

## Environment Variables

Required variables in `.env`:
- `MONGODB_URI` - MongoDB connection string
- `FIREBASE_PROJECT_ID` - Firebase project ID
- `FIREBASE_PRIVATE_KEY` - Firebase service account private key
- `FIREBASE_CLIENT_EMAIL` - Firebase service account email
- `PORT` - Server port (default: 4001)
- `ALLOWED_ORIGINS` - CORS allowed origins

## API Endpoints

- `/api/auth` - User authentication and profile
- `/api/tasks` - Task management
- `/api/projects` - Project management  
- `/api/teams` - Team management
- `/api/notifications` - Notifications

## Socket.IO Events

Real-time features for:
- Task updates
- Project changes
- Team activities
- Notifications
- Presence/typing indicators

## Tech Stack

- Node.js + Express + TypeScript
- MongoDB + Mongoose
- Socket.IO
- Firebase Authentication
- Joi validation
- Winston logging

## Frontend Integration

Set in your frontend `.env.local`:
```
NEXT_PUBLIC_API_URL=http://localhost:4001
```

The backend is fully compatible with your existing frontend code.