// src/config/firebase.ts
import './env'; // Load environment variables FIRST
import admin from 'firebase-admin';
import { logger } from '../utils/logger';

// Validate environment variables
if (!process.env.FIREBASE_PROJECT_ID) {
  throw new Error('FIREBASE_PROJECT_ID is not set in environment variables');
}
if (!process.env.FIREBASE_CLIENT_EMAIL) {
  throw new Error('FIREBASE_CLIENT_EMAIL is not set in environment variables');
}
if (!process.env.FIREBASE_PRIVATE_KEY) {
  throw new Error('FIREBASE_PRIVATE_KEY is not set in environment variables');
}

if (!admin.apps.length) {
  try {
    const serviceAccount = {
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    };
    
    // Log the service account details (without exposing private key)
    logger.info('Initializing Firebase Admin with:', {
      projectId: serviceAccount.projectId,
      clientEmail: serviceAccount.clientEmail,
      privateKeyLength: serviceAccount.privateKey?.length || 0
    });
    
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET || `${process.env.FIREBASE_PROJECT_ID}.appspot.com`
    });

    logger.info('Firebase Admin initialized successfully with storage bucket:',
      process.env.FIREBASE_STORAGE_BUCKET || `${process.env.FIREBASE_PROJECT_ID}.appspot.com`);
  } catch (error) {
    logger.error('Failed to initialize Firebase Admin:', error);
    throw error;
  }
}

// Export storage bucket
export const bucket = admin.storage().bucket();

export default admin;