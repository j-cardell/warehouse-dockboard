/**
 * Auth routes
 * POST /login, GET /status, GET /config
 * POST /change-password (authenticated)
 */

const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const { loginLimiter, generateToken, requireAuth } = require("../middleware");
const {
  JWT_SECRET,
  JWT_EXPIRES_IN,
  AUTH_USER,
  AUTH_PASS,
} = require("../config");
const {
  findUserByUsername,
  findUserByUsernameGlobal,
  findUserById,
  verifyPassword,
  isBootstrapAdmin,
  updateLastLogin,
  updateUser,
  hasUsers,
  createInitialAdmin,
  isPasswordResetRequired,
  clearPasswordReset,
  createUser,
} = require("../users");
const { MULTI_FACILITY_MODE, DEFAULT_FACILITY_ID } = require("../config");
const { getAllFacilities, facilityExists } = require("../facilities");

// POST /api/auth/login - Get JWT token (users.json based)
// Bootstrap: If no users exist, first login with AUTH_USER/AUTH_PASS creates admin
router.post("/login", loginLimiter, async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({
      error: "Username and password required",
      code: "MISSING_CREDENTIALS",
    });
  }

  // Bootstrap mode: No users exist yet
  // Allow first login with AUTH_USER/AUTH_PASS to auto-create admin
  if (!hasUsers()) {
    if (username !== AUTH_USER || password !== AUTH_PASS) {
      return res.status(401).json({
        error: "Invalid credentials",
        code: "INVALID_CREDENTIALS",
      });
    }

    // Auto-create admin user from env credentials
    const result = await createInitialAdmin(AUTH_USER, AUTH_PASS);
    if (!result.success) {
      return res.status(500).json({
        error: "Failed to create initial admin",
        code: "SETUP_FAILED",
      });
    }

    // Now login with the newly created user
    const user = result.user;

    // In multi-facility mode, bootstrap admin has no facility assigned yet
    // Return available facilities for them to choose from
    if (MULTI_FACILITY_MODE) {
      const availableFacilities = getAllFacilities();
      const tempToken = jwt.sign(
        {
          userId: user.id,
          username: user.username,
          role: user.role,
          isBootstrap: true,
        },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN }
      );

      return res.json({
        success: true,
        token: tempToken,
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          isBootstrap: true,
        },
        availableFacilities,
        multiFacilityMode: MULTI_FACILITY_MODE,
        expiresIn: JWT_EXPIRES_IN,
        message: "Initial admin account created. Please select a facility to manage.",
        selectFacilityRequired: availableFacilities.length > 0,
      });
    }

    // Single facility mode - assign to default facility
    const token = jwt.sign(
      {
        userId: user.id,
        username: user.username,
        role: user.role,
        homeFacility: DEFAULT_FACILITY_ID,
        currentFacility: DEFAULT_FACILITY_ID,
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    return res.json({
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        homeFacility: DEFAULT_FACILITY_ID,
        currentFacility: DEFAULT_FACILITY_ID,
        isBootstrap: true,
      },
      availableFacilities: [],
      multiFacilityMode: MULTI_FACILITY_MODE,
      expiresIn: JWT_EXPIRES_IN,
      message: "Initial admin account created",
    });
  }

  // Normal mode: Users exist, check against users.json
  // In multi-facility mode, search across all facilities and global users
  let user;
  let facilityId = DEFAULT_FACILITY_ID;
  let isGlobalUser = false;

  if (MULTI_FACILITY_MODE) {
    // First check global users (bootstrap admins)
    const { findGlobalUserByUsername } = require("../users");
    const globalUser = findGlobalUserByUsername(username);
    if (globalUser) {
      user = globalUser;
      facilityId = null; // Global users have no facility
      isGlobalUser = true;
    } else {
      // Then check facility-specific users
      const result = findUserByUsernameGlobal(username);
      if (result) {
        user = result.user;
        facilityId = result.facilityId;
      }
    }
  } else {
    user = findUserByUsername(username);
  }

  if (!user) {
    // Slow down response to prevent username enumeration
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return res.status(401).json({
      error: "Invalid credentials",
      code: "INVALID_CREDENTIALS",
    });
  }

  // Check if password reset is required FIRST
  // If reset is required, verify temp password before allowing reset
  // Skip for global users (bootstrap admins) who don't have facility-specific settings
  if (facilityId && isPasswordResetRequired(user.id, facilityId)) {
    // Verify the temp password provided by admin
    if (password !== user.tempPassword) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return res.status(401).json({
        error: "Invalid temporary password",
        code: "INVALID_TEMP_PASSWORD",
      });
    }

    // Temp password verified - generate a temporary token for password change
    const tempToken = jwt.sign(
      {
        userId: user.id,
        username: user.username,
        role: user.role,
        homeFacility: user.homeFacility || facilityId,
        currentFacility: facilityId,
        passwordReset: true,
      },
      JWT_SECRET,
      { expiresIn: "10m" }
    );

    return res.json({
      success: true,
      passwordResetRequired: true,
      token: tempToken,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        homeFacility: user.homeFacility || facilityId,
        currentFacility: facilityId,
      },
      message: "Temporary password verified. Please set a new password.",
    });
  }

  // Verify password for normal login (no reset required)
  const validPassword = await verifyPassword(password, user.passwordHash);

  if (!validPassword) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return res.status(401).json({
      error: "Invalid credentials",
      code: "INVALID_CREDENTIALS",
    });
  }

  // Update last login (skip for bootstrap users without facility)
  if (facilityId) {
    updateLastLogin(user.id, facilityId);
  }

  // For bootstrap users in multi-facility mode without a facility assigned,
  // return available facilities to choose from
  if (MULTI_FACILITY_MODE && user.isBootstrap && !user.homeFacility) {
    const availableFacilities = getAllFacilities();
    const tempToken = jwt.sign(
      {
        userId: user.id,
        username: user.username,
        role: user.role,
        isBootstrap: true,
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    // Use first available facility as default for bootstrap user
    const defaultFacility = availableFacilities.length > 0 ? availableFacilities[0].id : null;

    return res.json({
      success: true,
      token: tempToken,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        isBootstrap: true,
        homeFacility: defaultFacility,
        currentFacility: defaultFacility,
      },
      availableFacilities,
      multiFacilityMode: MULTI_FACILITY_MODE,
      expiresIn: JWT_EXPIRES_IN,
      selectFacilityRequired: availableFacilities.length > 0,
    });
  }

  // Determine user's home facility and current facility
  const homeFacility = user.homeFacility || facilityId;
  const currentFacility = facilityId;

  // For admins in multi-facility mode, allow facility switching
  let availableFacilities = null;
  if (MULTI_FACILITY_MODE && user.role === "admin") {
    availableFacilities = getAllFacilities();
  }

  // Determine if user is visiting (current != home)
  const isVisiting = homeFacility && currentFacility && homeFacility !== currentFacility;

  // Generate JWT with user info and facility context
  const token = jwt.sign(
    {
      userId: user.id,
      username: user.username,
      role: user.role,
      homeFacility,
      currentFacility,
      isVisiting,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );

  res.json({
    success: true,
    token,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      homeFacility,
      currentFacility,
      isBootstrap: isBootstrapAdmin(user),
      isVisiting,
    },
    availableFacilities,
    multiFacilityMode: MULTI_FACILITY_MODE,
    expiresIn: JWT_EXPIRES_IN,
  });
});

