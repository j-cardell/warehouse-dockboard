/**
 * User management module
 *
 * Handles user CRUD operations with bcrypt password hashing.
 * Users are stored in data/users.json.
 *
 * Roles:
 * - admin: Full access (user management, facility reset, all operations)
 * - user: Can manage trailers, edit mode, no destructive operations
 * - viewer: Read-only access
 */

const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");
const {
  USERS_FILE,
  DATA_DIR,
  AUTH_USER,
  MULTI_FACILITY_MODE,
  DEFAULT_FACILITY_ID,
  getFacilityUsersFile,
  FACILITIES_DIR,
  FACILITIES_FILE,
} = require("./config");

const SALT_ROUNDS = 10;

// Default empty users file structure
const DEFAULT_USERS = {
  users: [],
  version: 1,
};

/**
 * Load users from JSON file for a specific facility
 * Creates default structure if file doesn't exist
 */
function loadUsers(facilityId = DEFAULT_FACILITY_ID) {
  const usersFile = MULTI_FACILITY_MODE
    ? getFacilityUsersFile(facilityId)
    : USERS_FILE;

  try {
    if (!fs.existsSync(usersFile)) {
      return { ...DEFAULT_USERS };
    }
    const data = fs.readFileSync(usersFile, "utf8");
    return JSON.parse(data);
  } catch (error) {
    console.error(`[Users] Error loading users for facility ${facilityId}:`, error.message);
    return { ...DEFAULT_USERS };
  }
}

/**
 * Save users to JSON file for a specific facility
 */
function saveUsers(usersData, facilityId = DEFAULT_FACILITY_ID) {
  const usersFile = MULTI_FACILITY_MODE
    ? getFacilityUsersFile(facilityId)
    : USERS_FILE;

  try {
    if (MULTI_FACILITY_MODE) {
      const dir = path.dirname(usersFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    } else if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(usersFile, JSON.stringify(usersData, null, 2));
    return true;
  } catch (error) {
    console.error(`[Users] Error saving users for facility ${facilityId}:`, error.message);
    return false;
  }
}

/**
 * Load global bootstrap users from data/users.json
 * Used in multi-facility mode for bootstrap admins
 */
function loadGlobalUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) {
      return { ...DEFAULT_USERS };
    }
    const data = fs.readFileSync(USERS_FILE, "utf8");
    return JSON.parse(data);
  } catch (error) {
    console.error("[Users] Error loading global users:", error.message);
    return { ...DEFAULT_USERS };
  }
}

/**
 * Save global bootstrap users to data/users.json
 */
function saveGlobalUsers(usersData) {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(USERS_FILE, JSON.stringify(usersData, null, 2));
    return true;
  } catch (error) {
    console.error("[Users] Error saving global users:", error.message);
    return false;
  }
}

/**
 * Find bootstrap user by username (case-insensitive)
 */
function findGlobalUserByUsername(username) {
  const usersData = loadGlobalUsers();
  return usersData.users.find(
    (u) => u.username.toLowerCase() === username.toLowerCase() && u.active !== false
  );
}

/**
 * Find bootstrap user by ID
 */
function findGlobalUserById(userId) {
  const usersData = loadGlobalUsers();
  return usersData.users.find((u) => u.id === userId && u.active !== false);
}

/**
 * Load bootstrap/global users from data/users.json
 * These are admin users that can manage any facility
 */
function loadBootstrapUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) {
      return { ...DEFAULT_USERS };
    }
    const data = fs.readFileSync(USERS_FILE, "utf8");
    return JSON.parse(data);
  } catch (error) {
    console.error("[Users] Error loading bootstrap users:", error.message);
    return { ...DEFAULT_USERS };
  }
}

/**
 * Save bootstrap/global users to data/users.json
 */
function saveBootstrapUsers(usersData) {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(USERS_FILE, JSON.stringify(usersData, null, 2));
    return true;
  } catch (error) {
    console.error("[Users] Error saving bootstrap users:", error.message);
    return false;
  }
}

/**
 * Find user by username across all facilities (for login)
 * Returns { user, facilityId } or null
 */
