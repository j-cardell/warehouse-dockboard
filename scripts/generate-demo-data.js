#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const MULTI_FACILITY_MODE = true;
const DATA_DIR = path.join(__dirname, '..', 'data');
const FACILITIES_DIR = path.join(DATA_DIR, 'facilities');
const NOW = new Date();

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
const NOTES = [
  "Make sure doors are shut, it's a rolldown",
  "Driver has paperwork inside",
  "Call dispatch before unloading",
  "Fragile cargo - handle with care",
  "Seal broken upon arrival - verify contents",
  "Hazmat load - safety check required",
  "Refrigerated unit - keep plugged in",
  "Driver will return for pickup at 3pm",
  "Overweight load - special handling",
  "Stacked high - watch top boxes",
  "Load shift in transit - inspect before unload",
  "Rental trailer - return to yard after",
  "Customer requesting call before arrival",
  "COD shipment - collect payment",
  "Lift gate required for unloading",
];
const DEFAULT_DOOR_COUNT = 57;
const DEFAULT_YARD_SLOT_COUNT = 30;

function randomDate(daysBack = 30) {
  const date = new Date(NOW);
  date.setDate(date.getDate() - Math.floor(Math.random() * daysBack));
  date.setHours(Math.floor(Math.random() * 24), Math.floor(Math.random() * 60), Math.floor(Math.random() * 60));
  return date.toISOString();
}

function dateDaysAgo(daysAgo, hour = 8, minute = 0) {
  const date = new Date(NOW);
  date.setDate(date.getDate() - daysAgo);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
}

function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generatePhone() {
  return '555-' + (Math.floor(Math.random() * 9000) + 1000);
}

