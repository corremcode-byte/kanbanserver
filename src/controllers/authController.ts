import { Request, Response } from 'express';
import { User, Task, Project } from '../models';
import { successResponse, errorResponse, internalServerErrorResponse, notFoundResponse } from '../utils/responses';
import { logger } from '../utils/logger';
import { emailService } from '../services/emailService';
import { getAuth } from 'firebase-admin/auth';

export interface AuthenticatedRequest extends Request {
  user?: {
    _id: string;
    firebaseUid: string;
    email: string;
    displayName: string;
    role: string;
    isManager: boolean;
  };
  firebaseUser?: any; // Firebase user from token verification
}

// Remove any direct password-based login/register logic and references

export const syncFirebaseUser = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { firebaseUid, email, displayName, photoURL, role = 'member' } = req.body;

    if (!firebaseUid || !email) {
      return errorResponse(res, 'Firebase UID and email are required', 400);
    }

    // Check if user already exists by Firebase UID
    let user = await User.findOne({ firebaseUid });

    if (user) {
      // Update existing user (but don't change displayName if it would cause a conflict)
      if (displayName && displayName !== user.displayName) {
        // Check if new displayName is already taken by another user
        const existingUser = await User.findOne({ displayName, _id: { $ne: user._id } });
        if (existingUser) {
          logger.warn(`Attempted to change displayName to existing name: ${displayName}`);
          // Keep the old displayName
        } else {
          user.displayName = displayName;
        }
      }
      user.photoURL = photoURL || user.photoURL;
      user.email = email;
      user.lastLoginAt = new Date();
      await user.save();

      logger.info(`Firebase user synced: ${user.email}`);
      return successResponse(res, 'User synced successfully', user);
    }

    // Check if user exists by email (invited user scenario)
    user = await User.findOne({ email });
    if (user && !user.firebaseUid) {
      // Update existing user with Firebase UID
      user.firebaseUid = firebaseUid;
      if (displayName && displayName !== user.displayName) {
        // Check if new displayName is already taken
        const existingUser = await User.findOne({ displayName, _id: { $ne: user._id } });
        if (existingUser) {
          logger.warn(`Attempted to set displayName to existing name: ${displayName}`);
          // Keep the old displayName or generate a new one
        } else {
          user.displayName = displayName;
        }
      }
      user.photoURL = photoURL || user.photoURL;
      user.lastLoginAt = new Date();
      await user.save();

      logger.info(`Existing user linked to Firebase: ${user.email}`);
      return successResponse(res, 'User linked successfully', user);
    }

    // Create new user - ensure displayName is unique
    let uniqueDisplayName = displayName || email.split('@')[0];

    // Check if displayName is already taken
    let existingUser = await User.findOne({ displayName: uniqueDisplayName });
    if (existingUser) {
      // Generate a unique displayName by appending a number
      let counter = 1;
      while (existingUser) {
        uniqueDisplayName = `${displayName || email.split('@')[0]}_${counter}`;
        existingUser = await User.findOne({ displayName: uniqueDisplayName });
        counter++;
      }
      logger.info(`DisplayName was taken, generated unique name: ${uniqueDisplayName}`);
    }

    user = new User({
      firebaseUid,
      email,
      displayName: uniqueDisplayName,
      photoURL,
      role,
      isActive: true,
      lastLoginAt: new Date()
    });

    await user.save();
    logger.info(`New Firebase user created: ${user.email}`);

    return successResponse(res, 'User created successfully', user);
  } catch (error: any) {
    logger.error('Firebase user sync error:', error);

    // Handle duplicate key error specifically
    if (error.code === 11000 && error.keyPattern && error.keyPattern.displayName) {
      return errorResponse(res, 'This username is already taken. Please choose a different username.', 400);
    }

    return internalServerErrorResponse(res, 'Failed to sync user');
  }
};

