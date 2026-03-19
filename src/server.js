// Load environment variables from .env file if it exists
// Falls back to system environment variables
require("dotenv").config();

/**
 * Warehouse Dock Board Server - Main Entry Point
 *
 * Environment Setup:
 * Copy .env.example to .env and configure your settings:
 *   cp .env.example .env
 *   # Edit .env with your secure values
 *
 * Required environment variables:
 * - AUTH_PASS: Password for web login (must be changed from default)
 * - JWT_SECRET: Secret for token signing (generate with: openssl rand -hex 32)
 *
 * Architecture:
 * - Modular Express application with routes split by domain
 * - JSON file-based persistence (no database required)
 * - JWT authentication with fallback to Basic auth
 * - Real-time trailer tracking with movement history
 *
 * Module Structure:
 * - config.js     - Environment variables and constants
 * - state.js      - Data persistence functions (load/save JSON)
 * - utils.js      - Helper functions (sanitize, generate configs)
 * - middleware.js - Auth, rate limiting, headers
 * - analytics.js  - Dwell time calculations and statistics
 * - routes/*.js   - API endpoints organized by domain
 *
 * Data Flow:
 * 1. Request comes in via Express router
 * 2. Protected routes use requireAuth middleware
 * 3. Route handler calls loadState() to get current data
 * 4. Business logic modifies state in memory
 * 5. saveState(state) persists to JSON file
 * 6. addHistoryEntry() logs the action for audit trail
 *
 * To add a new API endpoint:
 * 1. Create route in appropriate routes/*.js file
 * 2. Import required functions from state.js
 * 3. Use requireAuth for protected routes
 * 4. Call loadState(), modify, saveState(), addHistoryEntry()
 * 5. Mount in this file: app.use('/api/my-route', require('./routes/my-route'))
 */

const express = require("express");
const path = require("path");
const cors = require("cors");
const fs = require("fs");

// Import configuration and utilities
const { PORT, DATA_DIR, STATE_FILE, AUTH_USER } = require("./config");
const { isSetupNeeded } = require("./utils");

// Import middleware
const { cacheHeaders, validateAuthConfig } = require("./middleware");

// Import state management
const { ensureDataDirs, loadState } = require("./state");

// Import analytics
const { calculateDailyDwell } = require("./analytics");
const { MULTI_FACILITY_MODE } = require("./config");
const { getAllFacilities } = require("./facilities");

// Import SSE
const { handleSSE } = require("./sse");

// Create Express app
const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(cors());
app.use(express.json({ limit: "50mb" }));

// Ensure data directories exist
ensureDataDirs(DATA_DIR);

// Validate auth configuration (exits if invalid)
validateAuthConfig();

// Sync bootstrap admin password if AUTH_PASS changed in environment
// This allows updating the bootstrap admin password by changing the env var
(async function syncBootstrapPassword() {
  const { AUTH_PASS, MULTI_FACILITY_MODE } = require("./config");
  const { hasUsers, findUserByUsername, findGlobalUserByUsername, verifyPassword, updateUser, updateGlobalUser } = require("./users");
  const { DEFAULT_FACILITY_ID } = require("./config");

  if (!hasUsers()) return; // No users yet - will be created on first login

  const { AUTH_USER } = require("./config");

  // In multi-facility mode, bootstrap admin is a global user
  // In single facility mode, bootstrap admin is in the default facility
  let user = null;
  let isGlobalUser = false;

  if (MULTI_FACILITY_MODE) {
    user = findGlobalUserByUsername(AUTH_USER);
    isGlobalUser = true;
  }

  // If not found as global user, try facility-specific
  if (!user) {
    user = findUserByUsername(AUTH_USER);
    isGlobalUser = false;
  }

  if (!user) {
    console.log("[Auth] Bootstrap user not found in database");
    return;
  }

  try {
    // Check if current password matches AUTH_PASS
    const passwordMatches = await verifyPassword(AUTH_PASS, user.passwordHash);
    if (passwordMatches) return; // Already synced

    // Update bootstrap user password to match AUTH_PASS
    let result;
    if (isGlobalUser) {
      result = await updateGlobalUser(user.id, { password: AUTH_PASS });
    } else {
      result = await updateUser(user.id, { password: AUTH_PASS }, DEFAULT_FACILITY_ID);
    }

    if (result.success) {
      console.log("[Auth] Bootstrap admin password synced from environment");
    } else {
      console.error("[Auth] Failed to sync bootstrap admin password:", result.error);
    }
  } catch (err) {
    console.error("[Auth] Error syncing bootstrap password:", err.message);
  }
})();

// Prevent caching of API responses
app.use("/api", cacheHeaders);

