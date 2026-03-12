/**
 * Demo Data routes
 * POST /api/demo/generate - Generate demo data (bootstrap admin only)
 *
 * Triggers the generate-demo-data.js script to populate
 * the system with sample trailers for testing.
 */

const express = require("express");
const router = express.Router();
const { exec } = require("child_process");
const path = require("path");
const { requireAuth } = require("../middleware");
const { isBootstrapAdmin, findUserById, findGlobalUserById } = require("../users");
const { MULTI_FACILITY_MODE } = require("../config");

// POST /api/demo/generate - Generate demo data (bootstrap admin only)
router.post("/generate", requireAuth, async (req, res) => {
  try {
    // Get the requesting user from the auth token
    const userId = req.user?.userId;
    const facilityId = req.user?.currentFacility;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    let user = findUserById(userId, facilityId);
    if (!user) {
      // In multi-facility mode, also check global users (bootstrap admin)
      if (MULTI_FACILITY_MODE) {
        user = findGlobalUserById(userId);
      }
    }

    if (!user) {
      return res.status(401).json({ error: "User not found" });
    }

    // Only bootstrap admin can generate demo data
    if (!isBootstrapAdmin(user)) {
      return res.status(403).json({
        error: "Only the bootstrap admin can generate demo data",
      });
    }

    // Get optional count from request body
    const count = req.body?.count || 0; // 0 means auto-scale based on facility

    // Run the generate-demo-data.js script with facility ID
    const scriptPath = path.join(__dirname, "..", "..", "scripts", "generate-demo-data.js");
    // Always pass count first, then facilityId (count can be 0 for auto-scale)
    const cmd = `node "${scriptPath}" ${count}${facilityId ? ` "${facilityId}"` : ""}`;

    exec(cmd, { timeout: 30000, env: { ...process.env, MULTI_FACILITY_MODE: MULTI_FACILITY_MODE ? 'true' : 'false' } }, (error, stdout, stderr) => {
      if (error) {
        console.error("Demo data generation error:", error);
        return res.status(500).json({
          error: "Failed to generate demo data",
          details: error.message,
        });
      }

      if (stderr) {
        console.error("Demo data stderr:", stderr);
      }

      console.log("Demo data output:", stdout);

      res.json({
        success: true,
        message: "Demo data generated successfully",
        output: stdout,
      });
    });
  } catch (error) {
    console.error("Demo data generation error:", error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
