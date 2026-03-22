/**
 * Queue routes
 * GET|POST /staging, GET|POST /queue, GET|POST /appointment-queue
 *
 * Manages the staging area, FCFS queue for specific doors, and
 * appointment-based queue with time-based ordering.
 */

/**
 * Queue routes
 * GET|POST /staging, GET|POST /queue, GET|POST /appointment-queue
 *
 * Manages the staging area, FCFS queue for specific doors, and
 * appointment-based queue with time-based ordering.
 */

const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const { requireAuth, requireRole } = require("../middleware");
const { broadcastStateChange } = require("../sse");
const { loadState, saveState, addHistoryEntry } = require("../state");
const { sanitizeInput } = require("../utils");

// ============================================================================
// Staging
// ============================================================================

// Get trailer in staging slot (returns single trailer or null)
router.get("/staging", requireAuth, (req, res) => {
  const facilityId = req.user.currentFacility || req.user.homeFacility;
  const state = loadState(facilityId);
  res.json({ trailer: state.staging || null });
});

// Add trailer to staging slot
router.post("/staging", requireAuth, requireRole("user"), (req, res) => {
  const facilityId = req.user.currentFacility || req.user.homeFacility;
  const {
    number,
    carrier,
    status = "loaded",
    customer,
    loadNumber,
    contents,
    isLive,
    direction = "outbound",
    appointmentTime,
    driverPhone,
    sourceId, // Optional: ID of trailer to remove from yardTrailers (for move operation)
  } = req.body;
  const state = loadState(facilityId);

  if (state.staging) {
    return res.status(400).json({ error: "Staging slot is already occupied" });
  }

  if (!carrier) {
    return res.status(400).json({ error: "Carrier is required" });
  }

  const trailer = {
    id: uuidv4(),
    number: number ? sanitizeInput(number) : null,
    carrier: sanitizeInput(carrier),
    status,
    customer: customer ? sanitizeInput(customer) : null,
    loadNumber: loadNumber ? sanitizeInput(loadNumber) : null,
    contents: contents ? sanitizeInput(contents) : null,
    appointmentTime: appointmentTime ? sanitizeInput(appointmentTime) : null,
    driverPhone: driverPhone ? sanitizeInput(driverPhone) : null,
    isLive: direction === 'inbound' ? (isLive !== false && isLive !== "false") : (isLive === true || isLive === "true"),
    direction: direction === 'inbound' ? 'inbound' : 'outbound',
    location: "staging",
    createdAt: new Date().toISOString(),
  };

  state.staging = trailer;

  // Remove from unassigned yard if sourceId provided (move operation)
  if (sourceId) {
    state.yardTrailers = state.yardTrailers.filter((t) => t.id !== sourceId);
  }

  const safeCarrier = trailer.carrier;
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

  // Broadcast update
  broadcastStateChange("queues", "update", { state }, facilityId);

  addHistoryEntry("TRAILER_CREATED", {
    trailerId: trailer.id,
    trailerNumber: trailer.number,
    carrier: trailer.carrier,
    location: "Staging",
    customer: trailer.customer,
    loadNumber: trailer.loadNumber,
  }, req.user, facilityId);

  res.json({ success: true, trailer });
});

// ============================================================================
// FCFS Queue
// ============================================================================

