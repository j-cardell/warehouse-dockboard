/**
 * Setup routes
 * GET /setup/status, POST /setup
 *
 * Handles first-run configuration for creating initial facility setup
 * with doors, yard slots, dumpsters, and ramps. Creates initial state files.
 */

/**
 * Setup routes
 * GET /setup/status, POST /setup
 *
 * Handles first-run configuration for creating initial facility setup
 * with doors, yard slots, dumpsters, and ramps. Creates initial state files.
 */

const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const { requireAuth, requireRole } = require("../middleware");
const { MULTI_FACILITY_MODE, DEFAULT_FACILITY_ID } = require("../config");
const { isSetupNeeded, generateFacilityConfig } = require("../utils");
const {
  DATA_DIR,
  STATE_FILE,
  HISTORY_FILE,
  ANALYTICS_FILE,
  SETTINGS_FILE,
  DEFAULT_SETTINGS,
} = require("../config");
const { loadSettings, saveSettings } = require("../state");
const { hasUsers, hasAdminUser, createInitialAdmin } = require("../users");
const { createFacility } = require("../facilities");

// Check if setup is needed (public - for first-run detection)
router.get("/status", (req, res) => {
  // In multi-facility mode, check if any facilities exist
  let stateSetupNeeded;
  if (MULTI_FACILITY_MODE) {
    const { getAllFacilities } = require("../facilities");
    const facilities = getAllFacilities();
    // Setup needed if no active facilities exist
    stateSetupNeeded = facilities.length === 0;
  } else {
    stateSetupNeeded = isSetupNeeded(STATE_FILE, fs);
  }

  // Check users in default facility (or global for single mode)
  const facilityId = MULTI_FACILITY_MODE ? DEFAULT_FACILITY_ID : undefined;
  const usersExist = hasUsers(facilityId);
  const hasAdmin = hasAdminUser(facilityId);

  res.json({
    setupNeeded: stateSetupNeeded,
    usersExist,
    hasAdmin,
    multiFacilityMode: MULTI_FACILITY_MODE,
    timestamp: new Date().toISOString(),
  });
});

// Note: Initial admin creation is now done via bootstrap login
// First login with AUTH_USER/AUTH_PASS env vars automatically creates admin
// See /api/auth/login for details

// Run initial setup (protected - requires admin authentication)
router.post("/", requireAuth, async (req, res) => {
  // Only admins can create the facility
  if (req.user.role !== "admin") {
    return res.status(403).json({
      error: "Admin access required to create facility",
      code: "ADMIN_REQUIRED",
    });
  }

  // In multi-facility mode, allow creating new facilities if they don't exist
  // In single facility mode, only allow setup if state doesn't exist yet
  if (MULTI_FACILITY_MODE) {
    // Check if facility with custom ID already exists
    const { facilityExists } = require("../facilities");
    const requestedFacilityId = req.body.facilityId;
    if (requestedFacilityId && facilityExists(requestedFacilityId)) {
      return res.status(403).json({
        error: "Facility with this ID already exists",
        code: "FACILITY_EXISTS",
      });
    }
  } else {
    // Single facility mode - only allow setup if state doesn't exist yet
    if (!isSetupNeeded(STATE_FILE, fs)) {
      return res.status(403).json({
        error: "Setup already completed. Delete data/state.json to reset.",
      });
    }
  }

  const {
    numDoors = 57,
    numYardSlots = 30,
    numDumpsters = 0,
    numRamps = 0,
    doorStart = 1,
    yardStart = 1,
    facilityName,
    facilityId: customFacilityId,
  } = req.body;

  // Validate inputs
  if (typeof numDoors !== "number" || numDoors < 0 || numDoors > 500) {
    return res.status(400).json({ error: "Invalid number of doors (0-500)" });
  }
  if (
    typeof numYardSlots !== "number" ||
    numYardSlots < 0 ||
    numYardSlots > 500
  ) {
    return res
      .status(400)
      .json({ error: "Invalid number of yard slots (0-500)" });
  }
  if (
    typeof numDumpsters !== "number" ||
    numDumpsters < 0 ||
    numDumpsters > 50
  ) {
    return res
      .status(400)
      .json({ error: "Invalid number of dumpsters (0-50)" });
  }
  if (typeof numRamps !== "number" || numRamps < 0 || numRamps > 50) {
    return res.status(400).json({ error: "Invalid number of ramps (0-50)" });
  }
  if (typeof doorStart !== "number" || doorStart < 1 || doorStart > 9999) {
    return res
      .status(400)
      .json({ error: "Invalid door start number (1-9999)" });
  }
  if (typeof yardStart !== "number" || yardStart < 1 || yardStart > 9999) {
    return res
      .status(400)
      .json({ error: "Invalid yard start number (1-9999)" });
  }

  try {
    // In multi-facility mode, create facility using the facilities module
    if (MULTI_FACILITY_MODE) {
      const result = await createFacility({
        name: facilityName || customFacilityId || "Default Facility",
        description: "Initial facility created during setup",
        config: {
          doorCount: numDoors,
          yardSlotCount: numYardSlots,
          dumpsterCount: numDumpsters,
          rampCount: numRamps,
        },
        id: customFacilityId,
      });

      if (!result.success) {
        return res.status(500).json({ error: result.error || "Failed to create facility" });
      }

      console.log("[Setup] Facility created:", result.facility.name);
      console.log(`  - ${numDoors} dock doors`);
      console.log(`  - ${numYardSlots} yard slots`);

      return res.json({
        success: true,
        facility: result.facility,
        message: "Facility created successfully. Please log in to continue.",
      });
    }

    // Single facility mode - create state directly
    const { doors, yardSlots } = generateFacilityConfig({
      numDoors,
      numYardSlots,
      numDumpsters,
      numRamps,
      doorStart,
      yardStart,
    });

    // Create initial state
    const initialState = {
      doors,
      trailers: [],
      carriers: [],
      yardTrailers: [],
      yardSlots,
      staging: null,
      queuedTrailers: [],
      appointmentQueue: [],
    };

    if (!fs.existsSync(path.join(DATA_DIR, "archives"))) {
      fs.mkdirSync(path.join(DATA_DIR, "archives"), { recursive: true });
    }

    // Save all data files
    fs.writeFileSync(STATE_FILE, JSON.stringify(initialState, null, 2));
    fs.writeFileSync(HISTORY_FILE, JSON.stringify({ entries: [] }, null, 2));
    fs.writeFileSync(
      ANALYTICS_FILE,
      JSON.stringify(
        {
          snapshots: [],
          dailyStats: {},
          weeklyStats: {},
          monthlyStats: {},
        },
        null,
        2,
      ),
    );

    // Preserve existing settings if they exist, otherwise use defaults
    if (!fs.existsSync(SETTINGS_FILE)) {
      saveSettings(DEFAULT_SETTINGS);
    }

    console.log("[Setup] Initial configuration created:");
    console.log(`  - ${numDoors} dock doors`);
    console.log(`  - ${numYardSlots} yard slots`);
    console.log(`  - ${numDumpsters} dumpsters`);
    console.log(`  - ${numRamps} ramps`);

    res.json({
      success: true,
      config: {
        numDoors,
        numYardSlots,
        numDumpsters,
        numRamps,
        totalDoors: doors.length,
      },
      message: "Setup complete. Please log in to continue.",
    });
  } catch (error) {
    console.error("[Setup] Error:", error);
    res.status(500).json({ error: "Failed to create initial configuration" });
  }
});