function loadOrCreateState(stateFile) {
  if (fs.existsSync(stateFile)) {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
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
  const doors = Array.from({ length: DEFAULT_DOOR_COUNT }, (_, i) => ({
    id: 'door-' + (i + 1), number: i + 1, order: i, type: 'normal',
    trailerId: null, status: 'empty', inService: true
  }));
  const yardSlots = Array.from({ length: DEFAULT_YARD_SLOT_COUNT }, (_, i) => ({
    id: 'yard-' + (i + 1), number: i + 1, order: i, trailerId: null
  }));
  return { doors, trailers: [], carriers: [], yardTrailers: [], yardSlots, staging: null, queuedTrailers: [], appointmentQueue: [], shippedTrailers: [] };
}

function loadOrCreateHistory(historyFile) {
  if (fs.existsSync(historyFile)) return JSON.parse(fs.readFileSync(historyFile, 'utf-8'));
  return { entries: [] };
}

function generateCarriers() {
  return CARRIERS.map(name => ({ id: uuidv4(), name, favorite: Math.random() > 0.7, usageCount: 0, createdAt: dateDaysAgo(60) }));
}

function generateDoorTrailer(carrier, doorNumber, createdAt) {
  return {
    id: uuidv4(), number: 'TR' + (Math.floor(Math.random() * 900000) + 100000), carrier,
    status: Math.random() > 0.3 ? 'loaded' : 'empty',
    customer: Math.random() > 0.5 ? randomItem(CUSTOMERS) : null,
    loadNumber: Math.random() > 0.5 ? 'LD' + (Math.floor(Math.random() * 9000000) + 1000000) : null,
    driverName: Math.random() > 0.3 ? 'Driver ' + Math.floor(Math.random() * 100) : null,
    driverPhone: Math.random() > 0.3 ? generatePhone() : null,
    contents: Math.random() > 0.5 ? 'General merchandise' : null,
    notes: Math.random() > 0.7 ? randomItem(NOTES) : null,
    appointmentTime: null, isLive: Math.random() > 0.5, location: 'door',
    doorId: 'door-' + doorNumber, doorNumber: doorNumber, createdAt, dwellResets: [], moveHistory: []
  };
}

function generateShippedTrailer(carrier, doorCount, createdAt, shippedAt) {
  return {
    id: uuidv4(), number: 'TR' + (Math.floor(Math.random() * 900000) + 100000), carrier,
    status: 'shipped', customer: Math.random() > 0.5 ? randomItem(CUSTOMERS) : null,
    loadNumber: Math.random() > 0.5 ? 'LD' + (Math.floor(Math.random() * 9000000) + 1000000) : null,
    notes: Math.random() > 0.7 ? randomItem(NOTES) : null,
    location: 'shipped', shippedAt,
    previousLocation: doorCount > 0 ? 'Door ' + (Math.floor(Math.random() * doorCount) + 1) : 'Yard', createdAt
  };
}

function generateQueuedTrailer(carrier, targetDoorNumber, targetDoorId) {
  return {
    id: uuidv4(), number: 'TR' + (Math.floor(Math.random() * 900000) + 100000), carrier,
    status: Math.random() > 0.3 ? 'loaded' : 'empty',
    customer: Math.random() > 0.5 ? randomItem(CUSTOMERS) : null,
    notes: Math.random() > 0.7 ? randomItem(NOTES) : null,
    location: 'queued', targetDoorId: targetDoorId || 'door-' + targetDoorNumber,
    targetDoorNumber: targetDoorNumber, queuedAt: randomDate(2), createdAt: randomDate(5), isLive: true
  };
}

function generateAppointmentTrailer(carrier) {
  return {
    id: uuidv4(), number: 'TR' + (Math.floor(Math.random() * 900000) + 100000), carrier,
    status: Math.random() > 0.3 ? 'loaded' : 'empty',
    customer: Math.random() > 0.5 ? randomItem(CUSTOMERS) : null,
    driverName: Math.random() > 0.3 ? 'Driver ' + Math.floor(Math.random() * 100) : null,
    driverPhone: Math.random() > 0.3 ? generatePhone() : null,
    notes: Math.random() > 0.7 ? randomItem(NOTES) : null,
    appointmentTime: (Math.floor(Math.random() * 12) + 8) + ':' + Math.floor(Math.random() * 60).toString().padStart(2, '0'),
    location: 'appointment', createdAt: randomDate(2)
  };
}

function generateYardTrailer(carrier, slotNumber = null) {
  const createdAt = randomDate(5);
  const trailer = {
    id: uuidv4(), number: 'TR' + (Math.floor(Math.random() * 900000) + 100000), carrier,
    status: Math.random() > 0.3 ? 'loaded' : 'empty',
    customer: Math.random() > 0.5 ? randomItem(CUSTOMERS) : null,
    notes: Math.random() > 0.7 ? randomItem(NOTES) : null,
    location: 'yard', createdAt, dwellResets: []
  };
  if (slotNumber !== null) {
    trailer.yardSlotId = 'yard-' + slotNumber;
    trailer.yardSlotNumber = slotNumber;
  }
  return trailer;
}

function createHistoryEntry(action, details) {
  return { id: 'hist-' + uuidv4(), action, timestamp: details.timestamp || new Date().toISOString(), ...details };
}

async function main() {
  const requestedCount = parseInt(process.argv[2]) || 0;
  const facilityId = process.argv[3] || null;
  const paths = getDataPaths(facilityId);

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (MULTI_FACILITY_MODE && facilityId && !fs.existsSync(path.join(FACILITIES_DIR, facilityId))) {
    fs.mkdirSync(path.join(FACILITIES_DIR, facilityId), { recursive: true });
  }

  const state = loadOrCreateState(paths.state);
  const history = loadOrCreateHistory(paths.history);
  const DOOR_COUNT = state.doors.length;
  const YARD_SLOT_COUNT = state.yardSlots.length;
  const defaultCount = Math.max(20, Math.floor(DOOR_COUNT * 0.7) + Math.floor(YARD_SLOT_COUNT * 0.5) + 15);
  const count = requestedCount > 0 ? requestedCount : defaultCount;

  console.log('Generating ' + count + ' trailers with 30 days of historical data...');
  console.log('  Facility: ' + DOOR_COUNT + ' doors, ' + YARD_SLOT_COUNT + ' yard slots');

  state.trailers = [];
  state.yardTrailers = [];
  state.staging = null;
  state.queuedTrailers = [];
  state.appointmentQueue = [];
  state.shippedTrailers = [];
  state.carriers = generateCarriers();
  state.doors.forEach(d => { d.trailerId = null; d.status = 'empty'; });
  state.yardSlots.forEach(s => s.trailerId = null);

  const historyEntries = [];
  const occupiedDoors = new Set();
  const occupiedSlots = new Set();
  const usableDoors = state.doors.filter(d => d.type === 'normal' && d.inService !== false);
  const USABLE_DOOR_COUNT = usableDoors.length;

  if (USABLE_DOOR_COUNT === 0) { console.error('No usable doors found.'); process.exit(1); }

  // Active trailers at doors
  const activeCount = Math.min(USABLE_DOOR_COUNT, Math.floor(count * 0.5));
  for (let i = 0; i < activeCount; i++) {
    let doorNum, door;
    do { door = randomItem(usableDoors); doorNum = door.number; } while (occupiedDoors.has(doorNum));
    occupiedDoors.add(doorNum);
    const carrier = randomItem(state.carriers).name;
    const daysAgo = Math.random() > 0.5 ? 0 : Math.floor(Math.random() * 2) + 1;
    const createdAt = dateDaysAgo(daysAgo, Math.floor(Math.random() * 14) + 6, Math.floor(Math.random() * 60));
    const trailer = generateDoorTrailer(carrier, doorNum, createdAt);
    state.trailers.push(trailer);
    const targetDoor = state.doors.find(d => d.number === doorNum);
    targetDoor.trailerId = trailer.id;
    targetDoor.status = trailer.status;
    historyEntries.push(
      createHistoryEntry('TRAILER_CREATED', { trailerId: trailer.id, trailerNumber: trailer.number, carrier: trailer.carrier, customer: trailer.customer, timestamp: trailer.createdAt }),
      createHistoryEntry('MOVED_TO_DOOR', { trailerId: trailer.id, trailerNumber: trailer.number, carrier: trailer.carrier, customer: trailer.customer, driverName: trailer.driverName, loadNumber: trailer.loadNumber, doorNumber: doorNum, timestamp: new Date(new Date(trailer.createdAt).getTime() + 1000).toISOString() })
    );
  }

  // Shipped trailers
  const shippedCount = Math.floor(count * 0.2);
  for (let i = 0; i < shippedCount; i++) {
    const carrier = randomItem(state.carriers).name;
    const createdAt = dateDaysAgo(Math.floor(Math.random() * 4) + 1, Math.floor(Math.random() * 8) + 6);
    const shippedAt = dateDaysAgo(Math.random() > 0.6 ? 0 : Math.floor(Math.random() * 2) + 1, Math.floor(Math.random() * 12) + 8);
    const trailer = generateShippedTrailer(carrier, DOOR_COUNT, createdAt, shippedAt);
    state.shippedTrailers.push(trailer);
    historyEntries.push(
      createHistoryEntry('TRAILER_CREATED', { trailerId: trailer.id, trailerNumber: trailer.number, carrier: trailer.carrier, customer: trailer.customer, timestamp: trailer.createdAt }),
      createHistoryEntry('MOVED_TO_DOOR', { trailerId: trailer.id, trailerNumber: trailer.number, carrier: trailer.carrier, customer: trailer.customer, driverName: trailer.driverName, loadNumber: trailer.loadNumber, doorNumber: trailer.previousLocation?.replace('Door ', '') || Math.floor(Math.random() * DOOR_COUNT) + 1, timestamp: new Date(new Date(trailer.createdAt).getTime() + 60000).toISOString() }),
      createHistoryEntry('TRAILER_SHIPPED', { trailerId: trailer.id, trailerNumber: trailer.number, carrier: trailer.carrier, customer: trailer.customer, from: trailer.previousLocation, to: 'Shipped', timestamp: trailer.shippedAt })
    );
  }

  // Historical data: 30 days of movements
  const historicalCount = Math.floor(count * 2);
  console.log('  Generating ' + historicalCount + ' historical trailer movements...');
  for (let day = 0; day < 30; day++) {
    const dayTrailers = Math.floor(historicalCount / 30) + Math.floor(Math.random() * 5);
    for (let i = 0; i < dayTrailers; i++) {
      const carrier = randomItem(state.carriers).name;
      const doorNum = Math.floor(Math.random() * USABLE_DOOR_COUNT) + 1;
      const dwellHours = Math.random() * 6 + 2;
      let hour, minute;
      if (day === 0) {
        const latestStartHour = Math.max(0, NOW.getHours() - Math.ceil(dwellHours) - 1);
        hour = Math.floor(Math.random() * (latestStartHour + 1));
        minute = Math.floor(Math.random() * 60);
      } else {
        hour = Math.floor(Math.random() * 14) + 6;
        minute = Math.floor(Math.random() * 60);
      }
      const createdAt = dateDaysAgo(day, hour, minute);
      const departedTime = new Date(new Date(createdAt).getTime() + dwellHours * 60 * 60 * 1000);
      if (departedTime > NOW) continue;
      const trailerId = uuidv4();
      const trailerNumber = 'TR' + (Math.floor(Math.random() * 900000) + 100000);
      const customer = Math.random() > 0.5 ? randomItem(CUSTOMERS) : null;
      const driverName = Math.random() > 0.3 ? 'Driver ' + Math.floor(Math.random() * 100) : null;
      const loadNumber = Math.random() > 0.5 ? 'LD' + (Math.floor(Math.random() * 9000000) + 1000000) : null;
      historyEntries.push(
        createHistoryEntry('TRAILER_CREATED', { trailerId, trailerNumber, carrier, customer, timestamp: createdAt }),
        createHistoryEntry('MOVED_TO_DOOR', { trailerId, trailerNumber, carrier, customer, driverName, loadNumber, doorNumber: doorNum, timestamp: new Date(new Date(createdAt).getTime() + 60000).toISOString() })
      );
      const action = Math.random() > 0.3 ? 'TRAILER_SHIPPED' : 'MOVED_TO_YARD';
      historyEntries.push(createHistoryEntry(action, { trailerId, trailerNumber, carrier, customer, from: 'Door ' + doorNum, to: action === 'TRAILER_SHIPPED' ? 'Shipped' : 'Yard', doorNumber: doorNum, timestamp: departedTime.toISOString() }));
    }
  }

  // Queued trailers
  const occupiedDoorNumbers = state.doors.filter(d => d.trailerId && d.type === 'normal').map(d => d.number);
  const queuedCount = Math.min(Math.floor(count * 0.15), occupiedDoorNumbers.length);
  for (let i = 0; i < queuedCount; i++) {
    const carrier = randomItem(state.carriers).name;
    const targetDoorNumber = randomItem(occupiedDoorNumbers);
    const targetDoor = state.doors.find(d => d.number === targetDoorNumber);
    if (targetDoor) {
      const trailer = generateQueuedTrailer(carrier, targetDoor.number, targetDoor.id);
      state.queuedTrailers.push(trailer);
      historyEntries.push(createHistoryEntry('TRAILER_CREATED', { trailerId: trailer.id, trailerNumber: trailer.number, carrier: trailer.carrier, customer: trailer.customer, timestamp: trailer.createdAt }));
    }
  }

  // Appointment trailers
  const apptCount = Math.floor(count * 0.12);
  for (let i = 0; i < apptCount; i++) {
    const carrier = randomItem(state.carriers).name;
    const trailer = generateAppointmentTrailer(carrier);
    state.appointmentQueue.push(trailer);
    historyEntries.push(createHistoryEntry('TRAILER_CREATED', { trailerId: trailer.id, trailerNumber: trailer.number, carrier: trailer.carrier, timestamp: trailer.createdAt }));
  }

  // Yard trailers
  const totalYardCount = Math.floor(count * 0.25);
  const maxSlotAssignments = Math.min(YARD_SLOT_COUNT, Math.floor(totalYardCount * 0.6));
  const assignedToSlotsCount = Math.min(maxSlotAssignments, Math.floor(YARD_SLOT_COUNT * 0.5));
  for (let i = 0; i < assignedToSlotsCount; i++) {
    let slotNum;
    do { slotNum = YARD_SLOT_COUNT > 0 ? Math.floor(Math.random() * YARD_SLOT_COUNT) + 1 : 1; } while (occupiedSlots.has(slotNum));
    occupiedSlots.add(slotNum);
    const carrier = randomItem(state.carriers).name;
    const trailer = generateYardTrailer(carrier, slotNum);
    state.yardTrailers.push(trailer);
    const slot = state.yardSlots.find(s => s.number === slotNum);
    if (slot) slot.trailerId = trailer.id;
    historyEntries.push(createHistoryEntry('TRAILER_CREATED', { trailerId: trailer.id, trailerNumber: trailer.number, carrier: trailer.carrier, timestamp: trailer.createdAt }));
  }
  const unassignedCount = totalYardCount - assignedToSlotsCount;
  for (let i = 0; i < unassignedCount; i++) {
    const carrier = randomItem(state.carriers).name;
    const trailer = generateYardTrailer(carrier, null);
    state.yardTrailers.push(trailer);
    historyEntries.push(createHistoryEntry('TRAILER_CREATED', { trailerId: trailer.id, trailerNumber: trailer.number, carrier: trailer.carrier, timestamp: trailer.createdAt }));
  }

  // Update carriers and save
  const allTrailers = [...state.trailers, ...state.yardTrailers, ...state.queuedTrailers, ...state.appointmentQueue, ...state.shippedTrailers];
  state.carriers.forEach(c => { c.usageCount = allTrailers.filter(t => t.carrier === c.name).length; });
  historyEntries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  history.entries = historyEntries;
  fs.writeFileSync(paths.state, JSON.stringify(state, null, 2));
  fs.writeFileSync(paths.history, JSON.stringify(history, null, 2));

  console.log('Done!');
  console.log('  - ' + state.trailers.length + ' at doors');
  console.log('  - ' + state.yardTrailers.length + ' in yard');
  console.log('  - ' + state.queuedTrailers.length + ' in queue');
  console.log('  - ' + state.appointmentQueue.length + ' with appointments');
  console.log('  - ' + state.shippedTrailers.length + ' shipped');
  console.log('  - ' + state.carriers.length + ' carriers');
  console.log('  - ' + history.entries.length + ' history entries');
}

main().catch(console.error);
