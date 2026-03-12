/**
 * Facilities management module
 *
 * Handles facility CRUD operations for multi-facility mode.
 * Facilities are stored in data/facilities.json with metadata.
 * Each facility has its own data directory under data/facilities/{facilityId}/
 *
 * Security:
 * - Only bootstrap admin can create/delete facilities
 * - Regular admins can view and switch between facilities
 * - All facility operations require authentication
 */

const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const {
  FACILITIES_FILE,
  FACILITIES_DIR,
  DEFAULT_FACILITY_ID,
  DEFAULT_DOORS,
  DEFAULT_YARD_SLOTS,
  DEFAULT_CARRIERS,
  MULTI_FACILITY_MODE,
} = require("./config");
const { saveState, loadState, saveUsers, loadUsers, ensureDataDirs } = require("./state");
const { createUser, hasUsers, findUserByUsername } = require("./users");

// Default facility structure
const DEFAULT_FACILITY = {
  id: DEFAULT_FACILITY_ID,
  name: "Default Facility",
  description: "Default facility",
  createdAt: null,
  updatedAt: null,
  active: true,
  config: {
    doorCount: 57,
    yardSlotCount: 30,
  },
};

/**
 * Load facilities list from facilities.json
 * Returns default structure if file doesn't exist
 */
function loadFacilities() {
  if (!MULTI_FACILITY_MODE) {
    // In single facility mode, return a virtual default facility
    return {
      facilities: [DEFAULT_FACILITY],
    };
  }

  try {
    if (!fs.existsSync(FACILITIES_FILE)) {
      return { facilities: [] };
    }
    const data = fs.readFileSync(FACILITIES_FILE, "utf8");
    return JSON.parse(data);
  } catch (error) {
    console.error("[Facilities] Error loading facilities:", error.message);
    return { facilities: [] };
  }
}

/**
 * Save facilities list to facilities.json
 */
