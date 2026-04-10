import { Request, Response } from 'express';
import { User, Task, Project } from '../models';
import { AuditLog } from '../models/AuditLog';
import { successResponse, errorResponse, internalServerErrorResponse, notFoundResponse } from '../utils/responses';
import { logger } from '../utils/logger';
import { emailService } from '../services/emailService';
import jwt from 'jsonwebtoken';
import { decrypt, encrypt } from '../utils/encryption';

export interface AuthenticatedRequest extends Request {
  user?: {
    _id: string;
    email: string;
    displayName: string;
    role: string;
    isManager: boolean;
  };
}

// MongoDB-only authentication - Login endpoint
export const login = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    console.log('Login attempt for:', email);

    if (!email || !password) {
      return errorResponse(res, 'Username/Email and password are required', 400);
    }

    // Normalize the input
    const normalizedInput = email.toLowerCase().trim();
    
    // Determine if input is email (contains @) or username
    const isEmail = normalizedInput.includes('@');
    
    console.log('Searching for user with:', isEmail ? 'email' : 'username', normalizedInput);
    
    // Search by email or username
    const user = await User.findOne({
      $or: [
        { email: normalizedInput },
        { username: normalizedInput }
      ],
      isActive: true
    }).select('+password');

    if (!user) {
      console.log('User not found or inactive:', normalizedInput);
      return errorResponse(res, 'Invalid username/email or password', 401);
    }

    console.log('User found:', user.email, 'Username:', user.username, 'Password field exists:', !!user.password);

    // Compare password
    const isPasswordValid = await user.comparePassword(password);

    if (!isPasswordValid) {
      console.log('Password validation failed for user:', user.email);
      return errorResponse(res, 'Invalid username/email or password', 401);
    }

    console.log('Password validated successfully for user:', user.email);

    // Generate JWT token
    const jwtSecret = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-this-in-production';
    console.log('Login debug - Using JWT_SECRET:', jwtSecret === process.env.JWT_SECRET ? 'from .env' : 'fallback');
    const token = jwt.sign(
      {
        userId: user._id.toString(),
        email: user.email,
        role: user.role
      },
      jwtSecret,
      { expiresIn: '7d' }
    );
    console.log('Login debug - Generated token preview:', token.substring(0, 50) + '...');

    // Update last login
    user.lastLoginAt = new Date();
    await user.save();

    // Log login event to audit logs
    try {
      const ipAddress = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
      const userAgent = req.headers['user-agent'] || 'unknown';
      
      await AuditLog.logSystemEvent({
        userId: user._id.toString(),
        action: 'user_login',
        metadata: {
          ipAddress: Array.isArray(ipAddress) ? ipAddress[0] : ipAddress,
          userAgent: userAgent
        }
      });
    } catch (auditError) {
      // Don't fail login if audit logging fails
      logger.error('Failed to log login event:', auditError);
    }

    // Remove password from response
    const userResponse = user.toJSON();

    logger.info(`User logged in: ${user.email}`);

    return successResponse(res, 'Login successful', {
      token,
      user: userResponse
    });
  } catch (error) {
    logger.error('Login error:', error);
    return internalServerErrorResponse(res, 'Login failed');
  }
};

