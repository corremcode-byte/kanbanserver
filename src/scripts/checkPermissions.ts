import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { ProjectPermission } from '../models/ProjectPermission';
// Import models to register them with mongoose (required for populate)
import Project from '../models/Project';
import User from '../models/User';
import { logger } from '../utils/logger';

// Load environment variables
dotenv.config();

const checkPermissions = async () => {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/kanban';
    logger.info(`Connecting to MongoDB...`);
    await mongoose.connect(mongoUri);
    logger.info('✅ Connected to MongoDB\n');

    // Ensure models are registered (imports should handle this, but just in case)
    void Project;
    void User;

    // Count all permissions
    const count = await ProjectPermission.countDocuments();
    logger.info(`📊 Total permissions in database: ${count}\n`);

    if (count === 0) {
      logger.info('⚠️  No permissions found in database.');
      await mongoose.disconnect();
      return;
    }

    // Get all permissions with populated fields
    const permissions = await ProjectPermission.find()
      .populate('projectId', 'name description')
      .populate('userId', 'displayName email')
      .sort({ updatedAt: -1 });

    logger.info('📋 All Permissions:\n');
    logger.info('='.repeat(100));

    permissions.forEach((perm, index) => {
      const project = perm.projectId;
      const user = perm.userId;
      const projectName = typeof project === 'object' && project !== null && 'name' in project 
        ? (project as any).name 
        : perm.projectId?.toString() || 'Unknown';
      const userName = typeof user === 'object' && user !== null && 'displayName' in user
        ? (user as any).displayName
        : perm.userId?.toString() || 'Unknown';
      const userEmail = typeof user === 'object' && user !== null && 'email' in user
        ? (user as any).email
        : 'Unknown';

      logger.info(`\n${index + 1}. Permission ID: ${perm._id}`);
      logger.info(`   Project: ${projectName} (${perm.projectId})`);
      logger.info(`   User: ${userName} (${userEmail})`);
      logger.info(`   User ID: ${perm.userId}`);
      logger.info(`   Role: ${perm.role}`);
      logger.info(`   Created: ${perm.createdAt}`);
      logger.info(`   Updated: ${perm.updatedAt}`);
      logger.info(`   Permissions Object:`);
      logger.info(`     - canCreateTasks: ${perm.permissions.canCreateTasks}`);
      logger.info(`     - canEditTasks: ${perm.permissions.canEditTasks}`);
      logger.info(`     - canDeleteTasks: ${perm.permissions.canDeleteTasks}`);
      logger.info(`     - canAssignTasks: ${perm.permissions.canAssignTasks}`);
      logger.info(`     - canEditProject: ${perm.permissions.canEditProject}`);
      logger.info(`     - canManageMembers: ${perm.permissions.canManageMembers}`);
      logger.info(`     - canViewAllTasks: ${perm.permissions.canViewAllTasks}`);
      logger.info(`     - canManagePermissions: ${perm.permissions.canManagePermissions}`);
      logger.info(`     - canCreateChatGroups: ${perm.permissions.canCreateChatGroups}`);
      logger.info(`     - canDeleteChatGroups: ${perm.permissions.canDeleteChatGroups}`);
    });

    logger.info('\n' + '='.repeat(100));

    // Statistics
    logger.info('\n📈 Statistics:\n');
    
    const byRole = await ProjectPermission.aggregate([
      { $group: { _id: '$role', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    logger.info('Permissions by Role:');
    byRole.forEach((item: { _id: string; count: number }) => {
      logger.info(`  ${item._id}: ${item.count}`);
    });

    // Check for permissions with missing fields
    logger.info('\n🔍 Checking for issues:\n');
    
    const allPerms = await ProjectPermission.find().lean();
    let issuesFound = false;

    allPerms.forEach((perm: any) => {
      const requiredFields = [
        'canCreateTasks', 'canEditTasks', 'canDeleteTasks', 'canAssignTasks',
        'canEditProject', 'canManageMembers', 'canViewAllTasks',
        'canManagePermissions', 'canCreateChatGroups', 'canDeleteChatGroups'
      ];

      const missingFields: string[] = [];
      requiredFields.forEach(field => {
        if (!(field in perm.permissions) || perm.permissions[field] === undefined || perm.permissions[field] === null) {
          missingFields.push(field);
        }
      });

      if (missingFields.length > 0) {
        issuesFound = true;
        logger.warn(`⚠️  Permission ${perm._id} (User: ${perm.userId}, Project: ${perm.projectId}) is missing fields: ${missingFields.join(', ')}`);
      }
    });

    if (!issuesFound) {
      logger.info('✅ All permissions have all required fields');
    }

    // Check for duplicate permissions (shouldn't happen due to unique index)
    const duplicates = await ProjectPermission.aggregate([
      {
        $group: {
          _id: { projectId: '$projectId', userId: '$userId' },
          count: { $sum: 1 },
          ids: { $push: '$_id' }
        }
      },
      { $match: { count: { $gt: 1 } } }
    ]);

    if (duplicates.length > 0) {
      logger.warn('\n⚠️  Duplicate permissions found:');
      duplicates.forEach((dup: any) => {
        logger.warn(`  Project: ${dup._id.projectId}, User: ${dup._id.userId}, Count: ${dup.count}, IDs: ${dup.ids.join(', ')}`);
      });
    } else {
      logger.info('\n✅ No duplicate permissions found');
    }

    await mongoose.disconnect();
    logger.info('\n✅ Disconnected from MongoDB');
  } catch (error) {
    logger.error('❌ Error:', error);
    process.exit(1);
  }
};

// Run the script
checkPermissions();

