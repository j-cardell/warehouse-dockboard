/**
 * State routes
 * GET /state, GET /health
 */

const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware");
const { loadState, loadHistory } = require("../state");

// Get current state (protected)
router.get("/", requireAuth, (req, res) => {
  const facilityId = req.user.currentFacility || req.user.homeFacility;
  const state = loadState(facilityId);
  res.json(state);
});

// Health check (public)
router.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

module.exports = router;