// Move trailer from staging to queue (waiting for specific door)
router.post("/queue", requireAuth, requireRole("user"), (req, res) => {
  const facilityId = req.user.currentFacility || req.user.homeFacility;
  const { trailerId, targetDoorId, targetDoorNumber } = req.body;
  const state = loadState(facilityId);

  if (!trailerId || !targetDoorId) {
    return res
      .status(400)
      .json({ error: "Trailer ID and target door ID are required" });
  }

  let trailer = null;
  let source = null;

  if (state.staging && state.staging.id === trailerId) {
    trailer = state.staging;
    source = "staging";
  } else if (state.appointmentQueue) {
    const idx = state.appointmentQueue.findIndex((t) => t.id === trailerId);
    if (idx !== -1) {
      trailer = state.appointmentQueue[idx];
      source = "appointment-queue";
    }
  }

  if (!trailer) {
    return res
      .status(404)
      .json({ error: "Trailer not found in staging or appointment queue" });
  }

  if (!state.queuedTrailers) state.queuedTrailers = [];

  trailer.location = "queued";
  trailer.targetDoorId = targetDoorId;
  trailer.targetDoorNumber = targetDoorNumber;
  trailer.queuedAt = new Date().toISOString();

  state.queuedTrailers.push(trailer);

  if (source === "staging") {
    state.staging = null;
  } else if (source === "appointment-queue") {
    state.appointmentQueue = state.appointmentQueue.filter(
      (t) => t.id !== trailerId,
    );
  }

  saveState(state, facilityId);

  // Broadcast update
  broadcastStateChange("queues", "update", { state }, facilityId);

  addHistoryEntry("TRAILER_QUEUED", {
    trailerId: trailer.id,
    trailerNumber: trailer.number,
    carrier: trailer.carrier,
    customer: trailer.customer,
    targetDoor: targetDoorNumber,
    targetDoorId,
  }, req.user, facilityId);

  res.json({ success: true, trailer });
});

// Get all queued trailers
router.get("/queue", requireAuth, (req, res) => {
  const facilityId = req.user.currentFacility || req.user.homeFacility;
  const state = loadState(facilityId);
  res.json({ trailers: state.queuedTrailers || [] });
});

// Cancel a queued trailer (move to unassigned yard)
router.post("/queue/:id/cancel", requireAuth, requireRole("user"), (req, res) => {
  const facilityId = req.user.currentFacility || req.user.homeFacility;
  const { id } = req.params;
  const state = loadState(facilityId);

  if (!state.queuedTrailers) {
    return res.status(404).json({ error: "No trailers in queue" });
  }

  const index = state.queuedTrailers.findIndex((t) => t.id === id);
  if (index === -1) {
    return res.status(404).json({ error: "Trailer not found in queue" });
  }

  const trailer = state.queuedTrailers[index];

  trailer.location = null;
  trailer.targetDoorId = null;
  trailer.targetDoorNumber = null;
  trailer.queuedAt = null;

  if (!state.yardTrailers) state.yardTrailers = [];
  state.yardTrailers.push(trailer);
  state.queuedTrailers.splice(index, 1);

  saveState(state, facilityId);

  // Broadcast update
  broadcastStateChange("queues", "update", { state }, facilityId);

  addHistoryEntry("TRAILER_UNQUEUED", {
    trailerId: trailer.id,
    trailerNumber: trailer.number,
    carrier: trailer.carrier,
    customer: trailer.customer,
    action: "moved to unassigned yard",
  }, req.user, facilityId);

  res.json({ success: true, trailer });
});

// Reassign queued trailer to different door
router.post("/queue/:id/reassign", requireAuth, requireRole("user"), (req, res) => {
  const facilityId = req.user.currentFacility || req.user.homeFacility;
  const { id } = req.params;
  const { targetDoorId, targetDoorNumber } = req.body;

  if (!targetDoorId) {
    return res.status(400).json({ error: "Target door ID is required" });
  }

  const state = loadState(facilityId);

  if (!state.queuedTrailers) {
    return res.status(404).json({ error: "No trailers in queue" });
  }

  const trailer = state.queuedTrailers.find((t) => t.id === id);
  if (!trailer) {
    return res.status(404).json({ error: "Trailer not found in queue" });
  }

  const oldDoor = trailer.targetDoorNumber;
  trailer.targetDoorId = targetDoorId;
  trailer.targetDoorNumber = targetDoorNumber;
  trailer.queuedAt = new Date().toISOString(); // Reset priority to now

  saveState(state, facilityId);

  // Broadcast update
  broadcastStateChange("queues", "update", { state }, facilityId);

  addHistoryEntry("TRAILER_REASSIGNED", {
    trailerId: trailer.id,
    trailerNumber: trailer.number,
    carrier: trailer.carrier,
    fromDoor: oldDoor,
    toDoor: targetDoorNumber,
  }, req.user, facilityId);

  res.json({ success: true, trailer });
});

