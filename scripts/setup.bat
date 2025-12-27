@echo off
echo 🚀 Setting up Asana Clone Backend...

REM Check if Node.js is installed
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ Node.js is not installed. Please install Node.js 16+ first.
    pause
    exit /b 1
)

REM Check if npm is installed
npm --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ npm is not installed. Please install npm first.
    pause
    exit /b 1
)

echo ✅ Node.js version:
node --version
echo ✅ npm version:
npm --version

REM Install dependencies
echo 📦 Installing dependencies...
npm install

REM Create environment file if it doesn't exist
if not exist .env (
    echo ⚙️ Creating .env file from template...
    copy env.example .env
    echo 📝 Please edit .env file with your configuration:
    echo    - MONGODB_URI
    echo    - FIREBASE_PROJECT_ID
    echo    - FIREBASE_PRIVATE_KEY
    echo    - FIREBASE_CLIENT_EMAIL
    echo    - JWT_SECRET
) else (
    echo ✅ .env file already exists
)

REM Create logs directory
if not exist logs mkdir logs
echo ✅ Created logs directory

echo.
echo 🎉 Setup complete!
echo.
echo Next steps:
echo 1. Edit .env file with your configuration
echo 2. Start the server: npm run dev
echo 3. Test health: curl http://localhost:4001/health
echo.
echo 📚 See README.md for detailed setup instructions
pause
