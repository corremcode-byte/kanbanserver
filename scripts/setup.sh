#!/bin/bash

# Asana Clone Backend Setup Script

echo "🚀 Setting up Asana Clone Backend..."

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 16+ first."
    exit 1
fi

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo "❌ npm is not installed. Please install npm first."
    exit 1
fi

echo "✅ Node.js version: $(node --version)"
echo "✅ npm version: $(npm --version)"

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Create environment file if it doesn't exist
if [ ! -f .env ]; then
    echo "⚙️ Creating .env file from template..."
    cp env.example .env
    echo "📝 Please edit .env file with your configuration:"
    echo "   - MONGODB_URI"
    echo "   - FIREBASE_PROJECT_ID"
    echo "   - FIREBASE_PRIVATE_KEY"
    echo "   - FIREBASE_CLIENT_EMAIL"
    echo "   - JWT_SECRET"
else
    echo "✅ .env file already exists"
fi

# Create logs directory
mkdir -p logs
echo "✅ Created logs directory"

# Check if MongoDB is running (optional)
if command -v mongod &> /dev/null; then
    echo "✅ MongoDB is installed"
else
    echo "⚠️  MongoDB not found locally. Make sure to:"
    echo "   - Install MongoDB locally, or"
    echo "   - Use MongoDB Atlas cloud service"
    echo "   - Update MONGODB_URI in .env accordingly"
fi

echo ""
echo "🎉 Setup complete!"
echo ""
echo "Next steps:"
echo "1. Edit .env file with your configuration"
echo "2. Start the server: npm run dev"
echo "3. Test health: curl http://localhost:4001/health"
echo ""
echo "📚 See README.md for detailed setup instructions"
