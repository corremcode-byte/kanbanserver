import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

async function seedSuperAdmin() {
  try {
    const mongoURI = process.env.MONGODB_URI;
    if (!mongoURI) {
      console.error('MONGODB_URI not set');
      process.exit(1);
    }

    console.log('Connecting to MongoDB...');
    await mongoose.connect(mongoURI);
    console.log('Connected!');

    // Import User model after connection
    const { User } = await import('../models/User');

    const superAdminData = {
      username: 'superadmin',
      email: 'superadmin@kanban.com',
      password: 'SuperAdmin@123',
      displayName: 'Super Admin',
      role: 'superadmin' as const,
      isActive: true,
      permissions: {
        // Project permissions
        canCreateProjects: true,
        canDeleteProjects: true,
        canManageAllProjects: true,
        canViewAllProjects: true,
        canCreatePersonalProjects: true,
        // Task permissions
        canCreateTasks: true,
        canEditTasks: true,
        canDeleteTasks: true,
        canAssignTasks: true,
        canMoveTasks: true,
        // Chat permissions
        canCreateChatGroups: true,
        canEditChatGroups: true,
        canDeleteChatGroups: true,
        canDeleteOwnChatGroups: true,
        // System permissions
        canViewAnalytics: true,
        canExportData: true,
        canManageUsers: true,
        // Profile editing permissions
        canEditDisplayName: true,
        canEditEmail: true,
        canEditPassword: true,
        // Auto-logout
        autoLogout: false,
        // Module permissions - ALL enabled
        modules: {
          dashboard: {
            view: true,
            edit: true
          },
          myTasks: {
            view: true,
            edit: true
          },
          projects: {
            view: true,
            edit: true
          },
          chat: {
            view: true,
            edit: true,
            createGroups: true,
            editGroups: true,
            deleteGroups: true,
            deleteMessages: true,
            sendMessages: true,
            voiceRecording: true,
            manageGroupMembers: true,
            personalChat: true
          },
          profile: {
            view: true,
            edit: true
          },
          userManagement: {
            view: true,
            edit: true
          },
          performance: {
            view: true,
            edit: true
          },
          auditLog: {
            view: true,
            edit: true
          }
        }
      }
    };

    // Check if super admin already exists
    const existingSuperAdmin = await User.findOne({
      $or: [
        { email: 'superadmin@kanban.com' },
        { username: 'superadmin' }
      ]
    });

    if (existingSuperAdmin) {
      console.log('\nSuper Admin account already exists. Updating...');
      // Update role, permissions and ensure active
      existingSuperAdmin.role = superAdminData.role;
      existingSuperAdmin.permissions = superAdminData.permissions as any;
      existingSuperAdmin.isActive = true;
      existingSuperAdmin.displayName = superAdminData.displayName;
      await existingSuperAdmin.save();
      console.log('Super Admin account updated successfully!');
    } else {
      console.log('\nCreating Super Admin account...');
      const superAdmin = new User(superAdminData);
      await superAdmin.save();
      console.log('Super Admin account created successfully!');
    }

    console.log('\n========================================');
    console.log('  SUPER ADMIN CREDENTIALS');
    console.log('========================================');
    console.log('  Username : superadmin');
    console.log('  Email    : superadmin@kanban.com');
    console.log('  Password : SuperAdmin@123');
    console.log('  Role     : superadmin');
    console.log('========================================\n');

    await mongoose.connection.close();
    console.log('Done!');
    process.exit(0);
  } catch (error) {
    console.error('Error seeding super admin:', error);
    process.exit(1);
  }
}

seedSuperAdmin();
