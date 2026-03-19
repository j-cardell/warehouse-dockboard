/**
 * Yard routes
 * GET /yard-slots, POST /yard-slots, PUT /yard-slots/:id, DELETE /yard-slots/:id, POST /yard-slots/reorder
 *
 * Manages numbered yard slots for organized trailer storage.
 * Each slot can optionally hold one trailer.
 */

/**
 * Yard routes
 * GET /yard-slots, POST /yard-slots, PUT /yard-slots/:id, DELETE /yard-slots/:id, POST /yard-slots/reorder
 *
 * Manages numbered yard slots for organized trailer storage.
 * Each slot can optionally hold one trailer.
 */

const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const { requireAuth, requireRole } = require("../middleware");
const { broadcastStateChange } = require("../sse");
const { loadState, saveState, addHistoryEntry } = require("../state");

// Get all yard slots
router.get("/", requireAuth, (req, res) => {
  const facilityId = req.user.currentFacility || req.user.homeFacility;
  const state = loadState(facilityId);
  res.json({ slots: state.yardSlots || [] });
});

// Reorder yard slots
router.post("/reorder", requireAuth, requireRole("user"), (req, res) => {
  const facilityId = req.user.currentFacility || req.user.homeFacility;
  const { slotIds } = req.body;
  const state = loadState(facilityId);

  const validIds = slotIds.filter((id) =>
    state.yardSlots.find((s) => s.id === id),
  );

  const reorderedSlots = validIds.map((id, index) => {
    const slot = state.yardSlots.find((s) => s.id === id);
    return { ...slot, order: index };
  });

  // Add any missing slots at the end
  const missingSlots = state.yardSlots.filter((s) => !validIds.includes(s.id));
  reorderedSlots.push(
    ...missingSlots.map((s, i) => ({ ...s, order: validIds.length + i })),
  );

  state.yardSlots = reorderedSlots;
  saveState(state, facilityId);

  broadcastStateChange("yard", "update", { slots: state.yardSlots }, facilityId);

  res.json({ success: true, slots: state.yardSlots });
});

// Update yard slot
router.put("/:id", requireAuth, requireRole("user"), (req, res) => {
  const facilityId = req.user.currentFacility || req.user.homeFacility;
  const { id } = req.params;
  const { number } = req.body;
  const state = loadState(facilityId);

  const slot = state.yardSlots.find((s) => s.id === id);
  if (!slot) {
    return res.status(404).json({ error: "Yard slot not found" });
  }

  if (number !== undefined) {
    if (state.yardSlots.find((s) => s.number === number && s.id !== id)) {
      return res.status(409).json({ error: "Yard slot number already exists" });
    }

    const oldNumber = slot.number;
    slot.number = number;

    if (slot.trailerId) {
      const trailer = state.trailers.find((t) => t.id === slot.trailerId);
      if (trailer) {
        trailer.yardSlotNumber = number;
      }
    }

    addHistoryEntry("YARD_SLOT_UPDATED", {
      slotId: id,
      oldNumber,
      newNumber: number,
    }, req.user, facilityId);
  }

  saveState(state, facilityId);

  broadcastStateChange("yard", "update", { slot }, facilityId);

  res.json({ success: true, slot });
});

// Create new yard slot
router.post("/", requireAuth, requireRole("user"), (req, res) => {
  const facilityId = req.user.currentFacility || req.user.homeFacility;
  const { number } = req.body;
  const state = loadState(facilityId);

  const slotNumber =
    number ||
    (state.yardSlots.length > 0
      ? Math.max(...state.yardSlots.map((s) => s.number)) + 1
      : 1);

  if (state.yardSlots.find((s) => s.number === slotNumber)) {
    return res.status(409).json({ error: "Yard slot number already exists" });
  }

  const newSlot = {
    id: `yard-${uuidv4()}`,
    number: slotNumber,
    trailerId: null,
  };

  state.yardSlots.push(newSlot);
  saveState(state, facilityId);

  broadcastStateChange("yard", "create", { slot: newSlot }, facilityId);

  addHistoryEntry("YARD_SLOT_CREATED", {
    slotId: newSlot.id,
    number: slotNumber,
  }, req.user, facilityId);

  res.json({ success: true, slot: newSlot });
});

// Delete yard slot
router.delete("/:id", requireAuth, requireRole("user"), (req, res) => {
  const facilityId = req.user.currentFacility || req.user.homeFacility;
  const { id } = req.params;
  const state = loadState(facilityId);

  const slotIndex = state.yardSlots.findIndex((s) => s.id === id);
  if (slotIndex === -1) {
    return res.status(404).json({ error: "Yard slot not found" });
  }

  const slot = state.yardSlots[slotIndex];

  if (slot.trailerId) {
    const trailer = state.trailers.find((t) => t.id === slot.trailerId);
    if (trailer) {
      trailer.location = "yard";
      delete trailer.yardSlotId;
      delete trailer.yardSlotNumber;
      if (!state.yardTrailers.find((t) => t.id === trailer.id)) {
        state.yardTrailers.push(trailer);
      }
      state.trailers = state.trailers.filter((t) => t.id !== trailer.id);
    }
  }

  state.yardSlots.splice(slotIndex, 1);
  saveState(state, facilityId);

  broadcastStateChange("yard", "delete", { slotId: id, slot }, facilityId);

  addHistoryEntry("YARD_SLOT_DELETED", {
    slotId: id,
    number: slot.number,
  }, req.user, facilityId);

  res.json({ success: true });
});

module.exports = router;
