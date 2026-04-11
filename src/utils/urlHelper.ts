/**
 * Helper functions for constructing full URLs from relative paths
 */

/**
 * Gets the base URL for the application
 * Uses environment variable or constructs from request
 */
export function getBaseUrl(req?: any): string {
  // Try to get from environment variable first
  if (process.env.BASE_URL) {
    return process.env.BASE_URL.replace(/\/+$/, ''); // Remove trailing slash
  }

  // Fallback to localhost for development
  const port = process.env.PORT || 4001;
  return `http://localhost:${port}`;
}

/**
 * Converts a relative URL to an absolute URL
 * @param relativePath - The relative path (e.g., '/uploads/avatars/file.jpg')
 * @param req - Optional request object to get host information
 * @returns Full absolute URL or null if path is empty
 */
export function toAbsoluteUrl(relativePath: string | null | undefined, req?: any): string | null {
  if (!relativePath) return null;

  // If already absolute, return as is
  if (relativePath.startsWith('http://') || relativePath.startsWith('https://')) {
    return relativePath;
  }

  const baseUrl = getBaseUrl(req);
  // Ensure path starts with /
  const path = relativePath.startsWith('/') ? relativePath : `/${relativePath}`;

  return `${baseUrl}${path}`;
}

/**
 * Converts user object's photoURL to absolute URL
 * @param user - User object with photoURL field
 * @param req - Optional request object
 * @returns User object with absolute photoURL
 */
export function toAbsoluteUserUrl(user: any, req?: any): any {
  if (!user) return user;

  return {
    ...user,
    photoURL: toAbsoluteUrl(user.photoURL, req)
  };
}

/**
 * Converts photoURLs to absolute URLs in nested objects (like populated fields)
 * @param obj - Object that may contain photoURL fields
 * @param req - Optional request object
 * @returns Object with all photoURLs converted to absolute URLs
 */
export function convertPhotoURLsToAbsolute(obj: any, req?: any): any {
  if (!obj) return obj;

  const baseUrl = getBaseUrl(req);

  // Helper function to convert a single photoURL
  const convertURL = (url: string | null | undefined): string | null => {
    if (!url) return null;
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    const path = url.startsWith('/') ? url : `/${url}`;
    return `${baseUrl}${path}`;
  };

  // Serialize through JSON first so all BSON ObjectIds become hex strings,
  // Dates become ISO strings, and Buffers are safely handled. This prevents
  // the spread operator from corrupting ObjectId instances into empty objects.
  const plain: any = JSON.parse(JSON.stringify(obj));

  const walk = (node: any): any => {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(walk);

    const result = { ...node };

    if (result.photoURL) result.photoURL = convertURL(result.photoURL);
    if (result.avatar) result.avatar = convertURL(result.avatar);

    Object.keys(result).forEach(key => {
      if (result[key] && typeof result[key] === 'object') {
        result[key] = walk(result[key]);
      }
    });

    return result;
  };

  return walk(plain);
}