export const getCurrentUser = async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user?._id) {
      return errorResponse(res, 'User not authenticated', 401);
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      return notFoundResponse(res, 'User not found');
    }

    if (!user.isActive) {
      return errorResponse(res, 'Account is deactivated', 403);
    }

    console.log('🔍 getCurrentUser - User permissions:', {
      userId: user._id,
      email: user.email,
      role: user.role,
      hasPermissionsField: !!user.permissions,
      permissions: user.permissions
    });

    return successResponse(res, 'User retrieved successfully', user);
  } catch (error) {
    logger.error('Error getting current user:', error);
    return internalServerErrorResponse(res, 'Failed to get user');
  }
};

export const getUserByFirebaseUid = async (req: Request, res: Response) => {
  try {
    const { firebaseUid } = req.params;
    
    if (!firebaseUid) {
      return errorResponse(res, 'Firebase UID is required', 400);
    }

    const user = await User.findOne({ firebaseUid });
    if (!user) {
      return notFoundResponse(res, 'User not found');
    }

    if (!user.isActive) {
      return errorResponse(res, 'Account is deactivated', 403);
    }

    return successResponse(res, 'User retrieved successfully', user);
  } catch (error) {
    logger.error('Error getting user by Firebase UID:', error);
    return internalServerErrorResponse(res, 'Failed to get user');
  }
};

export const getAllUsers = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const users = await User.find({ isActive: true })
      .select('-password') // Remove password field if it exists
      .sort({ createdAt: -1 });
    
    return successResponse(res, 'Users retrieved successfully', users);
  } catch (error) {
    logger.error('Error getting all users:', error);
    return internalServerErrorResponse(res, 'Failed to get users');
  }
};

export const getProfile = async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user?._id) {
      return errorResponse(res, 'User not authenticated', 401);
    }

    const userId = req.user._id.toString();
    const user = await User.findById(userId);

    if (!user) {
      return notFoundResponse(res, 'User not found');
    }

    if (!user.isActive) {
      return errorResponse(res, 'Account is deactivated', 403);
    }

    // Calculate stats
    // Create a query that matches tasks assigned to the user or created by them
    const taskQuery = {
      $or: [
        { assigneeId: userId },
        { assignedTo: userId },
        { assignees: userId },
        { createdBy: userId }
      ]
    };

    const [totalProjects, totalTasks, completedTasks, activeTasks, overdueTasks] = await Promise.all([
      // Only count projects the user actually created (as owner)
      Project.countDocuments({ ownerId: userId }),
      // All tasks related to the user
      Task.countDocuments(taskQuery),
      // Completed tasks
      Task.countDocuments({
        ...taskQuery,
        status: 'completed'
      }),
      // Active tasks (todo or in-progress)
      Task.countDocuments({
        ...taskQuery,
        status: { $in: ['todo', 'in-progress'] }
      }),
      // Overdue tasks (active tasks past due date)
      Task.countDocuments({
        ...taskQuery,
        status: { $in: ['todo', 'in-progress'] },
        dueDate: { $lt: new Date() }
      })
    ]);

    // Get recent activity
    const recentTasks = await Task.find(taskQuery)
      .sort({ updatedAt: -1 })
      .limit(10)
      .populate('projectId', 'name');

    const recentProjects = await Project.find({
      $or: [{ ownerId: userId }, { members: userId }]
    })
      .sort({ updatedAt: -1 })
      .limit(5);

    // Build activity timeline
    const recentActivity = [];

    for (const task of recentTasks) {
      const projectName = task.projectId && typeof task.projectId === 'object' && 'name' in task.projectId
        ? task.projectId.name
        : 'Unknown Project';

      if (task.status === 'completed') {
        recentActivity.push({
          id: task._id.toString(),
          type: 'task_completed',
          title: 'Task Completed',
          description: `Completed "${task.title}" in ${projectName}`,
          timestamp: task.updatedAt?.toISOString() || new Date().toISOString(),
          relatedId: task._id.toString(),
          metadata: {
            projectName,
            taskTitle: task.title
          }
        });
      } else if (task.createdBy?.toString() === userId && task.createdAt && new Date().getTime() - new Date(task.createdAt).getTime() < 7 * 24 * 60 * 60 * 1000) {
        recentActivity.push({
          id: task._id.toString(),
          type: 'task_assigned',
          title: 'Task Created',
          description: `Created "${task.title}" in ${projectName}`,
          timestamp: task.createdAt?.toISOString() || new Date().toISOString(),
          relatedId: task._id.toString(),
          metadata: {
            projectName,
            taskTitle: task.title
          }
        });
      }
    }

    for (const project of recentProjects) {
      if (project.ownerId.toString() === userId && project.createdAt && new Date().getTime() - new Date(project.createdAt).getTime() < 7 * 24 * 60 * 60 * 1000) {
        recentActivity.push({
          id: project._id.toString(),
          type: 'project_created',
          title: 'Project Created',
          description: `Created project "${project.name}"`,
          timestamp: project.createdAt?.toISOString() || new Date().toISOString(),
          relatedId: project._id.toString(),
          metadata: {
            projectName: project.name
          }
        });
      }
    }

    // Sort by timestamp descending
    recentActivity.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    const profileData = {
      user: {
        ...user.toObject(),
        name: user.displayName,
        stats: {
          totalBoardsCreated: totalProjects,
          totalTasksCompleted: completedTasks,
          activeTasksCount: activeTasks,
          overdueTasksCount: overdueTasks
        }
      },
      recentActivity: recentActivity.slice(0, 10)
    };

    return successResponse(res, 'Profile retrieved successfully', profileData);
  } catch (error) {
    logger.error('Error getting profile:', error);
    return internalServerErrorResponse(res, 'Failed to retrieve profile');
  }
};