// Reset facility - delete all data (protected - requires authentication)
router.delete("/", requireAuth, requireRole("admin"), (req, res) => {
  try {
    const facilityId = req.user.currentFacility || req.user.homeFacility;

    // Get facility-specific file paths
    const {
      getFacilityStateFile,
      getFacilityHistoryFile,
      getFacilityAnalyticsFile,
    } = require("../config");

    const stateFile = getFacilityStateFile(facilityId);
    const historyFile = getFacilityHistoryFile(facilityId);
    const analyticsFile = getFacilityAnalyticsFile(facilityId);

    // Delete state file
    if (fs.existsSync(stateFile)) {
      fs.unlinkSync(stateFile);
    }
    // Delete history file
    if (fs.existsSync(historyFile)) {
      fs.unlinkSync(historyFile);
    }
    // Delete analytics file
    if (fs.existsSync(analyticsFile)) {
      fs.unlinkSync(analyticsFile);
    }
    // Note: Keep settings file to preserve user preferences

    console.log(`[Setup] Facility data cleared for ${facilityId} by user`);
    res.json({
      success: true,
      message: "Facility data cleared. Setup required.",
    });
  } catch (error) {
    console.error("[Setup] Error clearing data:", error);
    res.status(500).json({ error: "Failed to clear facility data" });
  }
});

// Clear all data and reset to initial state (protected - requires authentication)
router.post("/reset", requireAuth, requireRole("admin"), (req, res) => {
  try {
    const facilityId = req.user.currentFacility || req.user.homeFacility;

    // Get facility-specific file paths
    const {
      getFacilityStateFile,
      getFacilityHistoryFile,
      getFacilityAnalyticsFile,
      getFacilitySettingsFile,
      FACILITIES_DIR,
    } = require("../config");

    const stateFile = getFacilityStateFile(facilityId);
    const historyFile = getFacilityHistoryFile(facilityId);
    const analyticsFile = getFacilityAnalyticsFile(facilityId);
    const settingsFile = getFacilitySettingsFile(facilityId);
    const carriersFile = path.join(FACILITIES_DIR, facilityId, "carriers.json");

    // Delete state file if it exists
    if (fs.existsSync(stateFile)) {
      fs.unlinkSync(stateFile);
    }

    // Delete history file
    if (fs.existsSync(historyFile)) {
      fs.unlinkSync(historyFile);
    }

    // Delete analytics file
    if (fs.existsSync(analyticsFile)) {
      fs.unlinkSync(analyticsFile);
    }

    // Delete settings file
    if (fs.existsSync(settingsFile)) {
      fs.unlinkSync(settingsFile);
    }

    // Delete carriers file if exists
    if (fs.existsSync(carriersFile)) {
      fs.unlinkSync(carriersFile);
    }

    // Delete users file for this facility
    const usersFile = path.join(FACILITIES_DIR, facilityId, "users.json");
    if (fs.existsSync(usersFile)) {
      fs.unlinkSync(usersFile);
    }

    // Hard delete the facility from facilities.json in multi-facility mode
    if (MULTI_FACILITY_MODE) {
      const { loadFacilities, saveFacilities } = require("../facilities");
      const facilitiesData = loadFacilities();
      facilitiesData.facilities = facilitiesData.facilities.filter(f => f.id !== facilityId);
      saveFacilities(facilitiesData);
    }

    console.log(`[Setup] Facility reset for ${facilityId} by user`);

    res.json({
      success: true,
      message: "Facility reset. You can now recreate it.",
      setupNeeded: true,
      resetFacilityId: facilityId,
    });
  } catch (error) {
    console.error("[Setup] Error resetting facility:", error);
    res.status(500).json({ error: "Failed to reset facility: " + error.message });
  }
});

module.exports = router;
