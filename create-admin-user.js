const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const userSchema = new mongoose.Schema({}, { strict: false });
const User = mongoose.model('User', userSchema);

async function createAdminUser() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB\n');

    // Check if user already exists
    const existingUser = await User.findOne({
      $or: [
        { email: 'aman@mail.com' },
        { username: 'aman09' }
      ]
    });

    if (existingUser) {
      console.log('User with this email or username already exists!');
      console.log('Updating existing user with admin permissions...');

      // Hash password
      const hashedPassword = await bcrypt.hash('amansingh', 10);

      // Update existing user
      await User.updateOne(
        { _id: existingUser._id },
        {
          $set: {
            username: 'aman09',
            email: 'aman@mail.com',
            displayName: 'Aman Singh',
            password: hashedPassword,
            role: 'admin',
            isActive: true,
            permissions: getAllPermissions()
          }
        }
      );

      console.log('✅ User updated successfully!');
    } else {
      // Hash password
      const hashedPassword = await bcrypt.hash('amansingh', 10);

      // Create new admin user
      const adminUser = new User({
        username: 'aman09',
        email: 'aman@mail.com',
        displayName: 'Aman Singh',
        password: hashedPassword,
        role: 'admin',
        isActive: true,
        createdAt: new Date(),
        lastLoginAt: new Date(),
        permissions: getAllPermissions()
      });

      await adminUser.save();
      console.log('✅ Admin user created successfully!');
    }

    console.log('\n📋 User Details:');
    console.log('   Username: aman09');
    console.log('   Email: aman@mail.com');
    console.log('   Password: amansingh');
    console.log('   Role: admin');
    console.log('   All permissions: ENABLED');

    await mongoose.connection.close();
    console.log('\n✅ Done!');
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

function getAllPermissions() {
  return {
    // Global permissions
    canCreateProjects: true,
    canDeleteProjects: true,
    canManageAllProjects: true,
    canViewAllProjects: true,
    canCreatePersonalProjects: true,
    canCreateTasks: true,
    canEditTasks: true,
    canDeleteTasks: true,
    canAssignTasks: true,
    canCreateChatGroups: true,
    canEditChatGroups: true,
    canDeleteChatGroups: true,
    canViewAnalytics: true,
    canExportData: true,
    canEditDisplayName: true,
    canEditEmail: true,
    canEditPassword: true,

    // Module permissions
    modules: {
      dashboard: {
        view: true,
        edit: true,
        viewStats: true,
        viewAnalytics: true,
        exportData: true,
        inviteMembers: true
      },
      myTasks: {
        view: true,
        edit: true,
        createTasks: true,
        editTasks: true,
        deleteTasks: true,
        assignTasks: true,
        viewTasks: true
      },
      projects: {
        view: true,
        edit: true,
        createProjects: true,
        editProjects: true,
        deleteProjects: true,
        manageMembers: true,
        viewProjects: true,
        personalProjects: true
      },
      chat: {
        view: true,
        edit: true,
        createGroups: true,
        editGroups: true,
        deleteGroups: true,
        sendMessages: true,
        deleteMessages: true,
        manageGroupMembers: true,
        personalChat: true,
        videoCall: true,
        voiceCall: true
      },
      profile: {
        view: true,
        edit: true,
        viewProfile: true,
        editProfile: true,
        canEditPassword: true
      },
      userManagement: {
        view: true,
        edit: true,
        viewUsers: true,
        addUsers: true,
        editUsers: true,
        deleteUsers: true,
        managePermissions: true,
        deactivateActivateUsers: true,
        autoLogout: true
      },
      performance: {
        view: true,
        edit: true,
        exportData: true,
        viewReports: true
      },
      auditLog: {
        view: true,
        edit: true,
        exportLogs: true,
        filterLogs: true
      }
    }
  };
}

createAdminUser();
