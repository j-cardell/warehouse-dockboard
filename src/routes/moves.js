/**
 * Move routes - Trailer movement operations
 *
 * Handles moving trailers between locations:
 * - Yard → Door (dock assignment)
 * - Door → Yard (clearing a door)
 * - Yard → Yard Slot (assigned spot)
 * - Yard Slot → Yard (unassign from slot)
 *
 * Movement rules:
 * - Moving to a door clears any existing trailer there (moved to yard)
 * - Dwell time resets on every move (for analytics)
 * - Moving from a door triggers auto-assignment from queue
 * - Trailers can be found in multiple locations: state.trailers (docked),
 *   state.yardTrailers (unassigned), state.staging, state.queuedTrailers
 *
 * Auto-assignment: When a door clears, if trailers are queued for that door,
 * the oldest queued trailer is automatically assigned (FCFS).
 */

const express = require("express");
const router = express.Router();
const { requireAuth, requireRole } = require("../middleware");
const { loadState, saveState, addHistoryEntry } = require("../state");
const { resetDwellTime } = require("../analytics");
const { broadcastStateChange } = require("../sse");

/**
 * POST /api/move-to-door
 * Move a trailer to a dock door.
 *
 * Body: { trailerId: string, doorId: string, previousDoorId?: string }
 *
 * Side effects:
 * - Removes trailer from yard/queue/staging
 * - If door occupied, moves existing trailer to yard
 * - Updates trailer.doorId and trailer.doorNumber
 * - Triggers auto-assignment if door was previously occupied
 * - Resets dwell time
 */