export const updateProfile = async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user?._id) {
      return errorResponse(res, 'User not authenticated', 401);
    }

    const { displayName, bio, photoURL } = req.body;

    const updateData: Partial<{ displayName: string; bio: string; photoURL: string }> = {};

    if (displayName !== undefined) {
      if (!displayName?.trim()) {
        return errorResponse(res, 'Display name cannot be empty', 400);
      }

      const trimmedDisplayName = displayName.trim();

      // Check if displayName is being changed and if new name is already taken
      const currentUser = await User.findById(req.user._id);
      if (currentUser && trimmedDisplayName !== currentUser.displayName) {
        const existingUser = await User.findOne({
          displayName: trimmedDisplayName,
          _id: { $ne: req.user._id }
        });

        if (existingUser) {
          return errorResponse(res, 'This username is already taken. Please choose a different username.', 400);
        }
      }

      updateData.displayName = trimmedDisplayName;
    }

    if (bio !== undefined) {
      updateData.bio = bio.trim();
    }

    if (photoURL !== undefined) {
      updateData.photoURL = photoURL;
    }

    const updatedUser = await User.findByIdAndUpdate(
      req.user._id,
      updateData,
      { new: true }
    );

    if (!updatedUser) {
      return notFoundResponse(res, 'User not found');
    }

    logger.info(`Profile updated for user: ${updatedUser.email}`);
    return successResponse(res, 'Profile updated successfully', updatedUser);
  } catch (error: any) {
    logger.error('Error updating profile:', error);

    // Handle duplicate key error
    if (error.code === 11000 && error.keyPattern && error.keyPattern.displayName) {
      return errorResponse(res, 'This username is already taken. Please choose a different username.', 400);
    }

    return internalServerErrorResponse(res, 'Failed to update profile');
  }
};

