// Quick test script to check user permissions in database
const mongoose = require('mongoose');
require('dotenv').config();

const userSchema = new mongoose.Schema({
  email: String,
  displayName: String,
  role: String,
  permissions: {
    canCreateProjects: Boolean,
    canDeleteProjects: Boolean,
    canManageAllProjects: Boolean,
    canViewAllProjects: Boolean,
    canCreateTasks: Boolean,
    canEditTasks: Boolean,
    canDeleteTasks: Boolean,
    canAssignTasks: Boolean,
    canCreateChatGroups: Boolean,
    canEditChatGroups: Boolean,
    canDeleteChatGroups: Boolean,
    canViewAnalytics: Boolean,
    canExportData: Boolean,
  }
}, { collection: 'users' });

const User = mongoose.model('User', userSchema);

async function checkPermissions() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    const users = await User.find({}).select('email displayName role permissions').limit(10);

    console.log('\n=== USER PERMISSIONS IN DATABASE ===\n');
    users.forEach(user => {
      console.log(`User: ${user.email} (${user.displayName})`);
      console.log(`Role: ${user.role}`);
      console.log('Permissions:', JSON.stringify(user.permissions, null, 2));
      console.log('---');
    });

    await mongoose.connection.close();
    console.log('\nDatabase connection closed');
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

checkPermissions();
