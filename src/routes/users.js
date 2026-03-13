/**
 * User management routes
 * CRUD operations for users (admin only, except self password change)
 */

const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware");
const {
  getAllUsers,
  createUser,
  updateUser,
  deleteUser,
  findUserById,
  requirePasswordReset,
  findUserByUsername,
  isBootstrapAdmin,
  findGlobalUserByUsername,
} = require("../users");

/**
 * Middleware to require admin role
 */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({
      error: "Admin access required",
      code: "ADMIN_REQUIRED",
    });
  }
  next();
}

/**
 * Middleware to require admin or self (for own account)
 */
function requireAdminOrSelf(req, res, next) {
  const targetUserId = req.params.id;
  if (req.user.role !== "admin" && req.user.userId !== targetUserId) {
    return res.status(403).json({
      error: "Can only modify own account",
      code: "FORBIDDEN",
    });
  }
  next();
}

// GET /api/users - List all users (admin only)
router.get("/", requireAuth, requireAdmin, (req, res) => {
  const facilityId = req.user?.currentFacility || req.user?.homeFacility;
  const users = getAllUsers(facilityId);
  res.json({ users });
});

// POST /api/users - Create new user (admin only)
router.post("/", requireAuth, requireAdmin, async (req, res) => {
  const { username, password, role } = req.body;
  const facilityId = req.user?.currentFacility || req.user?.homeFacility;

  if (!username || !password) {
    return res.status(400).json({
      error: "Username and password required",
    });
  }

  const result = await createUser({ username, password, role }, facilityId);

  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }

  res.status(201).json(result.user);
});

// PUT /api/users/:id - Update user (admin or self)
router.put("/:id", requireAuth, requireAdminOrSelf, async (req, res) => {
  const userId = req.params.id;
  const facilityId = req.user?.currentFacility || req.user?.homeFacility;
  const { role, password, active } = req.body;

  // Non-admins can't change role or active status
  if (req.user.role !== "admin") {
    if (role !== undefined || active !== undefined) {
      return res.status(403).json({
        error: "Only admins can change role or active status",
      });
    }
  }

  // Can't deactivate yourself if you're the last admin
  if (active === false && req.user.userId === userId) {
    return res.status(400).json({
      error: "Cannot deactivate your own account",
    });
  }

  const result = await updateUser(userId, { role, password, active }, facilityId);

  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }

  res.json(result.user);
});

// DELETE /api/users/:id - Deactivate user (admin only)
router.delete("/:id", requireAuth, requireAdmin, (req, res) => {
  const userId = req.params.id;
  const facilityId = req.user?.currentFacility || req.user?.homeFacility;

  // Can't delete yourself
  if (req.user.userId === userId) {
    return res.status(400).json({
      error: "Cannot delete your own account",
    });
  }

  const result = deleteUser(userId, facilityId);

  if (!result.success) {
    return res.status(404).json({ error: result.error });
  }

  res.json({ success: true, message: "User deactivated" });
});

// POST /api/users/:id/reset-password - Admin-initiated password reset (admin only)
router.post("/:id/reset-password", requireAuth, requireAdmin, async (req, res) => {
  const targetUserId = req.params.id;
  const facilityId = req.user?.currentFacility || req.user?.homeFacility;
  const requestingUser = req.user;

  // Find the target user
  const targetUser = findUserById(targetUserId, facilityId);
  if (!targetUser) {
    return res.status(404).json({ error: "User not found" });
  }

  // Check if target is an admin
  if (targetUser.role === "admin") {
    // Only bootstrap admin can reset other admin passwords
    const bootstrapUser = findGlobalUserByUsername(requestingUser.username);
    if (!isBootstrapAdmin(bootstrapUser)) {
      return res.status(403).json({
        error: "Only the bootstrap admin can reset other admin passwords",
        code: "FORBIDDEN",
      });
    }
  }

  // Can't reset bootstrap admin password via UI (must change via env/export)
  if (isBootstrapAdmin(targetUser)) {
    return res.status(403).json({
      error: "Bootstrap admin password must be changed via environment variable (AUTH_USER/AUTH_PASS)",
      code: "FORBIDDEN",
    });
  }

  // Can't reset your own password this way (use change-password instead)
  if (requestingUser.userId === targetUserId) {
    return res.status(400).json({
      error: "Use the change password feature to reset your own password",
    });
  }

  // Can't reset the bootstrap admin's password from UI (must be done via env)
  if (isBootstrapAdmin(targetUser)) {
    return res.status(403).json({
      error: "Bootstrap admin password must be changed via environment variable",
      code: "FORBIDDEN",
    });
  }

  const result = requirePasswordReset(targetUserId, facilityId);

  if (!result.success) {
    return res.status(500).json({ error: result.error });
  }

  // Sync password reset requirement to all other facilities where user exists
  const { getAllFacilities } = require("../facilities");
  const { findUserById, saveUsers, loadUsers } = require("../users");
  const allFacilities = getAllFacilities();
  for (const fac of allFacilities) {
    if (fac.id === facilityId) continue;
    const facUser = findUserById(targetUserId, fac.id);
    if (facUser) {
      const usersData = loadUsers(fac.id);
      const userIndex = usersData.users.findIndex((u) => u.id === targetUserId);
      if (userIndex !== -1) {
        usersData.users[userIndex].passwordResetRequired = true;
        usersData.users[userIndex].tempPassword = result.tempPassword;
        usersData.users[userIndex].passwordResetRequiredAt = new Date().toISOString();
        saveUsers(usersData, fac.id);
      }
    }
  }

  res.json({
    success: true,
    tempPassword: result.tempPassword,
    message: `Password reset required for ${targetUser.username}. Temporary password: ${result.tempPassword}`,
  });
});

module.exports = router;
