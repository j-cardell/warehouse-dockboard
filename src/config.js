/**
 * Configuration constants
 *
 * All environment variables and file paths are centralized here.
 * To add a new config option:
 * 1. Define the constant here
 * 2. Export it in module.exports
 * 3. Import in your file: const { YOUR_VAR } = require('./config')
 */

const path = require("path");

// Server port - defaults to 3000 if not specified
const PORT = process.env.PORT || 3000;

// Multi-facility mode - always enabled
const MULTI_FACILITY_MODE = true;
const DEFAULT_FACILITY_ID = "default";

// Data directory paths - all JSON data is stored here
const DATA_DIR = path.join(__dirname, "../data");
const FACILITIES_FILE = path.join(DATA_DIR, "facilities.json");
const FACILITIES_DIR = path.join(DATA_DIR, "facilities");

// Per-facility file paths (dynamic based on facilityId)
function getFacilityDataPath(facilityId) {
  return path.join(FACILITIES_DIR, facilityId || DEFAULT_FACILITY_ID);
}

function getFacilityStateFile(facilityId) {
  return path.join(getFacilityDataPath(facilityId), "state.json");
}

function getFacilityHistoryFile(facilityId) {
  return path.join(getFacilityDataPath(facilityId), "history.json");
}

function getFacilityAnalyticsFile(facilityId) {
  return path.join(getFacilityDataPath(facilityId), "analytics.json");
}

function getFacilitySettingsFile(facilityId) {
  return path.join(getFacilityDataPath(facilityId), "settings.json");
}

function getFacilityUsersFile(facilityId) {
  return path.join(getFacilityDataPath(facilityId), "users.json");
}

// Legacy paths for backward compatibility (single facility mode)
const STATE_FILE = path.join(DATA_DIR, "state.json");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");
const ANALYTICS_FILE = path.join(DATA_DIR, "analytics.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const USERS_FILE = path.join(DATA_DIR, "users.json");

// Default UI settings for trailer display fonts and colors
// These can be overridden by the user via the settings API
const DEFAULT_SETTINGS = {
  trailerDisplay: {
    customer: { fontSize: "9cqw", color: "#ffffff" },
    carrier: { fontSize: "15cqw", color: "#ffffff" },
    trailerNumber: { fontSize: "7cqw", color: "#fbbf24" },
    loadNumber: { fontSize: "9cqw", color: "#94a3b8" },
    driver: { fontSize: "8cqw" },
    door: { fontSize: "6.5cqw" },
    dwell: { fontSize: "5.5cqw" },
    live: { fontSize: "23cqw" },
  },
  sidebarLayout: {
    sidebarHeight: "1211.67px",
    stagingFlex: "",
    apptQueueFlex: "0 0 264.933px",
    queueFlex: "0 0 363.867px",
  },
};

// Carriers start empty and are auto-populated as trailers are created
const DEFAULT_CARRIERS = [];

// Default facility configuration: 57 dock doors numbered 1-57
// Each door has: id (string), number (int), order (display order), trailerId (assigned trailer or null), status, inService (bool), type ('normal'|'blank'|'out-of-service')
const DEFAULT_DOORS = Array.from({ length: 57 }, (_, i) => ({
  id: `door-${i + 1}`,
  number: i + 1,
  order: i + 1,
  trailerId: null,
  status: "empty",
  inService: true,
  type: "normal",
}));

// Default yard slots: 30 numbered spots for trailer organization
// Each slot: id, number, trailerId (assigned trailer or null)
const DEFAULT_YARD_SLOTS = Array.from({ length: 30 }, (_, i) => ({
  id: `yard-${i + 1}`,
  number: i + 1,
  trailerId: null,
}));

// Auth configuration from environment variables
// AUTH_PASS and JWT_SECRET are validated at startup - server exits if missing
const AUTH_USER = process.env.AUTH_USER || "dockadmin";
const AUTH_PASS = process.env.AUTH_PASS;
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "24h";

module.exports = {
  PORT,
  DATA_DIR,
  FACILITIES_DIR,
  FACILITIES_FILE,
  STATE_FILE,
  HISTORY_FILE,
  ANALYTICS_FILE,
  SETTINGS_FILE,
  USERS_FILE,
  DEFAULT_SETTINGS,
  DEFAULT_CARRIERS,
  DEFAULT_DOORS,
  DEFAULT_YARD_SLOTS,
  AUTH_USER,
  AUTH_PASS,
  JWT_SECRET,
  JWT_EXPIRES_IN,
  MULTI_FACILITY_MODE,
  DEFAULT_FACILITY_ID,
  getFacilityDataPath,
  getFacilityStateFile,
  getFacilityHistoryFile,
  getFacilityAnalyticsFile,
  getFacilitySettingsFile,
  getFacilityUsersFile,
};