function findUserByUsernameGlobal(username) {
  if (!MULTI_FACILITY_MODE) {
    const user = findUserByUsername(username);
    return user ? { user, facilityId: DEFAULT_FACILITY_ID } : null;
  }

  // Multi-facility: search all facilities
  try {
    if (!fs.existsSync(FACILITIES_DIR)) {
      return null;
    }
    const facilities = fs.readdirSync(FACILITIES_DIR);
    for (const facilityId of facilities) {
      const facilityPath = path.join(FACILITIES_DIR, facilityId);
      if (!fs.statSync(facilityPath).isDirectory()) continue;

      const usersFile = path.join(facilityPath, "users.json");
      if (!fs.existsSync(usersFile)) continue;

      try {
        const data = fs.readFileSync(usersFile, "utf8");
        const usersData = JSON.parse(data);
        const user = usersData.users.find(
          (u) => u.username.toLowerCase() === username.toLowerCase() && u.active !== false
        );
        if (user) {
          return { user, facilityId };
        }
      } catch (e) {
        continue;
      }
    }
    return null;
  } catch (error) {
    console.error("[Users] Error searching for user globally:", error.message);
    return null;
  }
}

/**
 * Hash a password using bcrypt
 */
async function hashPassword(password) {
  return bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Verify a password against a hash
 */
async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

/**
 * Find user by username (case-insensitive) in a specific facility
 */
function findUserByUsername(username, facilityId = DEFAULT_FACILITY_ID) {
  const usersData = loadUsers(facilityId);
  return usersData.users.find(
    (u) => u.username.toLowerCase() === username.toLowerCase() && u.active !== false
  );
}

/**
 * Find user by ID in a specific facility
 */
function findUserById(userId, facilityId = DEFAULT_FACILITY_ID) {
  const usersData = loadUsers(facilityId);
  return usersData.users.find((u) => u.id === userId && u.active !== false);
}

/**
 * Create a new user in a specific facility
 * Returns { success: boolean, user?: object, error?: string }
 */
async function createUser({ id, username, password, role = "viewer", homeFacility }, facilityId = DEFAULT_FACILITY_ID) {
  // facilityId is where the user is being created (the target facility)
  // homeFacility is the user's home facility (stored on user record)
  // id is optional - if provided (e.g., copying user from another facility), use it; otherwise generate new UUID
  const targetFacility = facilityId;
  const usersData = loadUsers(targetFacility);

  // Validate username
  if (!username || username.length < 3) {
    return { success: false, error: "Username must be at least 3 characters" };
  }

  // Check for existing username (within target facility only)
  if (usersData.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
    return { success: false, error: "Username already exists in this facility" };
  }

  // Validate password/PIN
  let passwordHash = null;
  if (role === "loader") {
    // Loaders don't use passwords - they select their name on tablet
    // Generate a random hash that can't be used for login
    passwordHash = "LOADER_NO_PASSWORD_" + uuidv4();
  } else if (role === "loading-tablet") {
    // Loading-tablet users use a 6-digit PIN
    if (!password || !/^\d{6}$/.test(password)) {
      return { success: false, error: "Loading-tablet requires a 6-digit PIN" };
    }
    // Store PIN in plaintext for tablet (like a device code, not a secure password)
    // Prepend with TABLET_ so we know to compare as PIN not bcrypt
    passwordHash = "TABLET_" + password;
  } else {
    if (!password || password.length < 8) {
      return { success: false, error: "Password must be at least 8 characters" };
    }
    passwordHash = await hashPassword(password);
  }

  // Validate role
  const validRoles = ["admin", "user", "viewer", "loader", "loading-tablet"];
  if (!validRoles.includes(role)) {
    return { success: false, error: "Invalid role" };
  }

  const newUser = {
    id: id || uuidv4(),
    username,
    passwordHash,
    role,
    homeFacility: homeFacility || facilityId, // Use passed homeFacility or default to target
    authType: "local",
    active: true,
    createdAt: new Date().toISOString(),
    lastLogin: null,
  };

  usersData.users.push(newUser);

  if (!saveUsers(usersData, targetFacility)) {
    return { success: false, error: "Failed to save user" };
  }

  // Return user without password hash
  const { passwordHash: _, ...userWithoutPassword } = newUser;
  return { success: true, user: userWithoutPassword };
}

/**
 * Update a user
 * Returns { success: boolean, user?: object, error?: string }
 */
async function updateUser(userId, updates, facilityId = DEFAULT_FACILITY_ID) {
  const usersData = loadUsers(facilityId);
  const userIndex = usersData.users.findIndex((u) => u.id === userId);

  if (userIndex === -1) {
    return { success: false, error: "User not found" };
  }

  const user = usersData.users[userIndex];

  // Update allowed fields
  if (updates.role !== undefined) {
    const validRoles = ["admin", "user", "viewer", "loader", "loading-tablet"];
    if (!validRoles.includes(updates.role)) {
      return { success: false, error: "Invalid role" };
    }
    user.role = updates.role;
  }

  if (updates.active !== undefined) {
    user.active = updates.active;
  }

  if (updates.password) {
    if (user.role === "loading-tablet") {
      // Loading-tablet uses 6-digit PIN
      if (!/^\d{6}$/.test(updates.password)) {
        return { success: false, error: "PIN must be 6 digits" };
      }
      user.passwordHash = "TABLET_" + updates.password;
    } else {
      if (updates.password.length < 8) {
        return { success: false, error: "Password must be at least 8 characters" };
      }
      user.passwordHash = await hashPassword(updates.password);
    }
  }

  if (updates.homeFacility !== undefined) {
    user.homeFacility = updates.homeFacility;
  }

  user.updatedAt = new Date().toISOString();

  if (!saveUsers(usersData, facilityId)) {
    return { success: false, error: "Failed to save user" };
  }

  const { passwordHash: _, ...userWithoutPassword } = user;
  return { success: true, user: userWithoutPassword };
}

/**
 * Update a global user (bootstrap admin)
 * Returns { success: boolean, user?: object, error?: string }
 */
async function updateGlobalUser(userId, updates) {
  const usersData = loadGlobalUsers();
  const userIndex = usersData.users.findIndex((u) => u.id === userId);

  if (userIndex === -1) {
    return { success: false, error: "User not found" };
  }

  const user = usersData.users[userIndex];

  // Update allowed fields
  if (updates.role !== undefined) {
    const validRoles = ["admin", "user", "viewer", "loader", "loading-tablet"];
    if (!validRoles.includes(updates.role)) {
      return { success: false, error: "Invalid role" };
    }
    user.role = updates.role;
  }

  if (updates.active !== undefined) {
    user.active = updates.active;
  }

  if (updates.password) {
    if (user.role === "loading-tablet") {
      // Loading-tablet uses 6-digit PIN
      if (!/^\d{6}$/.test(updates.password)) {
        return { success: false, error: "PIN must be 6 digits" };
      }
      user.passwordHash = "TABLET_" + updates.password;
    } else {
      if (updates.password.length < 8) {
        return { success: false, error: "Password must be at least 8 characters" };
      }
      user.passwordHash = await hashPassword(updates.password);
    }
  }

  user.updatedAt = new Date().toISOString();

  if (!saveGlobalUsers(usersData)) {
    return { success: false, error: "Failed to save user" };
  }

  // Return user without password hash
  const { passwordHash: _, ...userWithoutPassword } = user;
  return { success: true, user: userWithoutPassword };
}

/**
 * Update a global bootstrap user
 * Returns { success: boolean, user?: object, error?: string }
 */
async function updateGlobalUser(userId, updates) {
  const usersData = loadGlobalUsers();
  const userIndex = usersData.users.findIndex((u) => u.id === userId);

  if (userIndex === -1) {
    return { success: false, error: "User not found" };
  }

  const user = usersData.users[userIndex];

  // Update allowed fields
  if (updates.role !== undefined) {
    const validRoles = ["admin", "user", "viewer", "loader"];
    if (!validRoles.includes(updates.role)) {
      return { success: false, error: "Invalid role" };
    }
    user.role = updates.role;
  }

  if (updates.active !== undefined) {
    user.active = updates.active;
  }

  if (updates.password) {
    if (updates.password.length < 8) {
      return { success: false, error: "Password must be at least 8 characters" };
    }
    user.passwordHash = await hashPassword(updates.password);
  }

  if (updates.email !== undefined) {
    user.email = updates.email;
  }

  user.updatedAt = new Date().toISOString();

  if (!saveGlobalUsers(usersData)) {
    return { success: false, error: "Failed to save user" };
  }

  const { passwordHash: _, ...userWithoutPassword } = user;
  return { success: true, user: userWithoutPassword };
}

/**
 * Update a global bootstrap user (in data/users.json, not facility-specific)
 * Returns { success: boolean, user?: object, error?: string }
 */
async function updateGlobalUser(userId, updates) {
  const usersData = loadGlobalUsers();
  const userIndex = usersData.users.findIndex((u) => u.id === userId);

  if (userIndex === -1) {
    return { success: false, error: "User not found" };
  }

  const user = usersData.users[userIndex];

  // Update allowed fields
  if (updates.role !== undefined) {
    const validRoles = ["admin", "user", "viewer", "loader"];
    if (!validRoles.includes(updates.role)) {
      return { success: false, error: "Invalid role" };
    }
    user.role = updates.role;
  }

  if (updates.active !== undefined) {
    user.active = updates.active;
  }

  if (updates.password) {
    if (updates.password.length < 8) {
      return { success: false, error: "Password must be at least 8 characters" };
    }
    user.passwordHash = await hashPassword(updates.password);
  }

  if (updates.email !== undefined) {
    user.email = updates.email;
  }

  user.updatedAt = new Date().toISOString();

  if (!saveGlobalUsers(usersData)) {
    return { success: false, error: "Failed to save user" };
  }

  const { passwordHash: _, ...userWithoutPassword } = user;
  return { success: true, user: userWithoutPassword };
}

/**
 * Delete (deactivate) a user
 */
function deleteUser(userId, facilityId = DEFAULT_FACILITY_ID) {
  const usersData = loadUsers(facilityId);
  const userIndex = usersData.users.findIndex((u) => u.id === userId);

  if (userIndex === -1) {
    return { success: false, error: "User not found" };
  }

  // Hard delete - remove from array
  usersData.users.splice(userIndex, 1);

  if (!saveUsers(usersData, facilityId)) {
    return { success: false, error: "Failed to save user" };
  }

  return { success: true };
}

/**
 * Update last login timestamp
 */
function updateLastLogin(userId, facilityId = DEFAULT_FACILITY_ID) {
  const usersData = loadUsers(facilityId);
  const user = usersData.users.find((u) => u.id === userId);

  if (user) {
    user.lastLogin = new Date().toISOString();
    saveUsers(usersData, facilityId);
  }
}

/**
 * Get all users (without password hashes) for a specific facility
 */
function getAllUsers(facilityId = DEFAULT_FACILITY_ID) {
  const usersData = loadUsers(facilityId);
  return usersData.users
    .filter((u) => u.active !== false) // Filter out soft-deleted users
    .map(({ passwordHash, ...user }) => ({
      ...user,
      isBootstrap: user.username.toLowerCase() === AUTH_USER.toLowerCase(),
    }));
}

/**
 * Check if any users exist
 * In multi-facility mode, checks global bootstrap users first, then facility-specific
 */
function hasUsers(facilityId = DEFAULT_FACILITY_ID) {
  // In multi-facility mode, check global bootstrap users first
  if (MULTI_FACILITY_MODE) {
    const globalUsers = loadGlobalUsers();
    if (globalUsers.users.some((u) => u.active !== false)) {
      return true;
    }
  }

  // Fall back to facility-specific users
  const usersData = loadUsers(facilityId);
  return usersData.users.some((u) => u.active !== false);
}

/**
 * Check if any admin users exist in a specific facility
 */
function hasAdminUser(facilityId = DEFAULT_FACILITY_ID) {
  const usersData = loadUsers(facilityId);
  return usersData.users.some((u) => u.role === "admin" && u.active !== false);
}

/**
 * Create initial admin user from environment variables
 * This is called during setup if no users exist
 */
async function createInitialAdmin(username, password, facilityId = DEFAULT_FACILITY_ID) {
  if (hasUsers(facilityId)) {
    return { success: false, error: "Users already exist" };
  }

  // In multi-facility mode, create bootstrap admin as global user
  if (MULTI_FACILITY_MODE) {
    const globalUsers = loadGlobalUsers();
    if (globalUsers.users.some((u) => u.active !== false)) {
      return { success: false, error: "Bootstrap user already exists" };
    }

    const passwordHash = await hashPassword(password);
    const newUser = {
      id: uuidv4(),
      username,
      passwordHash,
      email: null,
      role: "admin",
      authType: "local",
      active: true,
      createdAt: new Date().toISOString(),
      lastLogin: null,
      isBootstrap: true,
    };

    globalUsers.users.push(newUser);
    if (!saveGlobalUsers(globalUsers)) {
      return { success: false, error: "Failed to save bootstrap user" };
    }

    return { success: true, user: { ...newUser, isBootstrap: true } };
  }

  // Single facility mode - create in facility
  return createUser({
    username,
    password,
    email: null,
    role: "admin",
  }, facilityId);
}

/**
 * Deep merge two objects
 * Recursively merges nested objects instead of overwriting them
 */
function deepMerge(target, source) {
  const result = { ...target };
  for (const key in source) {
    if (source.hasOwnProperty(key)) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        result[key] = deepMerge(target[key] || {}, source[key]);
      } else {
        result[key] = source[key];
      }
    }
  }
  return result;
}

