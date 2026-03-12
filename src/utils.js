/**
 * Utility functions
 *
 * Shared helper functions used across the application.
 * No dependencies on other project modules (except uuid).
 */

const { v4: uuidv4 } = require("uuid");

/**
 * Sanitize user input to prevent XSS and injection attacks.
 * Encodes HTML entities: & < > " '
 * Returns sanitized string or original value if not a string.
 *
 * @param {any} input - The input to sanitize
 * @returns {string} - Sanitized string
 */
function sanitizeInput(input) {
  if (!input || typeof input !== "string") return input;

  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
    .trim();
}

/**
 * Check if initial setup is needed.
 * Returns true if state file doesn't exist or has empty doors/yardSlots.
 * Used at startup to determine if setup wizard should be shown.
 *
 * @param {string} stateFilePath - Path to state.json
 * @param {object} fs - Node.js fs module
 * @returns {boolean} - True if setup needed
 */
function isSetupNeeded(stateFilePath, fs) {
  if (!fs.existsSync(stateFilePath)) {
    return true;
  }
  try {
    const content = fs.readFileSync(stateFilePath, "utf-8");
    const state = JSON.parse(content);
    return (
      (!state.doors || state.doors.length === 0) &&
      (!state.yardSlots || state.yardSlots.length === 0)
    );
  } catch (e) {
    return true;
  }
}

/**
 * Generate initial facility configuration.
 * Creates door and yard slot arrays based on parameters.
 * Supports numbered dock doors, dumpsters (blank doors with label), and ramps (blank doors with label).
 *
 * @param {object} options - Configuration options
 * @param {number} options.numDoors - Number of regular dock doors
 * @param {number} options.numYardSlots - Number of yard slots
 * @param {number} options.numDumpsters - Number of dumpster areas (blank doors)
 * @param {number} options.numRamps - Number of ramp areas (blank doors)
 * @param {number} options.doorStart - Starting number for doors (default 1)
 * @param {number} options.yardStart - Starting number for yard slots (default 1)
 * @returns {object} - { doors: Array, yardSlots: Array }
 */
function generateFacilityConfig({
  numDoors = 57,
  numYardSlots = 30,
  numDumpsters = 0,
  numRamps = 0,
  doorStart = 1,
  yardStart = 1,
}) {
  const doors = [];
  let order = 0;

  // Create regular dock doors with sequential numbers starting from doorStart
  for (let i = 0; i < numDoors; i++) {
    const doorNum = doorStart + i;
    doors.push({
      id: `door-${doorNum}`,
      number: doorNum,
      order: order++,
      trailerId: null,
      status: "empty",
      inService: true,
      type: "normal",
    });
  }

  // Create dumpsters as blank-type doors with custom labels
  // Blank doors have number: null and use labelText for display
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

  // Create ramps as blank-type doors with custom labels
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

  // Create yard slots with sequential numbers starting from yardStart
  const yardSlots = Array.from({ length: numYardSlots }, (_, i) => {
    const yardNum = yardStart + i;
    return {
      id: `yard-${yardNum}`,
      number: yardNum,
      trailerId: null,
    };
  });

  return { doors, yardSlots };
}

module.exports = {
  uuidv4,
  sanitizeInput,
  isSetupNeeded,
  generateFacilityConfig,
};
