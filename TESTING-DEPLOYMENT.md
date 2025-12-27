# Testing Your Render Deployment

After deploying to Render, follow these steps to verify everything is working correctly.

## Step 1: Check Deployment Status

### In Render Dashboard
1. Go to your service in Render dashboard
2. Check the status shows **"Live"** (green)
3. Look for "Deploy succeeded" in the Events tab
4. Note your service URL: `https://your-app-name.onrender.com`

### Check Build Logs
```
Render Dashboard > Your Service > Logs > Build Logs
```
Should show:
- `npm install` completed successfully
- TypeScript compilation succeeded
- No errors in build process

## Step 2: Test Health Endpoint

This is the quickest way to verify your server is running.

### Using Browser
Open in browser:
```
https://your-app-name.onrender.com/health
```

### Using curl (Command Line)
```bash
curl https://your-app-name.onrender.com/health
```

### Using PowerShell (Windows)
```powershell
Invoke-WebRequest -Uri https://your-app-name.onrender.com/health
```

### Expected Response
```json
{
  "status": "healthy",
  "timestamp": "2024-01-01T12:00:00.000Z"
}
```

**If you don't see this**, check runtime logs for errors.

## Step 3: Check Runtime Logs

### In Render Dashboard
```
Dashboard > Your Service > Logs
```

### What to Look For (Good Signs)
```
✅ MongoDB connected successfully
✅ Socket.IO initialized successfully
✅ Server running on port 4001
✅ Health check: http://localhost:4001/health
✅ Cron jobs started
```

### Common Error Messages

#### MongoDB Connection Failed
```
❌ MongoDB connection failed: Authentication failed
```
**Fix**: Check `MONGODB_URI` in environment variables
- Verify username/password are correct
- Check IP whitelist in MongoDB Atlas (should include 0.0.0.0/0)
- Ensure connection string format is correct

#### Missing Environment Variables
```
❌ Firebase initialization error
❌ JWT_SECRET is not defined
```
**Fix**: Add missing environment variables in Render dashboard

#### Port Binding Issues
```
❌ Error: listen EADDRINUSE
```
**Fix**: This shouldn't happen on Render. Check if PORT env var is set correctly.

## Step 4: Test API Endpoints

### Test Public Endpoint
```bash
curl https://your-app-name.onrender.com/api
```

Should return API info or a 404 (depends on your routes).

### Test With Authentication

First, get a Firebase token from your frontend, then:

```bash
curl -H "Authorization: Bearer YOUR_FIREBASE_TOKEN" \
  https://your-app-name.onrender.com/api/projects
```

**Expected**:
- 200 OK with your projects data
- 401 Unauthorized if token is invalid

### Using Postman or Thunder Client

1. **GET Health Check**
   - URL: `https://your-app-name.onrender.com/health`
   - Method: GET
   - Expected: 200 OK

2. **GET Projects (Authenticated)**
   - URL: `https://your-app-name.onrender.com/api/projects`
   - Method: GET
   - Headers: `Authorization: Bearer YOUR_FIREBASE_TOKEN`
   - Expected: 200 OK with projects array

3. **POST Create Project (Authenticated)**
   - URL: `https://your-app-name.onrender.com/api/projects`
   - Method: POST
   - Headers:
     - `Authorization: Bearer YOUR_FIREBASE_TOKEN`
     - `Content-Type: application/json`
   - Body:
     ```json
     {
       "name": "Test Project",
       "description": "Testing Render deployment"
     }
     ```
   - Expected: 201 Created with project data

## Step 5: Test WebSocket Connection

### Using Browser Console

Open your browser console and run:

```javascript
// Replace with your Render URL
const socket = io('https://your-app-name.onrender.com', {
  auth: {
    token: 'YOUR_FIREBASE_TOKEN'
  }
});

socket.on('connect', () => {
  console.log('✅ WebSocket connected!', socket.id);
});

socket.on('connect_error', (error) => {
  console.error('❌ Connection failed:', error.message);
});

socket.on('disconnect', () => {
  console.log('Disconnected');
});
```

**Expected**: "✅ WebSocket connected!" with a socket ID

### Using Your Frontend

1. Update your Next.js `.env.local`:
   ```env
   NEXT_PUBLIC_API_URL=https://your-app-name.onrender.com
   ```

2. Start your frontend:
   ```bash
   npm run dev
   ```

3. Open browser DevTools > Network tab
4. Filter by "WS" (WebSocket)
5. Look for connection to your Render URL
6. Status should be "101 Switching Protocols" (successful WebSocket upgrade)

## Step 6: Test CORS Configuration

### From Your Frontend Domain

Open your deployed Next.js app and check browser console for CORS errors.

**Good**: No errors, API calls work
**Bad**: `CORS policy: No 'Access-Control-Allow-Origin' header`

### Fix CORS Issues
Update `ALLOWED_ORIGINS` in Render environment variables:
```
ALLOWED_ORIGINS=https://your-nextjs.vercel.app,https://www.yourdomain.com
```

Remember to include:
- Your production frontend URL
- Your custom domain (if any)
- Local development URL for testing (optional): `http://localhost:3000`

## Step 7: Test Full Authentication Flow