// GET /api/auth/status - Check current auth status
router.get("/status", (req, res) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    console.log("[Auth Status] No auth header");
    return res.json({ authenticated: false, user: null });
  }

  const token = authHeader.substring(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // Verify user still exists in database (not deleted)
    // First check in facility-specific users, then in global users for bootstrap
    let user = null;
    let facilityId = decoded.currentFacility;

    if (facilityId) {
      user = findUserById(decoded.userId, facilityId);
    }

    // If not found in facility, check global users (bootstrap admin)
    if (!user && MULTI_FACILITY_MODE && decoded.isBootstrap) {
      const { findGlobalUserById } = require("../users");
      user = findGlobalUserById(decoded.userId);
      // Keep facilityId from JWT token - bootstrap user can have currentFacility set
    }

    if (!user) {
      return res.json({
        authenticated: false,
        user: null,
        error: "User not found",
      });
    }

    // For admins in multi-facility mode, get available facilities
    let availableFacilities = null;
    if (MULTI_FACILITY_MODE && user.role === "admin") {
      availableFacilities = getAllFacilities();
    }

    // Get facility names for display
    const { getFacility } = require("../facilities");
    const currentFacilityObj = getFacility(facilityId);
    const homeFacilityObj = getFacility(decoded.homeFacility || user.homeFacility || facilityId);

    return res.json({
      authenticated: true,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        homeFacility: decoded.homeFacility || user.homeFacility || facilityId,
        homeFacilityName: homeFacilityObj?.name || "Unknown Facility",
        currentFacility: facilityId,
        currentFacilityName: currentFacilityObj?.name || "Unknown Facility",
        isBootstrap: decoded.isBootstrap || isBootstrapAdmin(user),
        isVisiting: decoded.isVisiting || false,
      },
      availableFacilities,
      multiFacilityMode: MULTI_FACILITY_MODE,
      selectFacilityRequired: decoded.isBootstrap && !decoded.homeFacility && availableFacilities?.length > 0,
    });
  } catch (err) {
    return res.json({
      authenticated: false,
      user: null,
      error: "Token expired",
    });
  }
});

