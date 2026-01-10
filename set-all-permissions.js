const mongoose = require('mongoose');
require('dotenv').config();

const userSchema = new mongoose.Schema({}, { strict: false });
const User = mongoose.model('User', userSchema);

async function setAllPermissions() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB\n');

    // Set all permissions to TRUE for ALL users
    const result = await User.updateMany(
      {},
      {
        $set: {
          permissions: {
            canCreateProjects: true,
            canDeleteProjects: true,
            canManageAllProjects: true,
            canViewAllProjects: true,
            canCreateTasks: true,
            canEditTasks: true,
            canDeleteTasks: true,
            canAssignTasks: true,
            canCreateChatGroups: true,
            canEditChatGroups: true,
            canDeleteChatGroups: true,
            canViewAnalytics: true,
            canExportData: true,
          }
        }
      }
    );

    console.log(`✅ Updated ${result.modifiedCount} users with full permissions\n`);

    // Verify
    const users = await User.find({}, 'email displayName permissions').limit(5);
    console.log('Sample users after update:');
    users.forEach(user => {
      console.log(`  ${user.email}: canEditTasks = ${user.permissions?.canEditTasks}`);
    });

    await mongoose.connection.close();
    console.log('\n✅ Done! All users now have full permissions.');
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

setAllPermissions();