router.post("/move-to-door", requireAuth, requireRole("user"), (req, res) => {
  const { trailerId, doorId, previousDoorId } = req.body;
  const facilityId = req.user?.currentFacility || req.user?.homeFacility;
  const state = loadState(facilityId);

  // Find trailer in any location (docked trailers, unassigned yard, queue, staging, appointment queue)
  let trailer =
    state.trailers.find((t) => t.id === trailerId) ||
    state.yardTrailers.find((t) => t.id === trailerId) ||
    state.queuedTrailers?.find((t) => t.id === trailerId) ||
    state.appointmentQueue?.find((t) => t.id === trailerId) ||
    (state.staging?.id === trailerId ? state.staging : null);

  if (!trailer) {
    return res.status(404).json({ error: "Trailer not found" });
  }

  // Check if trailer was queued - if so, remember the target door for history
  const wasQueued = trailer.location === "queued";
  const oldTargetDoorId = wasQueued ? trailer.targetDoorId : null;

  // Find target door - supports 'door-1', 1, or door object ID
  const door = state.doors.find(
    (d) =>
      d.id === doorId ||
      d.number === parseInt(doorId) ||
      d.id === `door-${doorId}`,
  );
  if (!door) {
    return res.status(404).json({ error: "Door not found" });
  }

  // Validate door can accept trailers
  if (door.inService === false) {
    return res.status(400).json({ error: "Door is out of service" });
  }
  if (door.type === "blank") {
    return res
      .status(400)
      .json({ error: "Cannot place trailer in a blank door" });
  }

  // If door is occupied, move existing trailer back to unassigned yard
  if (door.trailerId) {
    const existingTrailer = state.trailers.find((t) => t.id === door.trailerId);
    if (existingTrailer) {
      existingTrailer.location = "yard";
      delete existingTrailer.doorId;
      delete existingTrailer.doorNumber;
      state.yardTrailers.push(existingTrailer);
      state.trailers = state.trailers.filter((t) => t.id !== door.trailerId);

      // Log the displacement
      addHistoryEntry("MOVED_TO_YARD", {
        trailerId: existingTrailer.id,
        trailerNumber: existingTrailer.number,
        carrier: existingTrailer.carrier,
        customer: existingTrailer.customer,
        fromDoor: door.number,
        reason: "Replaced by new trailer",
      }, req.user);
    }
  }

  // Track the door being vacated (for auto-assignment later)
  const oldDoor = state.doors.find((d) => d.trailerId === trailerId);
  let previousLocation = "Yard";
  let fromDoorNum = null;
  let oldDoorId = null;
  let oldDoorNumber = null;

  if (oldDoor) {
    fromDoorNum = oldDoor.number;
    oldDoorId = oldDoor.id;
    oldDoorNumber = oldDoor.number;
    previousLocation = `Door ${oldDoor.number}`;
    oldDoor.trailerId = null;
    oldDoor.status = "empty";
  }

  // Update previous location string if trailer was queued
  if (wasQueued) {
    const targetDoor = state.doors.find((d) => d.id === oldTargetDoorId);
    previousLocation = `Queue (was for Door ${targetDoor?.number || "?"})`;
  }

  // Clear trailer from any yard slot it's currently in
  const oldSlot = state.yardSlots.find((s) => s.trailerId === trailerId);
  if (oldSlot) {
    oldSlot.trailerId = null;
    if (!fromDoorNum) {
      previousLocation = `Yard Slot ${oldSlot.number}`;
    }
  }

  // Update trailer to be docked
  trailer.location = "door";
  trailer.doorId = door.id;
  trailer.doorNumber = door.number;
  delete trailer.yardSlotId;
  delete trailer.yardSlotNumber;

  // Remove from unassigned yard
  state.yardTrailers = state.yardTrailers.filter((t) => t.id !== trailerId);

  // Remove from queue if present
  if (state.queuedTrailers) {
    state.queuedTrailers = state.queuedTrailers.filter(
      (t) => t.id !== trailerId,
    );
  }
  // Remove from appointment queue if present
  if (state.appointmentQueue) {
    state.appointmentQueue = state.appointmentQueue.filter(
      (t) => t.id !== trailerId,
    );
  }
  // Clear queue-specific fields
  delete trailer.targetDoorId;
  delete trailer.targetDoorNumber;

  // Clear staging if trailer was there
  if (state.staging && state.staging.id === trailerId) {
    state.staging = null;
  }

  // Add to docked trailers array
  if (!state.trailers.find((t) => t.id === trailerId)) {
    state.trailers.push(trailer);
  }

  // Assign to door
  door.trailerId = trailerId;
  door.status = trailer.status;

  // Reset dwell time for analytics
  resetDwellTime(trailer);

  // Auto-assign: If we vacated a door and there are queued trailers for it, assign the oldest one
  let autoAssigned = null;
  if (oldDoorId) {
    const queuedForDoor = state.queuedTrailers?.filter(
      (t) => t.targetDoorId === oldDoorId,
    );
    if (queuedForDoor && queuedForDoor.length > 0) {
      // Get first in queue (oldest queuedAt)
      const nextTrailer = queuedForDoor[0];
      state.queuedTrailers = state.queuedTrailers.filter(
        (t) => t.id !== nextTrailer.id,
      );

      // Assign to door
      const doorToFill = state.doors.find((d) => d.id === oldDoorId);
      if (doorToFill) {
        doorToFill.trailerId = nextTrailer.id;
        doorToFill.status = nextTrailer.status || "occupied";
      }

      // Move to trailers array with door assignment
      nextTrailer.doorId = oldDoorId;
      nextTrailer.doorNumber = oldDoorNumber;
      nextTrailer.location = "door";
      delete nextTrailer.targetDoorId;
      delete nextTrailer.targetDoorNumber;
      state.trailers.push(nextTrailer);

      autoAssigned = {
        trailerId: nextTrailer.id,
        carrier: nextTrailer.carrier,
        doorNumber: oldDoorNumber,
      };
    }
  }

  saveState(state, facilityId);

  // Broadcast update to all clients
  broadcastStateChange("trailer", "move", { trailer }, facilityId);

  // Broadcast update to all connected clients
  broadcastStateChange("trailer", "move", {
    trailerId: trailer.id,
    from: previousLocation,
    to: `door-${door.number}`,
    doorNumber: door.number
  }, facilityId);

  // Log the movement
  const historyEntry = addHistoryEntry("MOVED_TO_DOOR", {
    trailerId: trailer.id,
    trailerNumber: trailer.number,
    carrier: trailer.carrier,
    customer: trailer.customer,
    doorNumber: door.number,
    status: trailer.status,
    isLive: trailer.isLive,
    previousLocation,
    fromDoorNum,
    cancelledQueue: wasQueued ? true : undefined,
    ...(autoAssigned && {
      autoAssignedToDoor: autoAssigned.doorNumber,
      autoAssignedCarrier: autoAssigned.carrier,
    }),
  }, req.user);

  res.json({ success: true, door, trailer, historyEntry, wasQueued, autoAssigned });
});

/**
 * POST /api/move-to-yard
 * Move a trailer to unassigned yard.
 *
 * Body: { trailerId: string, doorId?: string }
 *
 * If doorId is provided, clears that door and triggers auto-assignment.
 * Used when manually clearing a door or when a trailer is replaced.
 */