// GET /api/auth/config - Get auth configuration (public)
router.get("/config", (req, res) => {
  res.json({
    mode: "local",
    multiFacilityMode: MULTI_FACILITY_MODE,
    methods: {
      local: true,
      oidc: false,
    },
  });
});

// POST /api/auth/change-password - Change own password (authenticated)
router.post("/change-password", requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const userId = req.user.userId;
  const facilityId = req.user.currentFacility || req.user.homeFacility || DEFAULT_FACILITY_ID;

  // Bootstrap admin cannot change password via UI - must use environment variables
  if (req.user.isBootstrap) {
    return res.status(403).json({
      error: "Bootstrap admin password must be changed via environment variable (AUTH_PASS)",
      code: "BOOTSTRAP_PASSWORD_CHANGE_FORBIDDEN",
    });
  }

  if (!currentPassword || !newPassword) {
    return res.status(400).json({
      error: "Current password and new password required",
    });
  }

  if (newPassword.length < 8) {
    return res.status(400).json({
      error: "New password must be at least 8 characters",
    });
  }

  const result = await updateUser(userId, { password: newPassword }, facilityId);

  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }

  // Sync password to all other facilities where user exists (by same UUID)
  const { getAllFacilities } = require("../facilities");
  const allFacilities = getAllFacilities();
  for (const fac of allFacilities) {
    if (fac.id === facilityId) continue;
    const facUser = findUserById(userId, fac.id);
    if (facUser) {
      await updateUser(userId, { password: newPassword }, fac.id);
    }
  }

  res.json({ success: true, message: "Password updated successfully" });
});

