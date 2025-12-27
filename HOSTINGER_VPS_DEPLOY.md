# Deploying to Hostinger VPS

## Prerequisites
- Hostinger VPS plan 
- SSH access to your VPS
- Domain name pointed to your VPS IP (optional but recommended)

## Step 1: Connect to VPS

```bash
ssh root@your-vps-ip
# Enter your VPS password
```

## Step 2: Install Node.js

```bash
# Update system
apt update && apt upgrade -y

# Install Node.js 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# Verify installation
node --version  # Should show v20.x.x
npm --version
```

## Step 3: Install PM2 Process Manager

```bash
npm install -g pm2
```

## Step 4: Clone Your Repository

```bash
# Install git if not present
apt install -y git

# Clone your repo (replace with your GitHub URL)
cd /var/www
git clone https://github.com/yourusername/kanban.git
cd kanban/kanbanserver
```

## Step 5: Set Up Environment Variables

```bash
# Create .env file
nano .env
```

Add these variables (copy from .env.production.example):

```env
NODE_ENV=production
PORT=4001

# MongoDB Atlas
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/kanban

# Firebase
FIREBASE_PROJECT_ID=kanban-70131
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@kanban-70131.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYour-Key-Here\n-----END PRIVATE KEY-----\n"

# CORS - Your frontend URL
ALLOWED_ORIGINS=https://yourfrontend.vercel.app,http://yourdomain.com
APP_URL=https://yourfrontend.vercel.app

# JWT Secret
JWT_SECRET=your-super-secret-random-string-min-32-chars

# Email (optional)
EMAIL_SERVICE=gmail
EMAIL_USER=your-email@gmail.com
EMAIL_PASS=your-app-password
EMAIL_FROM=your-email@gmail.com
```

Save with `Ctrl+O`, `Enter`, then `Ctrl+X`

## Step 6: Install Dependencies and Build

```bash
npm install
npm run build
```

## Step 7: Start with PM2

```bash
# Start the app
pm2 start dist/server.js --name kanban-api

# Save PM2 process list
pm2 save

# Set PM2 to start on boot
pm2 startup
# Follow the command it outputs
```

## Step 8: Install and Configure Nginx

```bash
# Install Nginx
apt install -y nginx

# Create Nginx configuration
nano /etc/nginx/sites-available/kanban-api
```

Add this configuration:

```nginx
server {
    listen 80;
    server_name api.yourdomain.com;  # Replace with your domain or VPS IP

    location / {
        proxy_pass http://localhost:4001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable the site:

```bash
ln -s /etc/nginx/sites-available/kanban-api /etc/nginx/sites-enabled/
nginx -t  # Test configuration
systemctl restart nginx
```

## Step 9: Install SSL Certificate (Recommended)

```bash
# Install Certbot
apt install -y certbot python3-certbot-nginx

# Get SSL certificate (replace with your domain)
certbot --nginx -d api.yourdomain.com

# Follow the prompts
```

## Step 10: Configure Firewall

```bash
# Allow Nginx
ufw allow 'Nginx Full'

# Allow SSH (important!)
ufw allow OpenSSH

# Enable firewall
ufw enable
```

## Step 11: Test Your Deployment

```bash
# Check if app is running
pm2 status

# Check logs
pm2 logs kanban-api

# Test health endpoint
curl http://localhost:4001/health

# Test from outside (replace with your domain/IP)
curl http://api.yourdomain.com/health
```

## Updating Your App

```bash
cd /var/www/kanban/kanbanserver
git pull
npm install
npm run build
pm2 restart kanban-api
```

## Monitoring

```bash
# View logs
pm2 logs kanban-api

# Monitor CPU/Memory
pm2 monit

# Restart if needed
pm2 restart kanban-api

# Stop
pm2 stop kanban-api
```

## Troubleshooting

### App won't start
```bash
pm2 logs kanban-api --lines 50
```

### Check if port is in use
```bash
netstat -tulpn | grep 4001
```

### MongoDB connection issues
- Check MONGODB_URI in .env
- Verify MongoDB Atlas whitelist (add 0.0.0.0/0)
- Check network connectivity: `ping cluster.mongodb.net`

### Nginx errors
```bash
tail -f /var/log/nginx/error.log
```

## Important Notes

1. **MongoDB:** You MUST use MongoDB Atlas (cloud). Don't install MongoDB on the VPS for production.

2. **Domain:** Point your domain's A record to your VPS IP:
   - `api.yourdomain.com` → `your.vps.ip.address`

3. **Security:**
   - Keep system updated: `apt update && apt upgrade`
   - Use strong passwords
   - Enable firewall
   - Use SSH keys instead of passwords
   - Never commit .env to Git

4. **Frontend:** Update your frontend's `NEXT_PUBLIC_API_URL` to:
   ```
   NEXT_PUBLIC_API_URL=https://api.yourdomain.com
   ```

5. **Backups:** Set up regular backups of your VPS




If you're considering Hostinger VPS just for hosting this backend, **Render is easier**:
- No server maintenance
- No Nginx configuration
- Automatic SSL
- Health checks built-in
- Free tier available
- Just push to GitHub and done

But if you want full VPS control or need it for other projects, Hostinger VPS works fine!