// MongoDB-only authentication - Create user endpoint
export const createUser = async (req: Request, res: Response) => {
  try {
    const { email, password, displayName, username, role = 'member', permissions, settings } = req.body;

    if (!email || !password) {
      return errorResponse(res, 'Email and password are required', 400);
    }

    // Check if user already exists
    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return errorResponse(res, 'User with this email already exists', 400);
    }

    // Generate unique displayName if not provided or if it's already taken
    let uniqueDisplayName = displayName || email.split('@')[0];
    let existingDisplayName = await User.findOne({ displayName: uniqueDisplayName });

    if (existingDisplayName) {
      let counter = 1;
      while (existingDisplayName) {
        uniqueDisplayName = `${displayName || email.split('@')[0]}_${counter}`;
        existingDisplayName = await User.findOne({ displayName: uniqueDisplayName });
        counter++;
      }
      logger.info(`DisplayName was taken, generated unique name: ${uniqueDisplayName}`);
    }

    // Generate unique username if not provided
    let uniqueUsername = username || email.split('@')[0].toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    let existingUsername = await User.findOne({ username: uniqueUsername });

    if (existingUsername) {
      let counter = 1;
      while (existingUsername) {
        uniqueUsername = `${username || email.split('@')[0].toLowerCase().replace(/[^a-z0-9_-]/g, '_')}_${counter}`;
        existingUsername = await User.findOne({ username: uniqueUsername });
        counter++;
      }
      logger.info(`Username was taken, generated unique name: ${uniqueUsername}`);
    }

    // Create new user
    // Note: plainPassword is automatically saved by pre-save middleware
    const user = new User({
      email: email.toLowerCase(),
      password,
      username: uniqueUsername,
      displayName: uniqueDisplayName,
      role,
      permissions,
      settings,
      isActive: true,
      lastLoginAt: new Date()
    });

    await user.save();

    // Log user creation event to audit logs
    try {
      await AuditLog.logSystemEvent({
        userId: user._id.toString(),
        action: 'user_created',
        metadata: {
          userName: user.displayName,
          userEmail: user.email,
          role: user.role
        }
      });
    } catch (auditError) {
      // Don't fail user creation if audit logging fails
      logger.error('Failed to log user creation event:', auditError);
    }

    // Remove password from response
    const userResponse = user.toJSON();

    logger.info(`New user created: ${user.email}`);

    return successResponse(res, 'User created successfully', userResponse, 201);
  } catch (error: any) {
    logger.error('Create user error:', error);

    // Handle duplicate key error
    if (error.code === 11000) {
      if (error.keyPattern?.email) {
        return errorResponse(res, 'User with this email already exists', 400);
      }
      if (error.keyPattern?.displayName) {
        return errorResponse(res, 'This username is already taken', 400);
      }
      if (error.keyPattern?.firebaseUid) {
        logger.error('firebaseUid duplicate key error detected. The firebaseUid index needs to be dropped.');
        logger.error('Run: npm run drop-firebase-index or ts-node src/scripts/dropFirebaseIndex.ts');
        return errorResponse(res, 'Database configuration error. Please contact administrator.', 500);
      }
      // Generic duplicate key error
      const duplicateField = error.keyPattern ? Object.keys(error.keyPattern)[0] : 'unknown field';
      return errorResponse(res, `Duplicate value for ${duplicateField}`, 400);
    }

    return internalServerErrorResponse(res, 'Failed to create user');
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

    // Convert photoURL to absolute URL for client consumption
    const userData = user.toObject();
    if (userData.photoURL && !userData.photoURL.startsWith('http')) {
      const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 4001}`;
      userData.photoURL = `${baseUrl.replace(/\/+$/, '')}${userData.photoURL}`;
    }

    return successResponse(res, 'User retrieved successfully', userData);
  } catch (error) {
    logger.error('Error getting current user:', error);
    return internalServerErrorResponse(res, 'Failed to get user');
  }
};


export const getAllUsers = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const users = await User.find({ isActive: true })
      .select('-password') // Remove password field if it exists
      .sort({ createdAt: -1 });

    // Convert photoURLs to absolute URLs for all users
    const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 4001}`;
    const usersWithAbsoluteUrls = users.map(user => {
      const userObj = user.toObject();
      if (userObj.photoURL && !userObj.photoURL.startsWith('http')) {
        userObj.photoURL = `${baseUrl.replace(/\/+$/, '')}${userObj.photoURL}`;
      }
      return userObj;
    });

    return successResponse(res, 'Users retrieved successfully', usersWithAbsoluteUrls);
  } catch (error) {
    logger.error('Error getting all users:', error);
    return internalServerErrorResponse(res, 'Failed to get users');
  }
};

