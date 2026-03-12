/**
 * Archives routes
 * GET /archives, POST /archives, GET /archives/:filename, POST /archives/restore
 *
 * Handles creation, download, and restoration of point-in-time backups
 * of the application state. Archives are stored as timestamped JSON files.
 */

/**
 * Archives routes
 * GET /archives, POST /archives, GET /archives/:filename, POST /archives/restore
 *
 * Handles creation, download, and restoration of point-in-time backups
 * of the application state. Archives are stored as timestamped JSON files.
 */

const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const { requireAuth, requireRole } = require("../middleware");
const { DATA_DIR, STATE_FILE } = require("../config");
const { loadState, saveState, addHistoryEntry } = require("../state");

// Get list of archive files (protected)
router.get("/", requireAuth, (req, res) => {
  try {
    const facilityId = req.user.currentFacility || req.user.homeFacility;
    const archivesDir = path.join(DATA_DIR, "archives");
    if (!fs.existsSync(archivesDir)) {
      return res.json({ archives: [], facilityId });
    }

    // Get facility name for display
    const { getFacility } = require("../facilities");
    const currentFacility = getFacility(facilityId);

    const files = fs
      .readdirSync(archivesDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const filePath = path.join(archivesDir, f);
        const stats = fs.statSync(filePath);

        // Try to read metadata from archive
        let archiveFacilityId = null;
        let archiveFacilityName = null;
        try {
          const content = fs.readFileSync(filePath, "utf8");
          const data = JSON.parse(content);
          if (data._archiveMetadata) {
            archiveFacilityId = data._archiveMetadata.facilityId;
            archiveFacilityName = data._archiveMetadata.facilityName;
          }
        } catch (e) {
          // Legacy archive without metadata
        }

        return {
          name: f,
          size: stats.size,
          created: stats.birthtime,
          facilityId: archiveFacilityId,
          facilityName: archiveFacilityName,
          // Include archives that match current facility or have no metadata (legacy)
          isForCurrentFacility: !archiveFacilityId || archiveFacilityId === facilityId,
        };
      })
      // Filter to only show archives for current facility (or legacy archives)
      .filter((f) => f.isForCurrentFacility)
      .sort((a, b) => new Date(b.created) - new Date(a.created));

    res.json({
      archives: files,
      facilityId,
      facilityName: currentFacility?.name || "Unknown Facility",
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create archive snapshot (protected)
router.post("/", requireAuth, requireRole("user"), (req, res) => {
  try {
    const facilityId = req.user.currentFacility || req.user.homeFacility;
    const state = loadState(facilityId);

    // Get facility info for metadata
    const { getFacility } = require("../facilities");
    const facility = getFacility(facilityId);

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `archive-${facilityId}-${timestamp}.json`;
    const archivesDir = path.join(DATA_DIR, "archives");

    if (!fs.existsSync(archivesDir)) {
      fs.mkdirSync(archivesDir, { recursive: true });
    }

    // Create archive with metadata wrapper
    const archiveData = {
      _archiveMetadata: {
        version: "1.0",
        createdAt: new Date().toISOString(),
        facilityId: facilityId,
        facilityName: facility?.name || "Unknown Facility",
        createdBy: req.user.username,
      },
      ...state,
    };

    const archivePath = path.join(archivesDir, filename);
    fs.writeFileSync(archivePath, JSON.stringify(archiveData, null, 2));

    res.json({ success: true, filename, facilityId, facilityName: facility?.name });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Download archive file (protected)
router.get("/:filename", requireAuth, (req, res) => {
  try {
    const filename = req.params.filename;
    // Sanitize filename to prevent directory traversal
    if (!filename.match(/^([\w\-])+\.json$/)) {
      return res.status(400).json({ error: "Invalid filename" });
    }
    const filePath = path.join(DATA_DIR, "archives", filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "File not found" });
    }
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", "application/json");
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Validate and sanitize archive data before restore
function validateArchiveData(data) {
  // Check top-level structure
  if (!data || typeof data !== "object") {
    return { valid: false, error: "Invalid data structure" };
  }

  // Required fields that must be arrays
  const requiredArrays = [
    "doors",
    "trailers",
    "carriers",
    "yardTrailers",
    "yardSlots",
  ];
  for (const field of requiredArrays) {
    if (!Array.isArray(data[field])) {
      return { valid: false, error: `Missing or invalid ${field}` };
    }
  }

  // Validate doors structure
  for (const door of data.doors) {
    if (typeof door !== "object")
      return { valid: false, error: "Invalid door entry" };
    if (typeof door.id !== "string" || !door.id.match(/^[\w\-]+$/)) {
      return { valid: false, error: "Invalid door ID" };
    }
    if (
      door.number !== null &&
      (typeof door.number !== "number" || door.number < 0)
    ) {
      return { valid: false, error: "Invalid door number" };
    }
    if (typeof door.order !== "number")
      return { valid: false, error: "Invalid door order" };
    if (!["normal", "blank", "out-of-service"].includes(door.type)) {
      return { valid: false, error: "Invalid door type" };
    }
    // No code/exec allowed in any field
    for (const [key, value] of Object.entries(door)) {
      if (
        typeof value === "string" &&
        value.match(
          /[<>{}]|function\s*\(|\bexec\b|\beval\b|\brequire\b|\bimport\b/,
        )
      ) {
        return { valid: false, error: `Suspicious content in door.${key}` };
      }
    }
  }

  // Validate trailers
  for (const trailer of data.trailers) {
    if (typeof trailer !== "object")
      return { valid: false, error: "Invalid trailer entry" };
    if (typeof trailer.id !== "string" || !trailer.id.match(/^[\w\-]+$/)) {
      return { valid: false, error: "Invalid trailer ID" };
    }
    if (
      trailer.number != null &&
      typeof trailer.number !== "string" &&
      typeof trailer.number !== "number"
    ) {
      return { valid: false, error: "Invalid trailer number" };
    }
    // Check for code injection
    for (const [key, value] of Object.entries(trailer)) {
      if (
        typeof value === "string" &&
        value.match(
          /[<>{}]|function\s*\(|\bexec\b|\beval\b|\brequire\b|\bimport\b/,
        )
      ) {
        return { valid: false, error: `Suspicious content in trailer.${key}` };
      }
    }
  }

  // Validate yardSlots
  for (const slot of data.yardSlots) {
    if (typeof slot !== "object")
      return { valid: false, error: "Invalid yard slot" };
    if (typeof slot.id !== "string")
      return { valid: false, error: "Invalid yard slot ID" };
    if (typeof slot.number !== "number")
      return { valid: false, error: "Invalid yard slot number" };
  }

  // Check for prototype pollution
  const forbiddenKeys = ["__proto__", "constructor", "prototype"];
  function checkKeys(obj, path = "") {
    if (obj && typeof obj === "object") {
      for (const key of Object.keys(obj)) {
        if (forbiddenKeys.includes(key)) {
          return { valid: false, error: `Forbidden key: ${key}` };
        }
        const result = checkKeys(obj[key], `${path}.${key}`);
        if (!result.valid) return result;
      }
    }
    return { valid: true };
  }

  const keyCheck = checkKeys(data);
  if (!keyCheck.valid) return keyCheck;

  return { valid: true };
}

// Sanitize archive data before saving
function sanitizeArchiveData(data) {
  const sanitized = {
    doors: [],
    trailers: [],
    carriers: [],
    yardTrailers: [],
    yardSlots: [],
    staging: data.staging || null,
    queuedTrailers: Array.isArray(data.queuedTrailers)
      ? data.queuedTrailers
      : [],
    appointmentQueue: Array.isArray(data.appointmentQueue)
      ? data.appointmentQueue
      : [],
    shippedTrailers: Array.isArray(data.shippedTrailers)
      ? data.shippedTrailers
      : [],
  };

  // Sanitize yardTrailers (unassigned yard)
  for (const trailer of data.yardTrailers || []) {
    sanitized.yardTrailers.push({
      id: String(trailer.id)
        .replace(/[^\w\-]/g, "")
        .slice(0, 50),
      number: String(trailer.number || "").slice(0, 50),
      carrier: String(trailer.carrier || "").slice(0, 100),
      customer: String(trailer.customer || "").slice(0, 100),
      loadNumber: String(trailer.loadNumber || "").slice(0, 50),
      status: ["empty", "loaded", "shipped"].includes(trailer.status)
        ? trailer.status
        : "empty",
      location: trailer.location || "yard",
      yardSlotId: trailer.yardSlotId
        ? String(trailer.yardSlotId)
            .replace(/[^\w\-]/g, "")
            .slice(0, 50)
        : null,
      yardSlotNumber: trailer.yardSlotNumber || null,
      createdAt: String(trailer.createdAt || new Date().toISOString()).slice(
        0,
        50,
      ),
      dwellResets: Array.isArray(trailer.dwellResets)
        ? trailer.dwellResets.slice(0, 100)
        : [],
    });
  }

  // Sanitize doors
  for (const door of data.doors) {
    sanitized.doors.push({
      id: String(door.id)
        .replace(/[^\w\-]/g, "")
        .slice(0, 50),
      number: door.number === null ? null : Math.floor(Number(door.number)),
      order: Math.floor(Number(door.order)) || 0,
      trailerId: door.trailerId
        ? String(door.trailerId)
            .replace(/[^\w\-]/g, "")
            .slice(0, 50)
        : null,
      status: ["empty", "occupied", "out-of-service"].includes(door.status)
        ? door.status
        : "empty",
      inService: Boolean(door.inService),
      type: ["normal", "blank", "out-of-service"].includes(door.type)
        ? door.type
        : "normal",
      labelText: door.labelText
        ? String(door.labelText).replace(/[<>]/g, "").slice(0, 100)
        : undefined,
    });
  }

  // Sanitize trailers
  for (const trailer of data.trailers) {
    sanitized.trailers.push({
      id: String(trailer.id)
        .replace(/[^\w\-]/g, "")
        .slice(0, 50),
      number: String(trailer.number || "").slice(0, 50),
      carrier: String(trailer.carrier || "").slice(0, 100),
      customer: String(trailer.customer || "").slice(0, 100),
      loadNumber: String(trailer.loadNumber || "").slice(0, 50),
      status: ["empty", "loaded", "shipped"].includes(trailer.status)
        ? trailer.status
        : "empty",
      doorId: trailer.doorId
        ? String(trailer.doorId)
            .replace(/[^\w\-]/g, "")
            .slice(0, 50)
        : null,
      createdAt: String(trailer.createdAt || new Date().toISOString()).slice(
        0,
        50,
      ),
      dwellResets: Array.isArray(trailer.dwellResets)
        ? trailer.dwellResets.slice(0, 100)
        : [],
    });
  }

  // Sanitize yard slots
  for (const slot of data.yardSlots) {
    sanitized.yardSlots.push({
      id: String(slot.id)
        .replace(/[^\w\-]/g, "")
        .slice(0, 50),
      number: Math.floor(Number(slot.number)) || 0,
      trailerId: slot.trailerId
        ? String(slot.trailerId)
            .replace(/[^\w\-]/g, "")
            .slice(0, 50)
        : null,
    });
  }

  return sanitized;
}

// Upload and restore from archive (protected)
router.post("/restore", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const targetFacilityId = req.user.currentFacility || req.user.homeFacility;
    const { confirmed } = req.body;

    // Accept either { data: {...} } or direct {...}
    const data = req.body.data || req.body;

    if (!data || typeof data !== "object") {
      return res.status(400).json({ error: "No data provided" });
    }

    // Extract metadata if present
    const sourceFacilityId = data._archiveMetadata?.facilityId;
    const sourceFacilityName = data._archiveMetadata?.facilityName || "Unknown Facility";
    const archiveCreatedAt = data._archiveMetadata?.createdAt;

    // Check if this is a cross-facility restore
    const isCrossFacility = sourceFacilityId && sourceFacilityId !== targetFacilityId;

    // If cross-facility and not confirmed, return warning
    if (isCrossFacility && !confirmed) {
      return res.status(409).json({
        error: "Cross-facility restore requires confirmation",
        warning: {
          type: "cross-facility",
          sourceFacilityId,
          sourceFacilityName,
          targetFacilityId,
          targetFacilityName: req.user.facilityName || "Current Facility",
          message: `This archive is from "${sourceFacilityName}" (${sourceFacilityId}). Are you sure you want to restore it to your current facility?`,
        },
        requiresConfirmation: true,
      });
    }

    // Remove metadata wrapper before validation
    const stateData = { ...data };
    delete stateData._archiveMetadata;

    // Validate structure
    const validation = validateArchiveData(stateData);
    if (!validation.valid) {
      return res
        .status(400)
        .json({ error: `Invalid archive: ${validation.error}` });
    }

    // Sanitize the data
    const sanitizedData = sanitizeArchiveData(stateData);

    // Create backup of current state before restore
    const { getFacility } = require("../facilities");
    const currentFacility = getFacility(targetFacilityId);
    const currentState = loadState(targetFacilityId);
    const backupTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(
      DATA_DIR,
      "archives",
      `auto-backup-before-restore-${targetFacilityId}-${backupTimestamp}.json`,
    );

    const backupData = {
      _archiveMetadata: {
        version: "1.0",
        createdAt: new Date().toISOString(),
        facilityId: targetFacilityId,
        facilityName: currentFacility?.name || "Unknown Facility",
        createdBy: req.user.username,
        note: "Auto-created before restore",
      },
      ...currentState,
    };
    fs.writeFileSync(backupPath, JSON.stringify(backupData, null, 2));

    // Save sanitized state to target facility
    saveState(sanitizedData, targetFacilityId);

    // Add history entry for the restore
    const { addHistoryEntry } = require("../state");
    addHistoryEntry(
      "RESTORE_FROM_ARCHIVE",
      {
        sourceFacilityId: sourceFacilityId || "unknown",
        sourceFacilityName,
        targetFacilityId,
        archiveCreatedAt,
      },
      req.user,
      targetFacilityId,
    );

    res.json({
      success: true,
      message: "State restored successfully",
      backupCreated: path.basename(backupPath),
      sourceFacilityId,
      sourceFacilityName,
      doors: sanitizedData.doors.length,
      trailers: sanitizedData.trailers.length,
      yardSlots: sanitizedData.yardSlots.length,
    });
  } catch (error) {
    console.error("[Restore] Error:", error);
    res.status(500).json({ error: "Failed to restore archive" });
  }
});

module.exports = router;