/**
 * Deep merge two objects
 * Recursively merges nested objects instead of replacing them
 */
function deepMerge(target, source) {
  const result = { ...target };
  for (const key in source) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

/**
 * Get user settings
 * Returns user-specific settings or null if not set
 */
function getUserSettings(userId, facilityId = DEFAULT_FACILITY_ID) {
  const usersData = loadUsers(facilityId);
  const user = usersData.users.find((u) => u.id === userId);
  return user?.settings || null;
}

/**
 * Update user settings
 * Merges new settings with existing settings
 */
function updateUserSettings(userId, settings, facilityId = DEFAULT_FACILITY_ID) {
  const usersData = loadUsers(facilityId);
  const userIndex = usersData.users.findIndex((u) => u.id === userId);

  if (userIndex === -1) {
    return { success: false, error: "User not found" };
  }

  const user = usersData.users[userIndex];
  // Deep merge for nested objects like sidebarLayout
  user.settings = deepMerge(user.settings || {}, settings);
  user.updatedAt = new Date().toISOString();

  if (!saveUsers(usersData, facilityId)) {
    return { success: false, error: "Failed to save settings" };
  }

  return { success: true, settings: user.settings };
}

/**
 * Generate a temporary password for reset
 * Format: 3 letters + 3 numbers (easy to jot down)
 */
function generateTempPassword() {
  const letters = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // Excludes I, L, O to avoid confusion
  const numbers = '23456789'; // Excludes 0, 1 to avoid confusion
  let result = '';
  for (let i = 0; i < 3; i++) {
    result += letters[Math.floor(Math.random() * letters.length)];
  }
  for (let i = 0; i < 3; i++) {
    result += numbers[Math.floor(Math.random() * numbers.length)];
  }
  return result;
}

/**
 * Require password reset for a user
 * Sets the passwordResetRequired flag with temporary password
 */
function requirePasswordReset(userId, facilityId = DEFAULT_FACILITY_ID) {
  const usersData = loadUsers(facilityId);
  const user = usersData.users.find((u) => u.id === userId);

  if (!user) {
    return { success: false, error: "User not found" };
  }

  const tempPassword = generateTempPassword();

  user.passwordResetRequired = true;
  user.tempPassword = tempPassword; // Store temp password (plaintext, short-lived)
  user.passwordResetRequiredAt = new Date().toISOString();
  user.updatedAt = new Date().toISOString();

  if (!saveUsers(usersData, facilityId)) {
    return { success: false, error: "Failed to save user" };
  }

  return { success: true, tempPassword };
}

/**
 * Check if password reset is required (expires after 5 minutes)
 */
function isPasswordResetRequired(userId, facilityId = DEFAULT_FACILITY_ID) {
  const user = findUserById(userId, facilityId);
  if (!user?.passwordResetRequired) return false;

  // Check if reset has expired (5 minutes)
  const resetAt = user.passwordResetRequiredAt;
  if (resetAt) {
    const expiresAt = new Date(resetAt).getTime() + 5 * 60 * 1000;
    if (Date.now() > expiresAt) {
      // Auto-clear expired reset
      clearPasswordReset(userId, facilityId);
      return false;
    }
  }

  return true;
}

/**
 * Check if a user is the bootstrap admin (defined by AUTH_USER env var)
 */
function isBootstrapAdmin(user) {
  if (!user) return false;
  return user.username.toLowerCase() === AUTH_USER.toLowerCase();
}

/**
 * Clear password reset requirement and set new password
 */
function clearPasswordReset(userId, facilityId = DEFAULT_FACILITY_ID) {
  const usersData = loadUsers(facilityId);
  const userIndex = usersData.users.findIndex((u) => u.id === userId);

  if (userIndex === -1) {
    return { success: false, error: "User not found" };
  }

  const user = usersData.users[userIndex];
  delete user.passwordResetRequired;
  delete user.tempPassword; // Clear the temporary password
  delete user.passwordResetRequiredAt;
  user.updatedAt = new Date().toISOString();

  if (!saveUsers(usersData, facilityId)) {
    return { success: false, error: "Failed to save user" };
  }

  return { success: true };
}

module.exports = {
  loadUsers,
  saveUsers,
  loadGlobalUsers,
  saveGlobalUsers,
  findGlobalUserByUsername,
  findGlobalUserById,
  updateGlobalUser,
  findUserByUsername,
  findUserByUsernameGlobal,
  findUserById,
  hashPassword,
  verifyPassword,
  createUser,
  updateUser,
  deleteUser,
  updateLastLogin,
  getAllUsers,
  hasUsers,
  hasAdminUser,
  createInitialAdmin,
  getUserSettings,
  updateUserSettings,
  requirePasswordReset,
  isPasswordResetRequired,
  clearPasswordReset,
  isBootstrapAdmin,
};
