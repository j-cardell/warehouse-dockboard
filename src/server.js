/**
 * Warehouse Dock Board Server
 * Manages dock doors, trailers, and movement history
 */

const express = require('express');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const basicAuth = require('basic-auth');
const jwt = require('jsonwebtoken');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, '../data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const ANALYTICS_FILE = path.join(DATA_DIR, 'analytics.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(path.join(DATA_DIR, 'archives'))) {
  fs.mkdirSync(path.join(DATA_DIR, 'archives'), { recursive: true });
}

// Global UI Settings
const DEFAULT_SETTINGS = {
  trailerDisplay: {
    customer: { fontSize: '9cqw', color: '#ffffff' },
    carrier: { fontSize: '15cqw', color: '#ffffff' },
    trailerNumber: { fontSize: '7cqw', color: '#fbbf24' },
    loadNumber: { fontSize: '9cqw', color: '#94a3b8' },
    driver: { fontSize: '8cqw' },
    door: { fontSize: '6.5cqw' },
    dwell: { fontSize: '5.5cqw' },
    live: { fontSize: '23cqw' }
  },
  sidebarLayout: {
    sidebarHeight: '1211.67px',
    stagingFlex: '',
    apptQueueFlex: '0 0 264.933px',
    queueFlex: '0 0 363.867px'
  }
};

function loadSettings() {
  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
      return { ...DEFAULT_SETTINGS, ...saved };
    } catch (e) {
      console.error('Error loading settings:', e);
    }
  }
  return DEFAULT_SETTINGS;
}

function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

const DEFAULT_CARRIERS = []; // Start empty - carriers added as trailers are created

// Default state: 57 doors
const DEFAULT_DOORS = Array.from({ length: 57 }, (_, i) => ({
  id: `door-${i + 1}`,
  number: i + 1,
  order: i + 1,
  trailerId: null,
  status: 'empty',
  inService: true,
  type: 'normal'
}));

// Default yard slots: 30 numbered slots
const DEFAULT_YARD_SLOTS = Array.from({ length: 30 }, (_, i) => ({
  id: `yard-${i + 1}`,
  number: i + 1,
  trailerId: null
}));

// Check if setup is needed (no state file or empty doors/yardSlots)
function isSetupNeeded() {
  if (!fs.existsSync(STATE_FILE)) {
    return true;
  }
  try {
    const content = fs.readFileSync(STATE_FILE, 'utf-8');
    const state = JSON.parse(content);
    // Consider empty if no doors and no yard slots
    return (!state.doors || state.doors.length === 0) &&
           (!state.yardSlots || state.yardSlots.length === 0);
  } catch (e) {
    return true;
  }
}

// Generate initial facility configuration
function generateFacilityConfig({ numDoors = 57, numYardSlots = 30, numDumpsters = 0, numRamps = 0, doorStart = 1, yardStart = 1 }) {
  const doors = [];
  let order = 0;

  // Regular dock doors
  for (let i = 0; i < numDoors; i++) {
    const doorNum = doorStart + i;
    doors.push({
      id: `door-${doorNum}`,
      number: doorNum,
      order: order++,
      trailerId: null,
      status: 'empty',
      inService: true,
      type: 'normal'
    });
  }

  // Dumpsters as blank doors with custom labels
  for (let i = 0; i < numDumpsters; i++) {
    doors.push({
      id: `dumpster-${uuidv4()}`,
      number: null,
      order: order++,
      labelText: `Dumpster ${i + 1}`,
      trailerId: null,
      status: 'empty',
      inService: true,
      type: 'blank'
    });
  }

  // Ramps as blank doors with custom labels
  for (let i = 0; i < numRamps; i++) {
    doors.push({
      id: `ramp-${uuidv4()}`,
      number: null,
      order: order++,
      labelText: `Ramp ${i + 1}`,
      trailerId: null,
      status: 'empty',
      inService: true,
      type: 'blank'
    });
  }

  // Yard slots (start from yardStart)
  const yardSlots = Array.from({ length: numYardSlots }, (_, i) => {
    const yardNum = yardStart + i;
    return {
      id: `yard-${yardNum}`,
      number: yardNum,
      trailerId: null
    };
  });

  return { doors, yardSlots };
}

// Sanitize input to prevent injection
// Allows common business characters but strips dangerous HTML/script characters
function sanitizeInput(input) {
  if (!input || typeof input !== 'string') return input;
  
  // 1. First, encode HTML entities for the dangerous 5 characters
  // This turns <script> into &lt;script&gt; (harmless text)
  // We keep the original text but make it safe to display
  let safe = input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

  // 2. Allow '&' only if it was originally part of a valid name (like D&H)
  // Since we just encoded all '&' to '&amp;', we need to be careful.
  // Actually, standard practice is to encode EVERYTHING. 
  // If we save "D&amp;H" to the database, the browser will render it as "D&H".
  // This is the correct way to handle special characters.
  
  return safe.trim();
}

// Load or initialize state
function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      // Ensure yardSlots exists for backward compatibility
      if (!state.yardSlots) {
        state.yardSlots = DEFAULT_YARD_SLOTS;
      }
      // Ensure staging/queue exists for backward compatibility
      if (!state.hasOwnProperty('staging')) {
        state.staging = null;
      }
      if (!state.queuedTrailers) {
        state.queuedTrailers = [];
      }
      if (!state.appointmentQueue) {
        state.appointmentQueue = [];
      }
      return state;
    } catch (e) {
      console.error('Error loading state:', e);
    }
  }
  return {
    doors: DEFAULT_DOORS,
    trailers: [],
    carriers: DEFAULT_CARRIERS,
    yardTrailers: [],
    yardSlots: DEFAULT_YARD_SLOTS,
    staging: null,
    queuedTrailers: [],
    appointmentQueue: []
  };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// Load or initialize history
function loadHistory() {
  if (fs.existsSync(HISTORY_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    } catch (e) {
      console.error('Error loading history:', e);
    }
  }
  return { entries: [] };
}

function addHistoryEntry(action, details) {
  const history = loadHistory();
  history.entries.unshift({
    id: uuidv4(),
    timestamp: new Date().toISOString(),
    action,
    ...details
  });
  // Keep last 1000 entries
  if (history.entries.length > 1000) {
    history.entries = history.entries.slice(0, 1000);
  }
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  return history.entries[0];
}

// Analytics functions
function loadAnalytics() {
  if (fs.existsSync(ANALYTICS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(ANALYTICS_FILE, 'utf-8'));
    } catch (e) {
      console.error('Error loading analytics:', e);
    }
  }
  return { snapshots: [], dailyStats: {}, weeklyStats: {}, monthlyStats: {} };
}

function saveAnalytics(analytics) {
  fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(analytics, null, 2));
}

// Get effective dwell time (max 6 hours, respecting resets)
function getEffectiveDwellHours(createdAt, resets = [], currentTime = Date.now()) {
  const created = new Date(createdAt).getTime();
  
  // If there were resets, calculate from the most recent one that's < 6h ago
  if (resets && resets.length > 0) {
    const recentResets = resets
      .map(r => new Date(r).getTime())
      .filter(r => (currentTime - r) < 6 * 60 * 60 * 1000) // < 6h ago
      .sort((a, b) => b - a); // Newest first
    
    if (recentResets.length > 0) {
      const hoursSinceReset = (currentTime - recentResets[0]) / (1000 * 60 * 60);
      return Math.min(hoursSinceReset, 6);
    }
  }
  
  const totalHours = (currentTime - created) / (1000 * 60 * 60);
  return Math.min(totalHours, 6);
}

// Record dwell time snapshot every 15 minutes
// Reset dwell time for a trailer (call when moving)
function resetDwellTime(trailer) {
  if (!trailer) return;
  
  // Track the reset
  if (!trailer.dwellResets) trailer.dwellResets = [];
  trailer.dwellResets.push(new Date().toISOString());
  
  // Keep only last 10 resets
  if (trailer.dwellResets.length > 10) {
    trailer.dwellResets = trailer.dwellResets.slice(-10);
  }
  
  // Reset createdAt to now (optional - resets "age" display on UI too)
  trailer.createdAt = new Date().toISOString();
}

// Calculate daily dwell aggregates from history
// Run once per day instead of every 15 minutes
function calculateDailyDwell(date) {
  const dateStr = typeof date === 'string' ? date : date.toISOString().split('T')[0];
  const dayStart = new Date(dateStr + 'T00:00:00');
  const dayEnd = new Date(dateStr + 'T23:59:59');
  
  const history = loadHistory();
  const state = loadState();
  const analytics = loadAnalytics();
  
  // Find all trailers that were at docks during this day
  // Track: when they arrived, when they left
  const trailerDwells = {};
  
  // Process history to find movements in/out of doors for this date
  history.entries.forEach(entry => {
    if (!entry.timestamp) return;
    const entryTime = new Date(entry.timestamp);
    if (entryTime < dayStart || entryTime > dayEnd) return;
    
    // MOVEMENT events - trailer moved to/from a door
    if (entry.action === 'MOVED_TO_DOOR' && entry.trailerId) {
      if (!trailerDwells[entry.trailerId]) {
        trailerDwells[entry.trailerId] = { 
          carrier: entry.carrier, 
          arrivals: [], 
          departures: [],
          doorNumber: entry.doorNumber
        };
      }
      trailerDwells[entry.trailerId].arrivals.push(entryTime);
    }
    
    if (entry.action === 'MOVED_TO_YARD' && entry.trailerId) {
      if (!trailerDwells[entry.trailerId]) {
        trailerDwells[entry.trailerId] = { carrier: entry.carrier, arrivals: [], departures: [] };
      }
      trailerDwells[entry.trailerId].departures.push(entryTime);
    }
    
    // Trailer deleted = consider it departed
    if (entry.action === 'TRAILER_DELETED' && entry.trailerId) {
      if (!trailerDwells[entry.trailerId]) {
        trailerDwells[entry.trailerId] = { carrier: entry.carrier, arrivals: [], departures: [] };
      }
      trailerDwells[entry.trailerId].departures.push(entryTime);
    }
  });
  
  // Also check trailers still at doors (active)
  // If a trailer arrived yesterday and hasn't left, count dwell up to end of day
  state.trailers.forEach(t => {
    if (!t.doorId) return;
    const created = new Date(t.createdAt);
    if (created <= dayEnd && !trailerDwells[t.id]) {
      // Trailer was at door during this day
      trailerDwells[t.id] = {
        carrier: t.carrier,
        arrivals: [created < dayStart ? dayStart : created],
        departures: [], // Still there at end of day
        doorNumber: t.doorNumber
      };
    }
  });
  
  // Calculate dwell times
  let totalDwell = 0;
  let count = 0;
  let maxDwell = 0;
  let violations = 0;
  const violatorList = [];
  
  Object.entries(trailerDwells).forEach(([trailerId, data]) => {
    if (data.arrivals.length === 0) return;
    
    // Match arrivals with departures
    for (let i = 0; i < data.arrivals.length; i++) {
      const arrival = data.arrivals[i];
      let departure = data.departures[i] || dayEnd; // If no departure, use end of day
      
      // Cap arrival at start of day for spanning trailers
      if (arrival < dayStart) arrival = dayStart;
      
      const dwellMs = departure - arrival;
      const dwellHours = dwellMs / (1000 * 60 * 60);
      
      if (dwellHours > 0.1) { // Minimum 6 minutes
        totalDwell += dwellHours;
        count++;
        
        if (dwellHours > maxDwell) {
          maxDwell = dwellHours;
        }
        
        if (dwellHours >= 2) {
          violations++;
          violatorList.push({
            trailerId,
            carrier: data.carrier,
            dwellHours: Math.round(dwellHours * 100) / 100,
            doorNumber: data.doorNumber
          });
        }
      }
    }
  });
  
  // Calculate daily aggregate
  const avgDwell = count > 0 ? Math.round((totalDwell / count) * 100) / 100 : 0;
  
  // Store in analytics
  if (!analytics.dailyStats) analytics.dailyStats = {};
  
  analytics.dailyStats[dateStr] = {
    date: dateStr,
    avgDwell,
    maxDwell: Math.round(maxDwell * 100) / 100,
    count,
    violations,
    violators: violatorList.slice(0, 10), // Top 10 violators
    calculatedAt: new Date().toISOString()
  };
  
  // Retain 90 days of daily stats (trim old data)
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 90);
  Object.keys(analytics.dailyStats).forEach(dateKey => {
    if (new Date(dateKey) < cutoffDate) {
      delete analytics.dailyStats[dateKey];
    }
  });
  
  saveAnalytics(analytics);
  console.log(`[Analytics] Daily: ${dateStr} - avg ${avgDwell}h, max ${Math.round(maxDwell * 100) / 100}h, ${count} trailers, ${violations} violations`);
  
  return analytics.dailyStats[dateStr];
}