// Admin-only endpoint to get users with plain passwords
export const getAllUsersWithPasswords = async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user?._id) {
      return errorResponse(res, 'User not authenticated', 401);
    }

    // Verify the requesting user is an admin
    const requestingUser = await User.findById(req.user._id);
    if (!requestingUser || !['admin', 'superadmin'].includes(requestingUser.role)) {
      return errorResponse(res, 'Access denied. Admin privileges required.', 403);
    }

    // Fetch users with plainPassword field included (excluding superadmin)
    const users = await User.find({ isActive: true, role: { $ne: 'superadmin' } })
      .select('+plainPassword') // Include plainPassword field
      .sort({ createdAt: -1 });

    // Map users to include decrypted plainPassword in response
    const usersWithPasswords = users.map(user => {
      const userObj = user.toObject();
      let decryptedPassword = 'N/A';

      if (user.plainPassword) {
        try {
          decryptedPassword = decrypt(user.plainPassword);
        } catch (error) {
          logger.error(`Failed to decrypt password for user ${user.email}:`, error);
          decryptedPassword = 'Decryption failed';
        }
      }

      return {
        ...userObj,
        plainPassword: decryptedPassword
      };
    });

    return successResponse(res, 'Users with passwords retrieved successfully', usersWithPasswords);
  } catch (error) {
    logger.error('Error getting users with passwords:', error);
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
    if (!currentUser || !['superadmin', 'admin', 'manager'].includes(currentUser.role)) {
      return errorResponse(res, 'Insufficient permissions', 403);
    }

    if (!['superadmin', 'admin', 'manager', 'member'].includes(role)) {
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
        $or: [{ ownerId: userId }, { owners: userId }, { members: userId }, { managers: userId }],
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
        $or: [{ ownerId: userId }, { owners: userId }, { members: userId }, { managers: userId }],
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
      const isInOwners = projectObj.owners && projectObj.owners.some((o: any) => {
        const ownerId = typeof o === 'object' && o._id ? o._id.toString() : o.toString();
        return ownerId === userIdStr;
      });
      const coOwnerPerm = (projectObj.coOwnerPermissions && projectObj.coOwnerPermissions[userIdStr]) || 'edit';

      let userRole = 'member';
      if (ownerIdStr === userIdStr) {
        userRole = 'owner';
      } else if (isInOwners) {
        userRole = coOwnerPerm === 'edit' ? 'co-owner' : 'co-owner-view';
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

    const { newPassword } = req.body;

    if (!newPassword) {
      return errorResponse(res, 'New password is required', 400);
    }

    if (newPassword.length < 6) {
      return errorResponse(res, 'New password must be at least 6 characters long', 400);
    }

    // Find user
    const user = await User.findById(req.user._id);

    if (!user) {
      return notFoundResponse(res, 'User not found');
    }

    // Update password (will be hashed by pre-save middleware)
    // Note: plainPassword is automatically updated by pre-save middleware
    user.password = newPassword;
    await user.save();

    // Log password update event to audit logs
    try {
      await AuditLog.logSystemEvent({
        userId: user._id.toString(),
        action: 'user_password_updated',
        metadata: {
          userEmail: user.email,
          updatedBy: user.email
        }
      });
    } catch (auditError) {
      logger.error('Failed to log password update event:', auditError);
    }

    logger.info(`Password updated for user: ${user.email}`);
    return successResponse(res, 'Password updated successfully');
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

    // Check if file was uploaded
    if (!req.file) {
      return errorResponse(res, 'No file uploaded', 400);
    }

    // Construct the avatar URL
    const avatarUrl = `/uploads/avatars/${req.file.filename}`;

    // Update user's photoURL in database
    const user = await User.findByIdAndUpdate(
      req.user._id,
      { photoURL: avatarUrl },
      { new: true }
    ).select('-password');

    if (!user) {
      return errorResponse(res, 'User not found', 404);
    }

    logger.info(`Avatar uploaded successfully for user ${req.user._id}`);

    return successResponse(res, 'Avatar uploaded successfully', {
      avatar: avatarUrl,
      user: {
        _id: user._id,
        email: user.email,
        displayName: user.displayName,
        photoURL: user.photoURL,
      }
    });
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
    const user = await User.findOne({ email: normalizedEmail, isActive: true });

    // For security, always return success even if user doesn't exist
    // This prevents email enumeration attacks
    if (!user) {
      logger.info(`Password reset requested for non-existent email: ${email}`);
      return successResponse(res, 'If this email exists in our system, a password reset link has been sent');
    }

    // Generate password reset token
    const jwtSecret = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-this-in-production';
    const resetToken = jwt.sign(
      {
        userId: user._id.toString(),
        email: user.email,
        type: 'password-reset'
      },
      jwtSecret,
      { expiresIn: '1h' } // Token expires in 1 hour
    );

    // Create password reset link
    const appUrl = process.env.APP_URL || 'http://localhost:3000';
    const resetLink = `${appUrl}/reset-password?token=${resetToken}`;

    // Send password reset email
    try {
      const emailSent = await emailService.sendPasswordResetEmail(normalizedEmail, {
        userName: user.displayName || user.email,
        resetLink,
        expiresInMinutes: 60
      });

      if (emailSent) {
        logger.info(`Password reset email sent to: ${email}`);
      } else {
        logger.warn(`Failed to send password reset email to: ${email}`);
      }
    } catch (emailError) {
      logger.error('Email sending error:', emailError);
      // Don't throw error, still return success for security
    }

    return successResponse(
      res,
      'If this email exists in our system, a password reset link has been sent'
    );
  } catch (error) {
    logger.error('Error requesting password reset:', error);
    return internalServerErrorResponse(res, 'Failed to process password reset request');
  }
};

// Set passkey for user (first time setup)
export const setPasskey = async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user?._id) {
      return errorResponse(res, 'User not authenticated', 401);
    }

    const { passkey } = req.body;

    if (!passkey || typeof passkey !== 'string') {
      return errorResponse(res, 'Passkey is required', 400);
    }

    if (passkey.length !== 6) {
      return errorResponse(res, 'Passkey must be exactly 6 digits', 400);
    }

    if (!/^\d{6}$/.test(passkey)) {
      return errorResponse(res, 'Passkey must contain only digits', 400);
    }

    // Check if user already has a passkey
    const user = await User.findById(req.user._id).select('+passkey');
    if (!user) {
      return notFoundResponse(res, 'User not found');
    }

    if (user.passkey) {
      return errorResponse(res, 'Passkey already set. Use change passkey to update it.', 400);
    }

    // Encrypt and save passkey
    user.passkey = encrypt(passkey);
    await user.save();

    // Log passkey setup event to audit logs
    try {
      await AuditLog.logSystemEvent({
        userId: user._id.toString(),
        action: 'user_passkey_set',
        metadata: {
          userEmail: user.email,
          updatedBy: user.email
        }
      });
    } catch (auditError) {
      logger.error('Failed to log passkey setup event:', auditError);
    }

    logger.info(`Passkey set for user: ${user.email}`);
    return successResponse(res, 'Passkey set successfully');
  } catch (error) {
    logger.error('Error setting passkey:', error);
    return internalServerErrorResponse(res, 'Failed to set passkey');
  }
};

