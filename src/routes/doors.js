/**
 * Door routes
 * POST /doors, PUT /doors/:id, DELETE /doors/:id, POST /doors/reorder, POST /doors/:id/assign-next
 *
 * Manages dock door configuration including adding/removing doors,
 * reordering layout, marking in/out of service, and auto-assignment
 * of queued trailers to available doors.
 */

/**
 * Door routes
 * POST /doors, PUT /doors/:id, DELETE /doors/:id, POST /doors/reorder, POST /doors/:id/assign-next
 *
 * Manages dock door configuration including adding/removing doors,
 * reordering layout, marking in/out of service, and auto-assignment
 * of queued trailers to available doors.
 */

const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const { requireAuth, requireRole } = require("../middleware");
const { loadState, saveState, addHistoryEntry } = require("../state");
const { sanitizeInput } = require("../utils");
const { broadcastStateChange } = require("../sse");
// Reorder doors (customize layout)
router.post("/reorder", requireAuth, requireRole("user"), (req, res) => {
  const { doorIds } = req.body;
  const facilityId = req.user?.currentFacility || req.user?.homeFacility || 'default';
  const state = loadState(facilityId);

  const validIds = doorIds.filter((id) => state.doors.find((d) => d.id === id));

  const reorderedDoors = validIds.map((id, index) => {
    const door = state.doors.find((d) => d.id === id);
    return { ...door, order: index };
  });

  const missingDoors = state.doors.filter((d) => !validIds.includes(d.id));
  reorderedDoors.push(
    ...missingDoors.map((d, i) => ({ ...d, order: validIds.length + i })),
  );

  state.doors = reorderedDoors;
  saveState(state, facilityId);

  // Broadcast update to all clients
  broadcastStateChange("door", "update", { doors: state.doors }, facilityId);

  res.json({ success: true, doors: state.doors });
});

// Update door (in/out of service, type, etc.)
router.put("/:id", requireAuth, requireRole("user"), (req, res) => {
  const { id } = req.params;
  const { inService, type, number, labelText, order } = req.body;
  const facilityId = req.user?.currentFacility || req.user?.homeFacility || 'default';
  const state = loadState(facilityId);

  const door = state.doors.find((d) => d.id === id);
  if (!door) {
    return res.status(404).json({ error: "Door not found" });
  }

  if (number !== undefined) {
    const newNum = number === null || number === "" ? null : parseInt(number);
    door.number = newNum;
  }

  if (inService !== undefined) door.inService = inService;
  if (type !== undefined) door.type = type;
  if (labelText !== undefined)
    door.labelText = labelText ? sanitizeInput(labelText) : null;
  if (order !== undefined) door.order = order;

  saveState(state, facilityId);

  // Broadcast update to all clients
  broadcastStateChange("door", "update", { doors: state.doors }, facilityId);

  addHistoryEntry("DOOR_UPDATED", {
    doorId: id,
    doorNumber: door.number,
    labelText: door.labelText,
    inService: door.inService,
    type: door.type,
  }, req.user);

  res.json({ success: true, door });
});

// Create new door
router.post("/", requireAuth, requireRole("user"), (req, res) => {
  const { number, type = "normal", labelText } = req.body;
  const facilityId = req.user?.currentFacility || req.user?.homeFacility || 'default';
  const state = loadState(facilityId);

  const num = number ? parseInt(number) : null;

  const nextOrder = Math.max(...state.doors.map((d) => d.order || 0), 0) + 1;

  const newDoor = {
    id: `door-${uuidv4()}`,
    number: num,
    order: nextOrder,
    labelText: labelText ? sanitizeInput(labelText) : null,
    trailerId: null,
    status: "empty",
    inService: type !== "out-of-service",
    type: type,
  };

  state.doors.push(newDoor);
  state.doors.sort(
    (a, b) =>
      (a.order || 999) - (b.order || 999) ||
      (a.number || 999) - (b.number || 999),
  );
  saveState(state, facilityId);

  // Broadcast update to all clients
  broadcastStateChange("door", "update", { doors: state.doors }, facilityId);

  addHistoryEntry("DOOR_CREATED", {
    doorId: newDoor.id,
    doorNumber: newDoor.number,
    doorLabel: newDoor.labelText,
    type: newDoor.type,
  }, req.user);

  res.json({ success: true, door: newDoor });
});

