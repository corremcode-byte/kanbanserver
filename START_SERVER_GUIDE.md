# Server Startup Guide

## Problem: "Port 4001 Already in Use" Error

This happens when multiple Node.js processes are trying to use the same port.

## Solutions

### ✅ Option 1: Use the Clean Start Commands (RECOMMENDED)

Always use these commands to automatically kill any existing process before starting:

```bash
# For development (with auto-reload)
npm run dev:clean

# For production
npm run start:clean
```

### ✅ Option 2: Manual Port Cleanup

If you get the error, run this command first:

```bash
npx kill-port 4001
```

Then start normally:

```bash
npm run dev
```

### ✅ Option 3: Use the Batch File (Windows Only)

Double-click the `start-dev.bat` file in the server folder. It automatically:
1. Kills any process on port 4001
2. Starts the development server

## Best Practices

1. **Only run ONE server at a time** - Don't run both `npm start` and `npm run dev` simultaneously
2. **Close terminals properly** - Use `Ctrl+C` to stop the server before closing the terminal
3. **Use `dev:clean` or `start:clean`** - These commands prevent the port conflict issue
4. **Check running processes** - If unsure, run `npx kill-port 4001` first

## Common Mistakes to Avoid

❌ **DON'T**: Open multiple terminals and run `npm run dev` in each
❌ **DON'T**: Run `npm start` when `npm run dev` is already running
❌ **DON'T**: Close terminal without stopping server (Ctrl+C first)

✅ **DO**: Use `npm run dev:clean` to start
✅ **DO**: Stop server with Ctrl+C before closing terminal
✅ **DO**: Run only ONE server instance at a time

## Quick Reference

| Command | Description |
|---------|-------------|
| `npm run dev:clean` | Start development server (kills port first) |
| `npm run start:clean` | Start production server (kills port first) |
| `npx kill-port 4001` | Manually kill any process on port 4001 |
| `npm run dev` | Normal dev start (may fail if port in use) |
| `npm start` | Normal production start (may fail if port in use) |

## Verification

Server is running correctly when you see:
```
✅ MongoDB connected successfully
✅ Server running on port 4001
✅ Socket.IO enabled
```

## Still Having Issues?

Run these commands to check:
```bash
# Check if anything is using port 4001
netstat -ano | findstr :4001

# Kill all Node processes (use with caution)
taskkill /F /IM node.exe
```
