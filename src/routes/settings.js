/**
 * Settings routes
 * GET /settings, POST /settings
 */

const express = require("express");
const router = express.Router();
const { requireAuth, requireRole } = require("../middleware");
const { DEFAULT_FACILITY_ID } = require("../config");
const { loadSettings, saveSettings } = require("../state");

// Get global settings (requires authentication)
router.get("/", requireAuth, (req, res) => {
  const facilityId = req.user?.currentFacility || req.user?.homeFacility || DEFAULT_FACILITY_ID;
  const settings = loadSettings(facilityId);
  res.json(settings);
});

// Allowed settings keys for whitelist validation
const ALLOWED_SETTINGS_KEYS = ['trailerDisplay', 'sidebarLayout'];

// Update global settings (protected)
router.post("/", requireAuth, requireRole("user"), (req, res) => {
  const facilityId = req.user.currentFacility || req.user.homeFacility || DEFAULT_FACILITY_ID;
  const currentSettings = loadSettings(facilityId);

  // Prototype pollution protection
  if (req.body && (req.body.__proto__ || req.body.constructor)) {
    return res.status(400).json({ error: "Invalid key in request body" });
  }

  // Whitelist validation: only allow known settings keys
  const updates = Object.fromEntries(
    Object.entries(req.body).filter(([key]) => ALLOWED_SETTINGS_KEYS.includes(key))
  );

  const newSettings = { ...currentSettings, ...updates };
  saveSettings(newSettings, facilityId);
  res.json({ success: true, settings: newSettings });
});

module.exports = router;
