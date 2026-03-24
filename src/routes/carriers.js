/**
 * Carrier routes
 * GET /carriers, POST /carriers, PUT /carriers/:id/favorite, POST /carriers/:id/use, DELETE /carriers/:id
 *
 * Manages the carrier registry with favorite status and usage tracking.
 * Carriers are auto-created when new trailer carriers were encountered.
 */

const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const { requireAuth, requireRole } = require("../middleware");
const { broadcastStateChange } = require("../sse");
const { loadState, saveState, addHistoryEntry } = require("../state");
const { sanitizeInput } = require("../utils");

// Get all carriers (requires authentication)
router.get("/", requireAuth, (req, res) => {
  const facilityId = req.user?.currentFacility || req.user?.homeFacility;
  const state = loadState(facilityId);
  res.json({ carriers: state.carriers || [] });
});

// Add/update carrier
router.post("/", requireAuth, requireRole("user"), (req, res) => {
  const { name, mcNumber, favorite = false } = req.body;
  const facilityId = req.user?.currentFacility || req.user?.homeFacility;

  if (!name) {
    return res.status(400).json({ error: "Carrier name is required" });
  }

  const state = loadState(facilityId);

  const carrier = {
    id: uuidv4(),
    name: sanitizeInput(name),
    mcNumber: mcNumber ? sanitizeInput(mcNumber) : "",
    favorite,
    createdAt: new Date().toISOString(),
  };

  state.carriers.push(carrier);
  saveState(state, facilityId);

  broadcastStateChange("carrier", "create", { carrier }, facilityId);

  res.json({ success: true, carrier });
});

// Update carrier favorite status
router.put("/:id/favorite", requireAuth, requireRole("user"), (req, res) => {
  const { id } = req.params;
  const { favorite } = req.body;
  const facilityId = req.user?.currentFacility || req.user?.homeFacility;
  const state = loadState(facilityId);

  const carrier = state.carriers.find((c) => c.id === id);
  if (!carrier) {
    return res.status(404).json({ error: "Carrier not found" });
  }

  carrier.favorite = favorite;
  saveState(state, facilityId);

  broadcastStateChange("carrier", "update", { carrier }, facilityId);

  res.json({ success: true, carrier });
});

// Increment carrier usage count
router.post("/:id/use", requireAuth, requireRole("user"), (req, res) => {
  const { id } = req.params;
  const facilityId = req.user?.currentFacility || req.user?.homeFacility;
  const state = loadState(facilityId);

  const carrier = state.carriers.find((c) => c.id === id);
  if (!carrier) {
    return res.status(404).json({ error: "Carrier not found" });
  }

  carrier.usageCount = (carrier.usageCount || 0) + 1;
  saveState(state, facilityId);

  broadcastStateChange("carrier", "update", { carrier }, facilityId);

  res.json({ success: true, carrier });
});

// Delete carrier
router.delete("/:id", requireAuth, requireRole("user"), (req, res) => {
  const { id } = req.params;
  const facilityId = req.user?.currentFacility || req.user?.homeFacility;
  const state = loadState(facilityId);

  const carrierIndex = state.carriers.findIndex((c) => c.id === id);
  if (carrierIndex === -1) {
    return res.status(404).json({ error: "Carrier not found" });
  }

  const carrier = state.carriers[carrierIndex];

  const inUse =
    state.trailers.some((t) => t.carrier === carrier.name) ||
    state.yardTrailers.some((t) => t.carrier === carrier.name);
  if (inUse) {
    return res.status(400).json({ error: "Carrier is assigned to trailers" });
  }

  state.carriers.splice(carrierIndex, 1);
  saveState(state, facilityId);

  broadcastStateChange("carrier", "delete", { carrierId: id, carrier }, facilityId);

  addHistoryEntry("CARRIER_DELETED", {
    carrierId: id,
    carrierName: carrier.name,
  }, req.user, facilityId);

  res.json({ success: true });
});

module.exports = router;
