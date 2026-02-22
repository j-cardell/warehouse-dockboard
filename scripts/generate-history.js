#!/usr/bin/env node
/**
 * Generate fake history entries for testing pagination
 * Usage: node scripts/generate-history.js [count]
 * Default: 1000 entries
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DATA_DIR = path.join(__dirname, '..', 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

const CARRIERS = ['FedEx', 'UPS', 'Amazon', 'Walmart', 'Target', 'Home Depot', 'Lowes', 'Costco', 'Wayfair', 'IKEA'];
const DOORS = Array.from({length: 57}, (_, i) => i + 1);
const ACTIONS = ['TRAILER_CREATED', 'TRAILER_MOVED', 'TRAILER_UPDATED', 'TRAILER_SHIPPED', 'TRAILER_DELETED'];

function randomDate(daysBack = 30) {
  const date = new Date();
  date.setDate(date.getDate() - Math.floor(Math.random() * daysBack));
  date.setHours(Math.floor(Math.random() * 24), Math.floor(Math.random() * 60), Math.floor(Math.random() * 60));
  return date.toISOString();
}

function generateEntry(index) {
  const carrier = CARRIERS[Math.floor(Math.random() * CARRIERS.length)];
  const trailerNumber = `TR${100000 + index}`;
  const action = ACTIONS[Math.floor(Math.random() * ACTIONS.length)];
  const doorNumber = DOORS[Math.floor(Math.random() * DOORS.length)];
  const timestamp = randomDate();

  let entry = {
    id: `hist-${uuidv4()}`,
    trailerId: `trailer-${uuidv4()}`,
    trailerNumber,
    carrier,
    action,
    timestamp,
    doorNumber,
    user: 'admin'
  };

  // Add location info based on action
  if (action === 'TRAILER_MOVED') {
    entry.previousLocation = Math.random() > 0.5 ? `Door ${doorNumber}` : 'Yard';
    entry.toLocation = Math.random() > 0.5 ? `Door ${DOORS[Math.floor(Math.random() * DOORS.length)]}` : 'Yard';
  } else if (action === 'TRAILER_SHIPPED') {
    entry.from = `Door ${doorNumber}`;
    entry.shippedAt = timestamp;
  } else if (action === 'TRAILER_UPDATED') {
    entry.changes = [{
      field: ['status', 'loadNumber', 'customer'][Math.floor(Math.random() * 3)],
      from: 'old-value',
      to: 'new-value'
    }];
  }

  return entry;
}

async function main() {
  const count = parseInt(process.argv[2]) || 1000;
  console.log(`Generating ${count} fake history entries...`);

  // Ensure data directory exists
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  // Load existing history or create new
  let history = { entries: [] };
  if (fs.existsSync(HISTORY_FILE)) {
    try {
      history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
      console.log(`Loaded ${history.entries.length} existing entries`);
    } catch (e) {
      console.log('Creating new history file');
    }
  }

  // Generate new entries
  const newEntries = [];
  for (let i = 0; i < count; i++) {
    newEntries.push(generateEntry(i));
  }

  // Combine and sort by timestamp (newest first)
  history.entries = [...newEntries, ...history.entries]
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  // Keep only last 5000 entries to prevent file bloat
  if (history.entries.length > 5000) {
    console.log(`Truncating to 5000 entries (removed ${history.entries.length - 5000})`);
    history.entries = history.entries.slice(0, 5000);
  }

  // Save
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  console.log(`✅ Done! Total entries: ${history.entries.length}`);
}

main().catch(console.error);
