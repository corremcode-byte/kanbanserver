// src/config/env.ts
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables before anything else
const result = dotenv.config({
  path: path.resolve(process.cwd(), '.env')
});

if (result.error) {
  console.error('Error loading .env file:', result.error);
  console.log('Current working directory:', process.cwd());
  console.log('Looking for .env at:', path.resolve(process.cwd(), '.env'));
}

// Debug: Log which environment variables are available
console.log('Environment variables loaded:', {
  FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID ? '✓ Set' : '✗ Missing',
  FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL ? '✓ Set' : '✗ Missing',
  FIREBASE_PRIVATE_KEY: process.env.FIREBASE_PRIVATE_KEY ? '✓ Set (length: ' + process.env.FIREBASE_PRIVATE_KEY.length + ')' : '✗ Missing',
  MONGODB_URI: process.env.MONGODB_URI ? '✓ Set' : '✗ Missing',
  PORT: process.env.PORT || '4001'
});

export default result;