// POST /api/auth/set-new-password - Set new password after admin reset
// This endpoint accepts the temporary token from login
router.post("/set-new-password", async (req, res) => {
  const { token, newPassword } = req.body;

  if (!token || !newPassword) {
    return res.status(400).json({
      error: "Token and new password required",
    });
  }

  if (newPassword.length < 8) {
    return res.status(400).json({
      error: "New password must be at least 8 characters",
    });
  }

  try {
    // Verify the token
    const decoded = jwt.verify(token, JWT_SECRET);

    // Must be a password reset token
    if (!decoded.passwordReset) {
      return res.status(403).json({
        error: "Invalid token",
        code: "INVALID_TOKEN",
      });
    }

    const userId = decoded.userId;
    const facilityId = decoded.currentFacility || decoded.homeFacility || DEFAULT_FACILITY_ID;

    // Verify user exists and reset is required
    const user = findUserById(userId, facilityId);
    if (!user || !isPasswordResetRequired(userId, facilityId)) {
      return res.status(400).json({
        error: "Password reset not required or user not found",
        code: "RESET_NOT_REQUIRED",
      });
    }

    // Update password at current facility
    const result = await updateUser(userId, { password: newPassword }, facilityId);

    if (!result.success) {
      return res.status(500).json({ error: result.error });
    }

    // Sync password to all other facilities where user exists (by same UUID)
    const { getAllFacilities } = require("../facilities");
    const allFacilities = getAllFacilities();
    for (const fac of allFacilities) {
      if (fac.id === facilityId) continue;
      const facUser = findUserById(userId, fac.id);
      if (facUser) {
        await updateUser(userId, { password: newPassword }, fac.id);
        clearPasswordReset(userId, fac.id);
      }
    }

    // Clear the password reset requirement at current facility
    clearPasswordReset(userId, facilityId);

    // Now generate a full session token
    const sessionToken = jwt.sign(
      {
        userId: user.id,
        username: user.username,
        role: user.role,
        homeFacility: user.homeFacility || facilityId,
        currentFacility: facilityId,
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    res.json({
      success: true,
      token: sessionToken,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        homeFacility: user.homeFacility || facilityId,
        currentFacility: facilityId,
      },
      message: "Password updated successfully. You are now logged in.",
    });
  } catch (err) {
    return res.status(401).json({
      error: "Invalid or expired token",
      code: "TOKEN_INVALID",
    });
  }
});

// POST /api/auth/switch-facility - Switch to a different facility (admin only)
router.post("/switch-facility", requireAuth, async (req, res) => {
  if (!MULTI_FACILITY_MODE) {
    return res.status(403).json({
      error: "Multi-facility mode is not enabled",
      code: "NOT_MULTI_FACILITY",
    });
  }

  const { facilityId, createIfNotExists } = req.body;
  const userId = req.user.userId;
  const currentRole = req.user.role;
  const homeFacility = req.user.homeFacility;

  // Only admins can switch facilities
  if (currentRole !== "admin" && currentRole !== "bootstrap") {
    return res.status(403).json({
      error: "Only admins can switch facilities",
      code: "FORBIDDEN",
    });
  }

  // Verify facility exists
  if (!facilityExists(facilityId)) {
    return res.status(404).json({
      error: "Facility not found",
      code: "FACILITY_NOT_FOUND",
    });
  }

  // Check if this is the bootstrap admin (defined by AUTH_USER)
  const isBootstrap = req.user.username.toLowerCase() === AUTH_USER.toLowerCase();

  // For non-bootstrap users, check if they exist in the target facility
  let user;
  if (!isBootstrap) {
    // First try to find by ID (in case user was originally created here)
    user = findUserById(userId, facilityId);

    // If not found by ID, try to find by username (user may have been copied from another facility)
    if (!user) {
      const { findUserByUsername } = require("../users");
      user = findUserByUsername(req.user.username, facilityId);
    }

    // User doesn't exist in target facility
    if (!user) {
      // If createIfNotExists flag is set, copy the user over
      if (createIfNotExists) {
        const { createUser } = require("../users");
        // Generate a random password for the copied user
        // They'll need to use password reset or admin can set it
        const tempPassword = require('crypto').randomBytes(16).toString('hex');

        const result = await createUser({
          id: userId, // Preserve original UUID
          username: req.user.username,
          password: tempPassword,
          role: "admin",
          homeFacility: homeFacility,
        }, facilityId);

        if (!result.success) {
          return res.status(500).json({
            error: `Failed to create user in facility: ${result.error}`,
            code: "USER_CREATE_FAILED",
          });
        }

        user = result.user;
      } else {
        // Return info so frontend can ask user if they want to copy themselves
        return res.status(404).json({
          error: "User does not exist in this facility",
          code: "USER_NOT_IN_FACILITY",
          canCreate: true,
          homeFacility: homeFacility,
          targetFacility: facilityId,
        });
      }
    }
  }

  // Use found user or bootstrap user info from token
  const userInfo = user || req.user;

  // Get the actual user ID from either user.id (from DB) or user.userId (from JWT token)
  const resolvedUserId = userInfo.id || userInfo.userId;

  // Determine if user is outside their home facility
  const isVisiting = homeFacility && homeFacility !== facilityId;

  // Generate new JWT with updated current facility
  const token = jwt.sign(
    {
      userId: resolvedUserId,
      username: userInfo.username,
      role: userInfo.role,
      homeFacility: userInfo.homeFacility || facilityId,
      currentFacility: facilityId,
      isBootstrap: isBootstrap || isBootstrapAdmin(userInfo),
      isVisiting: isVisiting, // Flag indicating user is outside their home facility
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );

  // Get available facilities for admins
  const availableFacilities = getAllFacilities();

  res.json({
    success: true,
    token,
    user: {
      id: resolvedUserId,
      username: userInfo.username,
      role: userInfo.role,
      homeFacility: userInfo.homeFacility || facilityId,
      currentFacility: facilityId,
      isBootstrap: isBootstrap || isBootstrapAdmin(userInfo),
      isVisiting: isVisiting,
    },
    availableFacilities,
    multiFacilityMode: MULTI_FACILITY_MODE,
  });
});

// POST /api/auth/set-home-facility - Set user's home facility (any authenticated user)
router.post("/set-home-facility", requireAuth, async (req, res) => {
  if (!MULTI_FACILITY_MODE) {
    return res.status(403).json({
      error: "Multi-facility mode is not enabled",
      code: "NOT_MULTI_FACILITY",
    });
  }

  const { facilityId } = req.body;
  const userId = req.user.userId;
  const currentFacility = req.user.currentFacility;

  if (!facilityId) {
    return res.status(400).json({
      error: "Facility ID is required",
      code: "MISSING_FACILITY_ID",
    });
  }

  // Verify facility exists
  if (!facilityExists(facilityId)) {
    return res.status(404).json({
      error: "Facility not found",
      code: "FACILITY_NOT_FOUND",
    });
  }

  // Get user's current facility from token
  const facilityIdFromToken = currentFacility || DEFAULT_FACILITY_ID;

  // Update user's home facility
  const result = await updateUser(userId, { homeFacility: facilityId }, facilityIdFromToken);

  if (!result.success) {
    return res.status(400).json({
      error: result.error,
      code: "UPDATE_FAILED",
    });
  }

  // Determine if user is now visiting or at home
  const isVisiting = facilityId !== currentFacility;

  // Generate new JWT with updated home facility
  const token = jwt.sign(
    {
      userId: result.user.id,
      username: result.user.username,
      role: result.user.role,
      homeFacility: facilityId,
      currentFacility: currentFacility,
      isBootstrap: isBootstrapAdmin(result.user),
      isVisiting: isVisiting,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );

  res.json({
    success: true,
    token,
    user: {
      id: result.user.id,
      username: result.user.username,
      role: result.user.role,
      homeFacility: facilityId,
      currentFacility: currentFacility,
      isBootstrap: isBootstrapAdmin(result.user),
      isVisiting: isVisiting,
    },
    message: `Home facility set to ${facilityId}`,
  });
});

module.exports = router;