// ============================================================================
// Appointment Queue
// ============================================================================

// Move trailer from staging to appointment queue
router.post("/appointment-queue", requireAuth, requireRole("user"), (req, res) => {
  const facilityId = req.user.currentFacility || req.user.homeFacility;
  const { trailerId } = req.body;
  const state = loadState(facilityId);

  if (!trailerId) {
    return res.status(400).json({ error: "Trailer ID is required" });
  }

  // Find trailer in staging
  if (!state.staging || state.staging.id !== trailerId) {
    return res.status(404).json({ error: "Trailer not found in staging" });
  }

  const trailer = state.staging;

  // Move to appointment queue
  if (!state.appointmentQueue) state.appointmentQueue = [];

  trailer.location = "appointment-queue";
  delete trailer.targetDoorId;
  delete trailer.targetDoorNumber;
  trailer.queuedAt = new Date().toISOString();

  state.appointmentQueue.push(trailer);
  state.staging = null; // Clear staging

  saveState(state, facilityId);

  // Broadcast update
  broadcastStateChange("queues", "update", { state }, facilityId);

  addHistoryEntry("TRAILER_QUEUED_APPT", {
    trailerId: trailer.id,
    trailerNumber: trailer.number,
    carrier: trailer.carrier,
    location: "Appointment Queue",
  }, req.user, facilityId);

  res.json({ success: true, trailer });
});

// Get all appointment queue trailers
router.get("/appointment-queue", requireAuth, (req, res) => {
  const facilityId = req.user.currentFacility || req.user.homeFacility;
  const state = loadState(facilityId);
  res.json({ trailers: state.appointmentQueue || [] });
});

// Cancel an appointment queue trailer (move to unassigned yard)
router.post("/appointment-queue/:id/cancel", requireAuth, requireRole("user"), (req, res) => {
  const facilityId = req.user.currentFacility || req.user.homeFacility;
  const { id } = req.params;
  const state = loadState(facilityId);

  if (!state.appointmentQueue) {
    return res.status(404).json({ error: "No trailers in appointment queue" });
  }

  const index = state.appointmentQueue.findIndex((t) => t.id === id);
  if (index === -1) {
    return res
      .status(404)
      .json({ error: "Trailer not found in appointment queue" });
  }

  const trailer = state.appointmentQueue[index];

  trailer.location = null;
  trailer.queuedAt = null;

  if (!state.yardTrailers) state.yardTrailers = [];
  state.yardTrailers.push(trailer);
  state.appointmentQueue.splice(index, 1);

  saveState(state, facilityId);

  // Broadcast update
  broadcastStateChange("queues", "update", { state }, facilityId);

  addHistoryEntry("TRAILER_UNQUEUED_APPT", {
    trailerId: trailer.id,
    trailerNumber: trailer.number,
    carrier: trailer.carrier,
    action: "moved to unassigned yard",
  }, req.user, facilityId);

  res.json({ success: true, trailer });
});

// Reorder appointment queue
router.post("/appointment-queue/reorder", requireAuth, requireRole("user"), (req, res) => {
  const facilityId = req.user.currentFacility || req.user.homeFacility;
  const { trailerIds } = req.body;
  const state = loadState(facilityId);

  if (!state.appointmentQueue) return res.json({ success: true });

  // Rebuild queue based on new ID order
  const newQueue = [];
  const map = new Map(state.appointmentQueue.map((t) => [t.id, t]));

  trailerIds.forEach((id) => {
    if (map.has(id)) {
      newQueue.push(map.get(id));
      map.delete(id);
    }
  });

  // Append any remainders (safety)
  for (const t of map.values()) {
    newQueue.push(t);
  }

  state.appointmentQueue = newQueue;
  saveState(state, facilityId);

  // Broadcast update
  broadcastStateChange("queues", "update", { state }, facilityId);

  res.json({ success: true });
});

module.exports = router;
