import type { VercelRequest, VercelResponse } from '@vercel/node';
import { PassThrough } from 'stream';

// Create Express app instance for serverless (cached)
let app: any = null;

// Initialize the Express app (lazy loading)
async function getApp() {
  if (app) {
    return app;
  }

  try {
    // Import the Express app from src directory
    const serverApp = await import('../src/app');
    app = serverApp.default;
    
    console.log('Server app loaded successfully');
    return app;
  } catch (error) {
    console.error('Failed to load server app:', error);
    console.error('Error stack:', error instanceof Error ? error.stack : String(error));
    
    // Create a fallback Express app
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const express = require('express');
      app = express();
      app.use(express.json());
    app.get('/health', (req: any, res: any) => {
      res.json({ 
        status: 'error', 
        message: 'Server app not loaded',
        error: error instanceof Error ? error.message : String(error)
      });
    });
    } catch (importError) {
      console.error('Failed to import express for fallback:', importError);
      throw error; // Re-throw original error
    }
    return app;
  }
}

// Helper to convert Vercel request to Express request
function createExpressRequest(vercelReq: VercelRequest): any {
  let url = vercelReq.url || '/';
  
  // Vercel routes everything to /api/index.ts, but the URL doesn't include /api
  // Since Express app mounts routes at /api, we need to prepend /api to the path
  console.log('Vercel request URL:', url, 'Method:', vercelReq.method, 'Body:', vercelReq.body);
  
  // Prepend /api if not already present
  if (!url.startsWith('/api')) {
    url = `/api${url}`;
  }
  
  const [pathname, search] = url.split('?');
  const fullUrl = search ? `${pathname}?${search}` : pathname;
  
  // Ensure method is preserved correctly
  const method = (vercelReq.method || 'GET').toUpperCase();
  
  // Create a PassThrough stream for the body
  // This allows Express body parser to read from it
  const bodyStream = new PassThrough();
  
  // If body is already parsed by Vercel, write it to the stream
  if (vercelReq.body !== undefined && vercelReq.body !== null) {
    const bodyString = typeof vercelReq.body === 'string' 
      ? vercelReq.body 
      : JSON.stringify(vercelReq.body);
    bodyStream.write(bodyString);
    bodyStream.end();
  } else {
    bodyStream.end();
  }
  
  // Create request object that extends the stream
  const req = Object.assign(bodyStream, {
    method: method,
    url: fullUrl,
    path: pathname,
    pathname: pathname,
    query: vercelReq.query || {},
    headers: vercelReq.headers || {},
    body: vercelReq.body, // Keep parsed body for direct access after parsing
    cookies: vercelReq.cookies || {},
    ip: vercelReq.headers['x-forwarded-for'] || vercelReq.headers['x-real-ip'] || '',
    protocol: 'https',
    secure: true,
    hostname: vercelReq.headers.host || '',
    get: (name: string) => vercelReq.headers[name.toLowerCase()],
  }) as any;
  
  return req;
}

// Helper to convert Vercel response to Express response
function createExpressResponse(vercelRes: VercelResponse): any {
  const headers: Record<string, string> = {};
  
  return {
    statusCode: 200,
    status: function(code: number) {
      this.statusCode = code;
      vercelRes.status(code);
      return this;
    },
    setHeader: function(name: string, value: string) {
      headers[name.toLowerCase()] = value;
      vercelRes.setHeader(name, value);
      return this;
    },
    getHeader: function(name: string) {
      return headers[name.toLowerCase()] || vercelRes.getHeader(name);
    },
    json: function(body: any) {
      if (!vercelRes.headersSent) {
        vercelRes.json(body);
      }
      return this;
    },
    send: function(body: any) {
      if (!vercelRes.headersSent) {
        vercelRes.send(body);
      }
      return this;
    },
    end: function(body?: any) {
      if (!vercelRes.headersSent && body) {
        vercelRes.send(body);
      }
      return this;
    },
    get headersSent() {
      return vercelRes.headersSent;
    },
    locals: {},
  };
}

// Vercel serverless function handler
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  try {
    // Handle OPTIONS preflight requests immediately (before Express)
    if (req.method === 'OPTIONS') {
      const origin = req.headers.origin || '*';
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Max-Age', '86400'); // 24 hours
      return res.status(200).end();
    }

    const expressApp = await getApp();
    
    // Log the request for debugging
    const requestUrl = req.url || '/';
    console.log(`[${req.method}] ${requestUrl}`, {
      headers: req.headers,
      body: req.body,
      query: req.query
    });
    
    // Create Express-compatible request and response
    const expressReq = createExpressRequest(req);
    const expressRes = createExpressResponse(res);
    
    console.log('Express request:', {
      method: expressReq.method,
      url: expressReq.url,
      path: expressReq.path,
      pathname: expressReq.pathname
    });
    
    // Handle the request with Express
    return new Promise<void>((resolve) => {
      expressApp(expressReq, expressRes, (err?: any) => {
        if (err) {
          console.error('Express error:', err);
        if (!res.headersSent) {
            res.status(500).json({ 
              error: 'Internal server error', 
              message: err.message || String(err) 
            });
          }
        } else if (!res.headersSent) {
          // If Express didn't handle the route, send 404
          res.status(404).json({ 
            error: 'Route not found', 
            path: requestUrl,
            method: req.method 
          });
        }
        resolve();
      });
    });
  } catch (error) {
    console.error('Serverless function error:', error);
    console.error('Error stack:', error instanceof Error ? error.stack : String(error));
    if (!res.headersSent) {
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error instanceof Error ? error.message : String(error)
    });
    }
  }
}

