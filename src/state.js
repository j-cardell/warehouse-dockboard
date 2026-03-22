/**
 * State management module
 *
 * Handles all data persistence to JSON files.
 * Each function loads/saves a specific data type:
 * - state.json: Doors, trailers, yard, carriers, queues
 * - history.json: Audit log of all actions
 * - analytics.json: Daily dwell statistics
 * - settings.json: UI preferences
 *
 * All state modifications follow this pattern:
 * 1. const state = loadState() - Load current state
 * 2. Modify state (push, splice, update properties)
 * 3. saveState(state) - Persist to disk
 * 4. addHistoryEntry(action, details) - Log the action
 */

const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const {
  STATE_FILE,
  HISTORY_FILE,
  SETTINGS_FILE,
  ANALYTICS_FILE,
  DATA_DIR,
  FACILITIES_DIR,
  DEFAULT_SETTINGS,
  DEFAULT_DOORS,
  DEFAULT_YARD_SLOTS,
  DEFAULT_CARRIERS,
  MULTI_FACILITY_MODE,
  DEFAULT_FACILITY_ID,
  getFacilityStateFile,
  getFacilityHistoryFile,
  getFacilitySettingsFile,
  getFacilityAnalyticsFile,
} = require("./config");

/**
 * Load the main application state from state.json.
 * Returns defaults if file doesn't exist or is corrupted.
 *
 * State structure:
 * {
 *   doors: [{ id, number, order, trailerId, status, inService, type, labelText }],
 *   trailers: [{ id, number, carrier, status, doorId, doorNumber, createdAt, dwellResets }],
 *   yardTrailers: [{ id, number, carrier, status, location: 'yard' }],
 *   yardSlots: [{ id, number, trailerId }],
 *   staging: { id, number, carrier, status } | null,
 *   queuedTrailers: [{ id, carrier, targetDoorId, targetDoorNumber, queuedAt }],
 *   appointmentQueue: [{ id, carrier, appointmentTime, queuedAt }],
 *   carriers: [{ id, name, mcNumber, favorite, usageCount }],
 *   shippedTrailers: [{ ...trailer, shippedAt, previousLocation }]
 * }
 */
function loadState(facilityId = DEFAULT_FACILITY_ID) {
  const stateFile = MULTI_FACILITY_MODE
    ? getFacilityStateFile(facilityId)
    : STATE_FILE;

  if (fs.existsSync(stateFile)) {
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
      // Backward compatibility: ensure fields added in newer versions exist
      if (!state.yardSlots) state.yardSlots = DEFAULT_YARD_SLOTS;
      if (!state.hasOwnProperty("staging")) state.staging = null;
      if (!state.queuedTrailers) state.queuedTrailers = [];
      if (!state.appointmentQueue) state.appointmentQueue = [];
      if (!state.shippedTrailers) state.shippedTrailers = [];
      if (!state.receivedTrailers) state.receivedTrailers = [];
      return state;
    } catch (e) {
      console.error(`Error loading state:`, e);
    }
  }
  return {
    doors: DEFAULT_DOORS,
    trailers: [],
    carriers: DEFAULT_CARRIERS,
    yardTrailers: [],
    yardSlots: DEFAULT_YARD_SLOTS,
    staging: null,
    queuedTrailers: [],
    appointmentQueue: [],
    shippedTrailers: [],
    receivedTrailers: [],
  };
}

/**
 * Save state for a specific facility.
 */
