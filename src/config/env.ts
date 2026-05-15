// src/config/env.ts
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables before anything else
const result = dotenv.config({
  path: path.resolve(process.cwd(), '.env')
});

if (result.error) {
  console.error('Error loading .env file:', result.error);
}


export default result;