/**
 * Trailers routes - Trailer CRUD and shipping operations
 *
 * Provides endpoints for:
 * - Creating new trailers (POST /)
 * - Updating trailer data (PUT /:id)
 * - Deleting trailers (DELETE /:id)
 * - Shipping trailers (POST /:id/ship) - archives to shippedTrailers
 * - Deleting shipped trailers (DELETE /shipped/:id)
 *
 * Trailer locations:
 * - state.yardTrailers[] - Unassigned yard
 * - state.trailers[] - At dock doors (has doorId)
 * - state.staging - Single slot for pre-door
 * - state.queuedTrailers[] - Queue for specific doors
 * - state.appointmentQueue[] - Time-based queue
 * - state.shippedTrailers[] - Archived after shipping
 *
 * Carrier auto-creation: Creating a trailer with a new carrier name
 * automatically creates that carrier in state.carriers[].
 */

const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const { requireAuth, requireRole } = require("../middleware");
const { loadState, saveState, addHistoryEntry } = require("../state");
const { sanitizeInput } = require("../utils");
const { resetDwellTime } = require("../analytics");
const { broadcastStateChange } = require("../sse");

/**
 * POST /api/trailers
 * Create a new trailer in unassigned yard.
 *
 * Body: {
 *   number?: string,      // Optional trailer number
 *   carrier: string,      // Required - carrier name
 *   status?: string,      // 'empty' | 'loaded' | 'shipped'
 *   contents?: string,
 *   loadNumber?: string,
 *   customer?: string,
 *   driverName?: string,
 *   driverPhone?: string,
 *   appointmentTime?: string,
 *   isLive?: boolean
 * }
 *
 * Returns: { success: true, trailer, historyEntry }
 */
router.post("/", requireAuth, requireRole("user"), (req, res) => {
  const facilityId = req.user.currentFacility || req.user.homeFacility;
  const {
    number,
    carrier,
    carrierId,
    status = "empty",
    contents = "",
    loadNumber,
    customer,
    driverName,
    isLive,
  } = req.body;

  if (!carrier) {
    return res.status(400).json({ error: "Carrier is required" });
  }

  const state = loadState(facilityId);

  // Sanitize inputs
  const trailerNumber = number ? sanitizeInput(number) : null;
  const safeCarrier = sanitizeInput(carrier);

  // Check for duplicate trailer number across all locations
  if (trailerNumber) {
    if (
      state.trailers.find((t) => t.number === trailerNumber) ||
      state.yardTrailers.find((t) => t.number === trailerNumber) ||
      state.staging?.number === trailerNumber
    ) {
      return res.status(409).json({ error: "Trailer number already exists" });
    }
  }

  const trailer = {
    id: uuidv4(),
    number: trailerNumber,
    carrier: safeCarrier,
    carrierId: carrierId || null,
    status,
    contents: contents ? sanitizeInput(contents) : null,
    loadNumber: loadNumber ? sanitizeInput(loadNumber) : null,
    customer: customer ? sanitizeInput(customer) : null,
    driverName: driverName ? sanitizeInput(driverName) : null,
    driverPhone: req.body.driverPhone
      ? sanitizeInput(req.body.driverPhone)
      : null,
    appointmentTime: req.body.appointmentTime
      ? sanitizeInput(req.body.appointmentTime)
      : null,
    isLive: isLive === true || isLive === "true",
    location: "yard",
    createdAt: new Date().toISOString(),
  };

  // Add to unassigned yard
  state.yardTrailers.push(trailer);

  // Auto-create carrier if new, or increment usage count
  const existingCarrier = state.carriers.find(
    (c) => c.name.toLowerCase() === safeCarrier.toLowerCase(),
  );
  if (!existingCarrier) {
    state.carriers.push({
      id: uuidv4(),
      name: safeCarrier,
      mcNumber: "",
      favorite: false,
      usageCount: 1,
      createdAt: new Date().toISOString(),
    });
  } else {
    existingCarrier.usageCount = (existingCarrier.usageCount || 0) + 1;
  }

  saveState(state, facilityId);

  const historyEntry = addHistoryEntry("TRAILER_CREATED", {
    trailerId: trailer.id,
    trailerNumber: trailer.number,
    carrier: trailer.carrier,
    customer: trailer.customer,
    status: trailer.status,
  }, req.user, facilityId);

  // Broadcast state change to all connected clients in this facility
  broadcastStateChange("trailer", "create", { trailer }, facilityId);

  res.json({ success: true, trailer, historyEntry });
});

