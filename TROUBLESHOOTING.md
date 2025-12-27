# Server Deployment Troubleshooting

## "Route not found" Error

If you're getting `{"error":"Route not found"}` after deploying:

### 1. Check Vercel Function Logs
- Go to Vercel Dashboard → Your Project → Functions tab
- Check the logs for errors when making requests
- Look for: "Server app loaded successfully" message

### 2. Verify File Structure
Make sure your server repo has:
```
kanbanserver/
├── api/
│   └── index.ts       ← Serverless function wrapper
├── src/
│   ├── app.ts         ← Express app
│   ├── routes/
│   └── ...
├── vercel.json        ← Vercel config
└── package.json
```

### 3. Check Dependencies
Ensure `@vercel/node` is in `package.json`:
```json
"devDependencies": {
  "@vercel/node": "^3.0.0"
}
```

Then run: `npm install`

### 4. Test Health Endpoint
Try accessing: `https://your-backend.vercel.app/health`

Should return:
```json
{
  "status": "healthy",
  "timestamp": "...",
  "uptime": ...
}
```

### 5. Test API Endpoint
Try: `https://your-backend.vercel.app/api/auth/test` (or any valid route)

### 6. Check Environment Variables
Make sure all required env vars are set in Vercel:
- `MONGODB_URI`
- `JWT_SECRET`
- `ALLOWED_ORIGINS`
- Any other variables your app needs

### 7. Check CORS
If you get CORS errors, verify `ALLOWED_ORIGINS` includes your frontend URL:
```
ALLOWED_ORIGINS=https://your-frontend.vercel.app,http://localhost:3000
```

### 8. Common Issues

**Issue: Module not found errors**
- Solution: Make sure all dependencies are in `package.json`
- Run `npm install` locally to verify

**Issue: Database connection fails**
- Solution: Check `MONGODB_URI` is correct
- Verify MongoDB Atlas allows connections from Vercel IPs

**Issue: Routes return 404**
- Solution: Check that `vercel.json` routes all requests to `/api/index.ts`
- Verify Express app is loading correctly (check logs)

**Issue: TypeScript compilation errors**
- Solution: Make sure `tsconfig.json` is configured correctly
- Check that all imports resolve correctly

### 9. Debug Steps

1. **Check Vercel Build Logs:**
   - Go to Deployments → Click on latest deployment → View Build Logs
   - Look for any errors during build

2. **Check Function Logs:**
   - Go to Functions tab → Click on function → View Logs
   - Make a test request and check logs

3. **Test Locally with Vercel CLI:**
   ```bash
   npm install -g vercel
   cd kanbanserver
   vercel dev
   ```
   This runs your serverless function locally

4. **Add Debug Logging:**
   The `api/index.ts` file includes console.log statements. Check Vercel function logs to see:
   - "Server app loaded successfully"
   - Request method and URL
   - Any errors

### 10. Still Not Working?

1. Check that your Express app exports correctly:
   ```typescript
   // kanbanserver/src/app.ts should have:
   export default app;
   ```

2. Verify routes are set up correctly:
   ```typescript
   // kanbanserver/src/app.ts should have:
   app.use('/api', routes);
   ```

3. Make sure the serverless function can import the app:
   - Check that paths are correct: `../src/app`
   - Verify TypeScript compilation works

4. Try a minimal test:
   - Create a simple route in `app.ts` like `app.get('/test', (req, res) => res.json({ok: true}))`
   - Test it: `https://your-backend.vercel.app/test`