### End-to-End Test
1. **Login** on your frontend
2. **Check Network tab** - Should see successful API calls to Render
3. **Create a task/project** - Should save to database
4. **Open in another tab/browser** - Should see real-time updates via WebSocket
5. **Check MongoDB Atlas** - Data should appear in your database

## Step 8: Performance Checks

### Response Time
```bash
curl -w "\nTime: %{time_total}s\n" https://your-app-name.onrender.com/health
```

**Expected**:
- First request after spin-down: 30-60 seconds (free tier)
- Subsequent requests: < 1 second

### WebSocket Latency
Check in browser console:
```javascript
const start = Date.now();
socket.emit('ping');
socket.on('pong', () => {
  console.log('Latency:', Date.now() - start, 'ms');
});
```

**Expected**: < 200ms (depends on your location)

## Troubleshooting Checklist

### Server Won't Start
- [ ] Check build logs for compilation errors
- [ ] Verify all required env vars are set
- [ ] Check `package.json` has correct start script
- [ ] Verify Node version compatibility

### Database Connection Issues
- [ ] MongoDB Atlas cluster is running
- [ ] Database user created with correct password
- [ ] IP whitelist includes 0.0.0.0/0
- [ ] Connection string format is correct
- [ ] Network access configured in Atlas

### Authentication Failures
- [ ] Firebase credentials are correct
- [ ] FIREBASE_PRIVATE_KEY has proper `\n` escaping
- [ ] Firebase project has Authentication enabled
- [ ] Frontend is sending valid Firebase tokens

### WebSocket Not Connecting
- [ ] Check CORS allows your frontend domain
- [ ] Verify frontend URL is correct
- [ ] Check browser console for errors
- [ ] Ensure no ad-blockers blocking WebSocket

### CORS Errors
- [ ] ALLOWED_ORIGINS includes your frontend URL
- [ ] No trailing slashes in URLs
- [ ] Protocol matches (https vs http)
- [ ] Redeploy after changing CORS settings

## Monitoring Tools

### Render Dashboard
- **Metrics**: CPU, Memory, Network usage
- **Logs**: Real-time streaming logs
- **Events**: Deploy history and status

### Third-Party Monitoring (Optional)
- **UptimeRobot**: Free uptime monitoring (https://uptimerobot.com)
- **Better Uptime**: Advanced monitoring
- **Sentry**: Error tracking (https://sentry.io)

### Set Up Uptime Monitoring

Free tool to ping your health endpoint:

1. Sign up at https://uptimerobot.com
2. Create monitor:
   - Type: HTTP(s)
   - URL: `https://your-app-name.onrender.com/health`
   - Interval: 5 minutes
3. Get alerts via email if server goes down

## Quick Verification Script

Save this as `test-deployment.sh`:

```bash
#!/bin/bash

# Replace with your Render URL
RENDER_URL="https://your-app-name.onrender.com"

echo "Testing Render Deployment..."
echo "============================="

# Test health endpoint
echo -e "\n1. Testing Health Endpoint..."
curl -s "$RENDER_URL/health" | jq .

# Test API endpoint
echo -e "\n2. Testing API..."
curl -s "$RENDER_URL/api" -w "\nStatus: %{http_code}\n"

# Check response time
echo -e "\n3. Checking Response Time..."
curl -s "$RENDER_URL/health" -w "\nTime: %{time_total}s\n" -o /dev/null

echo -e "\n✅ Basic tests complete!"
echo "Next: Test with authentication using your frontend"
```

Run with:
```bash
chmod +x test-deployment.sh
./test-deployment.sh
```

## Success Criteria

Your deployment is working correctly if:

✅ Health endpoint returns status: "healthy"
✅ Runtime logs show "MongoDB connected successfully"
✅ Runtime logs show "Socket.IO initialized successfully"
✅ API endpoints respond with correct status codes
✅ WebSocket connections establish successfully
✅ Frontend can authenticate and fetch data
✅ Real-time updates work across multiple clients
✅ No CORS errors in browser console
✅ Data persists in MongoDB Atlas

## Next Steps After Verification

Once everything is working:

1. **Set up monitoring** (UptimeRobot recommended)
2. **Enable auto-deploy** on git push (in Render settings)
3. **Consider upgrading** from free tier for production (no spin-down)
4. **Set up custom domain** (optional)
5. **Configure CI/CD** for automated testing
6. **Add health check notifications** in Render

## Getting Help

If you encounter issues:

1. **Check Render Logs** first - most issues show up here
2. **Render Community**: https://community.render.com/
3. **Render Docs**: https://render.com/docs
4. **GitHub Issues**: Check your repo for deployment-specific issues

## Common "False Alarms"

### First Request is Slow
**Normal on free tier** - Service spins down after 15 minutes of inactivity. Upgrade to Starter plan for always-on service.

### WebSocket Disconnects After Inactivity
**Normal behavior** - Socket.IO will auto-reconnect. Implement reconnection logic in your frontend.

### 502 Bad Gateway During Deploy
**Normal** - Brief downtime during deployment. Use zero-downtime deploys on paid plans.

---

**Pro Tip**: Keep this guide handy and run through these checks after each deployment to catch issues early!