// Verify passkey
export const verifyPasskey = async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user?._id) {
      return errorResponse(res, 'User not authenticated', 401);
    }

    const { passkey } = req.body;

    if (!passkey || typeof passkey !== 'string') {
      return errorResponse(res, 'Passkey is required', 400);
    }

    const user = await User.findById(req.user._id).select('+passkey');
    if (!user) {
      return notFoundResponse(res, 'User not found');
    }

    if (!user.passkey) {
      return errorResponse(res, 'Passkey not set', 400);
    }

    const isValid = await user.comparePasskey(passkey);
    if (!isValid) {
      return errorResponse(res, 'Invalid passkey', 401);
    }

    logger.info(`Passkey verified for user: ${user.email}`);
    return successResponse(res, 'Passkey verified successfully', { verified: true });
  } catch (error) {
    logger.error('Error verifying passkey:', error);
    return internalServerErrorResponse(res, 'Failed to verify passkey');
  }
};

// Change passkey (no current passkey required)
export const changePasskey = async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user?._id) {
      return errorResponse(res, 'User not authenticated', 401);
    }

    const { newPasskey } = req.body;

    if (!newPasskey) {
      return errorResponse(res, 'New passkey is required', 400);
    }

    if (newPasskey.length !== 6) {
      return errorResponse(res, 'New passkey must be exactly 6 digits', 400);
    }

    if (!/^\d{6}$/.test(newPasskey)) {
      return errorResponse(res, 'New passkey must contain only digits', 400);
    }

    const user = await User.findById(req.user._id).select('+passkey');
    if (!user) {
      return notFoundResponse(res, 'User not found');
    }

    // Update passkey (works for both setting new and changing existing)
    user.passkey = encrypt(newPasskey);
    await user.save();

    // Log passkey change event to audit logs
    try {
      await AuditLog.logSystemEvent({
        userId: user._id.toString(),
        action: 'user_passkey_changed',
        metadata: {
          userEmail: user.email,
          updatedBy: user.email
        }
      });
    } catch (auditError) {
      logger.error('Failed to log passkey change event:', auditError);
    }

    logger.info(`Passkey changed for user: ${user.email}`);
    return successResponse(res, 'Passkey changed successfully');
  } catch (error) {
    logger.error('Error changing passkey:', error);
    return internalServerErrorResponse(res, 'Failed to change passkey');
  }
};