router.post("/move-to-yard", requireAuth, requireRole("user"), (req, res) => {
  const { trailerId, doorId } = req.body;
  const facilityId = req.user?.currentFacility || req.user?.homeFacility;
  const state = loadState(facilityId);

  let trailer =
    state.trailers.find((t) => t.id === trailerId) ||
    (state.staging?.id === trailerId ? state.staging : null);
  if (!trailer) {
    return res.status(404).json({ error: "Trailer not found" });
  }

  // Clear any yard slot assignment
  const oldSlot = state.yardSlots.find((s) => s.trailerId === trailerId);
  if (oldSlot) {
    oldSlot.trailerId = null;
  }

  // Move to unassigned yard
  trailer.location = "yard";
  delete trailer.doorId;
  delete trailer.doorNumber;
  delete trailer.yardSlotId;
  delete trailer.yardSlotNumber;

  // Add to unassigned yard
  if (!state.yardTrailers.find((t) => t.id === trailerId)) {
    state.yardTrailers.push(trailer);
  }

  // Remove from docked trailers
  state.trailers = state.trailers.filter((t) => t.id !== trailerId);

  // Clear staging if trailer was there
  if (state.staging?.id === trailerId) {
    state.staging = null;
  }

  // Clear door if specified and track for auto-assignment
  let clearedDoorId = null;
  let clearedDoorNumber = null;
  if (doorId) {
    const door = state.doors.find(
      (d) =>
        d.id === doorId ||
        d.number === parseInt(doorId) ||
        d.id === `door-${doorId}`,
    );
    if (door && door.trailerId === trailerId) {
      door.trailerId = null;
      door.status = "empty";
      clearedDoorId = door.id;
      clearedDoorNumber = door.number;
    }
  }

  // Auto-assign from queue if door was cleared
  let autoAssigned = null;
  if (clearedDoorId) {
    // Check if door is still empty (might have been filled by another concurrent request)
    const door = state.doors.find((d) => d.id === clearedDoorId);
    if (door && door.trailerId) {
      // Door already occupied, skip auto-assign
    } else {
      const queuedForDoor = state.queuedTrailers?.filter(
        (t) => t.targetDoorId === clearedDoorId,
      );
      if (queuedForDoor && queuedForDoor.length > 0) {
        const nextTrailer = queuedForDoor[0];
        state.queuedTrailers = state.queuedTrailers.filter(
          (t) => t.id !== nextTrailer.id,
        );

        if (door) {
          door.trailerId = nextTrailer.id;
          door.status = nextTrailer.status || "occupied";
        }

        nextTrailer.doorId = clearedDoorId;
        nextTrailer.doorNumber = clearedDoorNumber;
        nextTrailer.location = "door";
        delete nextTrailer.targetDoorId;
        delete nextTrailer.targetDoorNumber;
        state.trailers.push(nextTrailer);

        autoAssigned = {
          trailerId: nextTrailer.id,
          carrier: nextTrailer.carrier,
          doorNumber: clearedDoorNumber,
        };
      }
    }
  }

  // Reset dwell time
  resetDwellTime(trailer);

  saveState(state, facilityId);

  // Broadcast update to all clients
  broadcastStateChange("trailer", "move", { trailer }, facilityId);

  const historyEntry = addHistoryEntry("MOVED_TO_YARD", {
    trailerId: trailer.id,
    trailerNumber: trailer.number,
    carrier: trailer.carrier,
    customer: trailer.customer,
    toLocation: "Yard",
    fromDoor: doorId,
    isLive: trailer.isLive,
    ...(autoAssigned && {
      autoAssignedToDoor: autoAssigned.doorNumber,
      autoAssignedCarrier: autoAssigned.carrier,
    }),
  }, req.user);

  res.json({ success: true, trailer, historyEntry, autoAssigned });
});

/**
 * POST /api/move-to-yard-slot
 * Move a trailer to a specific numbered yard slot.
 *
 * Body: { trailerId: string, slotId: string, previousSlotId?: string }
 *
 * If slot is occupied, existing trailer is moved to unassigned yard.
 * Clears any door assignment the trailer had.
 */
