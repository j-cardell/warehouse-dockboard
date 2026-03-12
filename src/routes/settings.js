/**
 * Settings routes
 * GET /settings, POST /settings
 */

const express = require("express");
const router = express.Router();
const { requireAuth, requireRole } = require("../middleware");
const { DEFAULT_FACILITY_ID } = require("../config");
const { loadSettings, saveSettings } = require("../state");

// Get global settings (public - needed for rendering)
// In multi-facility mode, this returns settings for the default facility
// or the facility specified by the facilityId query parameter
router.get("/", (req, res) => {
  const facilityId = req.query.facilityId || DEFAULT_FACILITY_ID;
  const settings = loadSettings(facilityId);
  res.json(settings);
});

// Update global settings (protected)
router.post("/", requireAuth, requireRole("user"), (req, res) => {
  const facilityId = req.user.currentFacility || req.user.homeFacility || DEFAULT_FACILITY_ID;
  const currentSettings = loadSettings(facilityId);
  const newSettings = { ...currentSettings, ...req.body };
  saveSettings(newSettings, facilityId);
  res.json({ success: true, settings: newSettings });
});

module.exports = router;