// Check if user has passkey set
export const checkPasskeyStatus = async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user?._id) {
      return errorResponse(res, 'User not authenticated', 401);
    }

    const user = await User.findById(req.user._id).select('+passkey');
    if (!user) {
      return notFoundResponse(res, 'User not found');
    }

    return successResponse(res, 'Passkey status retrieved', {
      hasPasskey: !!user.passkey
    });
  } catch (error) {
    logger.error('Error checking passkey status:', error);
    return internalServerErrorResponse(res, 'Failed to check passkey status');
  }
};

// Reset password with token
export const resetPassword = async (req: Request, res: Response) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return errorResponse(res, 'Token and new password are required', 400);
    }

    if (newPassword.length < 6) {
      return errorResponse(res, 'Password must be at least 6 characters long', 400);
    }

    // Verify token
    const jwtSecret = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-this-in-production';
    let decoded: any;

    try {
      decoded = jwt.verify(token, jwtSecret);
    } catch (err) {
      return errorResponse(res, 'Invalid or expired reset token', 400);
    }

    // Check token type
    if (decoded.type !== 'password-reset') {
      return errorResponse(res, 'Invalid reset token', 400);
    }

    // Find user
    const user = await User.findById(decoded.userId);

    if (!user || !user.isActive) {
      return errorResponse(res, 'User not found', 404);
    }

    // Update password (will be hashed by pre-save middleware)
    // Note: plainPassword is automatically updated by pre-save middleware
    user.password = newPassword;
    await user.save();

    // Log password reset event to audit logs
    try {
      await AuditLog.logSystemEvent({
        userId: user._id.toString(),
        action: 'user_password_reset',
        metadata: {
          userEmail: user.email,
          resetMethod: 'token'
        }
      });
    } catch (auditError) {
      logger.error('Failed to log password reset event:', auditError);
    }

    logger.info(`Password reset successful for user: ${user.email}`);
    return successResponse(res, 'Password has been reset successfully');
  } catch (error) {
    logger.error('Error resetting password:', error);
    return internalServerErrorResponse(res, 'Failed to reset password');
  }
};