// Delete door
router.delete("/:id", requireAuth, requireRole("user"), (req, res) => {
  const { id } = req.params;
  const facilityId = req.user?.currentFacility || req.user?.homeFacility || 'default';
  const state = loadState(facilityId);

  const doorIndex = state.doors.findIndex((d) => d.id === id);
  if (doorIndex === -1) {
    return res.status(404).json({ error: "Door not found" });
  }

  const door = state.doors[doorIndex];

  // Move any trailer in the door to unassigned yard
  if (door.trailerId) {
    const trailer = state.trailers.find((t) => t.id === door.trailerId);
    if (trailer) {
      trailer.location = "yard";
      trailer.doorId = null;
      trailer.doorNumber = null;
      state.yardTrailers.push(trailer);
      state.trailers = state.trailers.filter((t) => t.id !== door.trailerId);
    }
  }

  // Move any trailers queued for this door to staging (if empty)
  const orphanedQueue = (state.queuedTrailers || []).filter(
    (t) => t.targetDoorId === door.id
  );
  for (const trailer of orphanedQueue) {
    trailer.location = "staging";
    trailer.targetDoorId = null;
    trailer.targetDoorNumber = null;
    trailer.queuedAt = null;
    // Only move to staging if it's empty, otherwise to unassigned yard
    if (!state.staging) {
      state.staging = trailer;
    } else {
      state.yardTrailers.push(trailer);
    }
  }
  state.queuedTrailers = state.queuedTrailers.filter(
    (t) => t.targetDoorId !== door.id
  );

  state.doors.splice(doorIndex, 1);
  saveState(state, facilityId);

  // Broadcast update to all clients
  broadcastStateChange("door", "update", { doors: state.doors }, facilityId);

  // Add history entry for door deletion
  addHistoryEntry("DOOR_DELETED", {
    doorId: id,
    doorNumber: door.number,
  }, req.user);

  // Add history entries for moved trailers
  if (door.trailerId) {
    const trailer = state.yardTrailers.find((t) => t.id === door.trailerId);
    if (trailer) {
      addHistoryEntry("MOVED_TO_YARD", {
        trailerId: trailer.id,
        trailerNumber: trailer.number,
        carrier: trailer.carrier,
        customer: trailer.customer,
        from: `Door ${door.number}`,
        reason: "Door deleted",
      }, req.user);
    }
  }

  for (const trailer of orphanedQueue) {
    const toLocation = state.staging?.id === trailer.id ? "Staging" : "Unassigned Yard";
    addHistoryEntry("MOVED_TO_STAGING", {
      trailerId: trailer.id,
      trailerNumber: trailer.number,
      carrier: trailer.carrier,
      customer: trailer.customer,
      from: `Queue for Door ${door.number}`,
      to: toLocation,
      reason: "Door deleted",
    }, req.user);
  }

  res.json({ success: true });
});

// Assign next queued trailer to a door (called when door becomes available)
router.post("/:id/assign-next", requireAuth, requireRole("user"), (req, res) => {
  const { id } = req.params;
  const facilityId = req.user?.currentFacility || req.user?.homeFacility || 'default';
  const state = loadState(facilityId);

  if (!state.queuedTrailers || state.queuedTrailers.length === 0) {
    return res.json({ success: false, message: "No trailers in queue" });
  }

  // Find oldest queued trailer for this door
  const queuedIndex = state.queuedTrailers.findIndex(
    (t) => t.targetDoorId === id,
  );
  if (queuedIndex === -1) {
    return res.json({
      success: false,
      message: "No trailers queued for this door",
    });
  }

  const door = state.doors.find((d) => d.id === id);
  if (!door) {
    return res.status(404).json({ error: "Door not found" });
  }

  if (door.trailerId) {
    return res.status(400).json({ error: "Door is still occupied" });
  }

  const trailer = state.queuedTrailers[queuedIndex];

  // Move trailer to door
  trailer.doorId = door.id;
  trailer.doorNumber = door.number;
  trailer.location = null;
  trailer.targetDoorId = null;
  trailer.targetDoorNumber = null;
  trailer.queuedAt = null;

  door.trailerId = trailer.id;
  door.status = trailer.status;

  // Remove from queue
  state.queuedTrailers.splice(queuedIndex, 1);

  // Add to trailers array
  state.trailers.push(trailer);

  saveState(state, facilityId);

  // Broadcast update to all clients
  broadcastStateChange("door", "update", { doors: state.doors }, facilityId);

  addHistoryEntry("TRAILER_ASSIGNED_FROM_QUEUE", {
    trailerId: trailer.id,
    trailerNumber: trailer.number,
    carrier: trailer.carrier,
    customer: trailer.customer,
    toDoor: door.number,
    doorId: door.id,
  }, req.user);

  res.json({ success: true, trailer, door });
});

module.exports = router;
