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
const { getFacility } = require("../facilities");

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

    // Recursively find all archive files
    const files = [];
    function findArchives(dir, basePath = "") {
      if (!fs.existsSync(dir)) return;

      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.join(basePath, entry.name);

        if (entry.isDirectory()) {
          findArchives(fullPath, relativePath);
        } else if (entry.name.endsWith(".json")) {
          const stats = fs.statSync(fullPath);

          // Try to read metadata from archive
          let archiveFacilityId = null;
          let archiveFacilityName = null;
          try {
            const content = fs.readFileSync(fullPath, "utf8");
            const data = JSON.parse(content);
            if (data._archiveMetadata) {
              archiveFacilityId = data._archiveMetadata.facilityId;
              archiveFacilityName = data._archiveMetadata.facilityName;
            }
          } catch (e) {
            // Legacy archive without metadata
          }

          files.push({
            name: entry.name,
            path: relativePath,
            size: stats.size,
            created: stats.birthtime,
            facilityId: archiveFacilityId,
            facilityName: archiveFacilityName,
            // Include archives that match current facility or have no metadata (legacy)
            isForCurrentFacility: !archiveFacilityId || archiveFacilityId === facilityId,
          });
        }
      }
    }

    findArchives(archivesDir);

    const sortedFiles = files
      // Filter to only show archives for current facility (or legacy archives)
      .filter((f) => f.isForCurrentFacility)
      .sort((a, b) => new Date(b.created) - new Date(a.created));

    res.json({
      archives: sortedFiles,
      facilityId,
      facilityName: currentFacility?.name || "Unknown Facility",
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Helper to get archive directory path organized by facility/year/month
function getArchiveDir(facilityId) {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const archivePath = path.join(DATA_DIR, "archives", facilityId, String(year), month);
  console.log(`[Archives] Archive directory path: ${archivePath} for facility: ${facilityId}`);
  return archivePath;
}

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
    const archivesDir = getArchiveDir(facilityId);

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

// Export shipped and received trailers to Excel
router.get("/export", requireAuth, async (req, res) => {
  try {
    const facilityId = req.user.currentFacility || req.user.homeFacility;
    const { type = "shipped", dateFrom, dateTo } = req.query;

    // Modern color palette
    const colors = {
      primary: "FF2563EB",
      primaryLight: "FFDBEAFE",
      secondary: "FF059669",
      secondaryLight: "FFD1FAE5",
      accent: "FF7C3AED",
      dark: "FF1E293B",
      gray: "FFF1F5F9",
      white: "FFFFFFFF",
      border: "FFE2E8F0",
    };

    // Create workbook
    const ExcelJS = require("exceljs");
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Warehouse Dock Board";
    workbook.created = new Date();

    // Load state
    const state = loadState(facilityId);

    // Get facility info
    const facility = getFacility(facilityId);
    const facilityName = facility?.name || "Unknown Facility";

    // Get trailers based on type
    let trailers = [];
    let sheetName = "";
    let statusLabel = "";
    let actionLabel = "";

    if (type === "shipped") {
      trailers = state.shippedTrailers || [];
      sheetName = "Shipped Trailers";
      statusLabel = "Shipped";
      actionLabel = "Shipped By";
    } else if (type === "received") {
      trailers = state.receivedTrailers || [];
      sheetName = "Received Trailers";
      statusLabel = "Received";
      actionLabel = "Received By";
    } else {
      return res.status(400).json({ error: "Invalid type. Use 'shipped' or 'received'" });
    }

    // Filter by date range
    if (dateFrom || dateTo) {
      trailers = trailers.filter((t) => {
        const dateField = type === "shipped" ? t.shippedAt : t.receivedAt;
        const itemDate = new Date(dateField || t.updatedAt || t.createdAt);
        const entryDate = itemDate.toISOString().split("T")[0];
        if (dateFrom && entryDate < dateFrom) return false;
        if (dateTo && entryDate > dateTo) return false;
        return true;
      });
    }

    // Sort by date (most recent first)
    trailers.sort(
      (a, b) =>
        new Date(
          (type === "shipped" ? b.shippedAt : b.receivedAt) || b.updatedAt || b.createdAt,
        ) -
        new Date(
          (type === "shipped" ? a.shippedAt : a.receivedAt) || a.updatedAt || a.createdAt,
        ),
    );

    // === SUMMARY SHEET (First) ===
    const summarySheet = workbook.addWorksheet("Summary");

    // Summary columns - first header is the report title
    summarySheet.columns = [
      { header: `${statusLabel} Trailers Report`, key: "metric", width: 35 },
      { header: "", key: "value", width: 25 },
    ];

    // Add metadata rows
    summarySheet.addRow([`Facility: ${facilityName}`, ""]);

    // Calculate date range text
    let dateRangeText;
    if (dateFrom || dateTo) {
      dateRangeText = `Date Range: ${dateFrom || "All"} to ${dateTo || "All"}`;
    } else if (trailers.length > 0) {
      // Find earliest and latest dates from trailers
      const dates = trailers.map(t => {
        const dateField = type === "shipped" ? t.shippedAt : t.receivedAt;
        return new Date(dateField || t.updatedAt || t.createdAt);
      });
      const earliestDate = new Date(Math.min(...dates));
      const latestDate = new Date(Math.max(...dates));
      const formatDate = (d) => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
      dateRangeText = `Date Range: ${formatDate(earliestDate)} - ${formatDate(latestDate)}`;
    } else {
      dateRangeText = `Date Range: All Dates`;
    }
    summarySheet.addRow([dateRangeText, ""]);
    summarySheet.addRow([`Generated: ${new Date().toLocaleString()}`, ""]);
    summarySheet.addRow([]); // Empty row
    summarySheet.addRow(["Summary Statistics", ""]);
    summarySheet.addRow(["Total Records:", trailers.length]);
    summarySheet.addRow([]); // Empty row

    // Carrier breakdown
    const carrierCounts = {};
    trailers.forEach((t) => {
      const carrier = t.carrier || "Unknown";
      carrierCounts[carrier] = (carrierCounts[carrier] || 0) + 1;
    });

    summarySheet.addRow(["Carrier Breakdown", ""]);
    Object.entries(carrierCounts)
      .sort((a, b) => b[1] - a[1])
      .forEach(([carrier, count]) => {
        summarySheet.addRow([carrier, count]);
      });

    summarySheet.addRow([]); // Empty row

    // Customer breakdown
    const customerCounts = {};
    trailers.forEach((t) => {
      const customer = t.customer || "Unknown";
      customerCounts[customer] = (customerCounts[customer] || 0) + 1;
    });

    summarySheet.addRow(["Customer Breakdown", ""]);
    Object.entries(customerCounts)
      .sort((a, b) => b[1] - a[1])
      .forEach(([customer, count]) => {
        summarySheet.addRow([customer, count]);
      });

    // Style summary sheet
    // Header row (contains report title)
    const headerCellA = summarySheet.getCell("A1");
    headerCellA.font = { size: 14, bold: true, color: { argb: colors.dark } };
    headerCellA.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: colors.primaryLight },
    };

    // Metadata rows
    [2, 3, 4].forEach((rowNum) => {
      summarySheet.getCell(`A${rowNum}`).font = { size: 10, color: { argb: colors.dark } };
    });

    // Calculate section header row numbers (adjusted for removed title row)
    const carrierBreakdownRow = 9;
    const customerBreakdownRow = 11 + Object.keys(carrierCounts).length;

    // Section headers - only style cells A and B, not entire row
    [5, carrierBreakdownRow, customerBreakdownRow].forEach((rowNum) => {
      const cellA = summarySheet.getCell(`A${rowNum}`);
      const cellB = summarySheet.getCell(`B${rowNum}`);
      if (cellA.value) {
        cellA.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: colors.primary },
        };
        cellA.font = { bold: true, color: { argb: "FFFFFFFF" } };
        if (cellB.value !== undefined && cellB.value !== null) {
          cellB.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: colors.primary },
          };
          cellB.font = { bold: true, color: { argb: "FFFFFFFF" } };
        }
      }
    });

    // === DATA SHEET (Second) ===
    const mainSheet = workbook.addWorksheet(sheetName);

    // Define columns
    mainSheet.columns = [
      { header: "Date", key: "date", width: 15 },
      { header: "Time", key: "time", width: 12 },
      { header: "Carrier", key: "carrier", width: 25 },
      { header: "Trailer #", key: "number", width: 15 },
      { header: "Load #", key: "loadNumber", width: 15 },
      { header: "Customer", key: "customer", width: 25 },
      { header: "Door", key: "door", width: 10 },
      { header: "Direction", key: "direction", width: 12 },
      { header: actionLabel, key: "user", width: 20 },
      { header: "Facility", key: "facility", width: 20 },
      { header: "Facility ID", key: "facilityId", width: 15 },
    ];

    // Add data rows
    trailers.forEach((t) => {
      const dateField = type === "shipped" ? t.shippedAt : t.receivedAt;
      const itemDate = new Date(dateField || t.updatedAt || t.createdAt);
      const userField = type === "shipped" ? t.shippedBy : t.receivedBy;

      mainSheet.addRow({
        date: itemDate.toLocaleDateString(),
        time: itemDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        carrier: t.carrier || "",
        number: t.number || "",
        loadNumber: t.loadNumber || "",
        customer: t.customer || "",
        door: t.doorNumber || "",
        direction: t.direction || "outbound",
        user: userField || "",
        facility: facilityName,
        facilityId: facilityId,
      });
    });

    // Style the header row (row 1) - apply to each cell individually
    const headerColumns = ["date", "time", "carrier", "number", "loadNumber", "customer", "door", "direction", "user", "facility", "facilityId"];
    headerColumns.forEach((col) => {
      const cell = mainSheet.getColumn(col).header;
      const cellRef = mainSheet.getRow(1).getCell(col);
      cellRef.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cellRef.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: colors.primary },
      };
      cellRef.alignment = { vertical: "middle", horizontal: "center" };
    });

    // Apply zebra striping to data rows - only to cells with data
    for (let i = 2; i <= mainSheet.rowCount; i++) {
      if (i % 2 === 0) {
        headerColumns.forEach((col) => {
          mainSheet.getRow(i).getCell(col).fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: colors.gray },
          };
        });
      }
      headerColumns.forEach((col) => {
        mainSheet.getRow(i).getCell(col).alignment = { vertical: "middle" };
      });
    }

    // Center align specific columns
    mainSheet.getColumn("door").alignment = { horizontal: "center" };
    mainSheet.getColumn("direction").alignment = { horizontal: "center" };

    // Generate filename
    const dateLabel = dateFrom && dateTo ? `${dateFrom}-to-${dateTo}` : new Date().toISOString().split("T")[0];
    const filename = `${facilityId}-${type}-trailers-${facilityName.replace(/\s+/g, "-").toLowerCase()}-${dateLabel}.xlsx`;

    // Write to buffer and send
    const buffer = await workbook.xlsx.writeBuffer();

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (error) {
    console.error("[Export] Error:", error);
    res.status(500).json({ error: "Failed to export trailers" });
  }
});