export const updateUserRole = async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user?._id) {
      return errorResponse(res, 'User not authenticated', 401);
    }

    const { userId } = req.params;
    const { role } = req.body;

    // Check if current user is admin or manager
    const currentUser = await User.findById(req.user._id);
    if (!currentUser || !['admin', 'manager'].includes(currentUser.role)) {
      return errorResponse(res, 'Insufficient permissions', 403);
    }

    if (!['admin', 'manager', 'member'].includes(role)) {
      return errorResponse(res, 'Invalid role', 400);
    }

    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { role },
      { new: true }
    );

    if (!updatedUser) {
      return notFoundResponse(res, 'User not found');
    }

    logger.info(`User role updated: ${updatedUser.email} -> ${role}`);
    return successResponse(res, 'User role updated successfully', updatedUser);
  } catch (error) {
    logger.error('Error updating user role:', error);
    return internalServerErrorResponse(res, 'Failed to update user role');
  }
};

export const getDashboardData = async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user?._id) {
      return errorResponse(res, 'User not authenticated', 401);
    }

    const userId = req.user._id.toString();

    // Get user's statistics in parallel
    const [
      totalTasks,
      completedTasks,
      activeProjects,
      recentTasks,
      projects
    ] = await Promise.all([
      Task.countDocuments({
        $or: [
          { assigneeId: userId },
          { assignedTo: userId },
          { assignees: userId },
          { createdBy: userId }
        ]
      }),
      Task.countDocuments({
        $or: [
          { assigneeId: userId },
          { assignedTo: userId },
          { assignees: userId },
          { createdBy: userId }
        ],
        status: 'completed'
      }),
      Project.countDocuments({
        $or: [{ ownerId: userId }, { members: userId }, { managers: userId }],
        status: 'active'
      }),
      Task.find({
        $or: [
          { assigneeId: userId },
          { assignedTo: userId },
          { assignees: userId },
          { assignedBy: userId },
          { createdBy: userId }
        ]
      })
        .sort({ updatedAt: -1 })
        .limit(10)
        .populate('projectId', 'name color')
        .populate('assignees', 'displayName email avatar photoURL')
        .populate('assignedTo', 'displayName email avatar photoURL'),
      Project.find({
        $or: [{ ownerId: userId }, { members: userId }, { managers: userId }],
        status: { $ne: 'archived' } // Only return active projects
      })
        .sort({ updatedAt: -1 })
        .limit(10)
        .populate('ownerId', 'name email')
        .populate('members', 'name email')
        .populate('managers', 'name email')
    ]);

    // Add roles information to projects
    const projectsWithRoles = projects.map(project => {
      const projectObj = project.toObject();
      const userIdStr = userId.toString();
      const ownerIdStr = project.ownerId.toString();

      let userRole = 'member';
      if (ownerIdStr === userIdStr) {
        userRole = 'owner';
      } else if (projectObj.managers && projectObj.managers.some((m: any) => {
        const managerId = typeof m === 'object' && m._id ? m._id.toString() : m.toString();
        return managerId === userIdStr;
      })) {
        userRole = 'manager';
      }

      return {
        ...projectObj,
        userRole
      };
    });

    const dashboardData = {
      stats: {
        totalTasks,
        completedTasks,
        activeProjects
      },
      recentTasks,
      projects: projectsWithRoles
    };

    return successResponse(res, 'Dashboard data retrieved successfully', dashboardData);
  } catch (error) {
    logger.error('Error getting dashboard data:', error);
    return internalServerErrorResponse(res, 'Failed to retrieve dashboard data');
  }
};

export const deactivateAccount = async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user?._id) {
      return errorResponse(res, 'User not authenticated', 401);
    }

    const updatedUser = await User.findByIdAndUpdate(
      req.user._id,
      { 
        isActive: false
      },
      { new: true }
    );

    if (!updatedUser) {
      return notFoundResponse(res, 'User not found');
    }

    logger.info(`User account deactivated: ${updatedUser.email}`);
    return successResponse(res, 'Account deactivated successfully');
  } catch (error) {
    logger.error('Error deactivating account:', error);
    return internalServerErrorResponse(res, 'Failed to deactivate account');
  }
};