// Mount routes - see individual route files for endpoint documentation
app.use("/api/auth", require("./routes/auth"));
app.use("/api/users", require("./routes/users"));
app.use("/api/user", require("./routes/user-settings"));
app.use("/api/setup", require("./routes/setup"));
app.use("/api/settings", require("./routes/settings"));
app.use("/api/archives", require("./routes/archives"));
app.use("/api/demo", require("./routes/demo"));
app.get("/api/health", (req, res) =>
  res.json({ status: "ok", timestamp: new Date().toISOString() }),
);
app.use("/api/state", require("./routes/state"));
app.use("/api/history", require("./routes/history"));

// Trailers routes (mounted at multiple paths)
const trailersRouter = require("./routes/trailers");
app.use("/api/trailers", trailersRouter);

// Shipped trailer deletion (special case)
app.delete("/api/shipped/:id", trailersRouter);

// Move routes - these need to be at specific paths
const movesRouter = require("./routes/moves");
app.use("/api", movesRouter);

// Door routes
const doorsRouter = require("./routes/doors");
app.use("/api/doors", doorsRouter);

// Yard routes
const yardRouter = require("./routes/yard");
app.use("/api/yard-slots", yardRouter);

// Queue routes
const queuesRouter = require("./routes/queues");
app.use("/api", queuesRouter);

// Carrier routes
const carriersRouter = require("./routes/carriers");
app.use("/api/carriers", carriersRouter);

// Analytics routes
app.use("/api/analytics", require("./routes/analytics"));

// Facilities routes (multi-facility support)
app.use("/api/facilities", require("./routes/facilities"));

// SSE endpoint for real-time updates
app.get("/api/events", handleSSE);

// SSE endpoint for real-time updates
app.get("/api/events", handleSSE);

// Static files - serves the vanilla JavaScript SPA frontend from public/
app.use(express.static(path.join(__dirname, "../public")));

// Start server - bind to 0.0.0.0 to accept connections from outside container
app.listen(PORT, "0.0.0.0", () => {
  // Check if setup is needed - in multi-facility mode, check if facilities exist
  let needsSetup;
  if (MULTI_FACILITY_MODE) {
    const facilities = getAllFacilities();
    needsSetup = facilities.length === 0;
  } else {
    const state = loadState();
    needsSetup = isSetupNeeded(STATE_FILE, fs);
  }

  let doorCount = 0;
  let yardSlotCount = 0;
  let facilityCount = 0;
  if (!needsSetup) {
    if (MULTI_FACILITY_MODE) {
      // Aggregate across all facilities
      const facilities = getAllFacilities();
      facilityCount = facilities.length;
      facilities.forEach(f => {
        const state = loadState(f.id);
        doorCount += state.doors?.length || 0;
        yardSlotCount += state.yardSlots?.length || 0;
      });
    } else {
      const state = loadState();
      doorCount = state.doors?.length || 0;
      yardSlotCount = state.yardSlots?.length || 0;
    }
  }

  const boxWidth = 44;
  const padLine = (content) => content.padEnd(boxWidth - 2);

  console.log(`╔${'═'.repeat(boxWidth - 2)}╗`);
  console.log(`║${padLine('      Warehouse Dock Board Server')}║`);
  console.log(`╠${'═'.repeat(boxWidth - 2)}╣`);
  console.log(`║${padLine(`  🌐 http://0.0.0.0:${PORT} (all interfaces)`)}║`);
  console.log(`║${padLine('  📁 Data: ./data/')}║`);
  if (needsSetup) {
    console.log(`║${padLine('  ⚠️  First run - Setup required')}║`);
  } else {
    if (MULTI_FACILITY_MODE && facilityCount > 0) {
      console.log(`║${padLine(`  🏭 Facilities: ${facilityCount}`)}║`);
    }
    console.log(`║${padLine(`  🚪 Doors: ${doorCount}`)}║`);
    console.log(`║${padLine(`  🅿️ Yard Slots: ${yardSlotCount}  `)} ║`);
  }
  console.log(`║${padLine(`  🔒 Auth: ${AUTH_USER}`)}║`);
  console.log(`╚${'═'.repeat(boxWidth - 2)}╝`);

  if (!needsSetup) {
    // Calculate daily dwell analytics once per day for all facilities
    setInterval(
      () => {
        const today = new Date().toISOString().split("T")[0];
        if (MULTI_FACILITY_MODE) {
          const facilities = getAllFacilities();
          facilities.forEach(f => calculateDailyDwell(today, f.id));
        } else {
          calculateDailyDwell(today);
        }
      },
      24 * 60 * 60 * 1000,
    ); // Once per day

    // Initial calculation for today
    if (MULTI_FACILITY_MODE) {
      const facilities = getAllFacilities();
      facilities.forEach(f => calculateDailyDwell(new Date().toISOString().split("T")[0], f.id));
    } else {
      calculateDailyDwell(new Date().toISOString().split("T")[0]);
    }
    console.log(
      "[Analytics] Daily dwell analytics active - calculated from history",
    );
  } else {
    console.log("[Setup] Server ready for initial configuration");
    console.log(
      "[Setup] Visit http://localhost:" + PORT + " to complete setup",
    );
  }
});
