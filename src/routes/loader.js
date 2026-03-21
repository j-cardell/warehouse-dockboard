/**
 * Loader tablet routes
 * POST /api/loader/door - Get door info
 * POST /api/loader/status - Update trailer status
 *
 * Simple tablet interface for forklift operators to mark trailers loaded/empty
 */

const express = require("express");
const router = express.Router();
const { requireAuth, requireRole } = require("../middleware");
const { loadState, addHistoryEntry } = require("../state");
const { broadcastStateChange } = require("../sse");
const { getAllUsers } = require("../users");

/**
 * Middleware to require loader, loading-tablet role or admin
 * Admins can act as any loader by providing loaderName in request
 * Loading-tablet users (the device) are allowed, actual operator name comes from selection
 */
function requireLoader(req, res, next) {
  if (!req.user) {
    return res.status(403).json({
      error: "Authentication required",
      code: "AUTH_REQUIRED",
    });
  }

  // Loaders and loading-tablet users can access
  if (req.user.role === "loader" || req.user.role === "loading-tablet") {
    return next();
  }

  // Admins can access and act on behalf of a loader
  if (req.user.role === "admin") {
    return next();
  }

  return res.status(403).json({
    error: "Loader or admin access required",
    code: "LOADER_REQUIRED",
  });
}

// POST /api/loader/door - Get door information by door number
router.post("/door", requireAuth, requireLoader, (req, res) => {
  const { doorNumber } = req.body;
  const facilityId = req.user.currentFacility || req.user.homeFacility;

  if (!doorNumber || isNaN(parseInt(doorNumber))) {
    return res.status(400).json({ error: "Valid door number required" });
  }

  const state = loadState(facilityId);
  const door = state.doors.find(d => d.number === parseInt(doorNumber));

  if (!door) {
    return res.status(404).json({ error: "Door not found" });
  }

  // Get trailer at this door
  const trailer = state.trailers.find(t => t.doorId === door.id);

  res.json({
    door: {
      number: door.number,
      hasTrailer: !!trailer,
    },
    trailer: trailer ? {
      id: trailer.id,
      number: trailer.number,
      carrier: trailer.carrier,
      status: trailer.status, // 'loaded' or 'empty'
      notes: trailer.contents, // Include contents as notes for loader display
    } : null,
  });
});

// POST /api/loader/status - Update trailer status
router.post("/status", requireAuth, requireLoader, (req, res) => {
  const { doorNumber, status, loaderName: selectedLoaderName } = req.body;
  const facilityId = req.user.currentFacility || req.user.homeFacility;
  // Use selected loader name if admin is acting on behalf of loader, otherwise use authenticated user
  const loaderName = selectedLoaderName || req.user.username;

  if (!doorNumber || isNaN(parseInt(doorNumber))) {
    return res.status(400).json({ error: "Valid door number required" });
  }

  if (!status || !['loaded', 'empty'].includes(status)) {
    return res.status(400).json({ error: "Status must be 'loaded' or 'empty'" });
  }

  const state = loadState(facilityId);
  const door = state.doors.find(d => d.number === parseInt(doorNumber));

  if (!door) {
    return res.status(404).json({ error: "Door not found" });
  }

  const trailerIndex = state.trailers.findIndex(t => t.doorId === door.id);

  if (trailerIndex === -1) {
    return res.status(404).json({ error: "No trailer at this door" });
  }

  const trailer = state.trailers[trailerIndex];
  const oldStatus = trailer.status;

  // Update trailer status
  state.trailers[trailerIndex].status = status;
  state.trailers[trailerIndex].updatedAt = new Date().toISOString();

  // Save state
  const { saveState } = require("../state");
  saveState(state, facilityId);

  // Create history entry
  const historyDetails = {
    trailerId: trailer.id,
    trailerNumber: trailer.number,
    carrier: trailer.carrier,
    doorNumber: door.number,
    previousStatus: oldStatus,
    newStatus: status,
    updatedBy: loaderName,
    updatedByRole: 'loader',
  };

  addHistoryEntry(
    `TRAILER_${status.toUpperCase()}`,
    historyDetails,
    { userId: req.user.userId, username: loaderName },
    facilityId
  );

  // Broadcast state change to all connected clients
  broadcastStateChange('trailer', 'update', {
    ...state.trailers[trailerIndex],
    doorNumber: door.number,
  }, facilityId);

  res.json({
    success: true,
    trailer: state.trailers[trailerIndex],
    message: `${loaderName} marked ${trailer.carrier} ${trailer.number} as ${status.toUpperCase()} at Door ${door.number}`,
  });
});

// GET /api/loader/loaders - Get list of loader names (for tablet name selection)
router.get("/loaders", requireAuth, requireLoader, (req, res) => {
  const facilityId = req.user.currentFacility || req.user.homeFacility;

  // Get all users for this facility
  const users = getAllUsers(facilityId);

  // Filter to only loader role users
  const loaders = users
    .filter(u => u.role === 'loader' && u.active !== false)
    .map(u => ({ id: u.id, username: u.username }));

  res.json({ loaders });
});

module.exports = router;