export const searchUsers = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { query } = req.query;

    if (!query || typeof query !== 'string') {
      return errorResponse(res, 'Search query is required', 400);
    }

    const users = await User.find({
      isActive: true,
      $or: [
        { displayName: { $regex: query, $options: 'i' } },
        { email: { $regex: query, $options: 'i' } }
      ]
    })
    .select('_id displayName email photoURL role')
    .limit(10);

    return successResponse(res, 'Users found', users);
  } catch (error) {
    logger.error('Error searching users:', error);
    return internalServerErrorResponse(res, 'Failed to search users');
  }
};

export const getSettings = async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user?._id) {
      return errorResponse(res, 'User not authenticated', 401);
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      return notFoundResponse(res, 'User not found');
    }

    // Return settings with defaults if not set
    const settings = user.settings || {
      appearance: {
        theme: 'light',
        colorScheme: 'blue',
        fontSize: 'medium'
      },
      notifications: {
        emailNotifications: true,
        taskDeadlineReminders: true,
        dailyDigest: false
      },
      boardPreferences: {
        defaultView: 'kanban',
        autoArchiveCompleted: false,
        taskSorting: 'due_date'
      }
    };

    return successResponse(res, 'Settings retrieved successfully', settings);
  } catch (error) {
    logger.error('Error getting settings:', error);
    return internalServerErrorResponse(res, 'Failed to retrieve settings');
  }
};

export const updateSettings = async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user?._id) {
      return errorResponse(res, 'User not authenticated', 401);
    }

    const { appearance, notifications, boardPreferences } = req.body;

    const user = await User.findById(req.user._id);
    if (!user) {
      return notFoundResponse(res, 'User not found');
    }

    // Initialize settings if not exists
    if (!user.settings) {
      user.settings = {
        appearance: {
          theme: 'light',
          colorScheme: 'blue',
          fontSize: 'medium'
        },
        notifications: {
          emailNotifications: true,
          taskDeadlineReminders: true,
          dailyDigest: false
        },
        boardPreferences: {
          defaultView: 'kanban',
          autoArchiveCompleted: false,
          taskSorting: 'due_date'
        }
      };
    }

    // Update appearance settings
    if (appearance) {
      if (!user.settings.appearance) {
        user.settings.appearance = {};
      }
      if (appearance.theme !== undefined) {
        user.settings.appearance.theme = appearance.theme;
      }
      if (appearance.colorScheme !== undefined) {
        user.settings.appearance.colorScheme = appearance.colorScheme;
      }
      if (appearance.fontSize !== undefined) {
        user.settings.appearance.fontSize = appearance.fontSize;
      }
    }

    // Update notification settings
    if (notifications) {
      if (!user.settings.notifications) {
        user.settings.notifications = {};
      }
      if (notifications.emailNotifications !== undefined) {
        user.settings.notifications.emailNotifications = notifications.emailNotifications;
      }
      if (notifications.taskDeadlineReminders !== undefined) {
        user.settings.notifications.taskDeadlineReminders = notifications.taskDeadlineReminders;
      }
      if (notifications.dailyDigest !== undefined) {
        user.settings.notifications.dailyDigest = notifications.dailyDigest;
      }
    }

    // Update board preferences
    if (boardPreferences) {
      if (!user.settings.boardPreferences) {
        user.settings.boardPreferences = {};
      }
      if (boardPreferences.defaultView !== undefined) {
        user.settings.boardPreferences.defaultView = boardPreferences.defaultView;
      }
      if (boardPreferences.autoArchiveCompleted !== undefined) {
        user.settings.boardPreferences.autoArchiveCompleted = boardPreferences.autoArchiveCompleted;
      }
      if (boardPreferences.taskSorting !== undefined) {
        user.settings.boardPreferences.taskSorting = boardPreferences.taskSorting;
      }
    }

    await user.save();

    logger.info(`Settings updated for user: ${user.email}`);
    return successResponse(res, 'Settings updated successfully', user.settings);
  } catch (error) {
    logger.error('Error updating settings:', error);
    return internalServerErrorResponse(res, 'Failed to update settings');
  }
};