// Legacy function - no longer records snapshots
function recordDwellSnapshot() {
  // Calculate today's daily aggregate instead
  const today = new Date().toISOString().split('T')[0];
  calculateDailyDwell(today);
}

// Get 2+ hour dwell violations for analytics tab
// Uses new daily aggregates (calculated from history)
function getDwellViolations(period = 'day') {
  const analytics = loadAnalytics();
  const now = new Date();
  const result = [];
  
  if (period === 'day') {
    // Last 7 days - violations from daily aggregates
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dateKey = d.toISOString().split('T')[0];
      const dayStats = analytics.dailyStats?.[dateKey];
      
      result.push({
        date: dateKey,
        label: d.toLocaleDateString('en-US', { weekday: 'short' }),
        count: dayStats?.violations || 0,
        avgDwell: dayStats?.avgDwell || 0,
        trailers: dayStats?.violators || []
      });
    }
  }
  
  return result;
}

const app = express();
app.set('trust proxy', 1); // Trust first proxy (required for rate limiting behind proxy)
app.disable('x-powered-by'); // Hide "Express" signature to frustrate reconnaissance
app.use(cors());
app.use(express.json({ limit: '10kb' })); // Limit body size to 10kb to prevent DoS via massive payloads

// Prevent caching of API responses (important for auth)
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// Rate limiting - 60 requests per minute per IP
// const limiter = rateLimit({
//   windowMs: 60 * 1000,
//   max: 60,
//   standardHeaders: true,
//   message: { error: 'Too many requests, slow down!' }
// });
// app.use(limiter);

// Strict rate limiting for login - 5 attempts per 15 minutes
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  message: { error: 'Too many login attempts, please try again later.' }
});

// Auth Configuration & Security Validation
const AUTH_USER = process.env.AUTH_USER || 'dockadmin';
const AUTH_PASS = process.env.AUTH_PASS;
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';

// CRITICAL SECURITY CHECKS
if (!AUTH_PASS) {
  console.error('❌ FATAL ERROR: AUTH_PASS environment variable is not set.');
  console.error('You must set a secure password to start the server.');
  process.exit(1);
}

if (AUTH_PASS === 'password123') {
  console.error('❌ FATAL ERROR: AUTH_PASS is set to the insecure default "password123".');
  console.error('Please change this to a secure password in your environment variables.');
  process.exit(1);
}

if (!JWT_SECRET) {
  console.error('❌ FATAL ERROR: JWT_SECRET environment variable is not set.');
  console.error('You must set a secure random string for JWT signing.');
  process.exit(1);
}

if (JWT_SECRET === 'change-this-secret-in-production') {
  console.error('❌ FATAL ERROR: JWT_SECRET is set to the insecure default.');
  console.error('Please change this to a secure random string.');
  process.exit(1);
}

console.log(`🔒 Security active: User=${AUTH_USER}, Auth Checks Passed`);

// Generate JWT token
function generateToken(username) {
  return jwt.sign({ username }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

// Verify JWT token middleware
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    console.log('[Auth] No authorization header');
    return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  }

  // Support both "Bearer <token>" and legacy basic auth for migration
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded.username;
      return next();
    } catch (err) {
      console.log('[Auth] Token verification failed:', err.message);
      return res.status(401).json({ error: 'Invalid or expired token', code: 'TOKEN_INVALID' });
    }
  }
  
  // Legacy: check for Basic auth (for migration period)
  const credentials = basicAuth(req);
  if (credentials && credentials.name === AUTH_USER && credentials.pass === AUTH_PASS) {
    req.user = credentials.name;
    return next();
  }
  
  return res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
}

// Public endpoints (no auth required)
// POST /api/auth/login - Get JWT token
app.post('/api/auth/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;
  
  // Slow down all responses slightly to frustrate timing attacks
  setTimeout(() => {
      if (username !== AUTH_USER || password !== AUTH_PASS) {
        return res.status(401).json({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
      }
      
      const token = generateToken(username);
      res.json({ success: true, token, user: username, expiresIn: JWT_EXPIRES_IN });
  }, 1000); // 1 second delay
});

// GET /api/auth/status - Check current auth status
app.get('/api/auth/status', (req, res) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    return res.json({ authenticated: false, user: null });
  }
  
  // Check JWT
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      return res.json({ authenticated: true, user: decoded.username });
    } catch (err) {
      return res.json({ authenticated: false, user: null, error: 'Token expired' });
    }
  }
  
  // Legacy: check Basic auth
  const credentials = basicAuth(req);
  if (credentials && credentials.name === AUTH_USER && credentials.pass === AUTH_PASS) {
    return res.json({ authenticated: true, user: credentials.name });
  }
  
  res.json({ authenticated: false, user: null });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Check if setup is needed (public - for first-run detection)
app.get('/api/setup/status', (req, res) => {
  res.json({
    setupNeeded: isSetupNeeded(),
    timestamp: new Date().toISOString()
  });
});

// Run initial setup (protected - requires authentication)
app.post('/api/setup', requireAuth, (req, res) => {
  // Only allow setup if state doesn't exist yet
  if (!isSetupNeeded()) {
    return res.status(403).json({
      error: 'Setup already completed. Delete data/state.json to reset.'
    });
  }

  const { numDoors = 57, numYardSlots = 30, numDumpsters = 0, numRamps = 0, doorStart = 1, yardStart = 1 } = req.body;

  // Validate inputs
  if (typeof numDoors !== 'number' || numDoors < 0 || numDoors > 500) {
    return res.status(400).json({ error: 'Invalid number of doors (0-500)' });
  }
  if (typeof numYardSlots !== 'number' || numYardSlots < 0 || numYardSlots > 500) {
    return res.status(400).json({ error: 'Invalid number of yard slots (0-500)' });
  }
  if (typeof numDumpsters !== 'number' || numDumpsters < 0 || numDumpsters > 50) {
    return res.status(400).json({ error: 'Invalid number of dumpsters (0-50)' });
  }
  if (typeof numRamps !== 'number' || numRamps < 0 || numRamps > 50) {
    return res.status(400).json({ error: 'Invalid number of ramps (0-50)' });
  }
  if (typeof doorStart !== 'number' || doorStart < 1 || doorStart > 9999) {
    return res.status(400).json({ error: 'Invalid door start number (1-9999)' });
  }
  if (typeof yardStart !== 'number' || yardStart < 1 || yardStart > 9999) {
    return res.status(400).json({ error: 'Invalid yard start number (1-9999)' });
  }

  try {
    // Generate facility configuration
    const { doors, yardSlots } = generateFacilityConfig({
      numDoors,
      numYardSlots,
      numDumpsters,
      numRamps,
      doorStart,
      yardStart
    });

    // Create initial state
    const initialState = {
      doors,
      trailers: [],
      carriers: [],
      yardTrailers: [],
      yardSlots,
      staging: null,
      queuedTrailers: [],
      appointmentQueue: []
    };

    // Ensure data directory exists
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(path.join(DATA_DIR, 'archives'))) {
      fs.mkdirSync(path.join(DATA_DIR, 'archives'), { recursive: true });
    }

    // Save all data files
    fs.writeFileSync(STATE_FILE, JSON.stringify(initialState, null, 2));
    fs.writeFileSync(HISTORY_FILE, JSON.stringify({ entries: [] }, null, 2));
    fs.writeFileSync(ANALYTICS_FILE, JSON.stringify({
      snapshots: [],
      dailyStats: {},
      weeklyStats: {},
      monthlyStats: {}
    }, null, 2));

    // Preserve existing settings if they exist, otherwise use defaults
    let settings = loadSettings();
    if (!fs.existsSync(SETTINGS_FILE)) {
      settings = DEFAULT_SETTINGS;
      saveSettings(settings);
    }

    console.log('[Setup] Initial configuration created:');
    console.log(`  - ${numDoors} dock doors`);
    console.log(`  - ${numYardSlots} yard slots`);
    console.log(`  - ${numDumpsters} dumpsters`);
    console.log(`  - ${numRamps} ramps`);

    res.json({
      success: true,
      config: {
        numDoors,
        numYardSlots,
        numDumpsters,
        numRamps,
        totalDoors: doors.length
      },
      message: 'Setup complete. Please log in to continue.'
    });
  } catch (error) {
    console.error('[Setup] Error:', error);
    res.status(500).json({ error: 'Failed to create initial configuration' });
  }
});

// Get global settings (public - needed for rendering)
app.get('/api/settings', (req, res) => {
  const settings = loadSettings();
  res.json(settings);
});

// Update global settings (protected)
app.post('/api/settings', requireAuth, (req, res) => {
  const currentSettings = loadSettings();
  const newSettings = { ...currentSettings, ...req.body };
  saveSettings(newSettings);
  res.json({ success: true, settings: newSettings });
});