router.post("/move-to-yard-slot", requireAuth, requireRole("user"), (req, res) => {
  const { trailerId, slotId, previousSlotId } = req.body;
  const facilityId = req.user?.currentFacility || req.user?.homeFacility;
  const state = loadState(facilityId);

  const trailer =
    state.trailers.find((t) => t.id === trailerId) ||
    state.yardTrailers.find((t) => t.id === trailerId) ||
    (state.staging?.id === trailerId ? state.staging : null);

  if (!trailer) {
    return res.status(404).json({ error: "Trailer not found" });
  }

  const slot = state.yardSlots.find(
    (s) => s.id === slotId || s.number === parseInt(slotId),
  );
  if (!slot) {
    return res.status(404).json({ error: "Yard slot not found" });
  }

  // If slot occupied, move existing trailer to unassigned yard
  if (slot.trailerId) {
    const existingTrailer =
      state.trailers.find((t) => t.id === slot.trailerId) ||
      state.yardTrailers.find((t) => t.id === slot.trailerId);
    if (existingTrailer) {
      slot.trailerId = null;
      if (!state.yardTrailers.find((t) => t.id === existingTrailer.id)) {
        existingTrailer.location = "yard";
        delete existingTrailer.doorId;
        delete existingTrailer.doorNumber;
        delete existingTrailer.yardSlotId;
        delete existingTrailer.yardSlotNumber;
        state.yardTrailers.push(existingTrailer);
      }
      state.trailers = state.trailers.filter((t) => t.id !== existingTrailer.id);
    }
  }

  // Clear previous slot if moving from another slot
  if (previousSlotId) {
    const prevSlot = state.yardSlots.find(
      (s) => s.id === previousSlotId || s.number === parseInt(previousSlotId),
    );
    if (prevSlot) {
      prevSlot.trailerId = null;
    }
  }

  // Clear from any other slot
  state.yardSlots.forEach((s) => {
    if (s.trailerId === trailerId) {
      s.trailerId = null;
    }
  });

  // Assign to slot
  trailer.location = "yard";
  trailer.yardSlotId = slot.id;
  trailer.yardSlotNumber = slot.number;
  delete trailer.doorId;
  delete trailer.doorNumber;

  slot.trailerId = trailerId;

  // Clear any door assignment
  state.doors.forEach((door) => {
    if (door.trailerId === trailerId) {
      door.trailerId = null;
      door.status = "empty";
    }
  });

  // Remove from unassigned yard
  state.yardTrailers = state.yardTrailers.filter((t) => t.id !== trailerId);

  // Add to docked trailers with slot info
  if (!state.trailers.find((t) => t.id === trailerId)) {
    state.trailers.push(trailer);
  }

  // Reset dwell time
  resetDwellTime(trailer);

  saveState(state, facilityId);

  // Broadcast update to all clients
  broadcastStateChange("trailer", "move", { trailer }, facilityId);

  const historyEntry = addHistoryEntry("MOVED_TO_YARD_SLOT", {
    trailerId: trailer.id,
    trailerNumber: trailer.number,
    carrier: trailer.carrier,
    customer: trailer.customer,
    toLocation: `Yard Slot ${slot.number}`,
    slotId: slot.id,
  }, req.user);

  res.json({ success: true, trailer, slot, historyEntry });
});

/**
 * POST /api/move-from-yard-slot
 * Move a trailer from assigned yard slot to unassigned yard.
 *
 * Body: { trailerId: string }
 */
router.post("/move-from-yard-slot", requireAuth, requireRole("user"), (req, res) => {
  const { trailerId } = req.body;
  const facilityId = req.user?.currentFacility || req.user?.homeFacility;
  const state = loadState(facilityId);

  const trailer = state.trailers.find((t) => t.id === trailerId);
  if (!trailer) {
    return res.status(404).json({ error: "Trailer not found" });
  }

  // Clear the slot
  const slot = state.yardSlots.find((s) => s.trailerId === trailerId);
  if (slot) {
    slot.trailerId = null;
  }

  // Move to unassigned yard
  trailer.location = "yard";
  delete trailer.yardSlotId;
  delete trailer.yardSlotNumber;

  if (!state.yardTrailers.find((t) => t.id === trailerId)) {
    state.yardTrailers.push(trailer);
  }
  state.trailers = state.trailers.filter((t) => t.id !== trailerId);

  // Reset dwell time
  resetDwellTime(trailer);

  saveState(state, facilityId);

  // Broadcast update to all clients
  broadcastStateChange("trailer", "move", { trailer }, facilityId);

  const historyEntry = addHistoryEntry("MOVED_TO_YARD", {
    trailerId: trailer.id,
    trailerNumber: trailer.number,
    carrier: trailer.carrier,
    customer: trailer.customer,
    fromSlot: slot?.number,
  }, req.user);

  res.json({ success: true, trailer, historyEntry });
});

module.exports = router;