// Download archive file (protected)
router.get("/:filename", requireAuth, (req, res) => {
  try {
    // Decode URL-encoded filename (Express doesn't auto-decode path params with special chars)
    const filename = decodeURIComponent(req.params.filename);
    // Sanitize filename to prevent directory traversal
    if (!filename.match(/^([\w\-])+\.json$/)) {
      return res.status(400).json({ error: "Invalid filename" });
    }

    // Search recursively in archives directory
    const archivesDir = path.join(DATA_DIR, "archives");
    let filePath = null;

    function findFile(dir) {
      if (!fs.existsSync(dir)) return;

      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const result = findFile(fullPath);
          if (result) return result;
        } else if (entry.name === filename) {
          return fullPath;
        }
      }
      return null;
    }

    filePath = findFile(archivesDir);

    if (!filePath) {
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
    receivedTrailers: Array.isArray(data.receivedTrailers)
      ? data.receivedTrailers
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

    // Get target facility info for the warning message
    const currentFacility = getFacility(targetFacilityId);
    const targetFacilityName = currentFacility?.name || "Current Facility";

    // If cross-facility and not confirmed, return warning
    if (isCrossFacility && !confirmed) {
      return res.status(409).json({
        error: "Cross-facility restore requires confirmation",
        warning: {
          type: "cross-facility",
          sourceFacilityId,
          sourceFacilityName,
          targetFacilityId,
          targetFacilityName,
          message: `This archive is from "${sourceFacilityName}" (${sourceFacilityId}). Are you sure you want to restore it to your current facility?`,
        },
        requiresConfirmation: true,
      });
    }

    // Remove metadata wrapper before validation
    const stateData = { ...data };
    delete stateData._archiveMetadata;

    // Validate only expected top-level keys are present
    const allowedKeys = ['doors', 'trailers', 'yardTrailers', 'yardSlots', 'staging', 'queuedTrailers', 'appointmentQueue', 'carriers', 'shippedTrailers', 'receivedTrailers'];
    const extraKeys = Object.keys(stateData).filter(k => !allowedKeys.includes(k));
    if (extraKeys.length > 0) {
      return res.status(400).json({ error: `Unexpected keys in archive: ${extraKeys.join(', ')}` });
    }

    // Validate structure
    const validation = validateArchiveData(stateData);
    if (!validation.valid) {
      return res
        .status(400)
        .json({ error: `Invalid archive: ${validation.error}` });
    }

    // Sanitize the data
    const sanitizedData = sanitizeArchiveData(stateData);

    // Create backup of current state before restore (organized by facility/year/month)
    const currentState = loadState(targetFacilityId);
    const backupTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = getArchiveDir(targetFacilityId);
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    const backupPath = path.join(
      backupDir,
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

// Delete archive file (protected, admin only)
router.delete("/:filename", requireAuth, requireRole("admin"), (req, res) => {
  try {
    // Decode URL-encoded filename (Express doesn't auto-decode path params with special chars)
    const filename = decodeURIComponent(req.params.filename);
    // Sanitize filename to prevent directory traversal
    if (!filename.match(/^([\w\-])+\.json$/)) {
      return res.status(400).json({ error: "Invalid filename" });
    }

    // Search recursively in archives directory
    const archivesDir = path.join(DATA_DIR, "archives");
    let filePath = null;

    function findFile(dir) {
      if (!fs.existsSync(dir)) return;

      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const result = findFile(fullPath);
          if (result) return result;
        } else if (entry.name === filename) {
          return fullPath;
        }
      }
      return null;
    }

    filePath = findFile(archivesDir);

    if (!filePath) {
      return res.status(404).json({ error: "File not found" });
    }

    fs.unlinkSync(filePath);

    // Clean up empty parent directories (month -> year -> facility)
    // Stop at the archives directory level
    let currentDir = path.dirname(filePath);
    let archivesBaseDir = path.join(DATA_DIR, "archives");

    while (currentDir !== archivesBaseDir && currentDir.startsWith(archivesBaseDir)) {
      try {
        const contents = fs.readdirSync(currentDir);
        if (contents.length === 0) {
          fs.rmdirSync(currentDir);
          currentDir = path.dirname(currentDir);
        } else {
          break; // Directory not empty, stop cleanup
        }
      } catch (e) {
        break; // Error reading directory, stop cleanup
      }
    }

    res.json({ success: true, message: "Archive deleted successfully" });
  } catch (error) {
    console.error("[Delete Archive] Error:", error);
    res.status(500).json({ error: "Failed to delete archive" });
  }
});

module.exports = router;
