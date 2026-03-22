/**
 * User Settings routes
 * GET /user/settings, POST /user/settings
 *
 * Stores per-user settings (display preferences, etc.)
 */

const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware");
const { getUserSettings, updateUserSettings } = require("../users");

// GET /api/user/settings - Get current user's settings
router.get("/settings", requireAuth, (req, res) => {
  const userId = req.user.userId;
  const facilityId = req.user.currentFacility || req.user.homeFacility;
  const settings = getUserSettings(userId, facilityId);

  res.json({
    success: true,
    settings: settings || {},
  });
});

// POST /api/user/settings - Update current user's settings
router.post("/settings", requireAuth, (req, res) => {
  const userId = req.user.userId;
  const facilityId = req.user.currentFacility || req.user.homeFacility;
  const settings = req.body;

  const result = updateUserSettings(userId, settings, facilityId);

  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }

  res.json({
    success: true,
    settings: result.settings,
  });
});

module.exports = router;
