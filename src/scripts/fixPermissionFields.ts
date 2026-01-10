import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { ProjectPermission } from '../models/ProjectPermission';
import Project from '../models/Project';
import User from '../models/User';
import { logger } from '../utils/logger';

// Load environment variables
dotenv.config();

const fixPermissionFields = async () => {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/kanban';
    logger.info(`Connecting to MongoDB...`);
    await mongoose.connect(mongoUri);
    logger.info('✅ Connected to MongoDB\n');

    // Ensure models are registered (imports should handle this, but just in case)
    void Project;
    void User;

    // Get all permissions
    const permissions = await ProjectPermission.find().lean();
    logger.info(`📊 Found ${permissions.length} permissions to check\n`);

    const requiredFields = [
      'canCreateTasks', 'canEditTasks', 'canDeleteTasks', 'canAssignTasks',
      'canEditProject', 'canManageMembers', 'canViewAllTasks',
      'canManagePermissions', 'canCreateChatGroups', 'canDeleteChatGroups'
    ];

    let fixedCount = 0;
    let skippedCount = 0;

    for (const perm of permissions) {
      const missingFields: string[] = [];

      // Check for missing fields
      requiredFields.forEach(field => {
        if (!(field in perm.permissions) || perm.permissions[field as keyof typeof perm.permissions] === undefined || perm.permissions[field as keyof typeof perm.permissions] === null) {
          missingFields.push(field);
        }
      });

      if (missingFields.length > 0) {
        // Get the permission document (not lean) to update it
        const permissionDoc = await ProjectPermission.findById(perm._id);
        if (!permissionDoc) {
          logger.warn(`⚠️  Permission ${perm._id} not found, skipping...`);
          skippedCount++;
          continue;
        }

        // Update missing fields with default values based on role
        const defaults = ProjectPermission.getDefaultPermissions(permissionDoc.role);
        let needsUpdate = false;

        missingFields.forEach(field => {
          // Type guard to check if the field is a boolean permission (not modules)
          if (field !== 'modules' && field in defaults) {
            const defaultValue = defaults[field as keyof typeof defaults];
            if (typeof defaultValue === 'boolean') {
              (permissionDoc.permissions as Record<string, unknown>)[field] = defaultValue;
              needsUpdate = true;
            }
          }
        });

        if (needsUpdate) {
          // Mark permissions field as modified
          permissionDoc.markModified('permissions');
          await permissionDoc.save();

          fixedCount++;
          logger.info(`✅ Fixed permission ${perm._id} (User: ${perm.userId}, Project: ${perm.projectId})`);
          logger.info(`   Added missing fields: ${missingFields.join(', ')}`);
        }
      } else {
        skippedCount++;
      }
    }

    logger.info('\n' + '='.repeat(100));
    logger.info(`\n📈 Migration Summary:`);
    logger.info(`   ✅ Fixed: ${fixedCount} permissions`);
    logger.info(`   ⏭️  Skipped: ${skippedCount} permissions (already complete)`);
    logger.info(`   📊 Total: ${permissions.length} permissions\n`);

    // Verify all permissions now have all fields
    logger.info('🔍 Verifying all permissions have all required fields...\n');
    const verifyPermissions = await ProjectPermission.find().lean();
    let allGood = true;

    for (const perm of verifyPermissions) {
      const missingFields: string[] = [];
      requiredFields.forEach(field => {
        if (!(field in perm.permissions) || perm.permissions[field as keyof typeof perm.permissions] === undefined || perm.permissions[field as keyof typeof perm.permissions] === null) {
          missingFields.push(field);
        }
      });

      if (missingFields.length > 0) {
        allGood = false;
        logger.error(`❌ Permission ${perm._id} still missing: ${missingFields.join(', ')}`);
      }
    }

    if (allGood) {
      logger.info('✅ All permissions now have all required fields!');
    } else {
      logger.error('❌ Some permissions still have missing fields. Please check the errors above.');
    }

    await mongoose.disconnect();
    logger.info('\n✅ Disconnected from MongoDB');
    process.exit(0);
  } catch (error) {
    logger.error('❌ Error:', error);
    process.exit(1);
  }
};

// Run the migration
fixPermissionFields();

