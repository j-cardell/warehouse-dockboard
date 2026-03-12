#!/usr/bin/env node
/**
 * Generate demo data for testing and demos
 * Usage: node scripts/generate-demo-data.js [count]
 * Default: 50 trailers with history
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// Check if multi-facility mode is enabled
const MULTI_FACILITY_MODE = process.env.MULTI_FACILITY_MODE === 'true';

const DATA_DIR = path.join(__dirname, '..', 'data');
const FACILITIES_DIR = path.join(DATA_DIR, 'facilities');

function getDataPaths(facilityId) {
  if (MULTI_FACILITY_MODE && facilityId) {
    const facilityDir = path.join(FACILITIES_DIR, facilityId);
    return {
      state: path.join(facilityDir, 'state.json'),
      history: path.join(facilityDir, 'history.json'),
      analytics: path.join(facilityDir, 'analytics.json'),
    };
  }
  return {
    state: path.join(DATA_DIR, 'state.json'),
    history: path.join(DATA_DIR, 'history.json'),
    analytics: path.join(DATA_DIR, 'analytics.json'),
  };
}

const CARRIERS = ['FedEx', 'UPS', 'Amazon', 'Walmart', 'Target', 'Home Depot', 'Costco', 'Wayfair'];
const CUSTOMERS = ['Acme Corp', 'Global Industries', 'Tech Solutions', 'Retail Plus', 'Distribution Co'];

// Default counts if creating new state
const DEFAULT_DOOR_COUNT = 57;
const DEFAULT_YARD_SLOT_COUNT = 30;

function randomDate(daysBack = 30) {
  const date = new Date();
  date.setDate(date.getDate() - Math.floor(Math.random() * daysBack));
  date.setHours(Math.floor(Math.random() * 24), Math.floor(Math.random() * 60), Math.floor(Math.random() * 60));
  return date.toISOString();
}

function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generatePhone() {
  return `555-${Math.floor(Math.random() * 9000) + 1000}`;
}

function loadOrCreateState(stateFile) {
  if (fs.existsSync(stateFile)) {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    // Ensure required arrays exist
    state.doors = state.doors || [];
    state.yardSlots = state.yardSlots || [];
    state.trailers = state.trailers || [];
    state.yardTrailers = state.yardTrailers || [];
    state.queuedTrailers = state.queuedTrailers || [];
    state.appointmentQueue = state.appointmentQueue || [];
    state.shippedTrailers = state.shippedTrailers || [];
    state.carriers = state.carriers || [];
    return state;
  }

  // Create new state with defaults
  const doors = Array.from({ length: DEFAULT_DOOR_COUNT }, (_, i) => ({
    id: `door-${i + 1}`,
    number: i + 1,
    order: i,
    type: 'normal',
    trailerId: null,
    status: 'empty',
    inService: true
  }));

  const yardSlots = Array.from({ length: DEFAULT_YARD_SLOT_COUNT }, (_, i) => ({
    id: `yard-${i + 1}`,
    number: i + 1,
    order: i,
    trailerId: null
  }));

  return {
    doors,
    trailers: [],
    carriers: [],
    yardTrailers: [],
    yardSlots,
    staging: null,
    queuedTrailers: [],
    appointmentQueue: [],
    shippedTrailers: []
  };
}

function loadOrCreateHistory(historyFile) {
  if (fs.existsSync(historyFile)) {
    return JSON.parse(fs.readFileSync(historyFile, 'utf-8'));
  }
  return { entries: [] };
}

function loadOrCreateAnalytics(analyticsFile) {
  if (fs.existsSync(analyticsFile)) {
    return JSON.parse(fs.readFileSync(analyticsFile, 'utf-8'));
  }
  return { snapshots: [], dailyStats: {}, weeklyStats: {}, monthlyStats: {} };
}

// Generate carriers with usage counts
function generateCarriers() {
  return CARRIERS.map(name => ({
    id: uuidv4(),
    name,
    favorite: Math.random() > 0.7,
    usageCount: 0,
    createdAt: randomDate(60)
  }));
}

// Generate a trailer at a door
function generateDoorTrailer(carrier, doorNumber) {
  const createdAt = randomDate(7);
  return {
    id: uuidv4(),
    number: `TR${Math.floor(Math.random() * 900000) + 100000}`,
    carrier,
    status: Math.random() > 0.3 ? 'loaded' : 'empty',
    customer: Math.random() > 0.5 ? randomItem(CUSTOMERS) : null,
    loadNumber: Math.random() > 0.5 ? `LD${Math.floor(Math.random() * 9000000) + 1000000}` : null,
    driverName: Math.random() > 0.3 ? `Driver ${Math.floor(Math.random() * 100)}` : null,
    driverPhone: Math.random() > 0.3 ? generatePhone() : null,
    contents: Math.random() > 0.5 ? 'General merchandise' : null,
    appointmentTime: null,
    isLive: Math.random() > 0.5, // 50% chance of being live
    location: 'door',
    doorId: `door-${doorNumber}`,
    doorNumber: doorNumber,
    createdAt,
    dwellResets: [],
    moveHistory: [] // Will track door-to-door moves
  };
}

// Generate shipped trailer
function generateShippedTrailer(carrier, doorCount) {
  const shippedAt = randomDate(30);
  return {
    id: uuidv4(),
    number: `TR${Math.floor(Math.random() * 900000) + 100000}`,
    carrier,
    status: 'shipped',
    customer: Math.random() > 0.5 ? randomItem(CUSTOMERS) : null,
    loadNumber: Math.random() > 0.5 ? `LD${Math.floor(Math.random() * 9000000) + 1000000}` : null,
    location: 'shipped',
    shippedAt,
    previousLocation: doorCount > 0 ? `Door ${Math.floor(Math.random() * doorCount) + 1}` : 'Yard',
    createdAt: randomDate(35)
  };
}

// Generate queued trailer
function generateQueuedTrailer(carrier, targetDoorNumber, targetDoorId) {
  return {
    id: uuidv4(),
    number: `TR${Math.floor(Math.random() * 900000) + 100000}`,
    carrier,
    status: Math.random() > 0.3 ? 'loaded' : 'empty',
    customer: Math.random() > 0.5 ? randomItem(CUSTOMERS) : null,
    location: 'queued',
    targetDoorId: targetDoorId || `door-${targetDoorNumber}`,
    targetDoorNumber: targetDoorNumber,
    queuedAt: randomDate(2),
    createdAt: randomDate(5),
    isLive: true // All queued trailers are marked live
  };
}

// Generate appointment trailer
function generateAppointmentTrailer(carrier) {
  return {
    id: uuidv4(),
    number: `TR${Math.floor(Math.random() * 900000) + 100000}`,
    carrier,
    status: Math.random() > 0.3 ? 'loaded' : 'empty',
    customer: Math.random() > 0.5 ? randomItem(CUSTOMERS) : null,
    driverName: Math.random() > 0.3 ? `Driver ${Math.floor(Math.random() * 100)}` : null,
    driverPhone: Math.random() > 0.3 ? generatePhone() : null,
    appointmentTime: `${Math.floor(Math.random() * 12) + 8}:${Math.floor(Math.random() * 60).toString().padStart(2, '0')}`,
    location: 'appointment',
    createdAt: randomDate(2)
  };
}

// Generate yard trailer
// If slotNumber is provided, trailer is assigned to that slot (in yardSlots array)
// If slotNumber is null, trailer is truly unassigned (in yardTrailers array only)
function generateYardTrailer(carrier, slotNumber = null) {
  const createdAt = randomDate(5);
  const trailer = {
    id: uuidv4(),
    number: `TR${Math.floor(Math.random() * 900000) + 100000}`,
    carrier,
    status: Math.random() > 0.3 ? 'loaded' : 'empty',
    customer: Math.random() > 0.5 ? randomItem(CUSTOMERS) : null,
    location: 'yard',
    createdAt,
    dwellResets: []
  };

  // Only add slot assignment if assigned to a specific slot
  if (slotNumber !== null) {
    trailer.yardSlotId = `yard-${slotNumber}`;
    trailer.yardSlotNumber = slotNumber;
  }

  return trailer;
}

// Create history entry
function createHistoryEntry(action, details) {
  return {
    id: `hist-${uuidv4()}`,
    action,
    timestamp: details.timestamp || new Date().toISOString(),
    ...details
  };
}

async function main() {
  const requestedCount = parseInt(process.argv[2]) || 0;
  const facilityId = process.argv[3] || null; // Facility ID for multi-facility mode

  // Get correct paths for facility
  const paths = getDataPaths(facilityId);

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (MULTI_FACILITY_MODE && facilityId && !fs.existsSync(path.join(FACILITIES_DIR, facilityId))) {
    fs.mkdirSync(path.join(FACILITIES_DIR, facilityId), { recursive: true });
  }

  const state = loadOrCreateState(paths.state);
  const history = loadOrCreateHistory(paths.history);
  let analytics = loadOrCreateAnalytics(paths.analytics);

  // Get actual counts from state
  const DOOR_COUNT = state.doors.length;
  const YARD_SLOT_COUNT = state.yardSlots.length;

  // Scale trailer count based on facility size if not explicitly requested
  // Formula: ~70% of doors + ~50% of yard slots + buffer for shipped/queued
  const defaultCount = Math.max(20, Math.floor(DOOR_COUNT * 0.7) + Math.floor(YARD_SLOT_COUNT * 0.5) + 15);
  const count = requestedCount > 0 ? requestedCount : defaultCount;

  console.log(`Generating ${count} trailers with demo data...`);
  console.log(`  Facility: ${DOOR_COUNT} doors, ${YARD_SLOT_COUNT} yard slots`);

  // Clear dynamic data
  state.trailers = [];
  state.yardTrailers = [];
  state.staging = null;
  state.queuedTrailers = [];
  state.appointmentQueue = [];
  state.shippedTrailers = [];
  state.carriers = generateCarriers();

  // Reset doors and slots
  state.doors.forEach(d => { d.trailerId = null; d.status = 'empty'; });
  state.yardSlots.forEach(s => s.trailerId = null);

  const historyEntries = [];
  const occupiedDoors = new Set();
  const occupiedSlots = new Set();

  // Filter to only usable doors (normal type, in service)
  const usableDoors = state.doors.filter(d => d.type === 'normal' && d.inService !== false);
  const USABLE_DOOR_COUNT = usableDoors.length;

  if (USABLE_DOOR_COUNT === 0) {
    console.error('No usable doors found. Cannot generate demo data.');
    process.exit(1);
  }

  // Active trailers at doors (70% of available doors, capped)
  const maxDoors = Math.min(USABLE_DOOR_COUNT, Math.floor(count * 0.5)); // Max 50% of count at doors
  const activeCount = Math.min(maxDoors, Math.max(1, Math.floor(USABLE_DOOR_COUNT * 0.7)));
  for (let i = 0; i < activeCount; i++) {
    let doorNum;
    let door;
    do {
      door = randomItem(usableDoors);
      doorNum = door.number;
    } while (occupiedDoors.has(doorNum));

    occupiedDoors.add(doorNum);
    const carrier = randomItem(state.carriers).name;
    const trailer = generateDoorTrailer(carrier, doorNum);

    // Generate move history for some trailers (they moved from one door to another)
    if (Math.random() > 0.5) {
      const previousDoorObj = randomItem(usableDoors);
      const previousDoor = previousDoorObj.number;
      if (previousDoor !== doorNum) {
        const moveTime = new Date(new Date(trailer.createdAt).getTime() + Math.random() * 2 * 60 * 60 * 1000);
        trailer.moveHistory = [{
          fromDoor: previousDoor,
          toDoor: doorNum,
          movedAt: moveTime.toISOString(),
          action: 'MOVED_TO_DOOR'
        }];

        historyEntries.push(createHistoryEntry('MOVED_TO_DOOR', {
          trailerId: trailer.id,
          trailerNumber: trailer.number,
          carrier: trailer.carrier,
          customer: trailer.customer,
          doorNumber: doorNum,
          previousLocation: `Door ${previousDoor}`,
          timestamp: moveTime.toISOString()
        }));
      }
    }

    state.trailers.push(trailer);
    const targetDoor = state.doors.find(d => d.number === doorNum);
    targetDoor.trailerId = trailer.id;
    targetDoor.status = trailer.status;

    historyEntries.push(
      createHistoryEntry('TRAILER_CREATED', {
        trailerId: trailer.id,
        trailerNumber: trailer.number,
        carrier: trailer.carrier,
        customer: trailer.customer,
        timestamp: trailer.createdAt
      }),
      createHistoryEntry('MOVED_TO_DOOR', {
        trailerId: trailer.id,
        trailerNumber: trailer.number,
        carrier: trailer.carrier,
        customer: trailer.customer,
        doorNumber: doorNum,
        timestamp: new Date(new Date(trailer.createdAt).getTime() + 1000).toISOString()
      })
    );
  }

  // Shipped trailers (30%)
  const shippedCount = Math.floor(count * 0.3);
  for (let i = 0; i < shippedCount; i++) {
    const carrier = randomItem(state.carriers).name;
    const trailer = generateShippedTrailer(carrier, DOOR_COUNT);
    state.shippedTrailers.push(trailer);

    historyEntries.push(
      createHistoryEntry('TRAILER_CREATED', {
        trailerId: trailer.id,
        trailerNumber: trailer.number,
        carrier: trailer.carrier,
        customer: trailer.customer,
        timestamp: trailer.createdAt
      }),
      createHistoryEntry('TRAILER_SHIPPED', {
        trailerId: trailer.id,
        trailerNumber: trailer.number,
        carrier: trailer.carrier,
        customer: trailer.customer,
        from: trailer.previousLocation,
        to: 'Shipped',
        timestamp: trailer.shippedAt
      })
    );
  }

  // Queued trailers (15%) - only target doors that are currently occupied
  const occupiedDoorNumbers = state.doors
    .filter(d => d.trailerId && d.type === 'normal' && d.inService !== false)
    .map(d => d.number);
  const queuedCount = Math.min(Math.floor(count * 0.15), occupiedDoorNumbers.length);
  for (let i = 0; i < queuedCount; i++) {
    const carrier = randomItem(state.carriers).name;
    // Pick a random occupied door to queue for
    const targetDoorNumber = randomItem(occupiedDoorNumbers);
    const targetDoor = state.doors.find(d => d.number === targetDoorNumber);
    if (targetDoor) {
      const trailer = generateQueuedTrailer(carrier, targetDoor.number, targetDoor.id);
      state.queuedTrailers.push(trailer);

      historyEntries.push(createHistoryEntry('TRAILER_CREATED', {
        trailerId: trailer.id,
        trailerNumber: trailer.number,
        carrier: trailer.carrier,
        customer: trailer.customer,
        timestamp: trailer.createdAt
      }));
    }
  }

  // Appointment trailers (12%)
  const apptCount = Math.floor(count * 0.12);
  for (let i = 0; i < apptCount; i++) {
    const carrier = randomItem(state.carriers).name;
    const trailer = generateAppointmentTrailer(carrier);
    state.appointmentQueue.push(trailer);

    historyEntries.push(createHistoryEntry('TRAILER_CREATED', {
      trailerId: trailer.id,
      trailerNumber: trailer.number,
      carrier: trailer.carrier,
      timestamp: trailer.createdAt
    }));
  }

  // Yard trailers - split between assigned slots and truly unassigned
  const totalYardCount = Math.floor(count * 0.25); // 25% of total in yard

  // Assign some to yard slots (up to 50% of available slots or yard count, whichever is smaller)
  const maxSlotAssignments = Math.min(YARD_SLOT_COUNT, Math.floor(totalYardCount * 0.6));
  const assignedToSlotsCount = Math.min(maxSlotAssignments, Math.floor(YARD_SLOT_COUNT * 0.5));

  for (let i = 0; i < assignedToSlotsCount; i++) {
    let slotNum;
    do { slotNum = YARD_SLOT_COUNT > 0 ? Math.floor(Math.random() * YARD_SLOT_COUNT) + 1 : 1; }
    while (occupiedSlots.has(slotNum));

    occupiedSlots.add(slotNum);
    const carrier = randomItem(state.carriers).name;
    // Pass slotNumber to generate trailer assigned to that slot
    const trailer = generateYardTrailer(carrier, slotNum);

    // Assigned trailers go in yardTrailers array WITH slot info
    state.yardTrailers.push(trailer);
    const slot = state.yardSlots.find(s => s.number === slotNum);
    if (slot) slot.trailerId = trailer.id;

    historyEntries.push(createHistoryEntry('TRAILER_CREATED', {
      trailerId: trailer.id,
      trailerNumber: trailer.number,
      carrier: trailer.carrier,
      timestamp: trailer.createdAt
    }));
  }

  // The rest are truly unassigned (no yardSlotId)
  const unassignedCount = totalYardCount - assignedToSlotsCount;
  for (let i = 0; i < unassignedCount; i++) {
    const carrier = randomItem(state.carriers).name;
    // Pass null for slotNumber to create truly unassigned trailer
    const trailer = generateYardTrailer(carrier, null);

    // Truly unassigned - just in yardTrailers, no slot assignment
    state.yardTrailers.push(trailer);

    historyEntries.push(createHistoryEntry('TRAILER_CREATED', {
      trailerId: trailer.id,
      trailerNumber: trailer.number,
      carrier: trailer.carrier,
      timestamp: trailer.createdAt
    }));
  }

  // Update carrier usage counts
  const allTrailers = [
    ...state.trailers,
    ...state.yardTrailers,
    ...state.queuedTrailers,
    ...state.appointmentQueue,
    ...state.shippedTrailers
  ];

  state.carriers.forEach(c => {
    c.usageCount = allTrailers.filter(t => t.carrier === c.name).length;
  });

  // Generate analytics
  analytics.dailyStats = {};
  for (let i = 0; i < 30; i++) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];
    analytics.dailyStats[dateStr] = {
      totalTrailers: Math.floor(Math.random() * 20) + 10,
      avgDwellTime: Math.random() * 4 + 1,
      violations: Math.floor(Math.random() * 5)
    };
  }

  // Sort history newest first
  historyEntries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  history.entries = historyEntries;

  // Save to correct paths (facility-specific in multi-facility mode)
  fs.writeFileSync(paths.state, JSON.stringify(state, null, 2));
  fs.writeFileSync(paths.history, JSON.stringify(history, null, 2));
  fs.writeFileSync(paths.analytics, JSON.stringify(analytics, null, 2));

  console.log(`✅ Done!`);
  console.log(`  - ${state.trailers.length} at doors`);
  console.log(`  - ${state.yardTrailers.length} in yard`);
  console.log(`  - ${state.queuedTrailers.length} in queue`);
  console.log(`  - ${state.appointmentQueue.length} with appointments`);
  console.log(`  - ${state.shippedTrailers.length} shipped`);
  console.log(`  - ${state.carriers.length} carriers`);
  console.log(`  - ${history.entries.length} history entries`);
}

main().catch(console.error);