// Get list of archive files (protected)
app.get('/api/archives', requireAuth, (req, res) => {
  try {
    const archivesDir = path.join(DATA_DIR, 'archives');
    if (!fs.existsSync(archivesDir)) {
      return res.json({ archives: [] });
    }
    const files = fs.readdirSync(archivesDir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const stats = fs.statSync(path.join(archivesDir, f));
        return {
          name: f,
          size: stats.size,
          created: stats.birthtime
        };
      })
      .sort((a, b) => new Date(b.created) - new Date(a.created));
    res.json({ archives: files });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create archive snapshot (protected)
app.post('/api/archives', requireAuth, (req, res) => {
  try {
    const state = loadState();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `archive-${timestamp}.json`;
    const archivesDir = path.join(DATA_DIR, 'archives');

    if (!fs.existsSync(archivesDir)) {
      fs.mkdirSync(archivesDir, { recursive: true });
    }

    const archivePath = path.join(archivesDir, filename);
    fs.writeFileSync(archivePath, JSON.stringify(state, null, 2));

    res.json({ success: true, filename });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Download archive file (protected)
app.get('/api/archives/:filename', requireAuth, (req, res) => {
  try {
    const { filename } = req.params;
    // Security: only allow .json files and prevent directory traversal
    if (!filename.endsWith('.json') || filename.includes('..') || filename.includes('/')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    const archivePath = path.join(DATA_DIR, 'archives', filename);
    if (!fs.existsSync(archivePath)) {
      return res.status(404).json({ error: 'Archive not found' });
    }
    res.download(archivePath);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Download archive file (protected)
app.get('/api/archives/:filename', requireAuth, (req, res) => {
  try {
    const filename = req.params.filename;
    // Sanitize filename to prevent directory traversal
    if (!filename.match(/^[\w\-]+\.json$/)) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    const filePath = path.join(DATA_DIR, 'archives', filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json');
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.use(express.static(path.join(__dirname, '../public')));

// Get current state (protected)
app.get('/api/state', requireAuth, (req, res) => {
  const state = loadState();
  res.json(state);
});

// Get history
app.get('/api/history', requireAuth, (req, res) => {
  const { search, limit = 50, offset = 0, dateFrom, dateTo } = req.query;
  const history = loadHistory();
  let entries = history.entries;
  
  // Date filtering
  if (dateFrom || dateTo) {
    const fromTime = dateFrom ? new Date(dateFrom).setHours(0, 0, 0, 0) : null;
    const toTime = dateTo ? new Date(dateTo).setHours(23, 59, 59, 999) : null;
    
    entries = entries.filter(e => {
      const entryTime = new Date(e.timestamp).getTime();
      if (fromTime && entryTime < fromTime) return false;
      if (toTime && entryTime > toTime) return false;
      return true;
    });
  }
  
  if (search) {
    const searchLower = search.toLowerCase();
    entries = entries.filter(e => {
      // Check basic fields
      const basicMatch = (e.trailerId && e.trailerId.toLowerCase().includes(searchLower)) ||
        (e.carrier && e.carrier.toLowerCase().includes(searchLower)) ||
        (e.doorNumber && e.doorNumber.toString().includes(searchLower)) ||
        (e.action && e.action.toLowerCase().includes(searchLower));
      
      if (basicMatch) return true;
      
      // Check trailer number (top-level or in updates)
      const trailerNum = e.trailerNumber || e.updates?.number || e.updates?.trailerNumber;
      if (trailerNum && trailerNum.toString().toLowerCase().includes(searchLower)) return true;
      
      // Check load/shipment number (top-level or in updates)
      const loadNum = e.loadNumber || e.updates?.loadNumber;
      if (loadNum && loadNum.toString().toLowerCase().includes(searchLower)) return true;
      
      // Check changes array for load numbers
      if (e.changes?.length > 0) {
        for (const change of e.changes) {
          const val = change.to?.toString().toLowerCase() || '';
          const fromVal = change.from?.toString().toLowerCase() || '';
          if (val.includes(searchLower) || fromVal.includes(searchLower)) return true;
        }
      }
      
      return false;
    });
  }
  
  const total = entries.length;
  entries = entries.slice(parseInt(offset), parseInt(offset) + parseInt(limit));
  
  res.json({ entries, total, offset: parseInt(offset), limit: parseInt(limit) });
});

// Move trailer to door
app.post('/api/move-to-door', requireAuth, (req, res) => {
  const { trailerId, doorId, previousDoorId } = req.body;
  const state = loadState();
  
  // Look for trailer in all locations
  let trailer = state.trailers.find(t => t.id === trailerId) || 
                state.yardTrailers.find(t => t.id === trailerId) ||
                state.queuedTrailers?.find(t => t.id === trailerId) ||
                state.appointmentQueue?.find(t => t.id === trailerId);
  
  if (!trailer) {
    return res.status(404).json({ error: 'Trailer not found' });
  }
  
  // Check if trailer was queued (cancel queue)
  const wasQueued = trailer.location === 'queued';
  const oldTargetDoorId = wasQueued ? trailer.targetDoorId : null;
  
  // Support both 'door-1' and 1 as doorId
  const door = state.doors.find(d => d.id === doorId || d.number === parseInt(doorId) || d.id === `door-${doorId}`);
  if (!door) {
    return res.status(404).json({ error: 'Door not found' });
  }
  
  // Validate door is in service and not blank
  if (door.inService === false) {
    return res.status(400).json({ error: 'Door is out of service' });
  }
  if (door.type === 'blank') {
    return res.status(400).json({ error: 'Cannot place trailer in a blank door' });
  }
  
  // If door is occupied, move existing trailer to yard
  if (door.trailerId) {
    const existingTrailer = state.trailers.find(t => t.id === door.trailerId);
    if (existingTrailer) {
      existingTrailer.location = 'yard';
      delete existingTrailer.doorId;
      delete existingTrailer.doorNumber;
      state.yardTrailers.push(existingTrailer);
      state.trailers = state.trailers.filter(t => t.id !== door.trailerId);
      
      addHistoryEntry('MOVED_TO_YARD', {
        trailerId: existingTrailer.id,
        trailerNumber: existingTrailer.number,
        carrier: existingTrailer.carrier,
        fromDoor: door.number,
        reason: 'Replaced by new trailer'
      });
    }
  }
  
  // Capture the previous location BEFORE clearing it
  const oldDoor = state.doors.find(d => d.trailerId === trailerId);
  let previousLocation = 'Yard';
  let fromDoorNum = null;
  let oldDoorId = null;
  let oldDoorNumber = null;
  
  if (oldDoor) {
    fromDoorNum = oldDoor.number;
    oldDoorId = oldDoor.id;
    oldDoorNumber = oldDoor.number;
    previousLocation = `Door ${oldDoor.number}`;
    oldDoor.trailerId = null;
    oldDoor.status = 'empty';
  }
  
  // Track if trailer was in queue
  if (wasQueued) {
    const targetDoor = state.doors.find(d => d.id === oldTargetDoorId);
    previousLocation = `Queue (was for Door ${targetDoor?.number || '?'})`;
  }
  
  // Clear trailer from any yard slot it's currently in
  const oldSlot = state.yardSlots.find(s => s.trailerId === trailerId);
  if (oldSlot) {
    oldSlot.trailerId = null;
    if (!fromDoorNum) {
      previousLocation = `Yard Slot ${oldSlot.number}`;
    }
  }
  
  // Update trailer location
  trailer.location = 'door';
  trailer.doorId = door.id;
  trailer.doorNumber = door.number;
  delete trailer.yardSlotId;
  delete trailer.yardSlotNumber;
  
  // Remove from yard if it was there
  state.yardTrailers = state.yardTrailers.filter(t => t.id !== trailerId);
  
  // Remove from queue if it was there
  if (state.queuedTrailers) {
    state.queuedTrailers = state.queuedTrailers.filter(t => t.id !== trailerId);
  }
  // Remove from appointment queue if it was there
  if (state.appointmentQueue) {
    state.appointmentQueue = state.appointmentQueue.filter(t => t.id !== trailerId);
  }
  // Clear queue-specific fields
  delete trailer.targetDoorId;
  delete trailer.targetDoorNumber;
  
  // Clear staging fields if it was there
  if (state.staging && state.staging.id === trailerId) {
    state.staging = null;
  }
  
  // Add to trailers if not already
  if (!state.trailers.find(t => t.id === trailerId)) {
    state.trailers.push(trailer);
  }
  
  // Update door
  door.trailerId = trailerId;
  door.status = trailer.status;
  
  // Reset dwell time on movement
  resetDwellTime(trailer);
  
  // Auto-assign from queue if old door was cleared
  let autoAssigned = null;
  if (oldDoorId) {
    const queuedForDoor = state.queuedTrailers?.filter(t => t.targetDoorId === oldDoorId);
    if (queuedForDoor && queuedForDoor.length > 0) {
      // Get first in queue (FCFS)
      const nextTrailer = queuedForDoor[0];
      // Remove from queue
      state.queuedTrailers = state.queuedTrailers.filter(t => t.id !== nextTrailer.id);
      
      // Assign to door
      const doorToFill = state.doors.find(d => d.id === oldDoorId);
      if (doorToFill) {
        doorToFill.trailerId = nextTrailer.id;
        doorToFill.status = nextTrailer.status || 'occupied';
      }
      
      // Move to trailers array with door assignment
      nextTrailer.doorId = oldDoorId;
      nextTrailer.doorNumber = oldDoorNumber;
      nextTrailer.location = 'door';
      delete nextTrailer.targetDoorId;
      delete nextTrailer.targetDoorNumber;
      state.trailers.push(nextTrailer);
      
      autoAssigned = {
        trailerId: nextTrailer.id,
        carrier: nextTrailer.carrier,
        doorNumber: oldDoorNumber
      };
    }
  }
  
  saveState(state);
  
  const historyEntry = addHistoryEntry('MOVED_TO_DOOR', {
    trailerId: trailer.id,
    trailerNumber: trailer.number,
    carrier: trailer.carrier,
    doorNumber: door.number,
    status: trailer.status,
    previousLocation,
    fromDoorNum,
    cancelledQueue: wasQueued ? true : undefined,
    ...(autoAssigned && { autoAssignedToDoor: autoAssigned.doorNumber, autoAssignedCarrier: autoAssigned.carrier })
  });
  
  res.json({ success: true, door, trailer, historyEntry, wasQueued, autoAssigned });
});

// Move trailer to yard
app.post('/api/move-to-yard', requireAuth, (req, res) => {
  const { trailerId, doorId } = req.body;
  const state = loadState();
  
  const trailer = state.trailers.find(t => t.id === trailerId);
  if (!trailer) {
    return res.status(404).json({ error: 'Trailer not found' });
  }
  
  // Clear trailer from any yard slot it's currently in
  const oldSlot = state.yardSlots.find(s => s.trailerId === trailerId);
  if (oldSlot) {
    oldSlot.trailerId = null;
  }
  
  // Update trailer
  trailer.location = 'yard';
  delete trailer.doorId;
  delete trailer.doorNumber;
  delete trailer.yardSlotId;
  delete trailer.yardSlotNumber;
  
  // Add to yard
  if (!state.yardTrailers.find(t => t.id === trailerId)) {
    state.yardTrailers.push(trailer);
  }
  
  // Remove from trailers list
  state.trailers = state.trailers.filter(t => t.id !== trailerId);
  
  // Clear door if specified and track for auto-assign
  let clearedDoorId = null;
  let clearedDoorNumber = null;
  if (doorId) {
    const door = state.doors.find(d => d.id === doorId || d.number === parseInt(doorId) || d.id === `door-${doorId}`);
    if (door && door.trailerId === trailerId) {
      door.trailerId = null;
      door.status = 'empty';
      clearedDoorId = door.id;
      clearedDoorNumber = door.number;
    }
  }
  
  // Auto-assign from queue if door was cleared
  let autoAssigned = null;
  if (clearedDoorId) {
    const queuedForDoor = state.queuedTrailers?.filter(t => t.targetDoorId === clearedDoorId);
    if (queuedForDoor && queuedForDoor.length > 0) {
      // Get first in queue (FCFS)
      const nextTrailer = queuedForDoor[0];
      // Remove from queue
      state.queuedTrailers = state.queuedTrailers.filter(t => t.id !== nextTrailer.id);
      
      // Assign to door
      const door = state.doors.find(d => d.id === clearedDoorId);
      if (door) {
        door.trailerId = nextTrailer.id;
        door.status = nextTrailer.status || 'occupied';
      }
      
      // Move to trailers array with door assignment
      nextTrailer.doorId = clearedDoorId;
      nextTrailer.doorNumber = clearedDoorNumber;
      nextTrailer.location = 'door';
      delete nextTrailer.targetDoorId;
      delete nextTrailer.targetDoorNumber;
      state.trailers.push(nextTrailer);
      
      autoAssigned = {
        trailerId: nextTrailer.id,
        carrier: nextTrailer.carrier,
        doorNumber: clearedDoorNumber
      };
    }
  }
  
  // Reset dwell time on movement to yard
  resetDwellTime(trailer);
  
  saveState(state);
  
  const historyEntry = addHistoryEntry('MOVED_TO_YARD', {
    trailerId: trailer.id,
    trailerNumber: trailer.number,
    carrier: trailer.carrier,
    toLocation: 'Yard',
    fromDoor: doorId,
    ...(autoAssigned && { autoAssignedToDoor: autoAssigned.doorNumber, autoAssignedCarrier: autoAssigned.carrier })
  });
  
  res.json({ success: true, trailer, historyEntry, autoAssigned });
});

// Create new trailer
app.post('/api/trailers', requireAuth, (req, res) => {
  const { number, carrier, carrierId, status = 'empty', contents = '', loadNumber, customer, driverName, isLive } = req.body;
  
  if (!carrier) {
    return res.status(400).json({ error: 'Carrier is required' });
  }
  
  const state = loadState();
  
  // Trailer number is optional (quick-add mode has no number)
  const trailerNumber = number ? sanitizeInput(number) : null;
  const safeCarrier = sanitizeInput(carrier);
  
  // Check for duplicate only if number provided
  if (trailerNumber) {
    if (state.trailers.find(t => t.number === trailerNumber) || 
        state.yardTrailers.find(t => t.number === trailerNumber)) {
      return res.status(409).json({ error: 'Trailer number already exists' });
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
    driverPhone: req.body.driverPhone ? sanitizeInput(req.body.driverPhone) : null,
    appointmentTime: req.body.appointmentTime ? sanitizeInput(req.body.appointmentTime) : null,
    isLive: isLive === true || isLive === 'true',
    location: 'yard',
    createdAt: new Date().toISOString()
  };
  
  state.yardTrailers.push(trailer);
  
  // Auto-add carrier if new
  if (!state.carriers.find(c => c.name.toLowerCase() === safeCarrier.toLowerCase())) {
    state.carriers.push({
      id: uuidv4(),
      name: safeCarrier,
      mcNumber: '',
      favorite: false,
      createdAt: new Date().toISOString()
    });
  }
  
  saveState(state);
  
  const historyEntry = addHistoryEntry('TRAILER_CREATED', {
    trailerId: trailer.id,
    trailerNumber: trailer.number,
    carrier: trailer.carrier,
    status: trailer.status
  });
  
  res.json({ success: true, trailer, historyEntry });
});

// Delete trailer
app.delete('/api/trailers/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  const state = loadState();
  
  // Check all possible locations
  let trailer = state.trailers.find(t => t.id === id) || 
                state.yardTrailers.find(t => t.id === id) ||
                (state.staging?.id === id ? state.staging : null) ||
                state.queuedTrailers?.find(t => t.id === id) ||
                state.appointmentQueue?.find(t => t.id === id);
  
  if (!trailer) {
    return res.status(404).json({ error: 'Trailer not found' });
  }
  
  // Track door info before clearing for queue auto-assign
  const clearedDoorId = trailer.doorId;
  const clearedDoorNumber = trailer.doorNumber;
  
  // Clear door if trailer is in one
  if (trailer.doorId) {
    const door = state.doors.find(d => d.id === trailer.doorId);
    if (door) {
      door.trailerId = null;
      door.status = 'empty';
    }
  }
  
  // Remove from all lists
  state.trailers = state.trailers.filter(t => t.id !== id);
  state.yardTrailers = state.yardTrailers.filter(t => t.id !== id);
  if (state.queuedTrailers) {
    state.queuedTrailers = state.queuedTrailers.filter(t => t.id !== id);
  }
  if (state.appointmentQueue) {
    state.appointmentQueue = state.appointmentQueue.filter(t => t.id !== id);
  }
  if (state.staging?.id === id) {
    state.staging = null;
  }
  
  // Auto-assign from queue if door was cleared
  let autoAssigned = null;
  if (clearedDoorId) {
    const queuedForDoor = state.queuedTrailers?.filter(t => t.targetDoorId === clearedDoorId);
    if (queuedForDoor && queuedForDoor.length > 0) {
      // Get first in queue (FCFS)
      const nextTrailer = queuedForDoor[0];
      // Remove from queue
      state.queuedTrailers = state.queuedTrailers.filter(t => t.id !== nextTrailer.id);
      
      // Assign to door
      const door = state.doors.find(d => d.id === clearedDoorId);
      if (door) {
        door.trailerId = nextTrailer.id;
        door.status = nextTrailer.status || 'occupied';
      }
      
      // Move to trailers array with door assignment
      nextTrailer.doorId = clearedDoorId;
      nextTrailer.doorNumber = clearedDoorNumber;
      nextTrailer.location = 'door';
      delete nextTrailer.targetDoorId;
      delete nextTrailer.targetDoorNumber;
      state.trailers.push(nextTrailer);
      
      autoAssigned = {
        trailerId: nextTrailer.id,
        carrier: nextTrailer.carrier,
        doorNumber: clearedDoorNumber
      };
    }
  }
  
  saveState(state);
  
  addHistoryEntry('TRAILER_DELETED', {
    trailerId: id,
    trailerNumber: trailer.number,
    carrier: trailer.carrier,
    ...(autoAssigned && { autoAssignedToDoor: autoAssigned.doorNumber, autoAssignedCarrier: autoAssigned.carrier })
  });
  
  res.json({ success: true, autoAssigned });
});

// Delete shipped trailer record
app.delete('/api/shipped/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  const state = loadState();
  
  const shippedTrailer = state.shippedTrailers?.find(t => t.id === id);
  
  if (!shippedTrailer) {
    return res.status(404).json({ error: 'Shipped trailer not found' });
  }
  
  // Remove from shippedTrailers
  state.shippedTrailers = state.shippedTrailers.filter(t => t.id !== id);
  
  saveState(state);
  
  addHistoryEntry('SHIPPED_DELETED', {
    trailerId: id,
    trailerNumber: shippedTrailer.number,
    carrier: shippedTrailer.carrier,
    shipDate: shippedTrailer.shippedAt
  });
  
  res.json({ success: true });
});

// Update trailer
app.put('/api/trailers/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  const updates = req.body;
  const state = loadState();
  
  let trailer = state.trailers.find(t => t.id === id) || 
                state.yardTrailers.find(t => t.id === id) ||
                (state.staging?.id === id ? state.staging : null) ||
                state.queuedTrailers?.find(t => t.id === id) ||
                state.appointmentQueue?.find(t => t.id === id);
  
  if (!trailer) {
    return res.status(404).json({ error: 'Trailer not found' });
  }
  
  // Track changes for detailed history
  const changes = [];
  const oldValues = {};
  
  // Store old location info for history
  const location = trailer.doorNumber ? `Door ${trailer.doorNumber}` : 
                   trailer.yardSlotNumber ? `Yard Spot ${trailer.yardSlotNumber}` : 
                   trailer.location || 'Unassigned Yard';
  
  // Apply updates and track changes
  if (updates.status && updates.status !== trailer.status) {
    oldValues.status = trailer.status;
    trailer.status = updates.status;
    changes.push({ field: 'status', from: oldValues.status, to: trailer.status });
  }

  if (updates.isLive !== undefined && updates.isLive !== trailer.isLive) {
    oldValues.isLive = trailer.isLive;
    trailer.isLive = updates.isLive;
    changes.push({ field: 'isLive', from: oldValues.isLive, to: trailer.isLive });
  }
  
  if (updates.contents !== undefined && updates.contents !== trailer.contents) {
    oldValues.contents = trailer.contents;
    trailer.contents = updates.contents ? sanitizeInput(updates.contents) : null;
    changes.push({ field: 'contents', from: oldValues.contents, to: trailer.contents });
  }
  
  if (updates.carrier && updates.carrier !== trailer.carrier) {
    oldValues.carrier = trailer.carrier;
    trailer.carrier = sanitizeInput(updates.carrier);
    changes.push({ field: 'carrier', from: oldValues.carrier, to: trailer.carrier });
  }
  
  if (updates.carrierId) trailer.carrierId = updates.carrierId;
  
  if (updates.number !== undefined && updates.number !== trailer.number) {
    oldValues.number = trailer.number;
    trailer.number = updates.number ? sanitizeInput(updates.number) : null;
    changes.push({ field: 'number', from: oldValues.number, to: trailer.number });
  }
  
  if (updates.createdAt) {
    // If createdAt is being updated (dwell reset), track the reset
    if (updates.createdAt !== trailer.createdAt) {
      if (!trailer.dwellResets) trailer.dwellResets = [];
      trailer.dwellResets.push(new Date().toISOString());
      // Keep only last 10 resets
      if (trailer.dwellResets.length > 10) {
        trailer.dwellResets = trailer.dwellResets.slice(-10);
      }
    }
    trailer.createdAt = updates.createdAt;
  }
  
  if (updates.loadNumber !== undefined && updates.loadNumber !== trailer.loadNumber) {
    oldValues.loadNumber = trailer.loadNumber;
    trailer.loadNumber = updates.loadNumber ? sanitizeInput(updates.loadNumber) : null;
    changes.push({ field: 'loadNumber', from: oldValues.loadNumber, to: trailer.loadNumber });
  }
  
  if (updates.customer !== undefined && updates.customer !== trailer.customer) {
    oldValues.customer = trailer.customer;
    trailer.customer = updates.customer ? sanitizeInput(updates.customer) : null;
    changes.push({ field: 'customer', from: oldValues.customer, to: trailer.customer });
  }
  
  if (updates.driverName !== undefined && updates.driverName !== trailer.driverName) {
    oldValues.driverName = trailer.driverName;
    trailer.driverName = updates.driverName ? sanitizeInput(updates.driverName) : null;
    changes.push({ field: 'driverName', from: oldValues.driverName, to: trailer.driverName });
  }

  if (updates.driverPhone !== undefined && updates.driverPhone !== trailer.driverPhone) {
    oldValues.driverPhone = trailer.driverPhone;
    trailer.driverPhone = updates.driverPhone ? sanitizeInput(updates.driverPhone) : null;
    changes.push({ field: 'driverPhone', from: oldValues.driverPhone, to: trailer.driverPhone });
  }

  if (updates.appointmentTime !== undefined && updates.appointmentTime !== trailer.appointmentTime) {
    oldValues.appointmentTime = trailer.appointmentTime;
    trailer.appointmentTime = updates.appointmentTime ? sanitizeInput(updates.appointmentTime) : null;
    changes.push({ field: 'appointmentTime', from: oldValues.appointmentTime, to: trailer.appointmentTime });
  }
  
  // Update door status if trailer is docked
  if (trailer.doorId && updates.status) {
    const door = state.doors.find(d => d.id === trailer.doorId);
    if (door) {
      door.status = updates.status;
    }
  }
  
  saveState(state);
  
  // Build detailed history entry
  const historyDetails = {
    trailerId: trailer.id,
    trailerNumber: trailer.number,
    carrier: trailer.carrier,
    location,
    doorNumber: trailer.doorNumber || null,
    changes: changes.length > 0 ? changes : null,
    updates: changes.length === 0 ? updates : null // Fallback if no changes detected
  };
  
  // Use specific action type if only status changed
  if (changes.length === 1 && changes[0].field === 'status') {
    addHistoryEntry(`TRAILER_${trailer.status.toUpperCase()}`, historyDetails);
  } else {
    addHistoryEntry('TRAILER_UPDATED', historyDetails);
  }
  
  res.json({ success: true, trailer });
});

// Ship trailer (soft delete/archive)
app.post('/api/trailers/:id/ship', requireAuth, (req, res) => {
  const { id } = req.params;
  const state = loadState();
  
  // Find trailer in any location
  let trailerIndex = state.trailers.findIndex(t => t.id === id);
  let trailer = null;
  let sourceLocation = null;
  
  if (trailerIndex >= 0) {
    trailer = state.trailers[trailerIndex];
    sourceLocation = trailer.doorNumber ? `Door ${trailer.doorNumber}` : 
                     trailer.yardSlotNumber ? `Yard Spot ${trailer.yardSlotNumber}` : 
                     'Unassigned Yard';
    // Remove from active trailers
    state.trailers.splice(trailerIndex, 1);
  } else {
    // Check yardTrailers
    trailerIndex = state.yardTrailers.findIndex(t => t.id === id);
    if (trailerIndex >= 0) {
      trailer = state.yardTrailers[trailerIndex];
      sourceLocation = trailer.yardSlotNumber ? `Yard Spot ${trailer.yardSlotNumber}` : 'Unassigned Yard';
      // Remove from yard trailers
      state.yardTrailers.splice(trailerIndex, 1);
    }
  }
  
  if (!trailer) {
    return res.status(404).json({ error: 'Trailer not found' });
  }
  
  // Clear any door/yard slot associations
  let clearedDoorId = null;
  let clearedDoorNumber = null;
  
  if (trailer.doorId) {
    const door = state.doors.find(d => d.id === trailer.doorId);
    if (door) {
      clearedDoorId = door.id;
      clearedDoorNumber = door.number; // Assuming 'number' property exists on door logic
      // Actually door object structure check: state.doors usually has 'id' and 'number' or labels
      // Let's verify how door number is usually accessed. In DELETE endpoint it used clearedDoorNumber.
      // Let's check how clearedDoorNumber was set in DELETE.
      // In DELETE (lines 830-840): 
      // if (trailer.doorId) { ... clearedDoorId = trailer.doorId; clearedDoorNumber = trailer.doorNumber; ... }
      // The trailer object itself stores doorNumber.
      clearedDoorId = trailer.doorId;
      clearedDoorNumber = trailer.doorNumber;
      
      door.trailerId = null;
      door.status = 'empty';
    }
  }
  if (trailer.yardSlotId) {
    const slot = state.yardSlots.find(s => s.id === trailer.yardSlotId);
    if (slot) {
      slot.trailerId = null;
    }
  }
  
  // Mark as shipped and add to shippedTrailers array
  trailer.location = 'shipped';
  trailer.shippedAt = new Date().toISOString();
  trailer.doorId = null;
  trailer.doorNumber = null;
  trailer.yardSlotId = null;
  trailer.yardSlotNumber = null;
  trailer.previousLocation = sourceLocation;
  
  if (!state.shippedTrailers) state.shippedTrailers = [];
  state.shippedTrailers.push(trailer);
  
  // Auto-assign from queue if door was cleared
  let autoAssigned = null;
  if (clearedDoorId) {
    const queuedForDoor = state.queuedTrailers?.filter(t => t.targetDoorId === clearedDoorId);
    if (queuedForDoor && queuedForDoor.length > 0) {
      // Get first in queue (FCFS)
      const nextTrailer = queuedForDoor[0];
      // Remove from queue
      state.queuedTrailers = state.queuedTrailers.filter(t => t.id !== nextTrailer.id);
      
      // Assign to door
      const door = state.doors.find(d => d.id === clearedDoorId);
      if (door) {
        door.trailerId = nextTrailer.id;
        door.status = nextTrailer.status || 'occupied';
      }
      
      // Move to trailers array with door assignment
      nextTrailer.doorId = clearedDoorId;
      nextTrailer.doorNumber = clearedDoorNumber;
      nextTrailer.location = 'door';
      delete nextTrailer.targetDoorId;
      delete nextTrailer.targetDoorNumber;
      state.trailers.push(nextTrailer);
      
      autoAssigned = {
        trailerId: nextTrailer.id,
        carrier: nextTrailer.carrier,
        doorNumber: clearedDoorNumber
      };
    }
  }
  
  saveState(state);
  
  addHistoryEntry('TRAILER_SHIPPED', {
    trailerId: trailer.id,
    trailerNumber: trailer.number,
    carrier: trailer.carrier,
    loadNumber: trailer.loadNumber,
    customer: trailer.customer,
    from: sourceLocation,
    to: 'Shipped',
    ...(autoAssigned && { autoAssignedToDoor: autoAssigned.doorNumber, autoAssignedCarrier: autoAssigned.carrier })
  });
  
  res.json({ success: true, trailer, message: 'Trailer marked as shipped', autoAssigned });
});

// ============================================================================
// Staging & Queue System
// ============================================================================

// Get trailer in staging slot (returns single trailer or null)
app.get('/api/staging', requireAuth, (req, res) => {
  const state = loadState();
  res.json({ trailer: state.staging || null });
});

// Add trailer to staging slot
app.post('/api/staging', requireAuth, (req, res) => {
  const { number, carrier, status = 'loaded', customer, loadNumber, contents, isLive, appointmentTime, driverPhone } = req.body;
  const state = loadState();
  
  // Validate staging is empty
  if (state.staging) {
    return res.status(400).json({ error: 'Staging slot is already occupied' });
  }
  
  // Validate required fields
  if (!carrier) {
    return res.status(400).json({ error: 'Carrier is required' });
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
    isLive: isLive === true || isLive === 'true',
    location: 'staging',
    createdAt: new Date().toISOString()
  };
  
  state.staging = trailer;
  saveState(state);
  
  addHistoryEntry('TRAILER_CREATED', {
    trailerId: trailer.id,
    trailerNumber: trailer.number,
    carrier: trailer.carrier,
    location: 'Staging',
    customer: trailer.customer,
    loadNumber: trailer.loadNumber
  });
  
  res.json({ success: true, trailer });
});

// Move trailer from staging to queue (waiting for specific door)
app.post('/api/queue', requireAuth, (req, res) => {
  const { trailerId, targetDoorId, targetDoorNumber } = req.body;
  const state = loadState();
  
  if (!trailerId || !targetDoorId) {
    return res.status(400).json({ error: 'Trailer ID and target door ID are required' });
  }
  
  // Find trailer in staging OR appointment queue
  let trailer = null;
  let source = null;
  
  if (state.staging && state.staging.id === trailerId) {
    trailer = state.staging;
    source = 'staging';
  } else if (state.appointmentQueue) {
    const idx = state.appointmentQueue.findIndex(t => t.id === trailerId);
    if (idx !== -1) {
      trailer = state.appointmentQueue[idx];
      source = 'appointment-queue';
    }
  }
  
  if (!trailer) {
    return res.status(404).json({ error: 'Trailer not found in staging or appointment queue' });
  }
  
  // Move to queue
  if (!state.queuedTrailers) state.queuedTrailers = [];
  
  trailer.location = 'queued';
  trailer.targetDoorId = targetDoorId;
  trailer.targetDoorNumber = targetDoorNumber;
  trailer.queuedAt = new Date().toISOString();
  
  state.queuedTrailers.push(trailer);
  
  // Clear from source
  if (source === 'staging') {
    state.staging = null;
  } else if (source === 'appointment-queue') {
    state.appointmentQueue = state.appointmentQueue.filter(t => t.id !== trailerId);
  }
  
  saveState(state);
  
  addHistoryEntry('TRAILER_QUEUED', {
    trailerId: trailer.id,
    trailerNumber: trailer.number,
    carrier: trailer.carrier,
    targetDoor: targetDoorNumber,
    targetDoorId
  });
  
  res.json({ success: true, trailer });
});

// Get all queued trailers
app.get('/api/queue', requireAuth, (req, res) => {
  const state = loadState();
  res.json({ trailers: state.queuedTrailers || [] });
});

// Cancel a queued trailer (move to unassigned yard)
app.post('/api/queue/:id/cancel', requireAuth, (req, res) => {
  const { id } = req.params;
  const state = loadState();
  
  if (!state.queuedTrailers) {
    return res.status(404).json({ error: 'No trailers in queue' });
  }
  
  const index = state.queuedTrailers.findIndex(t => t.id === id);
  if (index === -1) {
    return res.status(404).json({ error: 'Trailer not found in queue' });
  }
  
  const trailer = state.queuedTrailers[index];
  
  // Move to unassigned yard
  trailer.location = null;
  trailer.targetDoorId = null;
  trailer.targetDoorNumber = null;
  trailer.queuedAt = null;
  
  if (!state.yardTrailers) state.yardTrailers = [];
  state.yardTrailers.push(trailer);
  state.queuedTrailers.splice(index, 1);
  
  saveState(state);
  
  addHistoryEntry('TRAILER_UNQUEUED', {
    trailerId: trailer.id,
    trailerNumber: trailer.number,
    carrier: trailer.carrier,
    action: 'moved to unassigned yard'
  });
  
  res.json({ success: true, trailer });
});

// Reassign queued trailer to different door
app.post('/api/queue/:id/reassign', requireAuth, (req, res) => {
  const { id } = req.params;
  const { targetDoorId, targetDoorNumber } = req.body;
  
  if (!targetDoorId) {
    return res.status(400).json({ error: 'Target door ID is required' });
  }
  
  const state = loadState();
  
  if (!state.queuedTrailers) {
    return res.status(404).json({ error: 'No trailers in queue' });
  }
  
  const trailer = state.queuedTrailers.find(t => t.id === id);
  if (!trailer) {
    return res.status(404).json({ error: 'Trailer not found in queue' });
  }
  
  const oldDoor = trailer.targetDoorNumber;
  trailer.targetDoorId = targetDoorId;
  trailer.targetDoorNumber = targetDoorNumber;
  trailer.queuedAt = new Date().toISOString(); // Reset priority to now
  
  saveState(state);
  
  addHistoryEntry('TRAILER_REASSIGNED', {
    trailerId: trailer.id,
    trailerNumber: trailer.number,
    carrier: trailer.carrier,
    fromDoor: oldDoor,
    toDoor: targetDoorNumber
  });
  
  res.json({ success: true, trailer });
});

// Assign next queued trailer to a door (called when door becomes available)
app.post('/api/doors/:id/assign-next', requireAuth, (req, res) => {
  const { id } = req.params;
  const state = loadState();
  
  if (!state.queuedTrailers || state.queuedTrailers.length === 0) {
    return res.json({ success: false, message: 'No trailers in queue' });
  }
  
  // Find oldest queued trailer for this door
  const queuedIndex = state.queuedTrailers.findIndex(t => t.targetDoorId === id);
  if (queuedIndex === -1) {
    return res.json({ success: false, message: 'No trailers queued for this door' });
  }
  
  const door = state.doors.find(d => d.id === id);
  if (!door) {
    return res.status(404).json({ error: 'Door not found' });
  }
  
  if (door.trailerId) {
    return res.status(400).json({ error: 'Door is still occupied' });
  }
  
  const trailer = state.queuedTrailers[queuedIndex];
  
  // Move trailer to door
  trailer.doorId = door.id;
  trailer.doorNumber = door.number;
  trailer.location = null; // No longer special location
  trailer.targetDoorId = null;
  trailer.targetDoorNumber = null;
  trailer.queuedAt = null;
  
  door.trailerId = trailer.id;
  door.status = trailer.status;
  
  // Remove from queue
  state.queuedTrailers.splice(queuedIndex, 1);
  
  // Add to trailers array
  state.trailers.push(trailer);
  
  saveState(state);
  
  addHistoryEntry('TRAILER_ASSIGNED_FROM_QUEUE', {
    trailerId: trailer.id,
    trailerNumber: trailer.number,
    carrier: trailer.carrier,
    toDoor: door.number,
    doorId: door.id
  });
  
  res.json({ success: true, trailer, door });
});

// Move trailer from staging to appointment queue
app.post('/api/appointment-queue', requireAuth, (req, res) => {
  const { trailerId } = req.body;
  const state = loadState();
  
  if (!trailerId) {
    return res.status(400).json({ error: 'Trailer ID is required' });
  }
  
  // Find trailer in staging
  if (!state.staging || state.staging.id !== trailerId) {
    return res.status(404).json({ error: 'Trailer not found in staging' });
  }
  
  const trailer = state.staging;
  
  // Move to appointment queue
  if (!state.appointmentQueue) state.appointmentQueue = [];
  
  trailer.location = 'appointment-queue';
  delete trailer.targetDoorId;
  delete trailer.targetDoorNumber;
  trailer.queuedAt = new Date().toISOString();
  
  state.appointmentQueue.push(trailer);
  state.staging = null; // Clear staging
  
  saveState(state);
  
  addHistoryEntry('TRAILER_QUEUED_APPT', {
    trailerId: trailer.id,
    trailerNumber: trailer.number,
    carrier: trailer.carrier,
    location: 'Appointment Queue'
  });
  
  res.json({ success: true, trailer });
});

// Get all appointment queue trailers
app.get('/api/appointment-queue', requireAuth, (req, res) => {
  const state = loadState();
  res.json({ trailers: state.appointmentQueue || [] });
});

// Cancel an appointment queue trailer (move to unassigned yard)
app.post('/api/appointment-queue/:id/cancel', requireAuth, (req, res) => {
  const { id } = req.params;
  const state = loadState();
  
  if (!state.appointmentQueue) {
    return res.status(404).json({ error: 'No trailers in appointment queue' });
  }
  
  const index = state.appointmentQueue.findIndex(t => t.id === id);
  if (index === -1) {
    return res.status(404).json({ error: 'Trailer not found in appointment queue' });
  }
  
  const trailer = state.appointmentQueue[index];
  
  // Move to unassigned yard
  trailer.location = null;
  trailer.queuedAt = null;
  
  if (!state.yardTrailers) state.yardTrailers = [];
  state.yardTrailers.push(trailer);
  state.appointmentQueue.splice(index, 1);
  
  saveState(state);
  
  addHistoryEntry('TRAILER_UNQUEUED_APPT', {
    trailerId: trailer.id,
    trailerNumber: trailer.number,
    carrier: trailer.carrier,
    action: 'moved to unassigned yard'
  });
  
  res.json({ success: true, trailer });
});

// Reorder appointment queue
app.post('/api/appointment-queue/reorder', requireAuth, (req, res) => {
  const { trailerIds } = req.body;
  const state = loadState();
  
  if (!state.appointmentQueue) return res.json({ success: true });
  
  // Rebuild queue based on new ID order
  const newQueue = [];
  const map = new Map(state.appointmentQueue.map(t => [t.id, t]));
  
  trailerIds.forEach(id => {
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
  saveState(state);
  
  res.json({ success: true });
});

// Add/update carrier
app.post('/api/carriers', requireAuth, (req, res) => {
  const { name, mcNumber, favorite = false } = req.body;
  
  if (!name) {
    return res.status(400).json({ error: 'Carrier name is required' });
  }
  
  const state = loadState();
  
  const carrier = {
    id: uuidv4(),
    name: sanitizeInput(name),
    mcNumber: mcNumber ? sanitizeInput(mcNumber) : '',
    favorite,
    createdAt: new Date().toISOString()
  };
  
  state.carriers.push(carrier);
  saveState(state);
  
  res.json({ success: true, carrier });
});

// Update carrier favorite status
app.put('/api/carriers/:id/favorite', requireAuth, (req, res) => {
  const { id } = req.params;
  const { favorite } = req.body;
  const state = loadState();
  
  const carrier = state.carriers.find(c => c.id === id);
  if (!carrier) {
    return res.status(404).json({ error: 'Carrier not found' });
  }
  
  carrier.favorite = favorite;
  saveState(state);
  
  res.json({ success: true, carrier });
});

// Increment carrier usage count
app.post('/api/carriers/:id/use', requireAuth, (req, res) => {
  const { id } = req.params;
  const state = loadState();
  
  const carrier = state.carriers.find(c => c.id === id);
  if (!carrier) {
    return res.status(404).json({ error: 'Carrier not found' });
  }
  
  carrier.usageCount = (carrier.usageCount || 0) + 1;
  saveState(state);
  
  res.json({ success: true, carrier });
});

// Delete carrier
app.delete('/api/carriers/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  const state = loadState();
  
  const carrierIndex = state.carriers.findIndex(c => c.id === id);
  if (carrierIndex === -1) {
    return res.status(404).json({ error: 'Carrier not found' });
  }
  
  const carrier = state.carriers[carrierIndex];
  
  // Check if carrier is in use
  const inUse = state.trailers.some(t => t.carrier === carrier.name) || 
                state.yardTrailers.some(t => t.carrier === carrier.name);
  if (inUse) {
    return res.status(400).json({ error: 'Carrier is assigned to trailers' });
  }
  
  state.carriers.splice(carrierIndex, 1);
  saveState(state);
  
  addHistoryEntry('CARRIER_DELETED', { carrierId: id, carrierName: carrier.name });
  
  res.json({ success: true });
});

// Reorder doors (customize layout)
app.post('/api/doors/reorder', requireAuth, (req, res) => {
  const { doorIds } = req.body;
  const state = loadState();
  
  // Validate all doors exist
  const validIds = doorIds.filter(id => state.doors.find(d => d.id === id));
  
  // Reorder based on provided IDs
  const reorderedDoors = validIds.map((id, index) => {
    const door = state.doors.find(d => d.id === id);
    return { ...door, order: index };
  });
  
  // Add any missing doors at the end
  const missingDoors = state.doors.filter(d => !validIds.includes(d.id));
  reorderedDoors.push(...missingDoors.map((d, i) => ({ ...d, order: validIds.length + i })));
  
  state.doors = reorderedDoors;
  saveState(state);
  
  res.json({ success: true, doors: state.doors });
});

// Door Management APIs

// Update door (in/out of service, type, etc.)
app.put('/api/doors/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  const { inService, type, number, labelText, order } = req.body;
  const state = loadState();
  
  const door = state.doors.find(d => d.id === id);
  if (!door) {
    return res.status(404).json({ error: 'Door not found' });
  }
  
  // Handle number - can be set to null for unnumbered (blank) doors
  // Duplicate checking removed - labels are now the primary identifiers
  if (number !== undefined) {
    const newNum = number === null || number === '' ? null : parseInt(number);
    door.number = newNum;
  }
  
  if (inService !== undefined) door.inService = inService;
  if (type !== undefined) door.type = type;
  if (labelText !== undefined) door.labelText = labelText ? sanitizeInput(labelText) : null;
  if (order !== undefined) door.order = order;
  
  saveState(state);
  
  addHistoryEntry('DOOR_UPDATED', {
    doorId: id,
    doorNumber: door.number,
    labelText: door.labelText,
    inService: door.inService,
    type: door.type
  });
  
  res.json({ success: true, door });
});

// Create new door
app.post('/api/doors', requireAuth, (req, res) => {
  const { number, type = 'normal', labelText } = req.body;
  const state = loadState();
  
  // Parse number as integer (comes as string from form, can be null for blanks)
  // Number is now optional - labelText is the primary display identifier
  const num = number ? parseInt(number) : null;
  
  // For blank/text-only doors, number is optional
  // Generate a unique ID but no door number
  const nextOrder = Math.max(...state.doors.map(d => d.order || 0), 0) + 1;
  
  const newDoor = {
    id: `door-${uuidv4()}`,
    number: num, // Can be null for blank/spacer doors
    order: nextOrder,
    labelText: labelText ? sanitizeInput(labelText) : null,
    trailerId: null,
    status: 'empty',
    inService: type !== 'out-of-service',
    type: type
  };
  
  state.doors.push(newDoor);
  // Sort by order field, then by number (unnumbered doors go last)
  state.doors.sort((a, b) => (a.order || 999) - (b.order || 999) || (a.number || 999) - (b.number || 999));
  saveState(state);
  
  addHistoryEntry('DOOR_CREATED', {
    doorId: newDoor.id,
    doorNumber: newDoor.number,
    doorLabel: newDoor.labelText,
    type: newDoor.type
  });
  
  res.json({ success: true, door: newDoor });
});

// Delete door
app.delete('/api/doors/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  const state = loadState();
  
  const doorIndex = state.doors.findIndex(d => d.id === id);
  if (doorIndex === -1) {
    return res.status(404).json({ error: 'Door not found' });
  }
  
  const door = state.doors[doorIndex];
  
  // Move any trailer to yard if door is deleted
  if (door.trailerId) {
    const trailer = state.trailers.find(t => t.id === door.trailerId);
    if (trailer) {
      trailer.location = 'yard';
      trailer.doorId = null;
      trailer.doorNumber = null;
      state.yardTrailers.push(trailer);
      state.trailers = state.trailers.filter(t => t.id !== door.trailerId);
    }
  }
  
  state.doors.splice(doorIndex, 1);
  saveState(state);
  
  addHistoryEntry('DOOR_DELETED', {
    doorId: id,
    doorNumber: door.number
  });
  
  res.json({ success: true });
});

// ============================================================================
// Yard Slot APIs
// ============================================================================

// Get all yard slots
app.get('/api/yard-slots', requireAuth, (req, res) => {
  const state = loadState();
  res.json({ slots: state.yardSlots || [] });
});

// Reorder yard slots
app.post('/api/yard-slots/reorder', requireAuth, (req, res) => {
  const { slotIds } = req.body;
  const state = loadState();
  
  // Validate all slots exist
  const validIds = slotIds.filter(id => state.yardSlots.find(s => s.id === id));
  
  // Reorder based on provided IDs
  const reorderedSlots = validIds.map((id, index) => {
    const slot = state.yardSlots.find(s => s.id === id);
    return { ...slot, order: index };
  });
  
  // Add any missing slots at the end
  const missingSlots = state.yardSlots.filter(s => !validIds.includes(s.id));
  reorderedSlots.push(...missingSlots.map((s, i) => ({ ...s, order: validIds.length + i })));
  
  state.yardSlots = reorderedSlots;
  saveState(state);
  
  res.json({ success: true, slots: state.yardSlots });
});

// Move trailer to yard slot
app.post('/api/move-to-yard-slot', requireAuth, (req, res) => {
  const { trailerId, slotId, previousSlotId } = req.body;
  const state = loadState();
  
  const trailer = state.trailers.find(t => t.id === trailerId) ||
                  state.yardTrailers.find(t => t.id === trailerId);
  
  if (!trailer) {
    return res.status(404).json({ error: 'Trailer not found' });
  }
  
  const slot = state.yardSlots.find(s => s.id === slotId || s.number === parseInt(slotId));
  if (!slot) {
    return res.status(404).json({ error: 'Yard slot not found' });
  }
  
  // If slot is occupied, move existing trailer back to unassigned yard
  if (slot.trailerId) {
    const existingTrailer = state.trailers.find(t => t.id === slot.trailerId) ||
                           state.yardTrailers.find(t => t.id === slot.trailerId);
    if (existingTrailer) {
      slot.trailerId = null;
      if (!state.yardTrailers.find(t => t.id === existingTrailer.id)) {
        existingTrailer.location = 'yard';
        delete existingTrailer.doorId;
        delete existingTrailer.doorNumber;
        delete existingTrailer.yardSlotId;
        delete existingTrailer.yardSlotNumber;
        state.yardTrailers.push(existingTrailer);
      }
      state.trailers = state.trailers.filter(t => t.id !== existingTrailer.id);
    }
  }
  
  // Clear previous slot if moving from another slot
  if (previousSlotId) {
    const prevSlot = state.yardSlots.find(s => s.id === previousSlotId || s.number === parseInt(previousSlotId));
    if (prevSlot) {
      prevSlot.trailerId = null;
    }
  }
  
  // Also clear from any other slot
  state.yardSlots.forEach(s => {
    if (s.trailerId === trailerId) {
      s.trailerId = null;
    }
  });
  
  // Update trailer
  trailer.location = 'yard';
  trailer.yardSlotId = slot.id;
  trailer.yardSlotNumber = slot.number;
  delete trailer.doorId;
  delete trailer.doorNumber;
  
  // Assign to slot
  slot.trailerId = trailerId;
  
  // If trailer was at a door, clear the door
  state.doors.forEach(door => {
    if (door.trailerId === trailerId) {
      door.trailerId = null;
      door.status = 'empty';
    }
  });
  
  // Remove from yardTrailers if it was there
  state.yardTrailers = state.yardTrailers.filter(t => t.id !== trailerId);
  
  // Add to trailers list with yard slot location
  if (!state.trailers.find(t => t.id === trailerId)) {
    state.trailers.push(trailer);
  }
  
  // Reset dwell time on movement to yard slot
  resetDwellTime(trailer);
  
  saveState(state);
  
  const historyEntry = addHistoryEntry('MOVED_TO_YARD_SLOT', {
    trailerId: trailer.id,
    trailerNumber: trailer.number,
    carrier: trailer.carrier,
    toLocation: `Yard Slot ${slot.number}`,
    slotId: slot.id
  });
  
  res.json({ success: true, trailer, slot, historyEntry });
});

// Move trailer from yard slot back to unassigned yard
app.post('/api/move-from-yard-slot', requireAuth, (req, res) => {
  const { trailerId } = req.body;
  const state = loadState();
  
  const trailer = state.trailers.find(t => t.id === trailerId);
  if (!trailer) {
    return res.status(404).json({ error: 'Trailer not found' });
  }
  
  // Clear the slot
  const slot = state.yardSlots.find(s => s.trailerId === trailerId);
  if (slot) {
    slot.trailerId = null;
  }
  
  // Move to unassigned yard
  trailer.location = 'yard';
  delete trailer.yardSlotId;
  delete trailer.yardSlotNumber;
  
  if (!state.yardTrailers.find(t => t.id === trailerId)) {
    state.yardTrailers.push(trailer);
  }
  state.trailers = state.trailers.filter(t => t.id !== trailerId);
  
  // Reset dwell time on movement to unassigned yard
  resetDwellTime(trailer);
  
  saveState(state);
  
  const historyEntry = addHistoryEntry('MOVED_TO_YARD', {
    trailerId: trailer.id,
    trailerNumber: trailer.number,
    carrier: trailer.carrier,
    fromSlot: slot?.number
  });
  
  res.json({ success: true, trailer, historyEntry });
});

// Update yard slot
app.put('/api/yard-slots/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  const { number } = req.body;
  const state = loadState();
  
  const slot = state.yardSlots.find(s => s.id === id);
  if (!slot) {
    return res.status(404).json({ error: 'Yard slot not found' });
  }
  
  if (number !== undefined) {
    // Check for duplicate numbers
    if (state.yardSlots.find(s => s.number === number && s.id !== id)) {
      return res.status(409).json({ error: 'Yard slot number already exists' });
    }
    
    const oldNumber = slot.number;
    slot.number = number;
    
    // Update trailer's reference if there is one
    if (slot.trailerId) {
      const trailer = state.trailers.find(t => t.id === slot.trailerId);
      if (trailer) {
        trailer.yardSlotNumber = number;
      }
    }
    
    addHistoryEntry('YARD_SLOT_UPDATED', {
      slotId: id,
      oldNumber,
      newNumber: number
    });
  }
  
  saveState(state);
  res.json({ success: true, slot });
});

// Create new yard slot
app.post('/api/yard-slots', requireAuth, (req, res) => {
  const { number } = req.body;
  const state = loadState();
  
  const slotNumber = number || (state.yardSlots.length > 0 ? Math.max(...state.yardSlots.map(s => s.number)) + 1 : 1);
  
  // Check for duplicates
  if (state.yardSlots.find(s => s.number === slotNumber)) {
    return res.status(409).json({ error: 'Yard slot number already exists' });
  }
  
  const newSlot = {
    id: `yard-${uuidv4()}`,
    number: slotNumber,
    trailerId: null
  };
  
  state.yardSlots.push(newSlot);
  saveState(state);
  
  addHistoryEntry('YARD_SLOT_CREATED', {
    slotId: newSlot.id,
    number: slotNumber
  });
  
  res.json({ success: true, slot: newSlot });
});

// Delete yard slot
app.delete('/api/yard-slots/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  const state = loadState();
  
  const slotIndex = state.yardSlots.findIndex(s => s.id === id);
  if (slotIndex === -1) {
    return res.status(404).json({ error: 'Yard slot not found' });
  }
  
  const slot = state.yardSlots[slotIndex];
  
  // Move any trailer to unassigned yard if slot is deleted
  if (slot.trailerId) {
    const trailer = state.trailers.find(t => t.id === slot.trailerId);
    if (trailer) {
      trailer.location = 'yard';
      delete trailer.yardSlotId;
      delete trailer.yardSlotNumber;
      if (!state.yardTrailers.find(t => t.id === trailer.id)) {
        state.yardTrailers.push(trailer);
      }
      state.trailers = state.trailers.filter(t => t.id !== trailer.id);
    }
  }
  
  state.yardSlots.splice(slotIndex, 1);
  saveState(state);
  
  addHistoryEntry('YARD_SLOT_DELETED', {
    slotId: id,
    number: slot.number
  });
  
  res.json({ success: true });
});

// Analytics endpoint - uses daily aggregates calculated from history
app.get('/api/analytics', requireAuth, (req, res) => {
  const { period = 'day' } = req.query;
  const analytics = loadAnalytics();
  
  const now = new Date();
  const result = {
    period,
    generatedAt: now.toISOString(),
    data: []
  };
  
  // Ensure we have today's stats
  const today = now.toISOString().split('T')[0];
  if (!analytics.dailyStats?.[today]) {
    calculateDailyDwell(today);
  }
  
  if (period === 'day') {
    // Last 7 days
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dateKey = d.toISOString().split('T')[0];
      const stats = analytics.dailyStats?.[dateKey];
      result.data.push({
        date: dateKey,
        label: d.toLocaleDateString('en-US', { weekday: 'short' }),
        avgDwell: stats?.avgDwell || 0,
        maxDwell: stats?.maxDwell || 0,
        count: stats?.count || 0,
        violations: stats?.violations || 0
      });
    }
  } else if (period === 'week') {
    // Last 4 weeks - aggregate from daily stats
    const weeks = {};
    Object.entries(analytics.dailyStats || {}).forEach(([date, stats]) => {
      const d = new Date(date);
      const weekStart = new Date(d);
      weekStart.setDate(d.getDate() - d.getDay());
      const weekKey = weekStart.toISOString().split('T')[0];
      
      if (!weeks[weekKey]) weeks[weekKey] = { totalDwell: 0, maxDwell: 0, count: 0, violations: 0, days: 0 };
      weeks[weekKey].totalDwell += (stats.avgDwell * stats.count);
      weeks[weekKey].maxDwell = Math.max(weeks[weekKey].maxDwell, stats.maxDwell || 0);
      weeks[weekKey].count += stats.count;
      weeks[weekKey].violations += stats.violations || 0;
      weeks[weekKey].days++;
    });
    
    result.data = Object.entries(weeks)
      .sort((a, b) => new Date(a[0]) - new Date(b[0]))
      .slice(-4)
      .map(([week, stats]) => ({
        date: week,
        label: `Week of ${new Date(week).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
        avgDwell: stats.count > 0 ? Math.round((stats.totalDwell / stats.count) * 100) / 100 : 0,
        maxDwell: stats.maxDwell,
        count: stats.count,
        violations: stats.violations
      }));
  } else if (period === 'month') {
    // Last 3 months - aggregate from daily stats
    const months = {};
    Object.entries(analytics.dailyStats || {}).forEach(([date, stats]) => {
      const d = new Date(date);
      const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      
      if (!months[monthKey]) months[monthKey] = { totalDwell: 0, maxDwell: 0, count: 0, violations: 0, days: 0 };
      months[monthKey].totalDwell += (stats.avgDwell * stats.count);
      months[monthKey].maxDwell = Math.max(months[monthKey].maxDwell, stats.maxDwell || 0);
      months[monthKey].count += stats.count;
      months[monthKey].violations += stats.violations || 0;
      months[monthKey].days++;
    });
    
    result.data = Object.entries(months)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-3)
      .map(([month, stats]) => ({
        date: month,
        label: new Date(month + '-01').toLocaleDateString('en-US', { month: 'long' }),
        avgDwell: stats.count > 0 ? Math.round((stats.totalDwell / stats.count) * 100) / 100 : 0,
        maxDwell: stats.maxDwell,
        count: stats.count,
        violations: stats.violations
      }));
  }
  
  res.json(result);
});

// Force analytics snapshot (for testing)
app.post('/api/analytics/snapshot', requireAuth, (req, res) => {
  try {
    recordDwellSnapshot();
    res.json({ success: true, message: 'Snapshot recorded' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Clear all analytics history
app.delete('/api/analytics', requireAuth, (req, res) => {
  try {
    const { mode } = req.query;
    
    if (mode === 'reset_start_date') {
      const settings = loadSettings();
      settings.analyticsStartDate = new Date().toISOString();
      saveSettings(settings);
      
      addHistoryEntry('ANALYTICS_START_DATE_RESET', { timestamp: settings.analyticsStartDate });
      return res.json({ success: true, message: 'Analytics start date reset to now' });
    }
    
    const emptyAnalytics = { snapshots: [], dailyStats: {}, weeklyStats: {}, monthlyStats: {} };
    saveAnalytics(emptyAnalytics);
    addHistoryEntry('ANALYTICS_CLEARED', { timestamp: new Date().toISOString() });
    res.json({ success: true, message: 'Analytics history cleared' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get 2+ hour dwell violations (for analytics tab)
app.get('/api/analytics/violations', requireAuth, (req, res) => {
  try {
    const { period = 'day' } = req.query;
    const data = getDwellViolations(period);
    res.json({
      period,
      title: 'Trailers Over 2 Hours',
      description: 'Count of docked trailers exceeding 2 hours dwell time (excludes >6h)',
      generatedAt: new Date().toISOString(),
      data
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get current violations (real-time) - docked trailers only
app.get('/api/analytics/current-violations', requireAuth, (req, res) => {
  try {
    const state = loadState();
    const now = Date.now();
    const violations = [];
    
    // Only check docked trailers (with door assignment)
    state.trailers.forEach(t => {
      if (!t.createdAt || !t.doorId || !t.doorNumber) return;
      
      const resets = t.dwellResets || [];
      const dwellHours = getEffectiveDwellHours(t.createdAt, resets, now);
      
      // 2+ hours but < 6 hours
      if (dwellHours >= 2 && dwellHours < 6) {
        violations.push({
          id: t.id,
          carrier: t.carrier,
          number: t.number,
          loadNumber: t.loadNumber,
          customer: t.customer,
          dwellHours: Math.round(dwellHours * 100) / 100,
          doorNumber: t.doorNumber,
          location: `Door ${t.doorNumber}`,
          status: t.status
        });
      }
    });
    
    // Sort by dwell time descending (longest first)
    violations.sort((a, b) => b.dwellHours - a.dwellHours);
    
    res.json({
      count: violations.length,
      generatedAt: new Date().toISOString(),
      trailers: violations
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get door heatmap data (carrier/customer filterable)
app.get('/api/analytics/heatmap', requireAuth, (req, res) => {
  try {
    const state = loadState();
    const { carrier, customer } = req.query;
    
    // Build door usage map
    const doorStats = {};
    
    // Initialize all doors
    state.doors.forEach(d => {
      if (d.type !== 'blank' && d.inService !== false) {
        doorStats[d.number] = {
          doorNumber: d.number,
          trailerCount: 0,
          loadedCount: 0,
          emptyCount: 0,
          carriers: {},
          customers: {}
        };
      }
    });
    
    // Count trailers at each door
    state.trailers.forEach(t => {
      if (!t.doorNumber || !doorStats[t.doorNumber]) return;
      
      // Apply filters if provided
      if (carrier && t.carrier !== carrier) return;
      if (customer && t.customer !== customer) return;
      
      const stats = doorStats[t.doorNumber];
      stats.trailerCount++;
      
      if (t.status === 'loaded') {
        stats.loadedCount++;
      } else {
        stats.emptyCount++;
      }
      
      // Track carriers
      if (t.carrier) {
        stats.carriers[t.carrier] = (stats.carriers[t.carrier] || 0) + 1;
      }
      
      // Track customers
      if (t.customer) {
        stats.customers[t.customer] = (stats.customers[t.customer] || 0) + 1;
      }
    });
    
    // Get available filters
    const allCarriers = [...new Set(state.trailers.map(t => t.carrier).filter(Boolean))].sort();
    const allCustomers = [...new Set(state.trailers.map(t => t.customer).filter(Boolean))].sort();
    
    res.json({
      generatedAt: new Date().toISOString(),
      filters: { carrier, customer },
      availableCarriers: allCarriers,
      availableCustomers: allCustomers,
      doors: Object.values(doorStats).sort((a, b) => a.doorNumber - b.doorNumber)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get position patterns from history (where do carrier/customer combos usually go)
app.get('/api/analytics/position-patterns', requireAuth, (req, res) => {
  try {
    const historyData = loadHistory();
    const history = historyData.entries || historyData; // Handle both {entries: []} and direct array
    const { carrier, customer, dateFrom, dateTo } = req.query;
    
    // Get analytics start date from settings
    const settings = loadSettings();
    const startDate = settings.analyticsStartDate ? new Date(settings.analyticsStartDate).getTime() : 0;
    
    // Parse date range
    const fromDateParam = dateFrom ? new Date(dateFrom).getTime() : 0;
    const fromDate = Math.max(fromDateParam, startDate);
    const toDate = dateTo ? new Date(dateTo).getTime() + 24 * 60 * 60 * 1000 : null; // Include full day
    
    // Track current customer for each trailer (updated by TRAILER_UPDATED events)
    const trailerCustomers = {}; // trailerId -> current customer
    const allCarriersSet = new Set();
    const allCustomersSet = new Set();
    
    // Helper to extract customer from changes array
    const getCustomerFromChanges = (changes) => {
      if (!changes || !Array.isArray(changes)) return null;
      const customerChange = changes.find(c => c.field === 'customer');
      return customerChange ? customerChange.to : null;
    };
    
    // First pass: Build customer lookup from all history
    history.forEach(entry => {
      const entryCustomer = entry.customer || 
                           entry.details?.customer || 
                           getCustomerFromChanges(entry.changes) ||
                           getCustomerFromChanges(entry.details?.changes);
      
      if (entryCustomer && entry.trailerId) {
        trailerCustomers[entry.trailerId] = entryCustomer;
      }
      
      // Track all unique carriers and customers for dropdowns
      if (entry.carrier) allCarriersSet.add(entry.carrier);
      if (entryCustomer) allCustomersSet.add(entryCustomer);
    });
    
    // Second pass: Count ALL door movements (not just one per trailer)
    const doorFrequency = {};
    const comboStats = {};
    
    history.forEach(entry => {
      const entryTime = new Date(entry.timestamp).getTime();
      if (fromDate && entryTime < fromDate) return;
      if (toDate && entryTime > toDate) return;
      
      // Process door placement (MOVED_TO_DOOR or TRAILER_CREATED with doorNumber)
      const doorNum = entry.doorNumber || entry.toDoorNumber;
      if (!doorNum) return;
      if (entry.action !== 'MOVED_TO_DOOR' && entry.action !== 'TRAILER_CREATED') return;
      
      // Get customer for this trailer (current assigned customer)
      const entryCustomer = trailerCustomers[entry.trailerId] || 
                           entry.customer || 
                           entry.details?.customer;
      const entryCarrier = entry.carrier;
      
      // Apply filters
      if (carrier && entryCarrier !== carrier) return;
      if (customer && entryCustomer !== customer) return;
      
      // Count this placement
      if (!doorFrequency[doorNum]) {
        doorFrequency[doorNum] = { count: 0, carriers: {}, customers: {} };
      }
      doorFrequency[doorNum].count++;
      
      if (entryCarrier) {
        doorFrequency[doorNum].carriers[entryCarrier] = 
          (doorFrequency[doorNum].carriers[entryCarrier] || 0) + 1;
      }
      if (entryCustomer) {
        doorFrequency[doorNum].customers[entryCustomer] = 
          (doorFrequency[doorNum].customers[entryCustomer] || 0) + 1;
      }
      
      // Track carrier-customer combos
      if (entryCarrier && entryCustomer) {
        const comboKey = `${entryCarrier}|${entryCustomer}`;
        if (!comboStats[comboKey]) {
          comboStats[comboKey] = { carrier: entryCarrier, customer: entryCustomer, doors: {}, total: 0 };
        }
        comboStats[comboKey].doors[doorNum] = (comboStats[comboKey].doors[doorNum] || 0) + 1;
        comboStats[comboKey].total++;
      }
    });
    
    // Calculate statistics
    const doorStats = Object.entries(doorFrequency).map(([door, stats]) => ({
      doorNumber: parseInt(door),
      frequency: stats.count,
      carriers: Object.entries(stats.carriers).sort((a, b) => b[1] - a[1]),
      customers: Object.entries(stats.customers).sort((a, b) => b[1] - a[1])
    })).sort((a, b) => b.frequency - a.frequency);
    
    // Find most common door ranges
    const allDoors = doorStats.map(d => d.doorNumber).sort((a, b) => a - b);
    let doorRange = null;
    if (allDoors.length > 0) {
      const min = allDoors[0];
      const max = allDoors[allDoors.length - 1];
      const avg = allDoors.reduce((a, b) => a + b, 0) / allDoors.length;
      doorRange = { min, max, avg: Math.round(avg * 10) / 10 };
    }
    
    // Use ALL carriers/customers from history for dropdowns (not just filtered)
    const allCarriers = [...allCarriersSet].sort();
    const allCustomers = [...allCustomersSet].sort();
    
    res.json({
      generatedAt: new Date().toISOString(),
      filters: { carrier: carrier || null, customer: customer || null },
      availableCarriers: allCarriers,
      availableCustomers: allCustomers,
      totalPlacements: Object.values(doorFrequency).reduce((a, b) => a + b.count, 0),
      doorRange,
      doorStats,
      topCombos: Object.values(comboStats)
        .sort((a, b) => b.total - a.total)
        .slice(0, 10)
        .map(c => ({
          carrier: c.carrier,
          customer: c.customer,
          total: c.total,
          preferredDoors: Object.entries(c.doors)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([door, count]) => ({ door: parseInt(door), count, percentage: Math.round(count/c.total*100) }))
        }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start server - bind to 0.0.0.0 to accept connections from outside container
app.listen(PORT, '0.0.0.0', () => {
  const state = loadState();
  const doorCount = state.doors?.length || 0;
  const yardSlotCount = state.yardSlots?.length || 0;
  const needsSetup = isSetupNeeded();

  console.log(`╔════════════════════════════════════╗`);
  console.log(`║   Warehouse Dock Board Server      ║`);
  console.log(`╠════════════════════════════════════╣`);
  console.log(`║  🌐 http://0.0.0.0:${PORT} (all interfaces)  ║`);
  console.log(`║  📁 Data: ./data/                  ║`);
  if (needsSetup) {
    console.log(`║  ⚠️  First run - Setup required    ║`);
  } else {
    console.log(`║  🚪 Doors: ${String(doorCount).padEnd(26)}║`);
    console.log(`║  🅿️ Yard Slots: ${String(yardSlotCount).padEnd(20)}║`);
  }
  console.log(`║  🔒 Auth: ${AUTH_USER.padEnd(27)}║`);
  console.log(`╚════════════════════════════════════╝`);

  if (!needsSetup) {
    // Calculate daily dwell analytics once per day (instead of 15-min snapshots)
    // Also calculates on-demand when API is called for today's data
    setInterval(() => {
      const today = new Date().toISOString().split('T')[0];
      calculateDailyDwell(today);
    }, 24 * 60 * 60 * 1000); // Once per day

    // Initial calculation for today
    calculateDailyDwell(new Date().toISOString().split('T')[0]);
    console.log('[Analytics] Daily dwell analytics active - calculated from history');
  } else {
    console.log('[Setup] Server ready for initial configuration');
    console.log('[Setup] Visit http://localhost:' + PORT + ' to complete setup');
  }
});