function saveState(state, facilityId = DEFAULT_FACILITY_ID) {
  const stateFile = MULTI_FACILITY_MODE
    ? getFacilityStateFile(facilityId)
    : STATE_FILE;

  // Ensure directory exists for multi-facility mode
  if (MULTI_FACILITY_MODE) {
    const dir = path.dirname(stateFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

/**
 * Load history from history.json.
 * History is an append-only log of all significant actions.
 *
 * Structure: { entries: [{ id, timestamp, action, ...details }] }
 * Actions: 'MOVED_TO_DOOR', 'MOVED_TO_YARD', 'TRAILER_CREATED', 'TRAILER_SHIPPED', etc.
 */
function loadHistory(facilityId = DEFAULT_FACILITY_ID) {
  const historyFile = MULTI_FACILITY_MODE
    ? getFacilityHistoryFile(facilityId)
    : HISTORY_FILE;

  if (fs.existsSync(historyFile)) {
    try {
      return JSON.parse(fs.readFileSync(historyFile, "utf-8"));
    } catch (e) {
      console.error(`Error loading history:`, e);
    }
  }
  return { entries: [] };
}

function saveHistory(history, facilityId = DEFAULT_FACILITY_ID) {
  const historyFile = MULTI_FACILITY_MODE
    ? getFacilityHistoryFile(facilityId)
    : HISTORY_FILE;

  if (MULTI_FACILITY_MODE) {
    const dir = path.dirname(historyFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));
}

/**
 * Add an entry to the history log.
 * Automatically trims to 1000 most recent entries.
 *
 * @param {string} action - Action type (e.g., 'MOVED_TO_DOOR')
 * @param {object} details - Additional data to log
 * @param {object} user - User who performed the action (optional)
 * @param {string} facilityId - Facility ID (optional, defaults to DEFAULT_FACILITY_ID)
 * @returns {object} - The created history entry
 */
function addHistoryEntry(action, details, user = null, facilityId = DEFAULT_FACILITY_ID) {
  const history = loadHistory(facilityId);

  // Format username - append home facility ID if user is visiting from another facility
  // This shows WHERE they came from, not where they are
  let formattedUsername = user?.username;
  if (user?.isVisiting && user?.homeFacility) {
    formattedUsername = `${user.username}@${user.homeFacility}`;
  }

  history.entries.unshift({
    id: uuidv4(),
    timestamp: new Date().toISOString(),
    action,
    ...details,
    ...(user && { userId: user.userId, username: formattedUsername }),
  });
  // Keep last 1000 entries to prevent file bloat
  if (history.entries.length > 1000) {
    history.entries = history.entries.slice(0, 1000);
  }
  saveHistory(history, facilityId);
  return history.entries[0];
}

/**
 * Load analytics data from analytics.json.
 * Stores daily, weekly, and monthly dwell statistics.
 *
 * Structure:
 * {
 *   dailyStats: { '2026-03-04': { date, avgDwell, maxDwell, count, violations, violators } },
 *   weeklyStats: {},
 *   monthlyStats: {}
 * }
 */
function loadAnalytics(facilityId = DEFAULT_FACILITY_ID) {
  const analyticsFile = MULTI_FACILITY_MODE
    ? getFacilityAnalyticsFile(facilityId)
    : ANALYTICS_FILE;

  if (fs.existsSync(analyticsFile)) {
    try {
      return JSON.parse(fs.readFileSync(analyticsFile, "utf-8"));
    } catch (e) {
      console.error(`Error loading analytics:`, e);
    }
  }
  return { snapshots: [], dailyStats: {}, weeklyStats: {}, monthlyStats: {} };
}

function saveAnalytics(analytics, facilityId = DEFAULT_FACILITY_ID) {
  const analyticsFile = MULTI_FACILITY_MODE
    ? getFacilityAnalyticsFile(facilityId)
    : ANALYTICS_FILE;

  if (MULTI_FACILITY_MODE) {
    const dir = path.dirname(analyticsFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  fs.writeFileSync(analyticsFile, JSON.stringify(analytics, null, 2));
}

/**
 * Load user settings from settings.json.
 * Merges saved settings with defaults (for backward compatibility).
 */
function loadSettings(facilityId = DEFAULT_FACILITY_ID) {
  const settingsFile = MULTI_FACILITY_MODE
    ? getFacilitySettingsFile(facilityId)
    : SETTINGS_FILE;

  if (fs.existsSync(settingsFile)) {
    try {
      const saved = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
      return { ...DEFAULT_SETTINGS, ...saved };
    } catch (e) {
      console.error(`Error loading settings:`, e);
    }
  }
  return DEFAULT_SETTINGS;
}

function saveSettings(settings, facilityId = DEFAULT_FACILITY_ID) {
  const settingsFile = MULTI_FACILITY_MODE
    ? getFacilitySettingsFile(facilityId)
    : SETTINGS_FILE;

  if (MULTI_FACILITY_MODE) {
    const dir = path.dirname(settingsFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
}

/**
 * Ensure data directories exist.
 * Creates data/ and data/archives/ if missing.
 * Also creates facilities directory in multi-facility mode.
 */
function ensureDataDirs() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(path.join(DATA_DIR, "archives"))) {
    fs.mkdirSync(path.join(DATA_DIR, "archives"), { recursive: true });
  }
  if (MULTI_FACILITY_MODE && !fs.existsSync(FACILITIES_DIR)) {
    fs.mkdirSync(FACILITIES_DIR, { recursive: true });
  }
}

module.exports = {
  loadState,
  saveState,
  loadHistory,
  saveHistory,
  addHistoryEntry,
  loadAnalytics,
  saveAnalytics,
  loadSettings,
  saveSettings,
  ensureDataDirs,
};