export const updatePassword = async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user?._id) {
      return errorResponse(res, 'User not authenticated', 401);
    }

    // Since we're using Firebase authentication, password changes should be handled
    // through Firebase Admin SDK or client-side Firebase SDK
    // For now, we'll return an appropriate message
    return errorResponse(
      res,
      'Password changes must be done through Firebase authentication. Please use the Firebase password reset feature.',
      400
    );
  } catch (error) {
    logger.error('Error updating password:', error);
    return internalServerErrorResponse(res, 'Failed to update password');
  }
};

export const deleteAccount = async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user?._id) {
      return errorResponse(res, 'User not authenticated', 401);
    }

    // Soft delete by deactivating the account
    const updatedUser = await User.findByIdAndUpdate(
      req.user._id,
      { isActive: false },
      { new: true }
    );

    if (!updatedUser) {
      return notFoundResponse(res, 'User not found');
    }

    // Note: In a production environment, you might also want to:
    // 1. Delete user's Firebase account using Firebase Admin SDK
    // 2. Remove user from all projects
    // 3. Reassign or delete user's tasks
    // 4. Send confirmation email

    logger.info(`Account deleted/deactivated for user: ${updatedUser.email}`);
    return successResponse(res, 'Account deleted successfully');
  } catch (error) {
    logger.error('Error deleting account:', error);
    return internalServerErrorResponse(res, 'Failed to delete account');
  }
};

export const uploadAvatar = async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user?._id) {
      return errorResponse(res, 'User not authenticated', 401);
    }

    // For now, we'll return an error indicating that file upload needs to be configured
    // In production, you would:
    // 1. Use multer to handle file uploads
    // 2. Upload to Firebase Storage or AWS S3
    // 3. Get the public URL
    // 4. Update user's photoURL

    return errorResponse(
      res,
      'Avatar upload requires file storage configuration (Firebase Storage or AWS S3). Please configure file storage first.',
      501
    );
  } catch (error) {
    logger.error('Error uploading avatar:', error);
    return internalServerErrorResponse(res, 'Failed to upload avatar');
  }
};

export const requestPasswordReset = async (req: Request, res: Response) => {
  try {
    const { email } = req.body;

    if (!email || typeof email !== 'string') {
      return errorResponse(res, 'Email is required', 400);
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Check if user exists
    const user = await User.findOne({ email: normalizedEmail });

    // For security, always return success even if user doesn't exist
    // This prevents email enumeration attacks
    if (!user) {
      logger.info(`Password reset requested for non-existent email: ${email}`);
      return successResponse(res, 'If this email exists in our system, a password reset link has been sent');
    }

    // Generate Firebase password reset link
    try {
      const auth = getAuth();
      const appUrl = process.env.APP_URL || 'http://localhost:3000';

      // Generate password reset link using Firebase Admin SDK
      const resetLink = await auth.generatePasswordResetLink(normalizedEmail, {
        url: `${appUrl}/login`, // Redirect URL after password reset
      });

      // Send password reset email
      const emailSent = await emailService.sendPasswordResetEmail(normalizedEmail, {
        userName: user.displayName || user.email,
        resetLink,
        expiresInMinutes: 60
      });

      if (emailSent) {
        logger.info(`Password reset email sent to: ${email}`);
      } else {
        logger.warn(`Failed to send password reset email to: ${email}, but link was generated`);
      }

      return successResponse(
        res,
        'If this email exists in our system, a password reset link has been sent'
      );
    } catch (firebaseError: any) {
      logger.error('Firebase password reset error:', firebaseError);

      // Even on error, return generic success message for security
      return successResponse(
        res,
        'If this email exists in our system, a password reset link has been sent'
      );
    }
  } catch (error) {
    logger.error('Error requesting password reset:', error);
    return internalServerErrorResponse(res, 'Failed to process password reset request');
  }
};