/**
 * PUT /api/trailers/:id
 * Update trailer properties.
 *
 * Tracks changes for history logging.
 * Updates door status if trailer is docked and status changes.
 */
router.put("/:id", requireAuth, requireRole("user"), (req, res) => {
  const facilityId = req.user.currentFacility || req.user.homeFacility;
  const { id } = req.params;
  const updates = req.body;
  const state = loadState(facilityId);

  // Find trailer in any location
  let trailer =
    state.trailers.find((t) => t.id === id) ||
    state.yardTrailers.find((t) => t.id === id) ||
    (state.staging?.id === id ? state.staging : null) ||
    state.queuedTrailers?.find((t) => t.id === id) ||
    state.appointmentQueue?.find((t) => t.id === id);

  if (!trailer) {
    return res.status(404).json({ error: "Trailer not found" });
  }

  // Track changes for history
  const changes = [];
  const oldValues = {};

  // Determine current location string for history
  const location = trailer.doorNumber
    ? `Door ${trailer.doorNumber}`
    : trailer.yardSlotNumber
      ? `Yard Spot ${trailer.yardSlotNumber}`
      : trailer.location || "Unassigned Yard";

  // Apply updates and track what changed
  if (updates.status && updates.status !== trailer.status) {
    oldValues.status = trailer.status;
    trailer.status = updates.status;
    changes.push({ field: "status", from: oldValues.status, to: trailer.status });
  }

  if (updates.isLive !== undefined && updates.isLive !== trailer.isLive) {
    oldValues.isLive = trailer.isLive;
    trailer.isLive = updates.isLive;
    changes.push({ field: "isLive", from: oldValues.isLive, to: trailer.isLive });
  }

  if (updates.contents !== undefined && updates.contents !== trailer.contents) {
    oldValues.contents = trailer.contents;
    trailer.contents = updates.contents
      ? sanitizeInput(updates.contents)
      : null;
    changes.push({
      field: "contents",
      from: oldValues.contents,
      to: trailer.contents,
    });
  }

  if (updates.carrier && updates.carrier !== trailer.carrier) {
    oldValues.carrier = trailer.carrier;
    trailer.carrier = sanitizeInput(updates.carrier);
    changes.push({
      field: "carrier",
      from: oldValues.carrier,
      to: trailer.carrier,
    });
  }

  if (updates.carrierId) trailer.carrierId = updates.carrierId;

  if (updates.number !== undefined && updates.number !== trailer.number) {
    oldValues.number = trailer.number;
    trailer.number = updates.number ? sanitizeInput(updates.number) : null;
    changes.push({ field: "number", from: oldValues.number, to: trailer.number });
  }

  // Dwell reset: track in dwellResets array
  if (updates.createdAt) {
    if (updates.createdAt !== trailer.createdAt) {
      if (!trailer.dwellResets) trailer.dwellResets = [];
      trailer.dwellResets.push(new Date().toISOString());
      if (trailer.dwellResets.length > 10) {
        trailer.dwellResets = trailer.dwellResets.slice(-10);
      }
    }
    trailer.createdAt = updates.createdAt;
  }

  if (updates.loadNumber !== undefined && updates.loadNumber !== trailer.loadNumber) {
    oldValues.loadNumber = trailer.loadNumber;
    trailer.loadNumber = updates.loadNumber
      ? sanitizeInput(updates.loadNumber)
      : null;
    changes.push({
      field: "loadNumber",
      from: oldValues.loadNumber,
      to: trailer.loadNumber,
    });
  }

  if (updates.customer !== undefined && updates.customer !== trailer.customer) {
    oldValues.customer = trailer.customer;
    trailer.customer = updates.customer
      ? sanitizeInput(updates.customer)
      : null;
    changes.push({
      field: "customer",
      from: oldValues.customer,
      to: trailer.customer,
    });
  }

  if (updates.driverName !== undefined && updates.driverName !== trailer.driverName) {
    oldValues.driverName = trailer.driverName;
    trailer.driverName = updates.driverName
      ? sanitizeInput(updates.driverName)
      : null;
    changes.push({
      field: "driverName",
      from: oldValues.driverName,
      to: trailer.driverName,
    });
  }

  if (updates.driverPhone !== undefined && updates.driverPhone !== trailer.driverPhone) {
    oldValues.driverPhone = trailer.driverPhone;
    trailer.driverPhone = updates.driverPhone
      ? sanitizeInput(updates.driverPhone)
      : null;
    changes.push({
      field: "driverPhone",
      from: oldValues.driverPhone,
      to: trailer.driverPhone,
    });
  }

  if (updates.appointmentTime !== undefined && updates.appointmentTime !== trailer.appointmentTime) {
    oldValues.appointmentTime = trailer.appointmentTime;
    trailer.appointmentTime = updates.appointmentTime
      ? sanitizeInput(updates.appointmentTime)
      : null;
    changes.push({
      field: "appointmentTime",
      from: oldValues.appointmentTime,
      to: trailer.appointmentTime,
    });
  }

  // Update door status if trailer is docked
  if (trailer.doorId && updates.status) {
    const door = state.doors.find((d) => d.id === trailer.doorId);
    if (door) {
      door.status = updates.status;
    }
  }

  saveState(state, facilityId);

  // Broadcast update to all clients
  broadcastStateChange("trailer", "update", { trailer, changes });

  const historyDetails = {
    trailerId: trailer.id,
    trailerNumber: trailer.number,
    carrier: trailer.carrier,
    location,
    doorNumber: trailer.doorNumber || null,
    changes: changes.length > 0 ? changes : null,
    updates: changes.length === 0 ? updates : null,
  };

  // Use specific action for status-only changes
  if (changes.length === 1 && changes[0].field === "status") {
    addHistoryEntry(`TRAILER_${trailer.status.toUpperCase()}`, historyDetails, req.user, facilityId);
  } else {
    addHistoryEntry("TRAILER_UPDATED", historyDetails, req.user, facilityId);
  }

  res.json({ success: true, trailer });
});