function saveFacilities(facilitiesData) {
  if (!MULTI_FACILITY_MODE) {
    return true; // No-op in single facility mode
  }

  try {
    const dir = path.dirname(FACILITIES_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(FACILITIES_FILE, JSON.stringify(facilitiesData, null, 2));
    return true;
  } catch (error) {
    console.error("[Facilities] Error saving facilities:", error.message);
    return false;
  }
}

/**
 * Create a new facility
 * Only callable by bootstrap admin
 *
 * @param {Object} facilityData - Facility configuration
 * @param {string} facilityData.name - Facility name
 * @param {string} facilityData.description - Facility description
 * @param {Object} facilityData.config - Facility configuration
 * @param {number} facilityData.config.doorCount - Number of doors
 * @param {number} facilityData.config.yardSlotCount - Number of yard slots
 * @returns {Object} - { success: boolean, facility?: object, error?: string }
 */
async function createFacility(facilityData) {
  if (!MULTI_FACILITY_MODE) {
    return { success: false, error: "Multi-facility mode is not enabled" };
  }

  const { name, description, config, adminUsername, adminPassword, id: customId, numDumpsters = 0, numRamps = 0 } = facilityData;

  // Validate required fields
  if (!name || name.trim().length < 2) {
    return { success: false, error: "Facility name must be at least 2 characters" };
  }

  const facilitiesData = loadFacilities();

  // Check for duplicate name
  if (facilitiesData.facilities.some((f) => f.name.toLowerCase() === name.toLowerCase())) {
    return { success: false, error: "Facility with this name already exists" };
  }

  // Use custom ID or generate one
  const facilityId = customId || `facility-${Date.now()}-${uuidv4().slice(0, 8)}`;

  const newFacility = {
    id: facilityId,
    name: name.trim(),
    description: description?.trim() || "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    active: true,
    config: {
      doorCount: config?.doorCount || 57,
      yardSlotCount: config?.yardSlotCount || 30,
      dumpsterCount: config?.dumpsterCount || 0,
      rampCount: config?.rampCount || 0,
    },
  };

  console.log("[Facilities] Creating facility with config:", newFacility.config);

  // Create facility data directory
  const facilityDir = path.join(FACILITIES_DIR, facilityId);
  try {
    if (!fs.existsSync(facilityDir)) {
      fs.mkdirSync(facilityDir, { recursive: true });
    }

    // Initialize facility state with custom door/yard counts
    const doors = [];
    let order = 1;

    // Create regular dock doors
    for (let i = 0; i < newFacility.config.doorCount; i++) {
      doors.push({
        id: `door-${i + 1}`,
        number: i + 1,
        order: order++,
        trailerId: null,
        status: "empty",
        inService: true,
        type: "normal",
      });
    }

    // Create dumpsters as blank-type doors
    const numDumpsters = newFacility.config.dumpsterCount || 0;
    for (let i = 0; i < numDumpsters; i++) {
      doors.push({
        id: `dumpster-${uuidv4()}`,
        number: null,
        order: order++,
        labelText: `Dumpster ${i + 1}`,
        trailerId: null,
        status: "empty",
        inService: true,
        type: "blank",
      });
    }

    // Create ramps as blank-type doors
    const numRamps = newFacility.config.rampCount || 0;
    for (let i = 0; i < numRamps; i++) {
      doors.push({
        id: `ramp-${uuidv4()}`,
        number: null,
        order: order++,
        labelText: `Ramp ${i + 1}`,
        trailerId: null,
        status: "empty",
        inService: true,
        type: "blank",
      });
    }

    const yardSlots = Array.from({ length: newFacility.config.yardSlotCount }, (_, i) => ({
      id: `yard-${i + 1}`,
      number: i + 1,
      trailerId: null,
    }));

    const initialState = {
      doors,
      trailers: [],
      carriers: DEFAULT_CARRIERS,
      yardTrailers: [],
      yardSlots,
      staging: null,
      queuedTrailers: [],
      appointmentQueue: [],
    };

    saveState(initialState, facilityId);

    // Create initial admin user for the facility if provided
    if (adminUsername && adminPassword) {
      const userResult = await createUser(
        {
          username: adminUsername,
          password: adminPassword,
          role: "admin",
        },
        facilityId
      );

      if (!userResult.success) {
        return { success: false, error: `Failed to create admin user: ${userResult.error}` };
      }
    }

    // Add to facilities list
    facilitiesData.facilities.push(newFacility);
    if (!saveFacilities(facilitiesData)) {
      return { success: false, error: "Failed to save facility list" };
    }

    return { success: true, facility: newFacility };
  } catch (error) {
    console.error("[Facilities] Error creating facility:", error.message);
    return { success: false, error: "Failed to create facility" };
  }
}

/**
 * Get a facility by ID
 */
function getFacility(facilityId) {
  if (!MULTI_FACILITY_MODE) {
    return facilityId === DEFAULT_FACILITY_ID ? DEFAULT_FACILITY : null;
  }

  const facilitiesData = loadFacilities();
  return facilitiesData.facilities.find((f) => f.id === facilityId && f.active !== false) || null;
}

/**
 * Get all active facilities
 */
function getAllFacilities() {
  if (!MULTI_FACILITY_MODE) {
    return [DEFAULT_FACILITY];
  }

  const facilitiesData = loadFacilities();
  return facilitiesData.facilities.filter((f) => f.active !== false);
}

/**
 * Update a facility
 * Only callable by bootstrap admin
 */
function updateFacility(facilityId, updates) {
  if (!MULTI_FACILITY_MODE) {
    return { success: false, error: "Multi-facility mode is not enabled" };
  }

  const facilitiesData = loadFacilities();
  const facilityIndex = facilitiesData.facilities.findIndex((f) => f.id === facilityId);

  if (facilityIndex === -1) {
    return { success: false, error: "Facility not found" };
  }

  const facility = facilitiesData.facilities[facilityIndex];

  // Update allowed fields
  if (updates.name !== undefined) {
    if (updates.name.trim().length < 2) {
      return { success: false, error: "Facility name must be at least 2 characters" };
    }
    // Check for duplicate name
    const existing = facilitiesData.facilities.find(
      (f) => f.id !== facilityId && f.name.toLowerCase() === updates.name.toLowerCase()
    );
    if (existing) {
      return { success: false, error: "Facility with this name already exists" };
    }
    facility.name = updates.name.trim();
  }

  if (updates.description !== undefined) {
    facility.description = updates.description.trim();
  }

  if (updates.active !== undefined) {
    facility.active = updates.active;
  }

  facility.updatedAt = new Date().toISOString();

  if (!saveFacilities(facilitiesData)) {
    return { success: false, error: "Failed to save facility" };
  }

  return { success: true, facility };
}

/**
 * Delete (deactivate) a facility
 * Only callable by bootstrap admin
 * Note: This soft-deletes the facility; data is preserved
 */
function deleteFacility(facilityId) {
  if (!MULTI_FACILITY_MODE) {
    return { success: false, error: "Multi-facility mode is not enabled" };
  }

  if (facilityId === DEFAULT_FACILITY_ID) {
    return { success: false, error: "Cannot delete the default facility" };
  }

  const facilitiesData = loadFacilities();
  const facility = facilitiesData.facilities.find((f) => f.id === facilityId);

  if (!facility) {
    return { success: false, error: "Facility not found" };
  }

  // Soft delete
  facility.active = false;
  facility.updatedAt = new Date().toISOString();

  if (!saveFacilities(facilitiesData)) {
    return { success: false, error: "Failed to save facility" };
  }

  return { success: true };
}

/**
 * Check if a facility exists
 */
function facilityExists(facilityId) {
  if (!MULTI_FACILITY_MODE) {
    return facilityId === DEFAULT_FACILITY_ID;
  }

  const facilitiesData = loadFacilities();
  return facilitiesData.facilities.some((f) => f.id === facilityId && f.active !== false);
}

/**
 * Get facility statistics (user count, trailer count, etc.)
 */
function getFacilityStats(facilityId) {
  if (!facilityExists(facilityId)) {
    return null;
  }

  try {
    const usersData = loadUsers(facilityId);
    const state = loadState(facilityId);

    return {
      userCount: usersData.users.filter((u) => u.active !== false).length,
      doorCount: state.doors?.length || 0,
      trailerCount: state.trailers?.length || 0,
      yardTrailerCount: state.yardTrailers?.length || 0,
    };
  } catch (error) {
    console.error(`[Facilities] Error getting stats for ${facilityId}:`, error.message);
    return null;
  }
}

module.exports = {
  loadFacilities,
  saveFacilities,
  createFacility,
  getFacility,
  getAllFacilities,
  updateFacility,
  deleteFacility,
  facilityExists,
  getFacilityStats,
  DEFAULT_FACILITY,
};
