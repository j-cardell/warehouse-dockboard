/**
 * Facilities routes
 * POST /api/facilities - Create new facility (bootstrap admin only)
 * GET /api/facilities - List all facilities (admin only)
 * GET /api/facilities/:id - Get facility details (admin only)
 * PUT /api/facilities/:id - Update facility (bootstrap admin only)
 * DELETE /api/facilities/:id - Deactivate facility (bootstrap admin only)
 */

const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware");
const { isBootstrapAdmin, findUserById } = require("../users");
const { DEFAULT_FACILITY_ID } = require("../config");
const {
  createFacility,
  getFacility,
  getAllFacilities,
  updateFacility,
  deleteFacility,
  getFacilityStats,
} = require("../facilities");

/**
 * Middleware to check if user is bootstrap admin
 */
function requireBootstrapAdmin(req, res, next) {
  const userId = req.user.userId;
  const facilityId = req.user.currentFacility || req.user.homeFacility || DEFAULT_FACILITY_ID;

  const user = findUserById(userId, facilityId);
  if (!user || !isBootstrapAdmin(user)) {
    return res.status(403).json({
      error: "Bootstrap admin access required",
      code: "BOOTSTRAP_REQUIRED",
    });
  }
  next();
}

/**
 * Middleware to check if user is admin (any facility)
 */
function requireAdmin(req, res, next) {
  if (req.user.role !== "admin") {
    return res.status(403).json({
      error: "Admin access required",
      code: "ADMIN_REQUIRED",
    });
  }
  next();
}

// POST /api/facilities - Create new facility (bootstrap admin only)
router.post("/", requireAuth, requireBootstrapAdmin, async (req, res) => {
  const { name, description, config, adminUsername, adminPassword } = req.body;

  if (!name) {
    return res.status(400).json({
      error: "Facility name is required",
      code: "MISSING_NAME",
    });
  }

  const result = await createFacility({
    name,
    description,
    config,
    adminUsername,
    adminPassword,
  });

  if (!result.success) {
    return res.status(400).json({
      error: result.error,
      code: "CREATE_FAILED",
    });
  }

  res.status(201).json({
    success: true,
    facility: result.facility,
  });
});

// GET /api/facilities - List all facilities (admin only)
router.get("/", requireAuth, requireAdmin, (req, res) => {
  const facilities = getAllFacilities();

  // Add stats for each facility
  const facilitiesWithStats = facilities.map((f) => ({
    ...f,
    stats: getFacilityStats(f.id),
  }));

  res.json({
    success: true,
    facilities: facilitiesWithStats,
  });
});

// GET /api/facilities/:id - Get facility details (admin only)
router.get("/:id", requireAuth, requireAdmin, (req, res) => {
  const { id } = req.params;
  const facility = getFacility(id);

  if (!facility) {
    return res.status(404).json({
      error: "Facility not found",
      code: "FACILITY_NOT_FOUND",
    });
  }

  const stats = getFacilityStats(id);

  res.json({
    success: true,
    facility: {
      ...facility,
      stats,
    },
  });
});

// PUT /api/facilities/:id - Update facility (bootstrap admin only)
router.put("/:id", requireAuth, requireBootstrapAdmin, (req, res) => {
  const { id } = req.params;
  const { name, description, active } = req.body;

  const result = updateFacility(id, { name, description, active });

  if (!result.success) {
    return res.status(400).json({
      error: result.error,
      code: "UPDATE_FAILED",
    });
  }

  res.json({
    success: true,
    facility: result.facility,
  });
});

// DELETE /api/facilities/:id - Deactivate facility (bootstrap admin only)
router.delete("/:id", requireAuth, requireBootstrapAdmin, (req, res) => {
  const { id } = req.params;

  if (id === DEFAULT_FACILITY_ID) {
    return res.status(400).json({
      error: "Cannot delete the default facility",
      code: "CANNOT_DELETE_DEFAULT",
    });
  }

  const result = deleteFacility(id);

  if (!result.success) {
    return res.status(400).json({
      error: result.error,
      code: "DELETE_FAILED",
    });
  }

  res.json({
    success: true,
    message: "Facility deactivated successfully",
  });
});

module.exports = router;