/**
 * DELETE /api/trailers/:id
 * Permanently delete a trailer from any location.
 *
 * Triggers auto-assignment if a door is cleared.
 */
router.delete("/:id", requireAuth, requireRole("user"), (req, res) => {
  const facilityId = req.user.currentFacility || req.user.homeFacility;
  const { id } = req.params;
  const state = loadState(facilityId);

  // Find trailer anywhere
  let trailer =
    state.trailers.find((t) => t.id === id) ||
    state.yardTrailers.find((t) => t.id === id) ||
    (state.staging?.id === id ? state.staging : null) ||
    state.queuedTrailers?.find((t) => t.id === id) ||
    state.appointmentQueue?.find((t) => t.id === id);

  if (!trailer) {
    return res.status(404).json({ error: "Trailer not found" });
  }

  // Track door info for auto-assignment
  const clearedDoorId = trailer.doorId;
  const clearedDoorNumber = trailer.doorNumber;

  // Clear door if trailer is in one
  if (trailer.doorId) {
    const door = state.doors.find((d) => d.id === trailer.doorId);
    if (door) {
      door.trailerId = null;
      door.status = "empty";
    }
  }

  // Remove from all lists
  state.trailers = state.trailers.filter((t) => t.id !== id);
  state.yardTrailers = state.yardTrailers.filter((t) => t.id !== id);
  if (state.queuedTrailers) {
    state.queuedTrailers = state.queuedTrailers.filter((t) => t.id !== id);
  }
  if (state.appointmentQueue) {
    state.appointmentQueue = state.appointmentQueue.filter((t) => t.id !== id);
  }
  if (state.staging?.id === id) {
    state.staging = null;
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

        const door = state.doors.find((d) => d.id === clearedDoorId);
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

  saveState(state, facilityId);

  // Broadcast deletion to all clients
  broadcastStateChange("trailer", "delete", { trailerId: id, trailer });

  addHistoryEntry("TRAILER_DELETED", {
    trailerId: id,
    trailerNumber: trailer.number,
    carrier: trailer.carrier,
    isLive: trailer.isLive,
    ...(autoAssigned && {
      autoAssignedToDoor: autoAssigned.doorNumber,
      autoAssignedCarrier: autoAssigned.carrier,
    }),
  }, req.user);

  res.json({ success: true, autoAssigned });
});

/**
 * POST /api/trailers/:id/ship
 * Mark trailer as shipped (soft delete/archive).
 *
 * Moves trailer from active to shippedTrailers array.
 * Preserves all trailer data including location history.
 * Triggers auto-assignment if a door is cleared.
 */
router.post("/:id/ship", requireAuth, requireRole("user"), (req, res) => {
  const facilityId = req.user.currentFacility || req.user.homeFacility;
  const { id } = req.params;
  const state = loadState(facilityId);

  // Find trailer in docked or yard
  let trailerIndex = state.trailers.findIndex((t) => t.id === id);
  let trailer = null;
  let sourceLocation = null;

  if (trailerIndex >= 0) {
    trailer = state.trailers[trailerIndex];
    sourceLocation = trailer.doorNumber
      ? `Door ${trailer.doorNumber}`
      : trailer.yardSlotNumber
        ? `Yard Spot ${trailer.yardSlotNumber}`
        : "Unassigned Yard";
    state.trailers.splice(trailerIndex, 1);
  } else {
    trailerIndex = state.yardTrailers.findIndex((t) => t.id === id);
    if (trailerIndex >= 0) {
      trailer = state.yardTrailers[trailerIndex];
      sourceLocation = trailer.yardSlotNumber
        ? `Yard Spot ${trailer.yardSlotNumber}`
        : "Unassigned Yard";
      state.yardTrailers.splice(trailerIndex, 1);
    }
  }

  // Check staging
  if (!trailer && state.staging?.id === id) {
    trailer = state.staging;
    sourceLocation = "Staging";
    state.staging = null;
  }

  if (!trailer) {
    return res.status(404).json({ error: "Trailer not found" });
  }

  // Clear door/yard slot associations
  let clearedDoorId = null;
  let clearedDoorNumber = null;

  if (trailer.doorId) {
    const door = state.doors.find((d) => d.id === trailer.doorId);
    if (door) {
      clearedDoorId = trailer.doorId;
      clearedDoorNumber = trailer.doorNumber;
      door.trailerId = null;
      door.status = "empty";
    }
  }
  if (trailer.yardSlotId) {
    const slot = state.yardSlots.find((s) => s.id === trailer.yardSlotId);
    if (slot) {
      slot.trailerId = null;
    }
  }

  // Archive trailer
  trailer.location = "shipped";
  trailer.shippedAt = new Date().toISOString();
  trailer.shippedBy = req.user?.username || 'Unknown';
  trailer.doorId = null;
  trailer.doorNumber = null;
  trailer.yardSlotId = null;
  trailer.yardSlotNumber = null;
  trailer.previousLocation = sourceLocation;

  if (!state.shippedTrailers) state.shippedTrailers = [];
  state.shippedTrailers.push(trailer);

  // Auto-assign from queue
  let autoAssigned = null;
  if (clearedDoorId) {
    const queuedForDoor = state.queuedTrailers?.filter(
      (t) => t.targetDoorId === clearedDoorId,
    );
    if (queuedForDoor && queuedForDoor.length > 0) {
      const nextTrailer = queuedForDoor[0];
      state.queuedTrailers = state.queuedTrailers.filter(
        (t) => t.id !== nextTrailer.id,
      );

      const door = state.doors.find((d) => d.id === clearedDoorId);
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

  saveState(state, facilityId);

  // Broadcast ship event to all clients
  broadcastStateChange("trailer", "ship", { trailerId: id, trailer, autoAssigned });

  addHistoryEntry("TRAILER_SHIPPED", {
    trailerId: trailer.id,
    trailerNumber: trailer.number,
    carrier: trailer.carrier,
    loadNumber: trailer.loadNumber,
    customer: trailer.customer,
    from: sourceLocation,
    to: "Shipped",
    ...(autoAssigned && {
      autoAssignedToDoor: autoAssigned.doorNumber,
      autoAssignedCarrier: autoAssigned.carrier,
    }),
  }, req.user);

  res.json({ success: true, trailer, message: "Trailer marked as shipped", autoAssigned });
});

/**
 * DELETE /api/shipped/:id
 * Permanently delete a shipped trailer record.
 *
 * Use this when cleaning up old shipped trailers from the archive.
 */
router.delete("/shipped/:id", requireAuth, requireRole("user"), (req, res) => {
  const facilityId = req.user.currentFacility || req.user.homeFacility;
  const { id } = req.params;
  const state = loadState(facilityId);

  const shippedTrailer = state.shippedTrailers?.find((t) => t.id === id);

  if (!shippedTrailer) {
    return res.status(404).json({ error: "Shipped trailer not found" });
  }

  state.shippedTrailers = state.shippedTrailers.filter((t) => t.id !== id);

  saveState(state, facilityId);

  // Broadcast shipped trailer deletion to all clients
  broadcastStateChange("trailer", "delete", { trailerId: id, trailer: shippedTrailer, type: "shipped" });

  addHistoryEntry("SHIPPED_DELETED", {
    trailerId: id,
    trailerNumber: shippedTrailer.number,
    carrier: shippedTrailer.carrier,
    shipDate: shippedTrailer.shippedAt,
  }, req.user);

  res.json({ success: true });
});

module.exports = router;
