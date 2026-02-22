/**
 * Warehouse Dock Board - Main Application
 */

// API Base URL
const API_BASE = '';

// Global State
const state = {
  doors: [],
  trailers: [],
  yardTrailers: [],
  yardSlots: [],
  carriers: [],
  staging: null,
  queuedTrailers: [],
  appointmentQueue: []
};

// Utility: Escape HTML to prevent XSS
// Used for displaying data safely in the UI
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Utility: Decode HTML Entities for Form Inputs
// Used when populating input fields (value="...") so users see "D&H" instead of "D&amp;H"
function decodeHtml(html) {
  if (!html) return '';
  const txt = document.createElement("textarea");
  txt.innerHTML = html;
  return txt.value;
}

let pollingInterval = null;
let editMode = false;
let fetchErrorShown = false;
let consecutiveErrors = 0;
let isPaused = false;
const MAX_CONSECUTIVE_ERRORS = 5;
const NORMAL_POLL_INTERVAL = 5000;
const ERROR_POLL_INTERVAL = 30000; // Slow down on errors

// Undo functionality
let lastAction = null; // { type: 'moveToDoor'|'moveToYard'|'moveToSlot', trailerId, from: { doorNum|slotNum }, to: { doorNum|slotNum }, timestamp }

// Bulk selection
let selectedTrailers = new Set(); // Set of selected trailer IDs
let lastClickedTrailer = null;
let isShiftPressed = false;

// Search functionality
let searchQuery = '';
let searchResults = [];

// ============================================
// JWT AUTHENTICATION
// ============================================
const authState = { token: localStorage.getItem('dockboard_token'), user: null, isAuthenticated: false };
function getAuthHeader() { return authState.token ? `Bearer ${authState.token}` : null; }
async function checkAuthStatus() {
  const token = localStorage.getItem('dockboard_token');
  if (!token) { authState.isAuthenticated = false; updateAuthUI(); return false; }
  try {
    const res = await fetch('/api/auth/status', { headers: { 'Authorization': `Bearer ${token}` } });
    const data = await res.json();
    authState.isAuthenticated = data.authenticated;
    authState.user = data.user;
    if (!data.authenticated) localStorage.removeItem('dockboard_token');
    updateAuthUI();
    return data.authenticated;
  } catch (e) { authState.isAuthenticated = false; updateAuthUI(); return false; }
}
async function login(username, password) {
  try {
    console.log('[Auth] Attempting login...');
    const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    if (!res.ok) { const data = await res.json(); throw new Error(data.error || 'Invalid credentials'); }
    const data = await res.json();
    console.log('[Auth] Login response:', { success: data.success, hasToken: !!data.token, user: data.user });
    if (data.token) {
      authState.token = data.token; authState.user = data.user; authState.isAuthenticated = true;
      localStorage.setItem('dockboard_token', data.token);
      console.log('[Auth] Token stored, calling updateAuthUI...');
      updateAuthUI(); 
      // Close modal if open
      const modal = document.getElementById('modal-login');
      if (modal && modal.classList.contains('active')) closeModal('modal-login');
      showToast(`Welcome ${data.user}!`, 'success'); 
      return true;
    }
  } catch (e) { 
    showToast(e.message, 'error'); 
    const errorDiv = document.getElementById('login-error');
    if (errorDiv) {
        errorDiv.textContent = e.message;
        errorDiv.classList.remove('hidden');
    }
    throw e; // Rethrow so caller knows it failed
  }
  return false;
}
function logout() { authState.token = null; authState.user = null; authState.isAuthenticated = false; localStorage.removeItem('dockboard_token'); editMode = false; updateAuthUI(); showToast('Logged out', 'info'); }
function requireAuth(cb) { if (!authState.isAuthenticated) { showToast('Login required', 'warning'); openModal('modal-login'); return false; } return cb ? cb() : true; }
function updateAuthUI() {
  const appContainer = document.getElementById('app-container');
  const loginScreen = document.getElementById('login-screen');

  console.log('[AuthUI] updateAuthUI called, isAuthenticated:', authState.isAuthenticated, 'token exists:', !!authState.token);

  // Update header buttons FIRST (before any async operations or returns)
  const loginBtn = document.getElementById('btn-login');
  const logoutBtn = document.getElementById('btn-logout');
  const userInfo = document.getElementById('user-info');
  const usernameDisplay = document.getElementById('username-display');
  if (authState.isAuthenticated) {
    if (loginBtn) loginBtn.classList.add('hidden');
    if (logoutBtn) logoutBtn.classList.remove('hidden');
    if (userInfo) userInfo.classList.remove('hidden');
    if (usernameDisplay) usernameDisplay.textContent = authState.user || '';
    console.log('[AuthUI] Header updated for authenticated user:', authState.user);
  } else {
    if (loginBtn) loginBtn.classList.remove('hidden');
    if (logoutBtn) logoutBtn.classList.add('hidden');
    if (userInfo) userInfo.classList.add('hidden');
    console.log('[AuthUI] Header updated for logged out state');
  }

  // Show/hide login screen and app container based on auth state
  if (authState.isAuthenticated) {
    // Check if setup is needed first
    checkSetupStatus().then(needsSetup => {
      if (needsSetup) {
        console.log('[AuthUI] Setup needed, showing setup modal');
        if (loginScreen) loginScreen.classList.add('hidden');
        showSetupModal();
      } else {
        console.log('[AuthUI] Showing app');
        if (loginScreen) loginScreen.classList.add('hidden');
        if (appContainer) appContainer.classList.remove('hidden');
        if (!pollingInterval) startPolling();
      }
    });
  } else {
    console.log('[AuthUI] Showing login screen');
    if (loginScreen) loginScreen.classList.remove('hidden');
    if (appContainer) appContainer.classList.add('hidden');
    if (pollingInterval) {
      clearInterval(pollingInterval);
      pollingInterval = null;
    }
  }

}

// ============================================
// SETTINGS
// ============================================
let settings = {
  gridColumns: 10,
  trailerDisplay: {
    customer: { fontSize: '1.8vmin', color: '#ffffff' },
    carrier: { fontSize: '2.0vmin', color: '#ffffff' },
    trailerNumber: { fontSize: '2.2vmin', color: '#fbbf24' },
    loadNumber: { fontSize: '1.6vmin', color: '#94a3b8' }
  }
};

async function loadSettings() {
  try {
    const data = await apiCall('/settings');
    if (data) {
        settings = { ...settings, ...data };
        applySidebarLayout();
        applyGridSettings();
    }
  } catch (e) { console.log('Settings load error:', e); }
}

function applyGridSettings() {
    const cols = settings.gridColumns || 10;
    const grid = document.getElementById('dock-grid');
    if (grid) {
        grid.style.setProperty('--grid-columns', cols);
        
        // Apply Font Sizes
        const s = settings.trailerDisplay;
        if (s) {
            if (s.customer?.fontSize) document.body.style.setProperty('--customer-size', s.customer.fontSize);
            if (s.carrier?.fontSize) document.body.style.setProperty('--carrier-size', s.carrier.fontSize);
            if (s.trailerNumber?.fontSize) document.body.style.setProperty('--number-size', s.trailerNumber.fontSize);
            if (s.loadNumber?.fontSize) document.body.style.setProperty('--load-size', s.loadNumber.fontSize);
            // Apply new sliders
            if (s.driver?.fontSize) document.body.style.setProperty('--driver-size', s.driver.fontSize);
            if (s.live?.fontSize) document.body.style.setProperty('--live-size', s.live.fontSize);
            if (s.dwell?.fontSize) document.body.style.setProperty('--dwell-size', s.dwell.fontSize);
            if (s.door?.fontSize) document.body.style.setProperty('--door-size', s.door.fontSize);
            
            // Also apply colors if needed (not requested but good practice to sync)
            if (s.customer?.color) document.body.style.setProperty('--customer-color', s.customer.color);
            // ... (add others if we switch colors to vars later)
        }
    }
}

function applySidebarLayout() {
    if (!settings.sidebarLayout) return;
    
    const sidebarEl = document.querySelector('.yard-sidebar');
    const stagingEl = document.getElementById('staging-section');
    const apptQueueEl = document.getElementById('appointment-queue-section');
    const queueEl = document.getElementById('queue-section');
    
    if (sidebarEl && settings.sidebarLayout.sidebarHeight) {
        sidebarEl.style.height = settings.sidebarLayout.sidebarHeight;
        sidebarEl.style.maxHeight = 'none';
    }
    if (stagingEl && settings.sidebarLayout.stagingFlex) {
        stagingEl.style.flex = settings.sidebarLayout.stagingFlex;
    }
    if (apptQueueEl && settings.sidebarLayout.apptQueueFlex) {
        apptQueueEl.style.flex = settings.sidebarLayout.apptQueueFlex;
    }
    if (queueEl && settings.sidebarLayout.queueFlex) {
        queueEl.style.flex = settings.sidebarLayout.queueFlex;
    }
}

async function saveSettings(newSettings) {
  try {
    await apiCall('/settings', 'POST', newSettings);
    settings = { ...settings, ...newSettings }; // Merge instead of replace
    // showToast('Settings saved!', 'success'); // Optional: silence toast for auto-saves?
  } catch (e) { showToast('Failed to save settings', 'error'); }
}

function updateSettingsPreview() {
  const getVal = (id) => {
      const val = document.getElementById(id).value;
      return val.includes('cqw') ? val : val + 'cqw';
  };
  
  // Update Preview Elements directly
  const setStyle = (id, prop, val) => {
      const el = document.getElementById(id);
      if (el) el.style[prop] = val;
  };
  
  setStyle('prev-customer', 'fontSize', getVal('customer-size'));
  setStyle('prev-customer', 'color', document.getElementById('customer-color').value);
  
  setStyle('prev-carrier', 'fontSize', getVal('carrier-size'));
  setStyle('prev-carrier', 'color', document.getElementById('carrier-color').value);
  
  setStyle('prev-driver', 'fontSize', getVal('driver-size'));
  // Driver shares customer color usually, or inherited
  
  setStyle('prev-number', 'fontSize', getVal('number-size'));
  setStyle('prev-number', 'color', document.getElementById('number-color').value);
  
  setStyle('prev-load', 'fontSize', getVal('load-size'));
  setStyle('prev-load', 'color', document.getElementById('load-color').value);
  
  setStyle('prev-door', 'fontSize', getVal('door-size'));
  
  setStyle('prev-dwell', 'fontSize', getVal('dwell-size'));
  
  // Live tag pseudo-element size is hard to set via inline style on '::after'
  // We can simulate it by setting a CSS variable on the preview container if we used vars there
  // But our CSS uses .dock-door .is-live::after { font-size: var(...) }
  // So we need to set the variable on the preview container
  const previewContainer = document.getElementById('settings-preview-door');
  if (previewContainer) {
      previewContainer.style.setProperty('--live-size', getVal('live-size'));
      // Also apply other vars locally so the preview is accurate
      previewContainer.style.setProperty('--customer-size', getVal('customer-size'));
      previewContainer.style.setProperty('--carrier-size', getVal('carrier-size'));
      previewContainer.style.setProperty('--number-size', getVal('number-size'));
      previewContainer.style.setProperty('--load-size', getVal('load-size'));
      previewContainer.style.setProperty('--driver-size', getVal('driver-size'));
      previewContainer.style.setProperty('--door-size', getVal('door-size'));
      previewContainer.style.setProperty('--dwell-size', getVal('dwell-size'));
  }
}

function openSettingsModal() {
  const sizes = settings.trailerDisplay;
  const modal = document.createElement('div');
  modal.id = 'modal-settings';
  modal.className = 'modal';
  
  // Helper to parse value (strip 'cqw' or 'vmin')
  const parseVal = (val, def) => parseFloat(val) || def;
  // Helper to display value
  const dispVal = (val, def) => val && val.includes('cqw') ? val : (parseFloat(val) || def) + 'cqw';

  modal.innerHTML = `
    <div class="modal-content" style="max-width:650px;max-height:90vh;">
      <div class="modal-header">
        <h3>⚙️ Display Settings</h3>
        <button class="close-modal">&times;</button>
      </div>
      <div class="modal-body" style="display:flex;flex-direction:column;gap:0;padding:0;">
        <div style="flex:1;overflow-y:auto;padding:20px;">
          <!-- Grid Layout Settings -->
          <div style="border:1px solid #374151;border-radius:8px;margin-bottom:20px;overflow:hidden;">
            <div style="background:#1f2937;padding:10px 15px;font-weight:600;border-bottom:1px solid #374151;">Grid Layout</div>
            <div style="padding:15px;">
              <label style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
                <span style="min-width:100px;">Columns:</span>
                <input type="range" id="grid-columns" min="4" max="15" value="${settings.gridColumns || 10}" style="flex:1;" oninput="document.getElementById('grid-col-val').textContent=this.value; document.getElementById('dock-grid').style.setProperty('--grid-columns', this.value);">
                <span id="grid-col-val" style="min-width:40px;text-align:right;font-weight:bold;color:#fbbf24;">${settings.gridColumns || 10}</span>
              </label>
              <p style="font-size:0.75rem;color:#9ca3af;margin:0;">Adjust the number of columns to change cell size. Fewer columns = Larger cells.</p>
            </div>
          </div>

          <div style="border:1px solid #374151;border-radius:8px;margin-bottom:16px;overflow:hidden;">
            <div style="background:#1f2937;padding:10px 15px;font-weight:600;border-bottom:1px solid #374151;">Customer</div>
            <div style="padding:15px;display:flex;gap:20px;align-items:center;">
              <div style="flex:1;">
                <label style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
                  <span style="min-width:60px;">Size:</span>
                  <input type="range" id="customer-size" min="2" max="20" step="0.5" value="${parseVal(sizes.customer.fontSize, 6.5)}" style="flex:1;">
                  <span id="customer-val" style="min-width:60px;text-align:right;color:#9ca3af;">${dispVal(sizes.customer.fontSize, 6.5)}</span>
                </label>
              </div>
              <label style="display:flex;align-items:center;gap:8px;">Color: <input type="color" id="customer-color" value="${sizes.customer.color}" style="width:50px;height:32px;border:none;border-radius:4px;cursor:pointer;"></label>
            </div>
          </div>
          
          <div style="border:1px solid #374151;border-radius:8px;margin-bottom:16px;overflow:hidden;">
            <div style="background:#1f2937;padding:10px 15px;font-weight:600;border-bottom:1px solid #374151;">Carrier</div>
            <div style="padding:15px;display:flex;gap:20px;align-items:center;">
              <div style="flex:1;">
                <label style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
                  <span style="min-width:60px;">Size:</span>
                  <input type="range" id="carrier-size" min="5" max="30" step="0.5" value="${parseVal(sizes.carrier.fontSize, 14)}" style="flex:1;">
                  <span id="carrier-val" style="min-width:60px;text-align:right;color:#9ca3af;">${dispVal(sizes.carrier.fontSize, 14)}</span>
                </label>
              </div>
              <label style="display:flex;align-items:center;gap:8px;">Color: <input type="color" id="carrier-color" value="${sizes.carrier.color}" style="width:50px;height:32px;border:none;border-radius:4px;cursor:pointer;"></label>
            </div>
          </div>
          
          <div style="border:1px solid #374151;border-radius:8px;margin-bottom:16px;overflow:hidden;">
            <div style="background:#1f2937;padding:10px 15px;font-weight:600;border-bottom:1px solid #374151;">Trailer Number</div>
            <div style="padding:15px;display:flex;gap:20px;align-items:center;">
              <div style="flex:1;">
                <label style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
                  <span style="min-width:60px;">Size:</span>
                  <input type="range" id="number-size" min="2" max="15" step="0.5" value="${parseVal(sizes.trailerNumber.fontSize, 4.5)}" style="flex:1;">
                  <span id="number-val" style="min-width:60px;text-align:right;color:#9ca3af;">${dispVal(sizes.trailerNumber.fontSize, 4.5)}</span>
                </label>
              </div>
              <label style="display:flex;align-items:center;gap:8px;">Color: <input type="color" id="number-color" value="${sizes.trailerNumber.color}" style="width:50px;height:32px;border:none;border-radius:4px;cursor:pointer;"></label>
            </div>
          </div>
          
          <div style="border:1px solid #374151;border-radius:8px;margin-bottom:20px;overflow:hidden;">
            <div style="background:#1f2937;padding:10px 15px;font-weight:600;border-bottom:1px solid #374151;">Load Number</div>
            <div style="padding:15px;display:flex;gap:20px;align-items:center;">
              <div style="flex:1;">
                <label style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
                  <span style="min-width:60px;">Size:</span>
                  <input type="range" id="load-size" min="2" max="15" step="0.5" value="${parseVal(sizes.loadNumber.fontSize, 4)}" style="flex:1;">
                  <span id="load-val" style="min-width:60px;text-align:right;color:#9ca3af;">${dispVal(sizes.loadNumber.fontSize, 4)}</span>
                </label>
              </div>
              <label style="display:flex;align-items:center;gap:8px;">Color: <input type="color" id="load-color" value="${sizes.loadNumber.color}" style="width:50px;height:32px;border:none;border-radius:4px;cursor:pointer;"></label>
            </div>
          </div>

          <!-- New Sliders -->
          <div style="border:1px solid #374151;border-radius:8px;margin-bottom:16px;overflow:hidden;">
            <div style="background:#1f2937;padding:10px 15px;font-weight:600;border-bottom:1px solid #374151;">Driver Name</div>
            <div style="padding:15px;">
              <label style="display:flex;align-items:center;gap:10px;">
                <span style="min-width:60px;">Size:</span>
                <input type="range" id="driver-size" min="2" max="20" step="0.5" value="${parseVal(sizes.driver?.fontSize, 6.5)}" style="flex:1;">
                <span id="driver-val" style="min-width:60px;text-align:right;color:#9ca3af;">${dispVal(sizes.driver?.fontSize, 6.5)}</span>
              </label>
            </div>
          </div>
          
          <div style="border:1px solid #374151;border-radius:8px;margin-bottom:16px;overflow:hidden;">
            <div style="background:#1f2937;padding:10px 15px;font-weight:600;border-bottom:1px solid #374151;">Door Header</div>
            <div style="padding:15px;">
              <label style="display:flex;align-items:center;gap:10px;">
                <span style="min-width:60px;">Size:</span>
                <input type="range" id="door-size" min="2" max="15" step="0.5" value="${parseVal(sizes.door?.fontSize, 5)}" style="flex:1;">
                <span id="door-val" style="min-width:60px;text-align:right;color:#9ca3af;">${dispVal(sizes.door?.fontSize, 5)}</span>
              </label>
            </div>
          </div>

          <div style="border:1px solid #374151;border-radius:8px;margin-bottom:16px;overflow:hidden;">
            <div style="background:#1f2937;padding:10px 15px;font-weight:600;border-bottom:1px solid #374151;">Dwell Time</div>
            <div style="padding:15px;">
              <label style="display:flex;align-items:center;gap:10px;">
                <span style="min-width:60px;">Size:</span>
                <input type="range" id="dwell-size" min="2" max="10" step="0.5" value="${parseVal(sizes.dwell?.fontSize, 4)}" style="flex:1;">
                <span id="dwell-val" style="min-width:60px;text-align:right;color:#9ca3af;">${dispVal(sizes.dwell?.fontSize, 4)}</span>
              </label>
            </div>
          </div>

          <div style="border:1px solid #374151;border-radius:8px;margin-bottom:20px;overflow:hidden;">
            <div style="background:#1f2937;padding:10px 15px;font-weight:600;border-bottom:1px solid #374151;">LIVE Tag</div>
            <div style="padding:15px;">
              <label style="display:flex;align-items:center;gap:10px;">
                <span style="min-width:60px;">Size:</span>
                <input type="range" id="live-size" min="5" max="30" step="0.5" value="${parseVal(sizes.live?.fontSize, 14)}" style="flex:1;">
                <span id="live-val" style="min-width:60px;text-align:right;color:#9ca3af;">${dispVal(sizes.live?.fontSize, 14)}</span>
              </label>
            </div>
          </div>

          <div style="border:2px solid #4b5563;border-radius:8px;overflow:hidden;background:var(--bg-secondary);container-type:inline-size;padding:10px;">
            <div style="background:#1f2937;padding:10px 15px;font-weight:600;border-bottom:2px solid #4b5563;margin:-10px -10px 10px -10px;">Preview (Live Scale)</div>
            <div style="display:flex;align-items:center;justify-content:center;height:250px;">
              <!-- Mock Dock Door -->
              <div class="dock-door occupied status-loaded" style="width:200px;height:200px;border-color:var(--accent-primary);" id="settings-preview-door">
                <div class="door-header">
                  <span class="door-number" id="prev-door">Door 1</span>
                  <span class="door-queue-indicator" id="prev-queue">⏳ 2</span>
                  <div style="display:flex;align-items:center;">
                      <span class="badge loaded">📦 Loaded</span>
                  </div>
                </div>
                <div class="door-content">
                  <div class="trailer-card docked loaded">
                    <div class="trailer-header-row">
                      <span class="trailer-number" id="prev-number">TR-12345</span>
                      <span class="dwell-badge dwell-warning" id="prev-dwell">⏱️ 1h 30m</span>
                    </div>
                    <div class="trailer-customer" id="prev-customer">ACME CORP</div>
                    <div class="trailer-driver" id="prev-driver">JOHN DOE</div>
                    <div class="trailer-carrier" id="prev-carrier">JBHUNT</div>
                    <div class="trailer-load-number-row" id="prev-load">Load: 9876543</div>
                    <div class="trailer-card is-live" style="position:absolute;width:100%;height:100%;top:0;left:0;pointer-events:none;" id="prev-live"></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="modal-actions" style="border-top:1px solid #374151;padding:15px 20px;margin:0;">
          <button id="btn-save-settings" class="btn btn-success">Save</button>
          <button id="btn-reset-settings" class="btn btn-danger">Reset to Default</button>
          <button class="btn btn-secondary close-modal">Cancel</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  openModal('modal-settings');
  
  // Attach listeners
  ['customer-size','carrier-size','number-size','load-size','driver-size','live-size','dwell-size','door-size','customer-color','carrier-color','number-color','load-color'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', (e) => {
        if (e.target.type === 'range') {
            const valSpan = document.getElementById(e.target.id.replace('size', 'val'));
            if (valSpan) valSpan.textContent = e.target.value + 'cqw';
        }
        updateSettingsPreview();
    });
  });
  
  // Save button logic
  document.getElementById('btn-save-settings')?.addEventListener('click', async () => {
    const getCqw = (id) => {
        const el = document.getElementById(id);
        return el ? (el.value + 'cqw') : undefined;
    };

    const newSettings = {
      gridColumns: parseInt(document.getElementById('grid-columns').value) || 10,
      trailerDisplay: {
        customer: { fontSize: getCqw('customer-size'), color: document.getElementById('customer-color').value },
        carrier: { fontSize: getCqw('carrier-size'), color: document.getElementById('carrier-color').value },
        trailerNumber: { fontSize: getCqw('number-size'), color: document.getElementById('number-color').value },
        loadNumber: { fontSize: getCqw('load-size'), color: document.getElementById('load-color').value },
        driver: { fontSize: getCqw('driver-size') },
        door: { fontSize: getCqw('door-size') },
        dwell: { fontSize: getCqw('dwell-size') },
        live: { fontSize: getCqw('live-size') }
      }
    };
    // Save and Apply immediately
    await saveSettings(newSettings);
    // Explicitly re-apply settings to DOM so changes are visible without refresh
    applyGridSettings();
    modal.remove();
  });
  
  // Reset button logic
  document.getElementById('btn-reset-settings')?.addEventListener('click', async () => {
    if (!confirm('Reset all display settings to default?')) return;
    const defaults = {
      gridColumns: 10,
      trailerDisplay: {
        customer: { fontSize: '6.5cqw', color: '#ffffff' },
        carrier: { fontSize: '14cqw', color: '#ffffff' },
        trailerNumber: { fontSize: '4.5cqw', color: '#fbbf24' },
        loadNumber: { fontSize: '4cqw', color: '#94a3b8' }
      }
    };
    await saveSettings(defaults);
    modal.remove();
    openSettingsModal();
  });
  
  // Close handlers
  const closeSettings = () => { modal.remove(); };
  modal.querySelectorAll('.close-modal').forEach(btn => btn?.addEventListener('click', closeSettings));
  modal.addEventListener('click', (e) => { if (e.target === modal) closeSettings(); });
}async function updateDoor(doorId, data) { return apiCall(`/doors/${doorId}`, 'PUT', data); }
async function createDoor(data) { return apiCall('/doors', 'POST', data); }
async function deleteDoor(doorId) { return apiCall(`/doors/${doorId}`, 'DELETE'); }
async function reorderDoors(doorIds) { return apiCall('/doors/reorder', 'POST', { doorIds }); }

// Yard Slot Management API
async function moveToYardSlot(trailerId, slotId) { return apiCall('/move-to-yard-slot', 'POST', { trailerId, slotId }); }
async function moveFromYardSlot(trailerId) { return apiCall('/move-from-yard-slot', 'POST', { trailerId }); }
async function updateYardSlot(slotId, data) { return apiCall(`/yard-slots/${slotId}`, 'PUT', data); }
async function createYardSlot(data) { return apiCall('/yard-slots', 'POST', data); }
async function deleteYardSlotAPI(slotId) { return apiCall(`/yard-slots/${slotId}`, 'DELETE'); }
async function reorderYardSlots(slotIds) { return apiCall('/yard-slots/reorder', 'POST', { slotIds }); }

// Door Drag and Drop (edit mode)
let draggedDoorId = null;

function setupDoorDragAndDrop(grid) {
  const doors = grid.querySelectorAll('.door-draggable');
  
  doors.forEach(door => {
    door.addEventListener('dragstart', (e) => {
      draggedDoorId = door.dataset.doorId;
      door.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', draggedDoorId);
    });
    
    door.addEventListener('dragend', () => {
      door.classList.remove('dragging');
      draggedDoorId = null;
      grid.querySelectorAll('.drag-over').forEach(d => d.classList.remove('drag-over'));
    });
    
    door.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (draggedDoorId && draggedDoorId !== door.dataset.doorId) {
        door.classList.add('drag-over');
      }
    });
    
    door.addEventListener('dragleave', () => {
      door.classList.remove('drag-over');
    });
    
    door.addEventListener('drop', async (e) => {
      e.preventDefault();
      door.classList.remove('drag-over');
      
      const sourceId = e.dataTransfer.getData('text/plain');
      const targetId = door.dataset.doorId;
      
      if (!sourceId || sourceId === targetId) return;
      
      // Reorder doors locally
      const sourceIndex = state.doors.findIndex(d => d.id === sourceId);
      const targetIndex = state.doors.findIndex(d => d.id === targetId);
      
      if (sourceIndex === -1 || targetIndex === -1) return;
      
      // Get all door IDs in current order
      const currentDoors = [...state.doors].sort((a, b) => {
        if (a.order !== undefined && b.order !== undefined) return a.order - b.order;
        return a.number - b.number;
      });
      const doorIds = currentDoors.map(d => d.id);
      
      // Move source to position after target
      const sourcePos = doorIds.indexOf(sourceId);
      const targetPos = doorIds.indexOf(targetId);
      
      doorIds.splice(sourcePos, 1);  // Remove from old position
      doorIds.splice(targetPos, 0, sourceId);  // Insert at new position
      
      // Update server with new order
      try {
        showToast('Reordering doors...', 'info');
        await apiCall('/doors/reorder', 'POST', { doorIds });
        showToast('Door order saved', 'success');
        fetchState();  // Refresh state
      } catch (error) {
        showToast('Failed to reorder doors: ' + error.message, 'error');
      }
    });
  });
}

// Yard Slot Management API
async function moveToYardSlot(trailerId, slotId) { return apiCall('/move-to-yard-slot', 'POST', { trailerId, slotId }); }
async function moveFromYardSlot(trailerId) { return apiCall('/move-from-yard-slot', 'POST', { trailerId }); }
async function updateYardSlot(slotId, data) { return apiCall(`/yard-slots/${slotId}`, 'PUT', data); }
async function createYardSlot(data) { return apiCall('/yard-slots', 'POST', data); }
async function deleteYardSlot(slotId) { return apiCall(`/yard-slots/${slotId}`, 'DELETE'); }

// ============================================================================
// API Functions
// ============================================================================

async function apiCall(endpoint, method = 'GET', body = null) {
  const url = `/api${endpoint}`;
  const options = { method, headers: { 'Content-Type': 'application/json' } };
  const authHeader = getAuthHeader();
  if (authHeader) options.headers['Authorization'] = authHeader;
  if (body) options.body = JSON.stringify(body);

  console.log(`[API] ${method} ${url}`, { hasAuth: !!authHeader, tokenPreview: authHeader ? authHeader.substring(0, 20) + '...' : 'none' });

  const response = await fetch(url, options);
  if (response.status === 401) {
    console.error('[Auth] 401 Unauthorized - clearing token');
    authState.token = null; authState.isAuthenticated = false; localStorage.removeItem('dockboard_token'); updateAuthUI(); throw new Error('Please login');
  }
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
  return response.json();
}

async function getState() { return apiCall('/state'); }
async function moveToDoor(trailerId, doorId) { return apiCall('/move-to-door', 'POST', { trailerId, doorId }); }
async function moveToYard(trailerId, doorId) { return apiCall('/move-to-yard', 'POST', { trailerId, doorId }); }
async function createTrailer(data) { return apiCall('/trailers', 'POST', data); }
async function deleteTrailer(id) { return apiCall(`/trailers/${id}`, 'DELETE'); }
async function updateTrailer(id, data) { return apiCall(`/trailers/${id}`, 'PUT', data); }
async function shipTrailer(id) { return apiCall(`/trailers/${id}/ship`, 'POST'); }

// Staging & Queue API
async function getStaging() { return apiCall('/staging'); }
async function addToStaging(data) { return apiCall('/staging', 'POST', data); }
async function getQueue() { return apiCall('/queue'); }
async function queueTrailer(trailerId, targetDoorId, targetDoorNumber) { 
  return apiCall('/queue', 'POST', { trailerId, targetDoorId, targetDoorNumber }); 
}
async function cancelQueuedTrailer(trailerId) { 
  return apiCall(`/queue/${trailerId}/cancel`, 'POST'); 
}
async function reassignQueuedTrailer(trailerId, targetDoorId, targetDoorNumber) { 
  return apiCall(`/queue/${trailerId}/reassign`, 'POST', { targetDoorId, targetDoorNumber }); 
}
async function assignNextToDoor(doorId) { 
  return apiCall(`/doors/${doorId}/assign-next`, 'POST'); 
}

async function getHistory(search = '', limit = 50, offset = 0, dateFrom = '', dateTo = '') { 
  const params = new URLSearchParams({ search, limit, offset });
  if (dateFrom) params.append('dateFrom', dateFrom);
  if (dateTo) params.append('dateTo', dateTo);
  return apiCall(`/history?${params.toString()}`); 
}
async function getTrailerHistory(trailerId) {
  return apiCall(`/trailers/${trailerId}/history`);
}

// ============================================================================
// Undo Functionality
// ============================================================================

function recordLastAction(type, trailerId, from, to) {
  lastAction = {
    type,
    trailerId,
    from: { ...from },
    to: { ...to },
    timestamp: Date.now()
  };
  updateUndoButton();
}

async function undoLastAction() {
  if (!lastAction) {
    showToast('Nothing to undo', 'warning');
    return;
  }
  
  // Check if undo is within time limit (5 minutes)
  if (Date.now() - lastAction.timestamp > 5 * 60 * 1000) {
    showToast('Undo expired (too old)', 'warning');
    lastAction = null;
    updateUndoButton();
    return;
  }

  try {
    const { type, trailerId, from, to } = lastAction;
    
    // Check if trailer is still at the destination before attempting undo
    const trailer = state.trailers.find(t => t.id === trailerId) || 
                    state.yardTrailers.find(t => t.id === trailerId) ||
                    state.appointmentQueue?.find(t => t.id === trailerId);
    if (!trailer) {
      showToast('Trailer no longer exists', 'error');
      lastAction = null;
      updateUndoButton();
      return;
    }
    
    // If the trailer has been moved somewhere else since, warn but still try to undo
    // (user might still want to move it back to the original location)
    let currentPos = getTrailerPosition(trailer);
    if (!positionsMatch(currentPos, to)) {
      console.log('Trailer moved since last action, but attempting undo anyway');
    }
    
    // Perform the undo - move back to 'from' position
    if (from.doorNum) {
      await moveToDoor(trailerId, from.doorNum);
      showToast(`Undo: Moved trailer back to Door ${from.doorNum}`, 'success');
    } else if (from.slotNum) {
      // Find the slot ID
      const slot = state.yardSlots.find(s => s.number === from.slotNum);
      if (slot) {
        await moveToYardSlot(trailerId, slot.id);
        showToast(`Undo: Moved trailer back to Yard Spot ${from.slotNum}`, 'success');
      } else {
        await moveToYard(trailerId);
        showToast(`Undo: Moved trailer back to yard`, 'success');
      }
    } else {
      await moveToYard(trailerId);
      showToast(`Undo: Moved trailer back to unassigned yard`, 'success');
    }
    
    lastAction = null;
    updateUndoButton();
    fetchState();
  } catch (error) {
    showToast('Undo failed: ' + error.message, 'error');
  }
}

function updateUndoButton() {
  const btn = document.getElementById('btn-undo');
  if (btn) {
    btn.disabled = !lastAction;
    btn.style.opacity = lastAction ? '1' : '0.5';
    btn.title = lastAction ? `Undo: ${getActionDescription(lastAction)}` : 'Nothing to undo';
  }
}

function getActionDescription(action) {
  let toStr = '';
  if (action.to.doorNum) toStr = `Door ${action.to.doorNum}`;
  else if (action.to.slotNum) toStr = `Yard ${action.to.slotNum}`;
  else toStr = 'Unassigned Yard';
  return `Last move to ${toStr}`;
}

function getTrailerPosition(trailer) {
  const pos = { doorNum: null, slotNum: null, unassigned: false };
  if (trailer.doorNumber) {
    pos.doorNum = trailer.doorNumber;
  } else if (trailer.yardSlotNumber) {
    pos.slotNum = trailer.yardSlotNumber;
  } else {
    pos.unassigned = true;
  }
  return pos;
}

function positionsMatch(pos1, pos2) {
  // Check if both are unassigned
  if (pos1.unassigned && pos2.unassigned) return true;
  // Check door numbers match
  if (pos1.doorNum !== pos2.doorNum) return false;
  // Check slot numbers match
  if (pos1.slotNum !== pos2.slotNum) return false;
  // If we're here and neither has a position defined, check unassigned flag
  if (!pos1.doorNum && !pos1.slotNum && !pos2.doorNum && !pos2.slotNum) {
    return pos1.unassigned === pos2.unassigned;
  }
  return true;
}

// ============================================================================
// Dwell Time Alerts
// ============================================================================

function getDwellTimeClass(createdAt) {
  if (!createdAt) return '';
  
  const created = new Date(createdAt).getTime();
  const now = Date.now();
  const hours = (now - created) / (1000 * 60 * 60);
  
  // 2+ hours = critical (flashing red)
  // 1+ hours = warning (flashing yellow)
  if (hours >= 2) return 'dwell-critical';
  if (hours >= 1) return 'dwell-warning';
  return '';
}

function getDwellTimeHours(createdAt) {
  if (!createdAt) return null;
  
  const created = new Date(createdAt).getTime();
  const now = Date.now();
  return Math.floor((now - created) / (1000 * 60 * 60));
}

function getDwellTimeMinutes(createdAt) {
  if (!createdAt) return null;
  
  const created = new Date(createdAt).getTime();
  const now = Date.now();
  const totalMinutes = Math.floor((now - created) / (1000 * 60));
  return totalMinutes % 60; // Minutes within the current hour
}

function formatDwellTime(createdAt) {
  const hours = getDwellTimeHours(createdAt);
  const minutes = getDwellTimeMinutes(createdAt);
  if (hours === null) return '';
  if (hours < 1) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

// ============================================================================
// Search Functionality
// ============================================================================

function performSearch(query) {
  searchQuery = query.toLowerCase().trim();
  
  if (!searchQuery) {
    searchResults = [];
    renderDoors();
    renderYardSlots();
    renderUnassignedYard();
    return;
  }
  
  searchResults = [];
  
  // Search in docked trailers (including customer and loadNumber)
  state.trailers.forEach(t => {
    if (t.number?.toLowerCase().includes(searchQuery) ||
        t.carrier?.toLowerCase().includes(searchQuery) ||
        t.customer?.toLowerCase().includes(searchQuery) ||
        t.loadNumber?.toLowerCase().includes(searchQuery) ||
        (t.doorNumber && `door ${t.doorNumber}`.includes(searchQuery))) {
      searchResults.push({ type: 'dock', trailer: t });
    }
  });
  
  // Search in yard slots (including customer and loadNumber)
  state.yardSlots.forEach(slot => {
    if (slot.trailerId) {
      const t = state.trailers.find(tr => tr.id === slot.trailerId) ||
                state.yardTrailers.find(tr => tr.id === slot.trailerId);
      if (t && (t.number?.toLowerCase().includes(searchQuery) ||
                t.carrier?.toLowerCase().includes(searchQuery) ||
                t.customer?.toLowerCase().includes(searchQuery) ||
                t.loadNumber?.toLowerCase().includes(searchQuery) ||
                `yard ${slot.number}`.includes(searchQuery))) {
        searchResults.push({ type: 'yard-slot', trailer: t, slot });
      }
    }
  });
  
  // Search in unassigned yard (including customer and loadNumber)
  state.yardTrailers.forEach(t => {
    if (t.number?.toLowerCase().includes(searchQuery) ||
        t.carrier?.toLowerCase().includes(searchQuery) ||
        t.customer?.toLowerCase().includes(searchQuery) ||
        t.loadNumber?.toLowerCase().includes(searchQuery)) {
      searchResults.push({ type: 'unassigned', trailer: t });
    }
  });
  
  // Search in shipped trailers - EXACT MATCH ONLY for trailer number or load number
  const shippedTrailers = state.shippedTrailers || [];
  shippedTrailers.forEach(t => {
    const tNum = t.number?.toLowerCase();
    const tLoad = t.loadNumber?.toLowerCase();
    // Only exact match on trailer number or load number
    if ((tNum && tNum === searchQuery) || (tLoad && tLoad === searchQuery)) {
      searchResults.push({ type: 'shipped', trailer: t });
    }
  });
  
  renderDoors();
  renderYardSlots();
  renderUnassignedYard();
  
  // Show results toast
  const count = searchResults.length;
  if (count > 0) {
    showToast(`🔍 Found ${count} result${count === 1 ? '' : 's'}`, count > 5 ? 'warning' : 'info');
  } else {
    showToast(`🔍 No matches found`, 'warning');
  }
}

function clearSearch() {
  searchQuery = '';
  searchResults = [];
  const searchInput = document.getElementById('search-input');
  if (searchInput) searchInput.value = '';
  renderDoors();
  renderYardSlots();
  renderUnassignedYard();
}

function isTrailerInSearchResults(trailerId) {
  return searchResults.some(r => r.trailer.id === trailerId);
}

// ============================================================================
// Search Results Modal
// ============================================================================

function showSearchResultsModal() {
  if (!searchQuery || searchResults.length === 0) {
    showToast('No search results to show', 'warning');
    return;
  }
  
  // Separate active and shipped results
  const activeResults = searchResults.filter(r => r.type !== 'shipped');
  const shippedResults = searchResults.filter(r => r.type === 'shipped');
  
  // Also search shipped trailers if user wants to see them
  const allShipped = state.shippedTrailers || [];
  const additionalShipped = allShipped.filter(t => {
    const tNum = t.number?.toLowerCase();
    const tLoad = t.loadNumber?.toLowerCase();
    const tCarrier = t.carrier?.toLowerCase();
    const tCustomer = t.customer?.toLowerCase();
    const q = searchQuery.toLowerCase();
    // Include if any field matches (partial match for shipped section)
    return (tNum && tNum.includes(q)) ||
           (tLoad && tLoad.includes(q)) ||
           (tCarrier && tCarrier.includes(q)) ||
           (tCustomer && tCustomer.includes(q));
  }).map(t => ({ type: 'shipped', trailer: t }));
  
  // Merge without duplicates
  const shippedMap = new Map();
  [...shippedResults, ...additionalShipped].forEach(r => {
    shippedMap.set(r.trailer.id, r);
  });
  const allShippedResults = Array.from(shippedMap.values());
  
  const hasActive = activeResults.length > 0;
  const hasShipped = allShippedResults.length > 0;
  
  if (!hasActive && !hasShipped) {
    showToast('No search results to show', 'warning');
    return;
  }
  
  const modal = document.createElement('div');
  modal.className = 'modal active';
  modal.id = 'modal-search-results';
  
  // Build active results HTML
  const activeList = activeResults.map(r => {
    const t = r.trailer;
    const dwellHours = getDwellTimeHours(t.createdAt);
    const dwellText = dwellHours !== null ? `${dwellHours}h` : '-';
    
    let locationText = '';
    if (r.type === 'dock') {
      locationText = t.doorNumber ? `Door ${t.doorNumber}` : 'Dock';
    } else if (r.type === 'yard-slot') {
      locationText = r.slot ? `Yard ${r.slot.number}` : 'Yard Slot';
    } else {
      locationText = 'Unassigned Yard';
    }
    
    return `
      <div class="search-result-item" data-trailer-id="${t.id}" data-type="active">
        <div class="search-result-main">
          <span class="search-carrier">${t.carrier}</span>
          ${t.customer ? `<span class="search-customer">(${t.customer})</span>` : ''}
        </div>
        <div class="search-result-details">
          <span class="search-detail" title="Trailer Number">🚛 ${t.number || '-'}</span>
          <span class="search-detail" title="Load Number">📦 ${t.loadNumber || '-'}</span>
          <span class="search-detail" title="Dwell Time">⏱️ ${dwellText}</span>
          <span class="search-detail search-location" title="Location">📍 ${locationText}</span>
        </div>
        <div class="search-result-hint">Double-click to edit</div>
      </div>
    `;
  }).join('');
  
  // Build shipped results HTML
  const shippedList = allShippedResults.map(r => {
    const t = r.trailer;
    const shippedAt = t.shippedAt ? new Date(t.shippedAt).toLocaleDateString() : 'Unknown';
    const prevLoc = t.previousLocation || 'Unknown';
    
    return `
      <div class="search-result-item shipped-result" data-trailer-id="${t.id}" data-type="shipped">
        <div class="search-result-main">
          <span class="search-carrier">${t.carrier}</span>
          ${t.customer ? `<span class="search-customer">(${t.customer})</span>` : ''}
          <span class="shipped-badge">📦 SHIPPED</span>
        </div>
        <div class="search-result-details">
          <span class="search-detail" title="Trailer Number">🚛 ${t.number || '-'}</span>
          <span class="search-detail" title="Load Number">📦 ${t.loadNumber || '-'}</span>
          <span class="search-detail" title="Shipped Date">📅 ${shippedAt}</span>
          <span class="search-detail" title="Previous Location">📍 Was: ${prevLoc}</span>
        </div>
        <div class="search-result-hint">Double-click to view</div>
      </div>
    `;
  }).join('');
  
  modal.innerHTML = `
    <div class="modal-content modal-large">
      <div class="modal-header">
        <h3>🔍 Search Results</h3>
        <button class="close-modal">&times;</button>
      </div>
      <div class="modal-body">
        <div class="search-tabs">
          <button class="search-tab active" data-tab="active">
            🚛 Active (${activeResults.length})
          </button>
          ${hasShipped ? `<button class="search-tab" data-tab="shipped">
            📦 Shipped (${allShippedResults.length})
          </button>` : ''}
        </div>
        <div class="search-tab-content" id="tab-active" style="display:block;">
          ${hasActive ? `<div class="search-results-list">${activeList}</div>` : '<div class="no-results">No active trailers match your search</div>'}
        </div>
        ${hasShipped ? `<div class="search-tab-content" id="tab-shipped" style="display:none;">
          <div class="search-results-list shipped-list">${shippedList}</div>
        </div>` : ''}
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary close-modal">Close</button>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  // Tab switching
  modal.querySelectorAll('.search-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = tab.dataset.tab;
      // Update tab buttons
      modal.querySelectorAll('.search-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      // Update content
      modal.querySelectorAll('.search-tab-content').forEach(content => {
        content.style.display = 'none';
      });
      const activeContent = modal.querySelector(`#tab-${tabName}`);
      if (activeContent) activeContent.style.display = 'block';
    });
  });
  
  // Close handlers
  modal.querySelectorAll('.close-modal').forEach(btn => {
    btn.addEventListener('click', () => modal.remove());
  });
  
  // Double-click to edit handlers
  modal.querySelectorAll('.search-result-item').forEach(item => {
    item.addEventListener('dblclick', () => {
      const trailerId = item.dataset.trailerId;
      modal.remove();
      openTrailerEditModal(trailerId);
    });
  });
}

// ============================================================================
// Bulk Selection
// ============================================================================

function toggleTrailerSelection(trailerId, event) {
  // STRICT REQUIREMENT: Only start/modify multi-select with Ctrl+Click (or Meta+Click)
  // Single click does nothing.
  
  const isCtrl = event && (event.ctrlKey || event.metaKey);
  
  if (!isCtrl) {
      return;
  }

  const isSelected = selectedTrailers.has(trailerId);
  
  // Ctrl+Click Toggle
  if (isSelected) {
    selectedTrailers.delete(trailerId);
  } else {
    selectedTrailers.add(trailerId);
  }
  
  lastClickedTrailer = trailerId;
  updateSelectionUI();
  updateBulkActionUI();
}

function getAllVisibleTrailerIds() {
  const ids = [];
  // Docked trailers
  state.trailers.filter(t => t.doorNumber).forEach(t => ids.push(t.id));
  // Yard slots
  state.yardSlots.filter(s => s.trailerId).forEach(s => {
    if (!ids.includes(s.trailerId)) ids.push(s.trailerId);
  });
  // Unassigned
  state.yardTrailers.forEach(t => ids.push(t.id));
  return ids;
}

function clearSelection() {
  selectedTrailers.clear();
  lastClickedTrailer = null;
  updateSelectionUI();
  updateBulkActionUI();
}

function updateSelectionUI() {
  // Add/remove 'selected' class from all trailer cards/elements
  document.querySelectorAll('.trailer-card, .yard-trailer, .yard-slot.occupied').forEach(el => {
    const trailerId = el.dataset.trailerId;
    if (selectedTrailers.has(trailerId)) {
      el.classList.add('selected');
    } else {
      el.classList.remove('selected');
    }
  });
}

function updateBulkActionUI() {
  const count = selectedTrailers.size;
  const bulkBar = document.getElementById('bulk-selection-bar');
  const bulkInfo = document.getElementById('bulk-selection-info');
  const bulkMoveToYard = document.getElementById('btn-bulk-move-to-yard');
  const bulkShip = document.getElementById('btn-bulk-ship');
  const bulkDelete = document.getElementById('btn-bulk-delete');
  
  // Only show bar when 2+ items selected
  if (bulkBar) {
    if (count >= 2) {
      bulkBar.classList.remove('hidden');
    } else {
      bulkBar.classList.add('hidden');
    }
  }
  
  if (bulkInfo) {
    bulkInfo.textContent = `${count} selected`;
  }
  
  if (bulkMoveToYard) bulkMoveToYard.disabled = count === 0;
  if (bulkShip) bulkShip.disabled = count === 0;
  if (bulkDelete) bulkDelete.disabled = count === 0;
}

async function bulkMoveToYard() {
  if (selectedTrailers.size === 0) {
    showToast('No trailers selected', 'warning');
    return;
  }
  
  const ids = Array.from(selectedTrailers);
  showToast(`Moving ${ids.length} trailers to yard...`, 'info');
  
  let successCount = 0;
  let failCount = 0;
  
  for (const trailerId of ids) {
    try {
      const trailer = state.trailers.find(t => t.id === trailerId);
      if (trailer && trailer.doorNumber) {
        await moveToYard(trailerId, trailer.doorNumber);
        successCount++;
      }
    } catch (error) {
      failCount++;
    }
  }
  
  if (successCount > 0) {
    showToast(`✅ Moved ${successCount} trailer${successCount === 1 ? '' : 's'} to yard`, 'success');
  }
  if (failCount > 0) {
    showToast(`❌ Failed to move ${failCount} trailer${failCount === 1 ? '' : 's'}`, 'error');
  }
  
  clearSelection();
  fetchState();
}

async function bulkShipTrailers() {
  if (selectedTrailers.size === 0) return;
  
  if (!confirm(`Mark ${selectedTrailers.size} trailers as SHIPPED?\n\nThis will remove them from the active board.`)) return;
  
  const ids = Array.from(selectedTrailers);
  showToast(`Shipping ${ids.length} trailers...`, 'info');
  
  let successCount = 0;
  let failCount = 0;
  
  // Process sequentially to avoid race conditions/overload
  for (const trailerId of ids) {
    try {
      await shipTrailer(trailerId);
      successCount++;
    } catch (error) {
      failCount++;
    }
  }
  
  if (successCount > 0) showToast(`✅ Shipped ${successCount} trailers`, 'success');
  if (failCount > 0) showToast(`❌ Failed to ship ${failCount}`, 'error');
  
  clearSelection();
  fetchState();
}

async function bulkDeleteTrailers() {
  if (selectedTrailers.size === 0) return;
  
  if (!confirm(`⚠️ PERMANENTLY DELETE ${selectedTrailers.size} TRAILERS?\n\nThis cannot be undone.`)) return;
  
  const ids = Array.from(selectedTrailers);
  showToast(`Deleting ${ids.length} trailers...`, 'info');
  
  let successCount = 0;
  let failCount = 0;
  
  for (const trailerId of ids) {
    try {
      await deleteTrailer(trailerId);
      successCount++;
    } catch (error) {
      failCount++;
    }
  }
  
  if (successCount > 0) showToast(`✅ Deleted ${successCount} trailers`, 'success');
  if (failCount > 0) showToast(`❌ Failed to delete ${failCount}`, 'error');
  
  clearSelection();
  fetchState();
}

// ============================================================================
// Trailer Timeline
// ============================================================================

async function loadTrailerTimeline(trailerId) {
  const container = document.getElementById('trailer-timeline');
  if (!container) return;
  
  container.innerHTML = '<div class="timeline-loading">Loading history...</div>';
  
  try {
    // Try to fetch timeline from history API
    const history = await getHistory(trailerId, 20);
    
    // Include all trailer-related events
    const timelineEvents = (history.entries || []).filter(e => 
      e.action?.includes('TRAILER') || 
      e.action?.includes('MOVED')
    );
    
    if (timelineEvents.length === 0) {
      // Create a simple timeline from what we know
      const trailer = state.trailers.find(t => t.id === trailerId) ||
                      state.yardTrailers.find(t => t.id === trailerId);
      if (trailer) {
        container.innerHTML = renderSimpleTimeline([{
          action: 'Created',
          timestamp: trailer.createdAt,
          location: trailer.doorNumber ? `Door ${trailer.doorNumber}` : 
                   trailer.yardSlotNumber ? `Yard ${trailer.yardSlotNumber}` : 'Unassigned Yard',
          status: trailer.status
        }]);
      } else {
        container.innerHTML = '<div class="timeline-empty">No timeline data available</div>';
      }
      return;
    }
    
    // History already comes newest first, keep that order for display (most recent at top)
    container.innerHTML = renderTimeline(timelineEvents);
  } catch (error) {
    // Fallback to simple timeline
    const trailer = state.trailers.find(t => t.id === trailerId) ||
                    state.yardTrailers.find(t => t.id === trailerId);
    if (trailer) {
      container.innerHTML = renderSimpleTimeline([{
        action: 'Created',
        timestamp: trailer.createdAt,
        location: trailer.doorNumber ? `Door ${trailer.doorNumber}` : 
                 trailer.yardSlotNumber ? `Yard ${trailer.yardSlotNumber}` : 'Unassigned Yard',
        status: trailer.status
      }]);
    } else {
      container.innerHTML = '<div class="timeline-empty">Unable to load timeline</div>';
    }
  }
}

function renderTimeline(events) {
  const fieldLabels = {
    number: 'trailer number',
    loadNumber: 'load number',
    customer: 'customer',
    carrier: 'carrier',
    contents: 'notes',
    status: 'status'
  };
  
  return `
    <div class="timeline">
      ${events.map((e, i) => {
        // Format location info
        let locationText = '';
        if (e.action?.includes('DOOR')) {
          locationText = `Door ${e.doorNumber}`;
        } else if (e.action?.includes('YARD_SLOT')) {
          locationText = e.toLocation || `Yard Slot ${e.slotId?.replace('yard-', '') || '?'}`;
        } else if (e.action?.includes('YARD')) {
          locationText = 'Unassigned Yard';
        }
        
        // Build action description
        let actionDesc = e.action?.replace(/_/g, ' ') || 'Unknown';
        
        // Handle different event types
        if (e.action === 'TRAILER_CREATED') {
          actionDesc = 'Created';
          if (locationText) actionDesc += ` at ${locationText}`;
          if (e.status) actionDesc += ` (${e.status})`;
        }
        else if (e.action?.includes('MOVED')) {
          if (e.previousLocation && locationText) {
            actionDesc = `Moved from ${e.previousLocation} to ${locationText}`;
          } else if (locationText) {
            actionDesc = `Moved to ${locationText}`;
          }
        }
        else if (e.action === 'TRAILER_UPDATED') {
          // Try changes array first (new format), fall back to updates (old format)
          if (e.changes?.length > 0) {
            const change = e.changes[0];
            const label = fieldLabels[change.field] || change.field;
            if (!change.from) {
              actionDesc = `Added ${label}: ${change.to}`;
            } else if (!change.to) {
              actionDesc = `Removed ${label}`;
            } else {
              actionDesc = `Changed ${label}: ${change.from} → ${change.to}`;
            }
          } else if (e.updates) {
            // Old format - list what was updated
            const updatedFields = Object.keys(e.updates).filter(k => k !== 'carrier' && k !== 'status');
            if (updatedFields.length > 0) {
              const fields = updatedFields.map(f => fieldLabels[f] || f).join(', ');
              actionDesc = `Updated ${fields}`;
            } else if (e.updates.status) {
              actionDesc = `Marked ${e.updates.status}`;
            } else {
              actionDesc = 'Updated';
            }
          }
        }
        else if (e.action === 'TRAILER_LOADED') {
          actionDesc = 'Marked loaded';
        }
        else if (e.action === 'TRAILER_EMPTY') {
          actionDesc = 'Marked empty';
        }
        else if (e.action === 'TRAILER_DELETED') {
          actionDesc = 'Deleted';
        }
        
        const isCurrent = i === 0; // Most recent is first (at top)
        
        // Get color coding for event type
        let eventClass = '';
        if (e.action?.includes('CREATED')) eventClass = 'created';
        else if (e.action?.includes('DELETED')) eventClass = 'deleted';
        else if (e.action?.includes('MOVED')) eventClass = 'moved';
        else if (e.action?.includes('UPDATED') || e.action?.includes('LOADED') || e.action?.includes('EMPTY')) eventClass = 'updated';
        
        // Build location display - inline compact format using history-location classes
        let locationDisplay = '';
        if (e.action?.includes('MOVED') && e.previousLocation && locationText) {
          locationDisplay = `
            <span class="timeline-location-inline">
              <span class="tl-from">${e.previousLocation}</span>
              <span class="tl-arrow">→</span>
              <span class="tl-to">${locationText}</span>
            </span>
          `;
        } else if (locationText) {
          locationDisplay = `<span class="timeline-location-inline">${locationText}</span>`;
        }
        
        return `
        <div class="timeline-item ${isCurrent ? 'timeline-current' : ''} ${eventClass}">
          <div class="timeline-dot ${isCurrent ? 'current' : ''} ${eventClass}"></div>
          <div class="timeline-content">
            <div class="timeline-meta">
              <span class="timeline-action">${actionDesc}</span>
              ${locationDisplay}
            </div>
            <span class="timeline-time">${new Date(e.timestamp).toLocaleString()}</span>
          </div>
        </div>
        `;
      }).join('')}
    </div>
  `;
}

function renderSimpleTimeline(events) {
  return `
    <div class="timeline">
      ${events.map((e, i) => `
        <div class="timeline-item ${i === 0 ? 'timeline-current' : ''}">
          <div class="timeline-dot"></div>
          <div class="timeline-content">
            <div class="timeline-action">${e.action}</div>
            <div class="timeline-location">📍 ${e.location || 'Unknown'}</div>
            <div class="timeline-status">Status: ${e.status === 'loaded' ? '📦 Loaded' : '📭 Empty'}</div>
            <div class="timeline-time">${new Date(e.timestamp).toLocaleString()}</div>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

// ============================================================================
// Analytics Dashboard
// ============================================================================

async function showAnalyticsModal() {
  const modal = document.createElement('div');
  modal.className = 'modal active';
  modal.id = 'modal-analytics';
  
  modal.innerHTML = `
    <div class="modal-content modal-large">
      <div class="modal-header">
        <h3>📊 Dwell Time Analytics</h3>
        <button class="close-modal">&times;</button>
      </div>
      <div class="modal-body">
        <div class="analytics-tabs">
          <button class="analytics-tab active" data-view="dwell">Avg Dwell Time</button>
          <button class="analytics-tab" data-view="violations">2+ Hour Violations</button>
          <button class="analytics-tab" data-view="patterns">Position Patterns</button>
        </div>
        <div class="analytics-subtabs" id="dwell-tabs">
          <button class="analytics-subtab active" data-period="day">Daily (7 days)</button>
          <button class="analytics-subtab" data-period="week">Weekly (4 weeks)</button>
          <button class="analytics-subtab" data-period="month">Monthly (3 months)</button>
        </div>
        <div class="analytics-chart-container" id="chart-container">
          <canvas id="analytics-chart" width="800" height="400"></canvas>
        </div>
        <div class="analytics-violations hidden" id="violations-container">
          <div class="violations-header">
            <h4>Current Trailers Exceeding 2 Hours</h4>
            <span class="violations-count" id="current-violation-count">0</span>
          </div>
          <div class="violations-list" id="violations-list">
            <div class="violations-loading">Loading...</div>
          </div>
          <div class="violations-history">
            <h4>Historical Violation Counts</h4>
            <div id="violations-chart-container">
              <canvas id="violations-chart" width="800" height="300"></canvas>
            </div>
          </div>
        </div>
        <div class="analytics-patterns hidden" id="patterns-container">
          <div class="patterns-filters">
            <div class="filter-group">
              <label>Carrier</label>
              <select id="pattern-carrier-filter">
                <option value="">All Carriers</option>
              </select>
            </div>
            <div class="filter-group">
              <label>Customer</label>
              <select id="pattern-customer-filter">
                <option value="">All Customers</option>
              </select>
            </div>
            <div class="filter-group date-range">
              <label>From</label>
              <input type="date" id="pattern-date-from">
            </div>
            <div class="filter-group date-range">
              <label>To</label>
              <input type="date" id="pattern-date-to">
            </div>
            <button class="btn btn-secondary" id="btn-clear-pattern-filters">Clear</button>
          </div>
          <div class="patterns-stats" id="patterns-stats">
            <div class="pattern-summary">
              <span id="pattern-total">0</span> total placements analyzed
            </div>
            <div class="pattern-range" id="pattern-range"></div>
          </div>
          <div class="patterns-heatmap-grid" id="patterns-heatmap-grid">
            <div class="patterns-loading">Loading door patterns...</div>
          </div>
          <div class="patterns-legend">
            <span class="legend-item"><span class="legend-color none"></span> No data</span>
            <div class="legend-gradient-bar">
              <div class="gradient-track"></div>
              <div class="gradient-labels">
                <span>Low</span>
                <span>Medium</span>
                <span>High</span>
              </div>
            </div>
          </div>
          <div class="patterns-combos" id="patterns-combos">
            <h4>Top Carrier/Customer Combinations</h4>
            <div class="patterns-list" id="patterns-list"></div>
          </div>
        </div>
        <div class="analytics-summary" id="dwell-summary">
          <div class="summary-stat">
            <span class="stat-label">Avg Dwell Time</span>
            <span id="avg-dwell" class="stat-value">--</span>
          </div>
          <div class="summary-stat">
            <span class="stat-label">Trailers Tracked</span>
            <span id="tracked-count" class="stat-value">--</span>
          </div>
          <div class="summary-stat">
            <span class="stat-label">Data Points</span>
            <span id="data-points" class="stat-value">--</span>
          </div>
        </div>
        <div class="analytics-info" id="dwell-info">
          <p>📈 <strong>Tracking Method:</strong> Daily dwell calculated from movement history. Each trailer's actual time at dock is computed from arrival (MOVED_TO_DOOR) to departure (MOVED_TO_YARD/deleted).</p>
          <p>📊 <strong>Data Accuracy:</strong> Precise dwell times calculated retroactively from complete history - not sampled snapshots.</p>
          <p>🔄 <strong>Dwell Reset:</strong> When you reset a trailer's dwell time, tracking restarts from that point for future calculations.</p>
        </div>
      </div>
      <div class="modal-actions">
        ${editMode ? `<button class="btn btn-success" id="btn-capture-now">📸 Force Calculation</button>
        <button class="btn btn-primary" id="btn-refresh-analytics">🔄 Refresh</button>` : ''}
        <button class="btn btn-secondary" id="btn-export-patterns">📥 Export CSV</button>
        ${editMode ? `<button class="btn btn-danger" id="btn-clear-analytics">🗑️ Clear All History</button>` : ''}
        <button class="btn btn-secondary close-modal">Close</button>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  let currentPeriod = 'day';
  let analyticsData = null;
  
  async function loadAnalytics(period) {
    try {
      analyticsData = await apiCall(`/analytics?period=${period}`);
      // Delay chart render until DOM is laid out
      requestAnimationFrame(() => {
        renderChart(analyticsData, period);
        updateSummary(analyticsData);
      });
    } catch (error) {
      console.error('Analytics error:', error);
      showToast('Failed to load analytics: ' + error.message, 'error');
    }
  }
  
  function updateSummary(data) {
    if (!data || !data.data) return;
    
    const totalDwell = data.data.reduce((sum, d) => sum + d.avgDwell, 0);
    const avg = data.data.length > 0 ? (totalDwell / data.data.length).toFixed(1) : '--';
    const totalTracked = data.data.reduce((sum, d) => sum + (d.count || 0), 0);
    
    document.getElementById('avg-dwell').textContent = avg === '--' ? '--' : `${avg}h`;
    document.getElementById('tracked-count').textContent = totalTracked || '--';
    document.getElementById('data-points').textContent = data.data.length || '--';
  }
  
  function renderChart(data, period) {
    const canvas = document.getElementById('analytics-chart');
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    
    // Set canvas size with DPI scaling
    const rect = canvas.getBoundingClientRect();
    
    // If canvas has no size, set a default
    if (rect.width === 0 || rect.height === 0) {
      canvas.width = 800 * dpr;
      canvas.height = 400 * dpr;
    } else {
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
    }
    
    ctx.scale(dpr, dpr);
    
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    const padding = { top: 40, right: 40, bottom: 60, left: 60 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;
    
    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    if (!data || !data.data || data.data.length === 0) {
      ctx.fillStyle = '#94a3b8';
      ctx.font = '16px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No data available yet - check back after 15 min', width / 2, height / 2);
      return;
    }
    
    // Find max value for scaling
    const maxDwell = Math.max(...data.data.map(d => d.avgDwell || 0), 6);
    
    // Draw axes
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.3)';
    ctx.lineWidth = 1;
    
    // Y-axis label
    ctx.fillStyle = '#94a3b8';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('Avg Dwell (hours)', padding.left - 10, padding.top - 10);
    
    // Draw grid lines and Y labels
    const ySteps = 5;
    for (let i = 0; i <= ySteps; i++) {
      const y = padding.top + chartHeight - (i / ySteps) * chartHeight;
      
      // Grid line
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();
      
      // Y label
      const value = (i / ySteps) * maxDwell;
      ctx.fillStyle = '#94a3b8';
      ctx.textAlign = 'right';
      ctx.fillText(value.toFixed(1) + 'h', padding.left - 10, y + 4);
    }
    
    // Draw bars
    const barWidth = chartWidth / data.data.length * 0.6;
    const barSpacing = chartWidth / data.data.length * 0.4;
    
    data.data.forEach((d, i) => {
      const x = padding.left + (i * (barWidth + barSpacing)) + barSpacing / 2;
      const barHeight = ((d.avgDwell || 0) / maxDwell) * chartHeight;
      const y = padding.top + chartHeight - barHeight;
      
      // Bar color based on value
      const hue = Math.max(0, 120 - ((d.avgDwell || 0) / 6) * 120); // Green (120) to Red (0)
      ctx.fillStyle = `hsl(${hue}, 70%, 50%)`;
      
      // Bar
      ctx.fillRect(x, y, barWidth, barHeight);
      
      // Bar top highlight
      ctx.fillStyle = `hsl(${hue}, 70%, 60%)`;
      ctx.fillRect(x, y, barWidth, 3);
      
      // Value label on bar
      if (barHeight > 20) {
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText((d.avgDwell || 0).toFixed(1) + 'h', x + barWidth / 2, y + 15);
      }
      
      // X label
      ctx.fillStyle = '#94a3b8';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.save();
      ctx.translate(x + barWidth / 2, padding.top + chartHeight + 15);
      ctx.rotate(-Math.PI / 6);
      ctx.fillText(d.label || d.date, 0, 0);
      ctx.restore();
    });
    
    // Title
    ctx.fillStyle = '#f1f5f9';
    ctx.font = 'bold 16px sans-serif';
    ctx.textAlign = 'center';
    const periodLabel = period === 'day' ? 'Daily' : period === 'week' ? 'Weekly' : 'Monthly';
    ctx.fillText(`${periodLabel} Average Dwell Time`, width / 2, 20);
  }
  
  // Tab handlers
  let currentView = 'dwell';
  
  // Main view tabs (Dwell vs Violations)
  modal.querySelectorAll('.analytics-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      modal.querySelectorAll('.analytics-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentView = tab.dataset.view;
      
      // Hide all views first
      document.getElementById('chart-container')?.classList.add('hidden');
      document.getElementById('violations-container')?.classList.add('hidden');
      document.getElementById('patterns-container')?.classList.add('hidden');
      document.getElementById('dwell-summary')?.classList.add('hidden');
      document.getElementById('dwell-info')?.classList.add('hidden');
      document.getElementById('dwell-tabs')?.classList.add('hidden');
      
      // Show appropriate view
      const clearBtn = document.getElementById('btn-clear-analytics');
      
      if (currentView === 'dwell') {
        document.getElementById('chart-container')?.classList.remove('hidden');
        document.getElementById('dwell-summary')?.classList.remove('hidden');
        document.getElementById('dwell-info')?.classList.remove('hidden');
        document.getElementById('dwell-tabs')?.classList.remove('hidden');
        document.getElementById('btn-capture-now')?.classList.remove('hidden');
        document.getElementById('btn-export-patterns')?.classList.add('hidden');
        if (clearBtn) clearBtn.textContent = '🗑️ Clear All History';
        loadAnalytics(currentPeriod);
      } else if (currentView === 'violations') {
        document.getElementById('violations-container')?.classList.remove('hidden');
        document.getElementById('btn-capture-now')?.classList.remove('hidden');
        document.getElementById('btn-export-patterns')?.classList.add('hidden');
        if (clearBtn) clearBtn.textContent = '🗑️ Clear All History';
        loadViolations();
      } else if (currentView === 'patterns') {
        document.getElementById('patterns-container')?.classList.remove('hidden');
        document.getElementById('btn-capture-now')?.classList.add('hidden');
        document.getElementById('btn-export-patterns')?.classList.remove('hidden');
        if (clearBtn) clearBtn.textContent = '🧹 Clear Pattern Data';
        loadPatterns();
      }
    });
  });
  
  // Dwell period subtabs
  modal.querySelectorAll('.analytics-subtab').forEach(tab => {
    tab.addEventListener('click', () => {
      modal.querySelectorAll('.analytics-subtab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentPeriod = tab.dataset.period;
      loadAnalytics(currentPeriod);
    });
  });
  
  // Load violations data
  async function loadViolations() {
    try {
      // Load current violations
      const currentData = await apiCall('/analytics/current-violations');
      
      document.getElementById('current-violation-count').textContent = currentData.count;
      
      const list = document.getElementById('violations-list');
      if (currentData.trailers.length === 0) {
        list.innerHTML = '<div class="violations-empty">✅ No trailers currently exceeding 2 hours</div>';
      } else {
        list.innerHTML = currentData.trailers.map(t => `
          <div class="violation-item" data-trailer-id="${t.id}">
            <div class="violation-main">
              <span class="violation-carrier">${t.carrier}</span>
              ${t.number ? `<span class="violation-number">${t.number}</span>` : ''}
              <span class="viocation-location">Door ${t.doorNumber || '?'}</span>
            </div>
            <div class="violation-meta">
              <span class="violation-dwell ${t.dwellHours >= 3 ? 'critical' : 'warning'}">${t.dwellHours.toFixed(1)}h</span>
              ${t.customer ? `<span class="violation-customer">${t.customer}</span>` : ''}
            </div>
          </div>
        `).join('');
        
        // Add click handlers to open edit modal
        list.querySelectorAll('.violation-item').forEach(item => {
          item.addEventListener('dblclick', () => {
            const trailerId = item.dataset.trailerId;
            const trailer = state.trailers.find(t => t.id === trailerId);
            if (trailer) {
              openTrailerEditModal(trailerId);
            }
          });
        });
      }
      
      // Load historical violation counts
      const histData = await apiCall('/analytics/violations?period=day');
      
      renderViolationsChart(histData.data);
      
    } catch (error) {
      console.error('Violations load error:', error);
      document.getElementById('violations-list').innerHTML = '<div class="violations-empty">Failed to load</div>';
    }
  }
  
  function renderViolationsChart(data) {
    const canvas = document.getElementById('violations-chart');
    if (!canvas || !data || data.length === 0) return;
    
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    
    canvas.width = (rect.width || 800) * dpr;
    canvas.height = (rect.height || 300) * dpr;
    ctx.scale(dpr, dpr);
    
    const width = rect.width || 800;
    const height = rect.height || 300;
    const padding = { top: 30, right: 20, bottom: 50, left: 50 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;
    
    // Clear
    ctx.clearRect(0, 0, width, height);
    
    // Find max
    const maxCount = Math.max(...data.map(d => d.count || 0), 5);
    
    // Draw grid
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.2)';
    ctx.lineWidth = 1;
    
    const ySteps = 5;
    for (let i = 0; i <= ySteps; i++) {
      const y = padding.top + chartHeight - (i / ySteps) * chartHeight;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();
      
      ctx.fillStyle = '#94a3b8';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(Math.round((i / ySteps) * maxCount).toString(), padding.left - 10, y + 4);
    }
    
    // Draw bars
    const barWidth = chartWidth / data.length * 0.7;
    const spacing = chartWidth / data.length * 0.3;
    
    data.forEach((d, i) => {
      const x = padding.left + i * (barWidth + spacing) + spacing / 2;
      const barHeight = ((d.count || 0) / maxCount) * chartHeight;
      const y = padding.top + chartHeight - barHeight;
      
      // Red bars for violations
      ctx.fillStyle = d.count > 0 ? 'rgba(239, 68, 68, 0.8)' : 'rgba(148, 163, 184, 0.3)';
      ctx.fillRect(x, y, barWidth, barHeight);
      
      // Label
      ctx.fillStyle = '#94a3b8';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(d.label || '', x + barWidth / 2, height - 20);
      
      // Count on bar
      if (d.count > 0) {
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 12px sans-serif';
        ctx.fillText(d.count.toString(), x + barWidth / 2, y - 5);
      }
    });
  }
  
  // Refresh handler
  document.getElementById('btn-refresh-analytics')?.addEventListener('click', () => {
    if (currentView === 'dwell') {
      loadAnalytics(currentPeriod);
    } else if (currentView === 'violations') {
      loadViolations();
    } else if (currentView === 'patterns') {
      loadPatterns();
    }
  });
  
  // Position Patterns functions
  let currentPatternFilters = { carrier: '', customer: '', dateFrom: '', dateTo: '' };
  
  // Set default dates (last 30 days)
  const today = new Date().toISOString().split('T')[0];
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  
  async function loadPatterns() {
    try {
      const params = new URLSearchParams();
      if (currentPatternFilters.carrier) params.append('carrier', currentPatternFilters.carrier);
      if (currentPatternFilters.customer) params.append('customer', currentPatternFilters.customer);
      if (currentPatternFilters.dateFrom) params.append('dateFrom', currentPatternFilters.dateFrom);
      if (currentPatternFilters.dateTo) params.append('dateTo', currentPatternFilters.dateTo);
      
      const data = await apiCall(`/analytics/position-patterns?${params.toString()}`);
      
      // Update filter options
      const carrierSelect = document.getElementById('pattern-carrier-filter');
      const customerSelect = document.getElementById('pattern-customer-filter');
      
      if (carrierSelect && data.availableCarriers) {
        const currentVal = carrierSelect.value;
        carrierSelect.innerHTML = '<option value="">All Carriers</option>' +
          data.availableCarriers.map(c => `<option value="${c}" ${c === currentVal ? 'selected' : ''}>${c}</option>`).join('');
      }
      
      if (customerSelect && data.availableCustomers) {
        const currentVal = customerSelect.value;
        customerSelect.innerHTML = '<option value="">All Customers</option>' +
          data.availableCustomers.map(c => `<option value="${c}" ${c === currentVal ? 'selected' : ''}>${c}</option>`).join('');
      }
      
      // Update stats
      document.getElementById('pattern-total').textContent = data.totalPlacements || 0;
      
      const rangeEl = document.getElementById('pattern-range');
      if (data.doorRange) {
        rangeEl.innerHTML = `
          <span class="range-stat">Doors ${data.doorRange.min} - ${data.doorRange.max}</span>
          <span class="range-stat">Avg: Door ${data.doorRange.avg}</span>
        `;
      } else {
        rangeEl.innerHTML = '<span class="range-stat">No data</span>';
      }
      
      // Render heatmap grid
      renderPatternsHeatmap(data.doorStats || []);
      
      // Render combos list
      const combosList = document.getElementById('patterns-list');
      if (!data.topCombos || data.topCombos.length === 0) {
        combosList.innerHTML = '<div class="patterns-empty">No carrier/customer patterns found</div>';
      } else {
        combosList.innerHTML = data.topCombos.map(combo => `
          <div class="pattern-combo-item" data-carrier="${combo.carrier}" data-customer="${combo.customer}">
            <div class="combo-header">
              <span class="combo-carrier">${combo.carrier}</span>
              <span class="combo-arrow">→</span>
              <span class="combo-customer">${combo.customer}</span>
              <span class="combo-total">${combo.total} placements</span>
            </div>
            <div class="combo-doors">
              ${combo.preferredDoors.map(d => `
                <span class="combo-door" title="${d.percentage}% of time">
                  Door ${d.door} <small>(${d.percentage}%)</small>
                </span>
              `).join('')}
            </div>
          </div>
        `).join('');
        
        // Add click to filter
        combosList.querySelectorAll('.pattern-combo-item').forEach(item => {
          item.addEventListener('click', () => {
            document.getElementById('pattern-carrier-filter').value = item.dataset.carrier;
            document.getElementById('pattern-customer-filter').value = item.dataset.customer;
            currentPatternFilters = { 
              carrier: item.dataset.carrier, 
              customer: item.dataset.customer 
            };
            loadPatterns();
          });
        });
      }
      
    } catch (error) {
      console.error('Patterns load error:', error);
      document.getElementById('patterns-list').innerHTML = '<div class="patterns-empty">Failed to load patterns</div>';
    }
  }
  
  // Store current pattern data for click handlers
  let currentPatternData = [];
  
  function showDoorPatternModal(doorNumber, doorData) {
    // Debug: alert to confirm function is called
    console.log('showDoorPatternModal called for door', doorNumber, doorData);
    
    const carriers = doorData?.carriers || [];
    const customers = doorData?.customers || [];
    
    const carriersHtml = carriers.length > 0 
      ? carriers.map(([name, count]) => `<div class="door-stat-item"><span class="stat-name">${escapeHtml(name)}</span><span class="stat-count">${count}</span></div>`).join('')
      : '<div class="door-stat-empty">No carrier data</div>';
    
    const customersHtml = customers.length > 0
      ? customers.map(([name, count]) => `<div class="door-stat-item"><span class="stat-name">${escapeHtml(name)}</span><span class="stat-count">${count}</span></div>`).join('')
      : '<div class="door-stat-empty">No customer data</div>';
    
    const modal = document.createElement('div');
    modal.id = 'door-pattern-modal';
    modal.className = 'modal';
    modal.style.display = 'flex';
    modal.innerHTML = `
      <div class="modal-content modal-small" style="max-width: 400px;">
        <div class="modal-header">
          <h2>🚪 Door ${doorNumber} Details</h2>
          <button class="close-modal" style="background:none;border:none;color:var(--text-muted);font-size:1.5rem;cursor:pointer;">&times;</button>
        </div>
        <div class="modal-body" style="padding: 1rem;">
          <div class="door-stats-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;">
            <div class="door-stat-section">
              <h4 style="margin:0 0 0.5rem 0;font-size:0.875rem;color:var(--text-secondary);">Carriers (${carriers.length})</h4>
              <div class="door-stat-list" style="max-height:200px;overflow-y:auto;">${carriersHtml}</div>
            </div>
            <div class="door-stat-section">
              <h4 style="margin:0 0 0.5rem 0;font-size:0.875rem;color:var(--text-secondary);">Customers (${customers.length})</h4>
              <div class="door-stat-list" style="max-height:200px;overflow-y:auto;">${customersHtml}</div>
            </div>
          </div>
          <div class="door-stat-total" style="margin-top:1rem;padding-top:0.75rem;border-top:1px solid var(--border-color);text-align:center;">Total placements: <strong>${doorData?.frequency || 0}</strong></div>
        </div>
      </div>
    `;
    
    document.body.appendChild(modal);
    
    // Close handlers
    const closeModal = () => modal.remove();
    modal.querySelector('.close-modal')?.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });
    
    // Focus trap
    modal.querySelector('.close-modal')?.focus();
  }

function renderPatternsHeatmap(doorStats) {
    const grid = document.getElementById('patterns-heatmap-grid');
    if (!grid) return;
    
    // Store data for click handlers
    currentPatternData = doorStats;
    const doorDataMap = {};
    doorStats.forEach(d => {
      doorDataMap[d.doorNumber] = d;
    });
    
    // Find max for intensity scaling
    const maxFreq = Math.max(...doorStats.map(d => d.frequency), 0);
    
    // Generate all door numbers (1-57 based on warehouse setup)
    const doors = [];
    for (let i = 1; i <= 57; i++) {
      const doorData = doorDataMap[i];
      const freq = doorData?.frequency || 0;
      
      // Continuous gradient based on intensity
      let intensity = 0;
      let bgColor = 'transparent';
      let borderColor = 'var(--border-color)';
      let glowOpacity = 0;
      
      if (freq > 0 && maxFreq > 0) {
        intensity = freq / maxFreq;
        
        // Hue gradient: 220° (blue) → 270° (purple) → 330° (pink/red)
        // More granular - 10 distinct levels visually
        let hue;
        if (intensity <= 0.1) hue = 215;      // Light blue
        else if (intensity <= 0.2) hue = 225; // Blue
        else if (intensity <= 0.3) hue = 235; // Blue-purple
        else if (intensity <= 0.4) hue = 245; // Purple-blue
        else if (intensity <= 0.5) hue = 260; // Purple
        else if (intensity <= 0.6) hue = 275; // Purple-magenta
        else if (intensity <= 0.7) hue = 290; // Magenta
        else if (intensity <= 0.8) hue = 310; // Pink-magenta
        else if (intensity <= 0.9) hue = 330; // Pink
        else hue = 350;                         // Red-pink (hot!)
        
        // Saturation increases with intensity (more vibrant = more activity)
        const saturation = 50 + intensity * 50; // 50-100%
        
        // Lightness decreases slightly as intensity increases (darker = more activity)
        const lightness = 55 - intensity * 20; // 55-35%
        
        bgColor = `hsla(${hue}, ${saturation}%, ${lightness}%, ${0.3 + intensity * 0.7})`;
        borderColor = `hsla(${hue}, ${saturation}%, ${lightness - 10}%, 0.9)`;
        glowOpacity = intensity * 0.4;
      }
      
      doors.push({
        number: i,
        frequency: freq,
        intensity,
        bgColor,
        borderColor,
        glowOpacity,
        hasData: !!doorData
      });
    }
    
    grid.innerHTML = doors.map(d => `
      <div class="pattern-heat-cell ${d.frequency > 0 ? 'has-data' : ''}" 
           style="background: ${d.bgColor}; border-color: ${d.borderColor}; --glow-opacity: ${d.glowOpacity}"
           data-door="${d.number}"
           data-has-data="${d.hasData}"
           data-intensity="${Math.round(d.intensity * 100)}"
           title="Door ${d.number}: ${d.frequency} placements (${Math.round(d.intensity * 100)}%)">
        <span class="pattern-door-num">${d.number}</span>
        ${d.frequency > 0 ? `<span class="pattern-door-freq">${d.frequency}</span>` : ''}
      </div>
    `).join('');
    
    // Add click handler using event delegation (more reliable)
    grid.onclick = (e) => {
      const cell = e.target.closest('.pattern-heat-cell');
      if (!cell) return;
      
      const doorNum = parseInt(cell.dataset.door);
      const doorData = doorDataMap[doorNum];
      console.log('Clicked door', doorNum, 'data:', doorData);
      
      // Show modal even if no data
      showDoorPatternModal(doorNum, doorData || { frequency: 0, carriers: [], customers: [] });
    };
  }
  
  // Pattern filter handlers
  document.getElementById('pattern-carrier-filter')?.addEventListener('change', (e) => {
    currentPatternFilters.carrier = e.target.value;
    loadPatterns();
  });
  
  document.getElementById('pattern-customer-filter')?.addEventListener('change', (e) => {
    currentPatternFilters.customer = e.target.value;
    loadPatterns();
  });
  
  document.getElementById('pattern-date-from')?.addEventListener('change', (e) => {
    currentPatternFilters.dateFrom = e.target.value;
    loadPatterns();
  });
  
  document.getElementById('pattern-date-to')?.addEventListener('change', (e) => {
    currentPatternFilters.dateTo = e.target.value;
    loadPatterns();
  });
  
  document.getElementById('btn-clear-pattern-filters')?.addEventListener('click', () => {
    document.getElementById('pattern-carrier-filter').value = '';
    document.getElementById('pattern-customer-filter').value = '';
    document.getElementById('pattern-date-from').value = '';
    document.getElementById('pattern-date-to').value = '';
    currentPatternFilters = { carrier: '', customer: '', dateFrom: '', dateTo: '' };
    loadPatterns();
  });
  
  // Export patterns to CSV
  document.getElementById('btn-export-patterns')?.addEventListener('click', async () => {
    try {
      const params = new URLSearchParams();
      if (currentPatternFilters.carrier) params.append('carrier', currentPatternFilters.carrier);
      if (currentPatternFilters.customer) params.append('customer', currentPatternFilters.customer);
      if (currentPatternFilters.dateFrom) params.append('dateFrom', currentPatternFilters.dateFrom);
      if (currentPatternFilters.dateTo) params.append('dateTo', currentPatternFilters.dateTo);
      
      const data = await apiCall(`/analytics/position-patterns?${params.toString()}`);
      
      // Build CSV
      let csv = 'Door Number,Frequency,Top Carriers,Top Customers\n';
      data.doorStats.forEach(d => {
        const carriers = d.topCarriers.map(([c, count]) => `${c} (${count})`).join('; ');
        const customers = d.topCustomers.map(([c, count]) => `${c} (${count})`).join('; ');
        csv += `${d.doorNumber},${d.frequency},"${carriers}","${customers}"\n`;
      });
      
      // Download
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `door-patterns-${new Date().toISOString().split('T')[0]}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      showToast('CSV exported!', 'success');
    } catch (error) {
      showToast('Export failed: ' + error.message, 'error');
    }
  });
  
  // Force Calculation handler - recalculate today's dwell from history
  document.getElementById('btn-capture-now')?.addEventListener('click', async () => {
    try {
      await apiCall('/analytics/snapshot', 'POST');
      showToast('Daily dwell recalculated!', 'success');
      // Reload current view after brief delay
      setTimeout(() => {
        if (currentView === 'dwell') {
          loadAnalytics(currentPeriod);
        }
      }, 500);
    } catch (error) {
      showToast('Error: ' + error.message, 'error');
    }
  });
  
  // Clear analytics handler (edit mode only)
  document.getElementById('btn-clear-analytics')?.addEventListener('click', async () => {
    if (currentView === 'patterns') {
      if (!confirm('This will reset the analytics start date to NOW.\n\nOlder pattern data will be hidden but not deleted.\nContinue?')) return;
      
      try {
        await apiCall('/analytics?mode=reset_start_date', 'DELETE');
        showToast('Pattern data reset (start date updated)', 'success');
        loadPatterns();
      } catch (error) {
        showToast('Error: ' + error.message, 'error');
      }
      return;
    }
    
    // Default behavior for other tabs
    if (!confirm('⚠️ WARNING: This will permanently delete ALL analytics history!\n\nThis action cannot be undone. Continue?')) return;
    if (!confirm('Are you absolutely sure? All daily dwell aggregates will be lost.')) return;
    
    try {
      await apiCall('/analytics', 'DELETE');
      showToast('Analytics history cleared', 'success');
      setTimeout(() => loadAnalytics(currentPeriod), 500);
    } catch (error) {
      showToast('Error: ' + error.message, 'error');
    }
  });
  
  // Close handlers
  modal.querySelectorAll('.close-modal').forEach(btn => {
    btn.addEventListener('click', () => modal.remove());
  });
  
  // Initial load
  loadAnalytics(currentPeriod);
}

// ============================================================================
// Helper Functions
// ============================================================================

function generateTrailerNumber() {
  // Generate a random trailer number: TR-[timestamp]-[random]
  const timestamp = Date.now().toString(36).toUpperCase().slice(-4);
  const random = Math.random().toString(36).toUpperCase().slice(-3);
  return `TR-${timestamp}-${random}`;
}

function renderQuickCarrierButtons() {
  const container = document.getElementById('quick-carrier-buttons');
  const form = document.getElementById('form-create-trailer');
  const targetDoor = form?.dataset.targetDoor;
  const targetStaging = form?.dataset.targetStaging === 'true';
  
  if (!container) return;
  
  // Update target door display
  const targetDoorEl = document.getElementById('quick-target-door');
  if (targetDoorEl) {
    targetDoorEl.textContent = targetStaging ? 'Staging' : (targetDoor || 'Yard');
  }
  
  // Separate favorites and non-favorites
  const favorites = state.carriers.filter(c => c.favorite).sort((a, b) => a.name.localeCompare(b.name));
  const nonFavorites = state.carriers.filter(c => !c.favorite).sort((a, b) => (b.usageCount || 0) - (a.usageCount || 0));
  
  // Take top 6 non-favorites by usage
  const topNonFavorites = nonFavorites.slice(0, 6);

  if (favorites.length === 0 && topNonFavorites.length === 0) {
    container.innerHTML = '<span class="no-carriers-msg">No carriers yet. Add one below.</span>';
    return;
  }

  let html = '';
  
  // Favorites section (fixed positions)
  if (favorites.length > 0) {
    html += `<div class="quick-carrier-grid favorites-grid">`;
    html += favorites.map(carrier => `
      <button type="button" class="quick-carrier-btn favorite-btn" data-carrier="${carrier.name}">
        ⭐ ${carrier.name}
      </button>
    `).join('');
    html += `</div>`;
  }
  
  // Separator if both sections exist
  if (favorites.length > 0 && topNonFavorites.length > 0) {
    html += `<div class="quick-carrier-separator"></div>`;
  }
  
  // Non-favorites section (sorted by usage, floats to top)
  if (topNonFavorites.length > 0) {
    html += `<div class="quick-carrier-grid">`;
    html += topNonFavorites.map(carrier => `
      <button type="button" class="quick-carrier-btn" data-carrier="${carrier.name}">
        ${carrier.name}
        ${carrier.usageCount ? `<span class="usage-count">(${carrier.usageCount})</span>` : ''}
      </button>
    `).join('');
    html += `</div>`;
  }
  
  container.innerHTML = html;

  // Add click handlers
  container.querySelectorAll('.quick-carrier-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const carrierName = btn.dataset.carrier;
      const form = document.getElementById('form-create-trailer');
      const targetDoor = form?.dataset.targetDoor;
      const targetStaging = form?.dataset.targetStaging === 'true';
      const isLive = document.getElementById('quick-add-live')?.checked || false;
      
      try {
        // Find carrier to get ID for usage tracking
        const carrier = state.carriers.find(c => c.name === carrierName);
        
        // Increment usage count
        if (carrier) {
          apiCall(`/carriers/${carrier.id}/use`, 'POST').catch(() => {});
          carrier.usageCount = (carrier.usageCount || 0) + 1;
        }
        
        if (targetStaging) {
          // Add directly to staging
          await addToStaging({ carrier: carrierName, status: 'empty', isLive });
          showToast(`✅ ${carrierName} trailer added to Staging!`, 'success');
        } else {
          // Original logic for doors/yard
          const result = await createTrailer({
            carrier: carrierName,
            status: 'empty', // Default to empty for quick add
            isLive
          });
          
          const trailerId = result.trailer?.id;
          
          // If door was clicked, move trailer there
          if (targetDoor && trailerId) {
            await moveToDoor(trailerId, parseInt(targetDoor));
            showToast(`✅ ${carrierName} trailer placed in Door ${targetDoor}!`, 'success');
          } else {
            showToast(`✅ ${carrierName} trailer added to yard!`, 'success');
          }
        }
        
        closeModal('modal-create');
        delete form.dataset.targetDoor;
        delete form.dataset.targetStaging;
        // Reset the checkbox for next time
        const liveCheckbox = document.getElementById('quick-add-live');
        if (liveCheckbox) liveCheckbox.checked = false;
        await fetchState();
      } catch (error) {
        showToast(error.message, 'error');
      }
    });
  });
}

// ============================================================================
// State Management
// ============================================================================

async function fetchState() {
  if (isPaused) return;
  
  try {
    const newState = await getState();
    state.doors = newState.doors || [];
    state.trailers = newState.trailers || [];
    state.yardTrailers = newState.yardTrailers || [];
    state.yardSlots = newState.yardSlots || [];
    state.carriers = newState.carriers || [];
    state.shippedTrailers = newState.shippedTrailers || [];
    state.staging = newState.staging || null;
    state.queuedTrailers = newState.queuedTrailers || [];
    state.appointmentQueue = newState.appointmentQueue || [];
    
    // Only render if state changed (reduce DOM updates)
    renderAll();
    
    // Reset error tracking on success
    if (consecutiveErrors > 0) {
      consecutiveErrors = 0;
      fetchErrorShown = false;
      // Resume normal polling speed
      clearInterval(pollingInterval);
      pollingInterval = setInterval(fetchState, NORMAL_POLL_INTERVAL);
    }
  } catch (error) {
    consecutiveErrors++;
    console.error(`Fetch error (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):`, error);
    
    if (!fetchErrorShown) {
      showToast('Connection error - retrying...', 'warning');
      fetchErrorShown = true;
    }
    
    // Slow down polling after errors
    if (consecutiveErrors >= 3) {
      clearInterval(pollingInterval);
      pollingInterval = setInterval(fetchState, ERROR_POLL_INTERVAL);
    }
    
    // Pause entirely if too many errors (server likely restarting)
    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      isPaused = true;
      console.log('Too many errors, pausing polling for 60s...');
      setTimeout(() => {
        isPaused = false;
        consecutiveErrors = 0;
        pollingInterval = setInterval(fetchState, NORMAL_POLL_INTERVAL);
        fetchState(); // Try once more
      }, 60000);
    }
  }
}

function startPolling() {
  renderAll(); // Render empty grid immediately
  fetchState(); // Then fetch real data
  pollingInterval = setInterval(fetchState, NORMAL_POLL_INTERVAL);
}

function renderAll() {
  renderDoors();
  renderStaging();
  renderQueue();
  renderAppointmentQueue();
  renderYardSlots();
  renderUnassignedYard();
  updateStats();
  renderCarrierSelect();
  renderCarrierSummary();
  updateUndoButton();
}

// ============================================================================
// Render Functions  
// ============================================================================

function renderDoors() {
  const grid = document.getElementById('dock-grid');
  if (!grid) return;

  let html = '';
  // Sort doors by order field (if set), then by number. Door numbers stay fixed.
  const sortedDoors = [...state.doors].sort((a, b) => {
    // Use explicit order if both have it
    if (a.order !== undefined && b.order !== undefined) {
      return a.order - b.order;
    }
    // Fall back to number sort if no explicit order
    return a.number - b.number;
  });

  for (const door of sortedDoors) {
    const trailer = door?.trailerId ? state.trailers.find(t => t.id === door.trailerId && t.location !== 'shipped') : null;
    const doorNum = door.number;
    const hasTextLabel = door.labelText && door.labelText.trim();
    const displayLabel = hasTextLabel ? door.labelText : `Door ${doorNum}`;
    const textLabelClass = hasTextLabel ? 'has-text-label' : '';
    
    // Check search match
    let searchClass = '';
    if (searchQuery && trailer) {
      if (isTrailerInSearchResults(trailer.id)) {
        searchClass = 'search-match';
      } else {
        searchClass = 'search-mismatch';
      }
    } else if (searchQuery && !trailer) {
      searchClass = 'search-mismatch';
    }
    
    // Determine highlight state from carrier filter
    let highlightClass = '';
    if (activeCarrierFilter && trailer) {
      if (trailer.carrier === activeCarrierFilter) {
        highlightClass = 'highlighted';
      } else {
        highlightClass = 'dimmed';
      }
    } else if (activeCarrierFilter && !trailer) {
      highlightClass = 'dimmed';
    }

    // Out of service door
    if (door.inService === false) {
      html += `
        <div class="dock-door out-of-service ${highlightClass} ${searchClass} ${textLabelClass} ${editMode ? 'door-draggable' : ''}" data-door="${doorNum}" data-door-id="${door.id}" ${editMode ? 'draggable="true"' : ''}>
          <div class="door-header">
            <span class="door-number">${displayLabel}</span>
            <span class="badge">🔧 Out of Service</span>
          </div>
          <div class="door-content">
            ${hasTextLabel ? `<span class="door-text-label ${door.labelText.length > 6 ? 'long-label' : ''}">${door.labelText}</span>` : '<span class="out-of-service-text">Unavailable</span>'}
          </div>
          ${editMode ? `<button class="door-edit-btn" data-door-id="${door.id}" style="opacity: 1">⚙️</button>` : ''}
        </div>
      `;
      continue;
    }

    // Blank/dummy door (spacer)
    if (door.type === 'blank') {
      html += `
        <div class="dock-door blank ${highlightClass} ${searchClass} ${textLabelClass} ${editMode ? 'door-draggable' : ''}" data-door="${doorNum}" data-door-id="${door.id}" ${editMode ? 'draggable="true"' : ''}>
          <div class="door-header">
            <span class="door-number">${displayLabel}</span>
            <span class="door-status">Blank</span>
          </div>
          <div class="door-content">
            ${hasTextLabel ? `<span class="door-text-label ${door.labelText.length > 6 ? 'long-label' : ''}">${door.labelText}</span>` : '<span class="blank-text">—</span>'}
          </div>
          ${editMode ? `<button class="door-edit-btn" data-door-id="${door.id}" style="opacity: 1">⚙️</button>` : ''}
        </div>
      `;
      continue;
    }

    // Normal door with trailer
    if (trailer) {
      const statusBadge = trailer.status === 'loaded' ? 
        `<span class="badge loaded status-toggle" data-trailer-id="${trailer.id}">📦 Loaded</span>` : 
        `<span class="badge empty status-toggle" data-trailer-id="${trailer.id}">📭 Empty</span>`;
      const statusClass = trailer.status === 'loaded' ? 'status-loaded' : 'status-empty';
      const liveClass = (trailer.isLive === true || trailer.isLive === 'true') ? 'is-live' : '';
      
      // Dwell time
      const dwellClass = getDwellTimeClass(trailer.createdAt);
      const dwellTime = formatDwellTime(trailer.createdAt);
      const dwellBadge = dwellTime ? `<span class="dwell-badge ${dwellClass}">⏱️ ${dwellTime}</span>` : '';
      
      // Selection state
      const selectedClass = selectedTrailers.has(trailer.id) ? 'selected' : '';
      
      // Queue indicator - show count of trailers waiting for this door
      const queuedForDoor = state.queuedTrailers?.filter(t => t.targetDoorId === door.id) || [];
      const queueCount = queuedForDoor.length;
      const queueIndicator = queueCount > 0 ? 
        `<span class="door-queue-indicator clickable-queue" data-door-id="${door.id}" title="${queueCount} trailer(s) queued. Click to view next.">⏳ ${queueCount}</span>` : '';

      html += `
        <div class="dock-door occupied ${highlightClass} ${statusClass} ${searchClass} ${dwellClass} ${textLabelClass} ${editMode ? 'door-draggable' : ''}" data-door="${doorNum}" data-door-id="${door.id}" ${editMode ? 'draggable="true"' : ''}>
          <div class="door-header">
            <span class="door-number">${displayLabel}</span>
            ${queueIndicator}
            <div style="display:flex;align-items:center;">
                ${statusBadge}
            </div>
          </div>
          <div class="door-content">
            ${hasTextLabel ? `<span class="door-text-label ${door.labelText.length > 6 ? 'long-label' : ''}">${door.labelText}</span>` : ''}
            <div class="trailer-card docked ${trailer.status} ${selectedClass} ${dwellClass} ${liveClass}" draggable="true" data-trailer-id="${trailer.id}" data-location="door-${doorNum}">
              <div class="trailer-header-row">
                ${trailer.number ? `<span class="trailer-number">${trailer.number}</span>` : ''}
                ${dwellBadge}
                ${editMode ? `<button class="delete-trailer-btn" data-trailer-id="${trailer.id}" title="Delete trailer">🗑️</button>` : ''}
              </div>
              ${trailer.customer ? `<div class="trailer-customer">${trailer.customer}</div>` : ''}
              ${trailer.driverName ? `<div class="trailer-driver">${trailer.driverName}</div>` : ''}
              <div class="trailer-carrier">${trailer.carrier}</div>
              ${trailer.loadNumber ? `<div class="trailer-load-number-row">${trailer.loadNumber}</div>` : ''}
            </div>
          </div>
          ${editMode ? `<button class="door-edit-btn" data-door-id="${door.id}" style="opacity: 1">⚙️</button>` : ''}
        </div>
      `;
    } else {
      // Empty normal door
      const emptyContent = hasTextLabel 
        ? `<span class="door-text-label ${door.labelText.length > 6 ? 'long-label' : ''}">${door.labelText}</span>`
        : (editMode ? `<span class="placeholder-text">Drag to reorder</span>` : `<button class="quick-add-btn" data-door="${door.number}">+ Add</button>`);
      
      html += `
        <div class="dock-door empty ${highlightClass} ${searchClass} ${textLabelClass} ${editMode ? 'door-draggable' : ''}" data-door="${doorNum}" data-door-id="${door.id}" ${editMode ? 'draggable="true"' : ''}>
          <div class="door-header">
            <span class="door-number">${displayLabel}</span>
            <span class="door-status">Empty</span>
          </div>
          <div class="door-content">
            ${emptyContent}
          </div>
          ${editMode ? `<button class="door-edit-btn" data-door-id="${door.id}">⚙️</button>` : ''}
        </div>
      `;
    }
  }
  
  // Add "Add Door" button in edit mode
  if (editMode) {
    html += `
      <div class="dock-door add-door-card" id="btn-add-door">
        <div class="door-content">
          <span class="add-door-text">+ Add Door</span>
        </div>
      </div>
    `;
  }
  
  grid.innerHTML = html;
  
  // Add drag listeners to doors (edit mode only)
  if (editMode) {
    setupDoorDragAndDrop(grid);
  }
  
  // Add drag listeners to trailers
  grid.querySelectorAll('.trailer-card[draggable]').forEach(el => {
    el.addEventListener('dragstart', handleDragStart);
    el.addEventListener('dragend', handleDragEnd);
    el.addEventListener('click', (e) => {
      // Normal click -> Selection logic handles modifiers internally
      if (!e.target.closest('.delete-trailer-btn')) {
        // We must pass the event 'e' to toggleTrailerSelection so it can check ctrlKey
        toggleTrailerSelection(el.dataset.trailerId, e);
      }
    });
  });

  // Quick add buttons
  grid.querySelectorAll('.quick-add-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const doorNum = btn.dataset.door;
      
      document.getElementById('quick-add-panel')?.classList.remove('hidden');
      document.getElementById('form-create-trailer')?.classList.add('hidden');
      
      const form = document.getElementById('form-create-trailer');
      form.dataset.targetDoor = doorNum;
      
      renderQuickCarrierButtons();
      openModal('modal-create');
      
      setTimeout(() => {
        document.getElementById('quick-carrier-input')?.focus();
      }, 100);
    });
  });

  // Status badge double-click to toggle loaded/empty
  grid.querySelectorAll('.status-toggle').forEach(badge => {
    badge.style.cursor = 'pointer';
    badge.addEventListener('dblclick', async (e) => {
      e.stopPropagation();
      const trailerId = badge.dataset.trailerId;
      const trailer = state.trailers.find(t => t.id === trailerId);
      if (!trailer) return;
      
      const newStatus = trailer.status === 'loaded' ? 'empty' : 'loaded';
      try {
        await updateTrailer(trailerId, { status: newStatus });
        showToast(`Status changed to ${newStatus === 'loaded' ? '📦 Loaded' : '📭 Empty'}`, 'success');
        fetchState();
      } catch (error) {
        showToast(error.message, 'error');
      }
    });
  });

  // Clickable Queue Indicator
  grid.querySelectorAll('.clickable-queue').forEach(badge => {
    badge.style.cursor = 'pointer';
    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      const doorId = badge.dataset.doorId;
      // Find oldest queued trailer for this door (FIFO)
      const queuedForDoor = state.queuedTrailers?.filter(t => t.targetDoorId === doorId)
        .sort((a, b) => new Date(a.queuedAt) - new Date(b.queuedAt));
        
      if (queuedForDoor && queuedForDoor.length > 0) {
        openTrailerEditModal(queuedForDoor[0].id);
      } else {
        showToast('No trailers currently queued for this door', 'info');
      }
    });
  });

  // Trailer double-click to edit (but not on delete button)
  grid.querySelectorAll('.trailer-card').forEach(card => {
    card.style.cursor = 'pointer';
    card.addEventListener('dblclick', (e) => {
      if (!e.target.closest('.delete-trailer-btn') && !e.target.closest('.trailer-checkbox')) {
        openTrailerEditModal(card.dataset.trailerId);
      }
    });
  });
  
  grid.querySelectorAll('.delete-trailer-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const trailerId = btn.dataset.trailerId;
      const trailer = state.trailers.find(t => t.id === trailerId) ||
                      state.appointmentQueue?.find(t => t.id === trailerId);
      if (!trailer) return;
      
      // Decode HTML entities for display in the confirm dialog
      const trailerName = trailer.number || trailer.carrier;
      const displayName = decodeHtml(trailerName);
      
      if (!confirm(`Delete trailer ${displayName} (${decodeHtml(trailer.carrier)})?\n\nThis will permanently remove it.`)) {
        return;
      }
      
      if (selectedTrailers.has(trailerId)) {
        selectedTrailers.delete(trailerId);
      }
      
      try {
        await deleteTrailer(trailerId);
        showToast('Trailer deleted', 'success');
        fetchState();
      } catch (error) {
        showToast(error.message, 'error');
      }
    });
  });

  // Door edit buttons (edit mode only)
  if (editMode) {
    grid.querySelectorAll('.door-edit-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const doorId = btn.dataset.doorId;
        openDoorEditor(doorId);
      });
    });

    // Add door button
    const addDoorBtn = document.getElementById('btn-add-door');
    if (addDoorBtn) {
      addDoorBtn.addEventListener('click', () => openAddDoorModal());
    }
  }
  
  // Update selection visual state
  updateSelectionUI();
}

// Staging Area (1 slot)
function renderStaging() {
  const container = document.getElementById('staging-area');
  if (!container) return;
  
  const trailer = state.staging;
  
  if (!trailer) {
    container.classList.add('empty');
    container.innerHTML = '';
    // Add click handler to open quick add for staging
    container.onclick = () => openQuickAddForStaging();
    return;
  }
  
  // Remove click handler when trailer is present
  container.onclick = null;
  container.classList.remove('empty');
  
  // Search match
  let searchClass = '';
  if (searchQuery) {
    if (isTrailerInSearchResults(trailer.id)) {
      searchClass = 'search-match';
    } else {
      searchClass = 'search-mismatch';
    }
  }
  
  // Status class
  const statusClass = trailer.status === 'loaded' ? 'loaded' : 'empty';
  const statusText = trailer.status === 'loaded' ? 'LOADED' : 'EMPTY';
  const liveClass = (trailer.isLive === true || trailer.isLive === 'true') ? 'is-live' : '';
  
  // Build info row - trailer number and load number
  let infoItems = [];
  if (trailer.number) infoItems.push(`<span class="trailer-number">${trailer.number}</span>`);
  if (trailer.loadNumber) infoItems.push(`<span class="trailer-load-number">Load: ${trailer.loadNumber}</span>`);
  const infoRow = infoItems.length > 0 ? `<div class="yard-trailer-info">${infoItems.join('')}</div>` : '';
  
  // Build driver and customer rows (customer first, then driver above carrier)
  // Backend now encodes these entities, so we don't need to escape them again if they are just text
  // However, escapeHtml is safe to remove IF the backend guarantees encoding.
  // Given we just switched to backend encoding, we should treat the data as "safe HTML"
  // and insert it directly, OR decode it then escape it (if we want to be paranoid).
  // But simpler: just remove escapeHtml since backend sends "&amp;"
  const customerRow = trailer.customer ? `<div class="yard-trailer-customer">${trailer.customer}</div>` : '';
  const driverRow = trailer.driverName ? `<div class="yard-trailer-driver">${trailer.driverName}</div>` : '';
  
  container.innerHTML = `
    <div class="yard-trailer ${statusClass} ${searchClass} ${liveClass}" 
         draggable="true" 
         data-trailer-id="${trailer.id}"
         data-location="staging">
      <div class="yard-trailer-header">
        <span class="trailer-carrier">${trailer.carrier}</span>
        <div style="display:flex;align-items:center;">
            <span class="yard-status-badge ${statusClass}">${statusText}</span>
        </div>
      </div>
      ${customerRow}
      ${driverRow}
      ${infoRow}
    </div>
  `;
  
  // Add drag handlers
  const el = container.querySelector('.yard-trailer');
  if (el) {
    el.addEventListener('dragstart', handleDragStart);
    el.addEventListener('dragend', handleDragEnd);
    el.addEventListener('dblclick', () => openTrailerEditModal(trailer.id));
  }
}

// Queue Area (list of trailers waiting for doors)
function renderQueue() {
  const container = document.getElementById('queue-area');
  const countEl = document.getElementById('queue-count');
  if (!container) return;
  
  const queue = state.queuedTrailers || [];
  if (countEl) countEl.textContent = queue.length;
  
  if (queue.length === 0) {
    container.innerHTML = '';
    return;
  }
  
  // Sort by queued time (oldest first)
  const sortedQueue = [...queue].sort((a, b) => new Date(a.queuedAt) - new Date(b.queuedAt));
  
  container.innerHTML = sortedQueue.map((t, index) => {
    // Search match
    let searchClass = '';
    if (searchQuery) {
      if (isTrailerInSearchResults(t.id)) {
        searchClass = 'search-match';
      } else {
        searchClass = 'search-mismatch';
      }
    }
    
    // Status class
    const statusClass = t.status === 'loaded' ? 'loaded' : 'empty';
    const statusText = t.status === 'loaded' ? 'LOADED' : 'EMPTY';
    const liveClass = (t.isLive === true || t.isLive === 'true') ? 'is-live' : '';
    
    // Build info row - trailer number and load number
    let infoItems = [];
    if (t.number) infoItems.push(`<span class="trailer-number">${t.number}</span>`);
    if (t.loadNumber) infoItems.push(`<span class="trailer-load-number">Load: ${t.loadNumber}</span>`);
    const infoRow = infoItems.length > 0 ? `<div class="yard-trailer-info">${infoItems.join('')}</div>` : '';
    
    // Build driver and customer rows (customer first, then driver above carrier)
    const customerRow = t.customer ? `<div class="yard-trailer-customer">${t.customer}</div>` : '';
    const driverRow = t.driverName ? `<div class="yard-trailer-driver">${t.driverName}</div>` : '';
    
    // Appointment Time Display
    let apptTimeHtml = '';
    if (t.appointmentTime) {
      // If the input type="time", the value is HH:MM (24h)
      // We can display it directly or convert to AM/PM
      const [hours, mins] = t.appointmentTime.split(':');
      const timeObj = new Date();
      timeObj.setHours(hours);
      timeObj.setMinutes(mins);
      const timeStr = timeObj.toLocaleTimeString([], {hour: 'numeric', minute:'2-digit'});
      apptTimeHtml = `<div class="yard-trailer-appt" style="font-size:0.7rem;color:#fbbf24;text-align:center;font-weight:600;margin-top:2px;">🕒 ${timeStr}</div>`;
    }

    return `
      <div class="yard-trailer ${statusClass} ${searchClass} ${liveClass}" 
           draggable="true" 
           data-trailer-id="${t.id}"
           data-location="queue"
           data-target-door="${t.targetDoorId}">
        <div class="yard-trailer-header">
          <span class="trailer-carrier">${t.carrier}</span>
          <span class="yard-status-badge ${statusClass}">${statusText}</span>
          <span class="queued-badge">#${index + 1}</span>
        </div>
        ${customerRow}
        ${driverRow}
        ${infoRow}
        ${apptTimeHtml}
        <div class="target-door-badge">➜ Door ${t.targetDoorNumber}</div>
      </div>
    `;
  }).join('');
  
  // Add drag handlers
  container.querySelectorAll('.yard-trailer').forEach(el => {
    el.addEventListener('dragstart', handleDragStart);
    el.addEventListener('dragend', handleDragEnd);
    el.addEventListener('dblclick', () => openTrailerEditModal(el.dataset.trailerId));
  });
}

// Appointment Queue Area (Waiting for Appt)
function setupAppointmentQueueDragAndDrop(container) {
  // Only add drop handlers, let global handleDragStart handle the drag initiation
  container.querySelectorAll('.yard-trailer').forEach(item => {
    // Note: dragstart is handled globally by handleDragStart
    
    item.addEventListener('dragover', (e) => {
      e.preventDefault(); // Necessary to allow dropping
      const draggingItem = document.querySelector('.dragging');
      // Only highlight if dragging a different item and it's from the same queue
      if (draggingItem && draggingItem !== item && draggingItem.dataset.location === 'appointment-queue') {
        item.classList.add('drag-over-item');
        e.dataTransfer.dropEffect = 'move';
      }
    });
    
    item.addEventListener('dragleave', () => {
      item.classList.remove('drag-over-item');
    });
    
    item.addEventListener('drop', async (e) => {
      e.preventDefault();
      // Don't stop propagation completely, but we handled it
      item.classList.remove('drag-over-item');
      
      const sourceId = e.dataTransfer.getData('text/plain');
      const sourceLoc = e.dataTransfer.getData('source-location');
      
      // Only allow reordering within the same list
      // handleDragStart sets source-location to 'appointment-queue' for these items
      if (sourceLoc !== 'appointment-queue' || !sourceId) return;
      
      // Stop it from bubbling to other drop handlers (like the container)
      e.stopPropagation();
      
      // Calculate new order
      const items = Array.from(container.querySelectorAll('.yard-trailer'));
      const sourceIndex = items.findIndex(i => i.dataset.trailerId === sourceId);
      const targetIndex = items.findIndex(i => i === item);
      
      if (sourceIndex === -1 || targetIndex === -1 || sourceIndex === targetIndex) return;
      
      // Move item in DOM temporarily for visual feedback
      if (sourceIndex < targetIndex) {
        item.after(items[sourceIndex]);
      } else {
        item.before(items[sourceIndex]);
      }
      
      // Get new ID order
      const newOrderIds = Array.from(container.querySelectorAll('.yard-trailer')).map(el => el.dataset.trailerId);
      
      try {
        await apiCall('/appointment-queue/reorder', 'POST', { trailerIds: newOrderIds });
        // showToast('Queue order updated', 'success'); // Optional: reduce noise
        // No need to fetchState immediately if we trust the UI update, but safer to sync
        fetchState();
      } catch (error) {
        showToast('Failed to reorder: ' + error.message, 'error');
        fetchState(); // Revert on error
      }
    });
  });
}

function renderAppointmentQueue() {
  const container = document.getElementById('appointment-queue-area');
  const countEl = document.getElementById('appointment-queue-count');
  if (!container) return;
  
  const queue = state.appointmentQueue || [];
  if (countEl) countEl.textContent = queue.length;
  
  if (queue.length === 0) {
    container.innerHTML = '<div class="queue-placeholder">Drag trailers waiting for appointment here</div>';
    return;
  }
  
  // Manual reordering enabled: use array order directly
  const sortedQueue = queue;
  
  container.innerHTML = sortedQueue.map((t, index) => {
    // Search match
    let searchClass = '';
    if (searchQuery) {
      if (isTrailerInSearchResults(t.id)) {
        searchClass = 'search-match';
      } else {
        searchClass = 'search-mismatch';
      }
    }
    
    // Status class
    const statusClass = t.status === 'loaded' ? 'loaded' : 'empty';
    const statusText = t.status === 'loaded' ? 'LOADED' : 'EMPTY';
    const liveClass = (t.isLive === true || t.isLive === 'true') ? 'is-live' : '';
    
    // Build info row
    let infoItems = [];
    if (t.number) infoItems.push(`<span class="trailer-number">${t.number}</span>`);
    if (t.loadNumber) infoItems.push(`<span class="trailer-load-number">Load: ${t.loadNumber}</span>`);
    const infoRow = infoItems.length > 0 ? `<div class="yard-trailer-info">${infoItems.join('')}</div>` : '';
    
    const customerRow = t.customer ? `<div class="yard-trailer-customer">${t.customer}</div>` : '';
    const driverRow = t.driverName ? `<div class="yard-trailer-driver">${t.driverName}</div>` : '';
    
    // Appointment Time Display
    let apptTimeHtml = '';
    if (t.appointmentTime) {
      // If input is time, value is HH:MM
      const [hours, mins] = t.appointmentTime.split(':');
      const timeObj = new Date();
      timeObj.setHours(hours);
      timeObj.setMinutes(mins);
      const timeStr = timeObj.toLocaleTimeString([], {hour: 'numeric', minute:'2-digit'});
      apptTimeHtml = `<div class="yard-trailer-appt" style="font-size:0.7rem;color:#a5b4fc;text-align:center;font-weight:600;margin-top:2px;">🕒 ${timeStr}</div>`;
    }

    const phoneHtml = t.driverPhone ? `<span style="margin-left:auto;font-size:0.7rem;opacity:0.9;">📞 ${formatPhoneNumber(t.driverPhone)}</span>` : '';

    return `
      <div class="yard-trailer ${statusClass} ${searchClass} ${liveClass}" 
           draggable="true" 
           data-trailer-id="${t.id}"
           data-location="appointment-queue">
        <div class="yard-trailer-header">
          <span class="trailer-carrier">${t.carrier}</span>
          <span class="yard-status-badge ${statusClass}">${statusText}</span>
          <span class="queued-badge">#${index + 1}</span>
        </div>
        ${customerRow}
        ${driverRow}
        ${infoRow}
        ${apptTimeHtml}
        <div class="target-door-badge appt-badge" style="background:#6366f1;display:flex;justify-content:space-between;align-items:center;">
            <span>📅 Appt Pending</span>
            ${phoneHtml}
        </div>
      </div>
    `;
  }).join('');
  
  // Add drag handlers
  setupAppointmentQueueDragAndDrop(container);
  
  container.querySelectorAll('.yard-trailer').forEach(el => {
    // Only attach standard dragstart if setupAppointmentQueueDragAndDrop relies on it
    // setupAppointmentQueueDragAndDrop now uses global drag state, so we need this
    el.addEventListener('dragstart', handleDragStart);
    el.addEventListener('dragend', handleDragEnd);
    el.addEventListener('dblclick', () => openTrailerEditModal(el.dataset.trailerId));
  });
}

function renderYardSlots() {
  const list = document.getElementById('yard-slots-list');
  const count = document.getElementById('yard-count');
  if (!list) return;

  // Use yardSlots directly (independent from doors now)
  const slots = state.yardSlots?.sort((a, b) => (a.order || a.number) - (b.order || b.number)) || [];

  // Count trailers in yard slots
  const trailersInSlots = slots.filter(s => s.trailerId).length;
  if (count) count.textContent = `${trailersInSlots}`;

  // Generate slots
  let html = slots.map(slot => {
    const slotNumber = slot.number;
    const trailer = slot.trailerId ? 
      state.trailers.find(t => t.id === slot.trailerId && t.location !== 'shipped') || 
      state.yardTrailers.find(t => t.id === slot.trailerId && t.location !== 'shipped') : null;
    
    // Search match
    let searchClass = '';
    if (searchQuery && trailer) {
      if (isTrailerInSearchResults(trailer.id)) {
        searchClass = 'search-match';
      } else {
        searchClass = 'search-mismatch';
      }
    } else if (searchQuery && !trailer) {
      searchClass = 'search-mismatch';
    }
    
    // Determine highlight state for carrier filter
    let highlightClass = '';
    if (activeCarrierFilter && trailer) {
      if (trailer.carrier === activeCarrierFilter) {
        highlightClass = 'highlighted';
      } else {
        highlightClass = 'dimmed';
      }
    } else if (activeCarrierFilter && !trailer) {
      highlightClass = 'dimmed';
    }
    
    // Selection state
    const selectedClass = trailer && selectedTrailers.has(trailer.id) ? 'selected' : '';
    
    if (trailer) {
      const statusText = trailer.status === 'loaded' ? 'LOADED' : 'EMPTY';
      const statusClass = trailer.status === 'loaded' ? 'loaded' : 'empty';
      const liveClass = (trailer.isLive === true || trailer.isLive === 'true') ? 'is-live' : '';
      return `
        <div class="yard-slot occupied ${trailer.status} ${highlightClass} ${liveClass} ${editMode ? 'slot-draggable' : ''}" data-slot="${slotNumber}" data-slot-id="${slot.id || ''}" ${editMode ? 'draggable="true"' : ''}>
          <div class="yard-slot-number">${slotNumber}</div>
          <div class="slot-content">
            <div class="slot-trailer-row slot-customer-row">${trailer.customer || ''}</div>
            <div class="slot-trailer-row slot-driver-row">${trailer.driverName || ''}</div>
            <div class="slot-trailer-row">
              <span class="trailer-carrier">${trailer.carrier}</span>
              <span class="yard-slot-status ${statusClass}" data-trailer-id="${trailer.id}">${statusText}</span>
            </div>
            <div class="trailer-number-row">${trailer.number ? trailer.number : ''}${trailer.loadNumber ? ` • ${trailer.loadNumber}` : ''}</div>
          </div>
          <div class="slot-actions">
            ${editMode ? `<button class="delete-trailer-btn" data-trailer-id="${trailer.id}" title="Delete trailer">🗑️</button>` : ''}
            ${editMode ? `<button class="slot-edit-btn" data-slot-id="${slot.id}" title="Edit slot">⚙️</button>` : ''}
          </div>
        </div>
      `;
    } else {
      return `
        <div class="yard-slot empty ${highlightClass} ${searchClass} ${editMode ? 'slot-draggable' : ''}" data-slot="${slotNumber}" data-slot-id="${slot.id}" ${editMode ? 'draggable="true"' : ''}>
          <div class="yard-slot-number">${slotNumber}</div>
          <div class="slot-content">
            <span class="slot-empty-text">Empty - Available</span>
          </div>
          ${editMode ? `<div class="slot-actions"><button class="slot-edit-btn" data-slot-id="${slot.id}" title="Edit slot">⚙️</button></div>` : ''}
        </div>
      `;
    }
  }).join('');
  
  // Add "Add Yard Slot" button in edit mode
  if (editMode) {
    html += `
      <div class="yard-slot add-slot-card" id="btn-add-yard-slot" style="border:2px dashed var(--accent-primary);background:var(--bg-secondary);cursor:pointer;">
        <div class="slot-content" style="display:flex;align-items:center;justify-content:center;height:100%;">
          <span style="font-size:1.5rem;color:var(--accent-primary);">+ Add Slot</span>
        </div>
      </div>
    `;
  }
  
  list.innerHTML = html;

  // Add drag and click listeners to occupied slots
  list.querySelectorAll('.yard-slot.occupied').forEach(slot => {
    const trailerId = slot.querySelector('.yard-slot-status')?.dataset.trailerId;
    const trailer = state.trailers.find(t => t.id === trailerId) || 
                    state.yardTrailers.find(t => t.id === trailerId);
    slot.setAttribute('draggable', 'true');
    slot.dataset.trailerId = trailerId;
    slot.style.cursor = 'pointer';
    
    // Click for selection
    slot.addEventListener('click', (e) => {
      if (!e.target.closest('.delete-trailer-btn') && !e.target.closest('.yard-slot-status')) {
        // We must pass the event 'e'
        toggleTrailerSelection(trailerId, e);
      }
    });
    
    // Double-click status badge to toggle
    const statusBadge = slot.querySelector('.yard-slot-status');
    if (statusBadge) {
      statusBadge.addEventListener('dblclick', async (e) => {
        e.stopPropagation();
        if (!trailer) return;
        
        const newStatus = trailer.status === 'loaded' ? 'empty' : 'loaded';
        try {
          await updateTrailer(trailerId, { status: newStatus });
          showToast(`Status changed to ${newStatus === 'loaded' ? '📦 Loaded' : '📭 Empty'}`, 'success');
          fetchState();
        } catch (error) {
          showToast(error.message, 'error');
        }
      });
    }
    
    // Double-click slot to edit (not on status badge or delete button)
    slot.addEventListener('dblclick', (e) => {
      if (!e.target.closest('.delete-trailer-btn') && 
          !e.target.closest('.yard-slot-status')) {
        openTrailerEditModal(trailerId);
      }
    });
    
    // Drag handlers
    slot.addEventListener('dragstart', (e) => {
      if (trailerId) {
        draggedTrailerId = trailerId;
        e.dataTransfer.setData('text/plain', trailerId);
        slot.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      }
    });
    slot.addEventListener('dragend', (e) => {
      slot.classList.remove('dragging');
      draggedTrailerId = null;
      document.querySelectorAll('.drop-hover').forEach(el => el.classList.remove('drop-hover'));
    });
    
    if (selectedTrailers.has(trailerId)) {
      slot.classList.add('selected');
    }
  });

  // Add drop zone events to empty slots
  list.querySelectorAll('.yard-slot.empty').forEach(slot => {
    slot.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      slot.classList.add('drop-hover');
    });
    slot.addEventListener('dragleave', () => {
      slot.classList.remove('drop-hover');
    });
    slot.addEventListener('drop', async (e) => {
      e.preventDefault();
      slot.classList.remove('drop-hover');
      const trailerId = e.dataTransfer.getData('text/plain');
      if (!trailerId) return;

      const slotNum = parseInt(slot.dataset.slot);
      
      // Record position before move for undo
      const fromPos = getCurrentTrailerPosition(trailerId);
      
      let yardSlot = state.yardSlots.find(s => s.number === slotNum);
      if (!yardSlot) {
        try {
          const result = await createYardSlot({ number: slotNum });
          yardSlot = result.slot;
        } catch (error) {
          showToast('Failed to create yard slot', 'error');
          return;
        }
      }
      
      try {
        await moveToYardSlot(trailerId, yardSlot.id);
        recordLastAction('moveToSlot', trailerId, fromPos, { slotNum });
        showToast(`Moved to Yard Spot ${slotNum}`, 'success');
        fetchState();
      } catch (error) {
        showToast(error.message, 'error');
      }
    });
  });

  // Trailer delete buttons in slots
  list.querySelectorAll('.delete-trailer-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const trailerId = btn.dataset.trailerId;
      const trailer = state.trailers.find(t => t.id === trailerId) ||
                     state.yardTrailers.find(t => t.id === trailerId) ||
                     state.appointmentQueue?.find(t => t.id === trailerId);
      if (!trailer) return;

      if (!confirm(`Delete trailer ${trailer.number} (${trailer.carrier})?\n\nThis will permanently remove it.`)) {
        return;
      }

      if (selectedTrailers.has(trailerId)) {
        selectedTrailers.delete(trailerId);
      }

      try {
        await deleteTrailer(trailerId);
        showToast('Trailer deleted', 'success');
        fetchState();
      } catch (error) {
        showToast(error.message, 'error');
      }
    });
  });
  
  // Slot edit buttons (edit mode only)
  if (editMode) {
    list.querySelectorAll('.slot-edit-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const slotId = btn.dataset.slotId;
        const slot = state.yardSlots.find(s => s.id === slotId);
        if (slot) openEditYardSlotModal(slot);
      });
    });
    
    // Add slot button
    document.getElementById('btn-add-yard-slot')?.addEventListener('click', () => {
      openAddYardSlotModal();
    });
    
    // Setup slot drag-and-drop for reordering
    setupYardSlotDragAndDrop(list);
  }
}

function getCurrentTrailerPosition(trailerId) {
  const trailer = state.trailers.find(t => t.id === trailerId) ||
                  state.yardTrailers.find(t => t.id === trailerId) ||
                  state.appointmentQueue?.find(t => t.id === trailerId);
  if (!trailer) return { doorNum: null, slotNum: null, unassigned: true };
  
  if (trailer.doorNumber) return { doorNum: trailer.doorNumber, slotNum: null, unassigned: false };
  if (trailer.yardSlotNumber) return { doorNum: null, slotNum: trailer.yardSlotNumber, unassigned: false };
  if (trailer.location === 'appointment-queue') return { doorNum: null, slotNum: null, unassigned: true, isApptQueue: true };
  return { doorNum: null, slotNum: null, unassigned: true };
}

// Yard Slot Management Functions
async function createYardSlot(data) { return apiCall('/yard-slots', 'POST', data); }
async function updateYardSlot(slotId, data) { return apiCall(`/yard-slots/${slotId}`, 'PUT', data); }
async function deleteYardSlot(slotId) { return apiCall(`/yard-slots/${slotId}`, 'DELETE'); }
async function reorderYardSlots(slotIds) { return apiCall('/yard-slots/reorder', 'POST', { slotIds }); }

function openAddYardSlotModal() {
  const modal = document.createElement('div');
  modal.id = 'modal-add-yard-slot';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content" style="max-width:400px;">
      <div class="modal-header">
        <h3>➕ Add Yard Slot</h3>
        <button class="close-modal">&times;</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label>Slot Number</label>
          <input type="number" id="new-slot-number" placeholder="e.g., 31" min="1" max="999" style="width:100%;">
        </div>
        <div class="modal-actions">
          <button id="btn-create-slot" class="btn btn-success">Create Slot</button>
          <button class="btn btn-secondary close-modal">Cancel</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  openModal('modal-add-yard-slot');
  
  // Focus input
  setTimeout(() => document.getElementById('new-slot-number')?.focus(), 100);
  
  // Event handlers
  modal.querySelectorAll('.close-modal').forEach(btn => {
    btn.addEventListener('click', () => { modal.remove(); });
  });
  
  document.getElementById('btn-create-slot')?.addEventListener('click', async () => {
    const number = parseInt(document.getElementById('new-slot-number').value);
    if (!number || number < 1) {
      showToast('Please enter a valid slot number', 'warning');
      return;
    }
    // Check if slot already exists
    if (state.yardSlots.find(s => s.number === number)) {
      showToast(`Slot ${number} already exists`, 'warning');
      return;
    }
    try {
      await createYardSlot({ number });
      showToast(`Yard slot ${number} created`, 'success');
      modal.remove();
      fetchState();
    } catch (e) {
      showToast(e.message, 'error');
    }
  });
}

function openEditYardSlotModal(slot) {
  const modal = document.createElement('div');
  modal.id = 'modal-edit-yard-slot';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content" style="max-width:400px;">
      <div class="modal-header">
        <h3>⚙️ Edit Yard Slot ${slot.number}</h3>
        <button class="close-modal">&times;</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label>New Slot Number</label>
          <input type="number" id="edit-slot-number" value="${slot.number}" min="1" max="999" style="width:100%;">
        </div>
        <div class="modal-actions">
          <button id="btn-update-slot" class="btn btn-success">Update</button>
          <button id="btn-delete-slot" class="btn btn-danger">🗑️ Delete Slot</button>
          <button class="btn btn-secondary close-modal">Cancel</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  openModal('modal-edit-yard-slot');
  
  modal.querySelectorAll('.close-modal').forEach(btn => {
    btn.addEventListener('click', () => { modal.remove(); });
  });
  
  document.getElementById('btn-update-slot')?.addEventListener('click', async () => {
    const newNumber = parseInt(document.getElementById('edit-slot-number').value);
    if (!newNumber || newNumber < 1) {
      showToast('Please enter a valid slot number', 'warning');
      return;
    }
    if (newNumber !== slot.number && state.yardSlots.find(s => s.number === newNumber)) {
      showToast(`Slot ${newNumber} already exists`, 'warning');
      return;
    }
    try {
      await updateYardSlot(slot.id, { number: newNumber });
      showToast(`Slot updated to ${newNumber}`, 'success');
      modal.remove();
      fetchState();
    } catch (e) {
      showToast(e.message, 'error');
    }
  });
  
  document.getElementById('btn-delete-slot')?.addEventListener('click', async () => {
    if (!confirm(`Delete yard slot ${slot.number}?\n\nAny trailers in this slot will be moved to unassigned yard.`)) return;
    try {
      await deleteYardSlot(slot.id);
      showToast(`Slot ${slot.number} deleted`, 'success');
      modal.remove();
      fetchState();
    } catch (e) {
      showToast(e.message, 'error');
    }
  });
}

let draggedSlotId = null;
function setupYardSlotDragAndDrop(list) {
  const slots = list.querySelectorAll('.slot-draggable');
  
  slots.forEach(slot => {
    slot.addEventListener('dragstart', (e) => {
      draggedSlotId = slot.dataset.slotId;
      slot.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', draggedSlotId);
    });
    
    slot.addEventListener('dragend', () => {
      slot.classList.remove('dragging');
      draggedSlotId = null;
      list.querySelectorAll('.drag-over').forEach(d => d.classList.remove('drag-over'));
    });
    
    slot.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (draggedSlotId && draggedSlotId !== slot.dataset.slotId) {
        slot.classList.add('drag-over');
      }
    });
    
    slot.addEventListener('dragleave', () => {
      slot.classList.remove('drag-over');
    });
    
    slot.addEventListener('drop', async (e) => {
      e.preventDefault();
      slot.classList.remove('drag-over');
      const sourceId = e.dataTransfer.getData('text/plain');
      const targetId = slot.dataset.slotId;
      
      if (!sourceId || sourceId === targetId) return;
      
      // Get current order of slots
      const slotIds = Array.from(list.querySelectorAll('.slot-draggable')).map(s => s.dataset.slotId);
      // Move source to position before target
      const sourceIdx = slotIds.indexOf(sourceId);
      const targetIdx = slotIds.indexOf(targetId);
      if (sourceIdx > -1 && targetIdx > -1) {
        slotIds.splice(sourceIdx, 1);
        slotIds.splice(targetIdx, 0, sourceId);
        try {
          await reorderYardSlots(slotIds);
          showToast('Slots reordered', 'success');
          fetchState();
        } catch (err) {
          showToast('Failed to reorder', 'error');
        }
      }
    });
  });
}

function renderUnassignedYard() {
  const yard = document.getElementById('yard-area');
  const unassignedCount = document.getElementById('unassigned-count');
  // Filter out shipped trailers
  const activeTrailers = state.yardTrailers.filter(t => t.location !== 'shipped');
  if (unassignedCount) unassignedCount.textContent = activeTrailers.length;
  if (!yard) return;

  if (activeTrailers.length === 0) {
    yard.innerHTML = '<div class="yard-placeholder">Drop unassigned trailers here</div>';
  } else {
    yard.innerHTML = activeTrailers.map(t => {
      // Search match
      let searchClass = '';
      if (searchQuery) {
        if (isTrailerInSearchResults(t.id)) {
          searchClass = 'search-match';
        } else {
          searchClass = 'search-mismatch';
        }
      }
      
      // Determine highlight state for carrier filter
      let highlightClass = '';
      if (activeCarrierFilter) {
        if (t.carrier === activeCarrierFilter) {
          highlightClass = 'highlighted';
        } else {
          highlightClass = 'dimmed';
        }
      }
      
      // Selection state
      const selectedClass = selectedTrailers.has(t.id) ? 'selected' : '';
      
      const statusText = t.status === 'loaded' ? 'LOADED' : 'EMPTY';
      const statusClass = t.status === 'loaded' ? 'loaded' : 'empty';
      const liveClass = (t.isLive === true || t.isLive === 'true') ? 'is-live' : '';
      
      // Build info row with trailer number, load number (no dwell time in yard)
      let infoRow = '';
      if (t.number) infoRow += `<span class="trailer-number">${t.number}</span>`;
      if (t.loadNumber) infoRow += `<span class="trailer-load-number">${t.loadNumber}</span>`;
      
      return `
        <div class="yard-trailer ${t.status} ${highlightClass} ${searchClass} ${selectedClass} ${liveClass}" draggable="true" data-trailer-id="${t.id}">
          <div class="yard-trailer-customer">${t.customer || ''}</div>
          <div class="yard-trailer-header">
            <span class="trailer-carrier">${t.carrier}</span>
            <span class="yard-status-badge ${statusClass}" data-trailer-id="${t.id}">${statusText}</span>
            ${editMode ? `<button class="delete-trailer-btn" data-trailer-id="${t.id}" title="Delete trailer">🗑️</button>` : ''}
          </div>
          ${infoRow ? `<div class="yard-trailer-info">${infoRow}</div>` : ''}
        </div>
      `;
    }).join('');
    
    // Add drag handlers to unassigned yard trailers
    yard.querySelectorAll('.yard-trailer[draggable]').forEach(el => {
      el.addEventListener('dragstart', handleDragStart);
      el.addEventListener('dragend', handleDragEnd);
      el.addEventListener('click', (e) => {
        // Selection
        if (!e.target.closest('.delete-trailer-btn') && !e.target.closest('.yard-status-badge')) {
          // We must pass the event 'e'
          toggleTrailerSelection(el.dataset.trailerId, e);
        }
      });
    });
    
    // Double-click status badge to toggle
    yard.querySelectorAll('.yard-status-badge').forEach(badge => {
      badge.style.cursor = 'pointer';
      badge.addEventListener('dblclick', async (e) => {
        e.stopPropagation();
        const trailerId = badge.dataset.trailerId;
        const trailer = state.yardTrailers.find(t => t.id === trailerId);
        if (!trailer) return;
        
        const newStatus = trailer.status === 'loaded' ? 'empty' : 'loaded';
        try {
          await updateTrailer(trailerId, { status: newStatus });
          showToast(`Status changed to ${newStatus === 'loaded' ? '📦 Loaded' : '📭 Empty'}`, 'success');
          fetchState();
        } catch (error) {
          showToast(error.message, 'error');
        }
      });
    });
    
    // Double-click trailer to edit
    yard.querySelectorAll('.yard-trailer').forEach(el => {
      el.style.cursor = 'pointer';
      el.addEventListener('dblclick', (e) => {
        if (!e.target.closest('.delete-trailer-btn') && 
            !e.target.closest('.yard-status-badge')) {
          openTrailerEditModal(el.dataset.trailerId);
        }
      });
    });
    
    // Trailer delete buttons
    yard.querySelectorAll('.delete-trailer-btn').forEach(btn => {
      if (btn._handlerAttached) return;
      btn._handlerAttached = true;
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const trailerId = btn.dataset.trailerId;
        const trailer = state.yardTrailers.find(t => t.id === trailerId) ||
                        state.appointmentQueue?.find(t => t.id === trailerId);
        if (!trailer) return;
        
        if (!confirm(`Delete trailer ${trailer.number} (${trailer.carrier})?\n\nThis will permanently remove it.`)) {
          return;
        }
        
        if (selectedTrailers.has(trailerId)) {
          selectedTrailers.delete(trailerId);
        }
        
        try {
          await deleteTrailer(trailerId);
          showToast('Trailer deleted', 'success');
          fetchState();
        } catch (error) {
          showToast(error.message, 'error');
        }
      });
    });
  }
}

function updateStats() {
  const occupied = state.trailers.filter(t => t.doorNumber).length;
  // Count only doors that are in service and not blank
  const activeDoors = state.doors.filter(d => d.inService !== false && d.type !== 'blank').length;
  
  const occupiedCount = document.getElementById('occupied-count');
  const lastUpdate = document.getElementById('last-update');
  
  if (occupiedCount) occupiedCount.textContent = `Occupied: ${occupied}/${activeDoors}`;
  if (lastUpdate) lastUpdate.textContent = `Updated: ${new Date().toLocaleTimeString()}`;
}

function renderCarrierSelect() {
  const select = document.getElementById('carrier-select');
  if (!select) return;
  
  const favorites = state.carriers.filter(c => c.favorite).sort((a,b) => a.name.localeCompare(b.name));
  const others = state.carriers.filter(c => !c.favorite).sort((a,b) => a.name.localeCompare(b.name));
  
  let html = '<option value="">Select a carrier...</option>';
  
  if (favorites.length > 0) {
    html += '<optgroup label="⭐ Favorites">';
    favorites.forEach(c => html += `<option value="${c.name}">${c.name}</option>`);
    html += '</optgroup>';
  }
  
  if (others.length > 0) {
    html += '<optgroup label="All Carriers">';
    others.forEach(c => html += `<option value="${c.name}">${c.name}</option>`);
    html += '</optgroup>';
  }
  
  select.innerHTML = html;
}

// ============================================================================
// Carrier Summary Bar & Filtering
// ============================================================================

let activeCarrierFilter = null;

function renderCarrierSummary() {
  const container = document.getElementById('carrier-list');
  if (!container) return;
  
  // Get ALL trailers by carrier (dock + yard slots + unassigned)
  const carrierLocations = {};
  
  // Docked trailers
  state.trailers.forEach(t => {
    if (t.doorNumber) {
      if (!carrierLocations[t.carrier]) carrierLocations[t.carrier] = { doors: [], yardSlots: [], unassigned: 0 };
      carrierLocations[t.carrier].doors.push({ num: t.doorNumber, status: t.status });
    }
  });
  
  // Yard slot trailers
  state.yardSlots.forEach(slot => {
    if (slot.trailerId) {
      const trailer = state.trailers.find(t => t.id === slot.trailerId) || 
                      state.yardTrailers.find(t => t.id === slot.trailerId);
      if (trailer) {
        if (!carrierLocations[trailer.carrier]) carrierLocations[trailer.carrier] = { doors: [], yardSlots: [], unassigned: 0 };
        carrierLocations[trailer.carrier].yardSlots.push({ num: slot.number, status: trailer.status });
      }
    }
  });
  
  // Unassigned yard trailers
  state.yardTrailers.forEach(t => {
    if (!carrierLocations[t.carrier]) carrierLocations[t.carrier] = { doors: [], yardSlots: [], unassigned: 0 };
    carrierLocations[t.carrier].unassigned++;
  });
  
  const carriers = Object.keys(carrierLocations).sort();
  
  if (carriers.length === 0) {
    container.innerHTML = '<span class="no-carriers">No trailers</span>';
    return;
  }
  
  container.innerHTML = carriers.map(carrier => {
    const loc = carrierLocations[carrier];
    const isActive = activeCarrierFilter === carrier;
    
    // Build location text with status-colored numbers
    const parts = [];
    if (loc.doors.length > 0) {
      const doorText = loc.doors.sort((a,b) => a.num - b.num)
        .map(d => `<span class="loc-num ${d.status}">${d.num}</span>`).join(', ');
      parts.push(`Doors ${doorText}`);
    }
    if (loc.yardSlots.length > 0) {
      const yardText = loc.yardSlots.sort((a,b) => a.num - b.num)
        .map(s => `<span class="loc-num ${s.status}">Y${s.num}</span>`).join(', ');
      parts.push(`Yard ${yardText}`);
    }
    if (loc.unassigned > 0) {
      parts.push(`Unassigned ×${loc.unassigned}`);
    }
    
    return `
      <span class="carrier-summary-item ${isActive ? 'active' : ''}" data-carrier="${carrier}">
        <span class="carrier-name">${carrier}</span>
        <span class="location-list">${parts.join(' • ')}</span>
      </span>
    `;
  }).join('');
  
  // Add click handlers for filtering
  container.querySelectorAll('.carrier-summary-item').forEach(item => {
    item.addEventListener('click', () => {
      const carrier = item.dataset.carrier;
      if (activeCarrierFilter === carrier) {
        activeCarrierFilter = null;
      } else {
        activeCarrierFilter = carrier;
      }
      renderDoors();
      renderYardSlots();
      renderUnassignedYard();
      renderCarrierSummary();
      if (activeCarrierFilter) {
        const loc = carrierLocations[carrier];
        const total = loc.doors.length + loc.yardSlots.length + loc.unassigned;
        showToast(`${carrier}: ${total} trailer${total > 1 ? 's' : ''} found`, 'info');
      }
    });
  });
}

// ============================================================================
// Drag and Drop
// ============================================================================

let draggedTrailerId = null;
let draggedSourceLocation = null; // 'staging', 'queue', or null (yard/door)

function handleDragStart(e) {
  const el = e.target.closest('.yard-trailer, .trailer-card');
  draggedTrailerId = el?.dataset.trailerId;
  draggedSourceLocation = el?.dataset.location; // 'staging', 'queue', 'door-X'
  e.dataTransfer.setData('text/plain', draggedTrailerId);
  e.dataTransfer.setData('source-location', draggedSourceLocation || '');
  el?.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  console.log('Dragging trailer:', draggedTrailerId, 'from:', draggedSourceLocation);
}

function handleDragEnd(e) {
  const el = e.target.closest('.yard-trailer, .trailer-card');
  el?.classList.remove('dragging');
  console.log('Drag ended, keeping vars for drop handler');
  // Don't clear draggedTrailerId/draggedSourceLocation here - 
  // handleDrop needs them. They'll be cleared on next dragStart.
  document.querySelectorAll('.drop-hover').forEach(el => el.classList.remove('drop-hover'));
}

function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const door = e.target.closest('.dock-door');
  if (door) {
    // Allow drop on both empty and occupied doors (for queue creation)
    const sourceLoc = draggedSourceLocation;
    const isFromStaging = sourceLoc === 'staging';
    const isFromQueue = sourceLoc === 'queue';
    const isFromApptQueue = sourceLoc === 'appointment-queue';
    
    // Highlight: allow on empty (always), or occupied (only from staging/queue)
    if (!door.classList.contains('occupied') || isFromStaging || isFromQueue || isFromApptQueue) {
      door.classList.add('drop-hover');
    }
  }
}

function handleDragLeave(e) {
  const door = e.target.closest('.dock-door');
  if (door) door.classList.remove('drop-hover');
  const yard = e.target.closest('#yard-area');
  if (yard) yard.classList.remove('drop-hover');
}

async function handleDrop(e) {
  e.preventDefault();
  const door = e.target.closest('.dock-door');
  if (!door) return;
  
  door.classList.remove('drop-hover');
  
  const doorId = door.dataset.doorId || door.dataset.door;
  const doorNum = parseInt(door.dataset.door);
  const trailerId = e.dataTransfer.getData('text/plain') || draggedTrailerId;
  // Use the global variable since dataTransfer.getData can be unreliable across elements
  const sourceLoc = draggedSourceLocation;
  
  console.log('handleDrop debug:', {trailerId, sourceLoc, doorNum, doorId, occupied: door.classList.contains('occupied')});
  
  // Handle selected trailers if no drag data (using Shift+Click selection)
  if (!trailerId && selectedTrailers.size > 0) {
    const firstTrailer = Array.from(selectedTrailers)[0];
    const fromPos = getCurrentTrailerPosition(firstTrailer);
    
    try {
      await moveToDoor(firstTrailer, doorNum);
      recordLastAction('moveToDoor', firstTrailer, fromPos, { doorNum });
      showToast(`Moved to Door ${doorNum}`, 'success');
      if (selectedTrailers.size > 1) {
        showToast(`Note: Only moved one trailer. Use bulk move for multiple.`, 'warning');
      }
      clearSelection();
      await fetchState();
    } catch (error) {
      showToast(error.message, 'error');
    }
    return;
  }
  
  if (!trailerId) return;
  
  // Check if this is staging/queue drag to occupied door (queue creation)
  if (door.classList.contains('occupied')) {
    console.log('Door occupied check - sourceLoc:', sourceLoc);
    if (sourceLoc === 'staging' || sourceLoc === 'appointment-queue') {
      // Move from staging or appointment queue to queue for this door
      try {
        await apiCall('/queue', 'POST', { 
          trailerId, 
          targetDoorId: doorId, 
          targetDoorNumber: doorNum 
        });
        showToast(`Added to queue for Door ${doorNum}`, 'success');
        await fetchState();
      } catch (error) {
        showToast(error.message || 'Failed to queue trailer', 'error');
      }
      return;
    } else if (sourceLoc === 'queue') {
      showToast('Trailer is already queued for a door', 'warning');
      return;
    } else {
      showToast('Door is already occupied!', 'error');
      return;
    }
  }
  
  // Door is empty - handle assignment
  if (sourceLoc === 'queue') {
    // Move from queue to door (cancels queue, assigns to new door)
    try {
      await moveToDoor(trailerId, doorNum);
      showToast(`Moved from queue to Door ${doorNum}`, 'success');
      await fetchState();
    } catch (error) {
      showToast(error.message, 'error');
    }
    return;
  }
  
  // Record position before move for undo
  const fromPos = getCurrentTrailerPosition(trailerId);
  
  try {
    await moveToDoor(trailerId, doorNum);
    recordLastAction('moveToDoor', trailerId, fromPos, { doorNum });
    showToast(`Moved to Door ${doorNum}`, 'success');
    await fetchState();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function handleDropToAppointmentQueue(e) {
  e.preventDefault();
  e.currentTarget.classList.remove('drop-hover');
  
  const trailerId = e.dataTransfer.getData('text/plain') || draggedTrailerId;
  const sourceLoc = e.dataTransfer.getData('source-location') || draggedSourceLocation;
  
  if (!trailerId) return;
  
  if (sourceLoc !== 'staging') {
    showToast('Can only move to Appointment Queue from Staging', 'warning');
    return;
  }
  
  try {
    await apiCall('/appointment-queue', 'POST', { trailerId });
    showToast('Added to Appointment Queue', 'success');
    await fetchState();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function handleDropToYard(e) {
  e.preventDefault();
  console.log('Drop to yard, trailerId:', draggedTrailerId);
  e.currentTarget.classList.remove('drop-hover');
  
  const trailerId = e.dataTransfer.getData('text/plain') || draggedTrailerId;
  if (!trailerId) {
    console.log('No trailer ID, aborting');
    return;
  }
  
  // Find which door this trailer is in
  const trailer = state.trailers.find(t => t.id === trailerId);
  const doorId = trailer?.doorNumber;
  
  // Record position before move for undo
  const fromPos = getCurrentTrailerPosition(trailerId);
  
  try {
    await moveToYard(trailerId, doorId);
    recordLastAction('moveToYard', trailerId, fromPos, { unassigned: true });
    showToast('Moved to yard', 'success');
    await fetchState();
    
    // After moving out, check for queued trailers and auto-assign
    if (doorId) {
      await checkAndAssignQueue(doorId, doorNum);
    }
  } catch (error) {
    showToast(error.message, 'error');
  }
}

// Auto-assign next trailer from queue to a freed door
async function checkAndAssignQueue(doorId, doorNum) {
  // Check if there are trailers queued for this door
  const queuedForDoor = state.queuedTrailers?.filter(t => t.targetDoorId === doorId);
  if (!queuedForDoor || queuedForDoor.length === 0) return;
  
  // Get first in queue (FCFS)
  const nextTrailer = queuedForDoor[0];
  
  try {
    // Assign next trailer to the door
    await apiCall(`/doors/${doorId}/assign-next`, 'POST', {});
    showToast(`Door ${doorNum}: Assigned ${nextTrailer.carrier} from queue`, 'success');
    await fetchState();
  } catch (error) {
    console.error('Auto-assign failed:', error);
  }
}

// ============================================================================
// Modal Handling
// ============================================================================

function openModal(id) {
  const modal = document.getElementById(id);
  if (modal) {
    modal.style.display = 'flex';
    modal.classList.add('active');
  }
}

function closeModal(id) {
  const modal = document.getElementById(id);
  if (modal) {
    modal.style.display = 'none';
    modal.classList.remove('active');
  }
}

function setupModals() {
  // Close buttons
  document.querySelectorAll('.close-modal, .modal-close, .modal-cancel').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const modal = e.target.closest('.modal');
      if (modal) closeModal(modal.id);
    });
  });

  // Backdrop click
  document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal(modal.id);
    });
  });

  // Main buttons
  document.getElementById('btn-create-trailer')?.addEventListener('click', () => {
    document.getElementById('quick-add-panel')?.classList.remove('hidden');
    document.getElementById('form-create-trailer')?.classList.add('hidden');
    renderQuickCarrierButtons();
    document.getElementById('form-create-trailer').dataset.targetStaging = '';
    openModal('modal-create');
  });
  
  // Quick Add for Staging
  window.openQuickAddForStaging = function() {
    if (state.staging) {
      showToast('Staging slot already occupied', 'warning');
      return;
    }
    
    const quickAddPanel = document.getElementById('quick-add-panel');
    const form = document.getElementById('form-create-trailer');
    
    quickAddPanel?.classList.remove('hidden');
    form?.classList.add('hidden');
    
    // Set target to staging mode
    form.dataset.targetStaging = 'true';
    delete form.dataset.targetDoor;
    
    // Update the hint text
    const hintText = quickAddPanel?.querySelector('.quick-add-hint');
    if (hintText) {
      hintText.innerHTML = 'Click a carrier to instantly add trailer to <strong>⭐ Staging</strong>';
    }
    
    renderQuickCarrierButtons();
    openModal('modal-create');
  };
  
  // Undo button
  document.getElementById('btn-undo')?.addEventListener('click', () => {
    undoLastAction();
  });
  
  // Clear search button
  document.getElementById('btn-clear-search')?.addEventListener('click', () => {
    clearSearch();
  });
  
  // Show/hide clear button based on search input
  const searchInput = document.getElementById('search-input');
  const clearBtn = document.getElementById('btn-clear-search');
  if (searchInput && clearBtn) {
    searchInput.addEventListener('input', (e) => {
      if (e.target.value) {
        clearBtn.classList.remove('hidden');
      } else {
        clearBtn.classList.add('hidden');
      }
    });
  }
  
  // Bulk move to yard
  document.getElementById('btn-bulk-move-to-yard')?.addEventListener('click', () => {
    bulkMoveToYard();
  });
  
  // Bulk ship
  document.getElementById('btn-bulk-ship')?.addEventListener('click', () => {
    bulkShipTrailers();
  });
  
  // Bulk delete
  document.getElementById('btn-bulk-delete')?.addEventListener('click', () => {
    bulkDeleteTrailers();
  });
  
  // Clear selection
  document.getElementById('btn-clear-selection')?.addEventListener('click', () => {
    clearSelection();
  });

  // Quick Add Toggle
  document.getElementById('btn-show-full-form')?.addEventListener('click', () => {
    document.getElementById('quick-add-panel')?.classList.add('hidden');
    document.getElementById('form-create-trailer')?.classList.remove('hidden');
    document.getElementById('carrier-input').focus();
  });
  
  document.getElementById('btn-cancel-full')?.addEventListener('click', () => {
    document.getElementById('form-create-trailer')?.classList.add('hidden');
    document.getElementById('quick-add-panel')?.classList.remove('hidden');
    renderQuickCarrierButtons();
  });

  // Quick Add Custom Carrier
  document.getElementById('btn-quick-add')?.addEventListener('click', async () => {
    const carrierInput = document.getElementById('quick-carrier-input');
    const form = document.getElementById('form-create-trailer');
    const targetDoor = form?.dataset.targetDoor;
    const targetStaging = form?.dataset.targetStaging === 'true';
    const isLive = document.getElementById('quick-add-live')?.checked || false;
    
    const carrier = carrierInput?.value.trim();
    if (!carrier) {
      showToast('Please enter a carrier name', 'warning');
      return;
    }

    try {
      if (targetStaging) {
        // Add directly to staging
        // We'll pass through the appointmentTime if user filled it in the custom flow?
        // Wait, quick add doesn't have appt time field in the quick panel.
        // It's only in the full form.
        // So for quick-add button (custom carrier), we don't have it.
        // But for full form submit, we do. This handler is for the quick add button.
        await addToStaging({ carrier, status: 'empty', isLive });
        showToast(`✅ ${carrier} trailer added to Staging!`, 'success');
      } else {
        // Original logic for doors/yard
        const result = await createTrailer({
          carrier: carrier,
          status: 'empty',
          isLive
        });
        
        const trailerId = result.trailer?.id;
        
        if (targetDoor && trailerId) {
          await moveToDoor(trailerId, parseInt(targetDoor));
          showToast(`✅ ${carrier} trailer added to Door ${targetDoor}!`, 'success');
        } else {
          showToast(`✅ ${carrier} trailer added to yard!`, 'success');
        }
      }
      
      closeModal('modal-create');
      carrierInput.value = '';
      document.getElementById('quick-add-live').checked = false;
      delete form.dataset.targetDoor;
      delete form.dataset.targetStaging;
      await fetchState();
    } catch (error) {
      showToast(error.message, 'error');
    }
  });

  // Quick carrier input Enter key
  document.getElementById('quick-carrier-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('btn-quick-add')?.click();
    }
  });

  // Create trailer form
  document.getElementById('form-create-trailer')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const targetDoor = form.dataset.targetDoor;
    
    const data = {
      number: document.getElementById('trailer-number')?.value || null,
      carrier: document.getElementById('carrier-input')?.value,
      status: document.getElementById('load-type')?.value,
      customer: document.getElementById('trailer-customer')?.value || null,
      loadNumber: document.getElementById('load-number')?.value || null,
      contents: document.getElementById('notes')?.value,
      appointmentTime: document.getElementById('appointment-time')?.value || null,
      driverPhone: document.getElementById('driver-phone')?.value || null,
      isLive: document.getElementById('trailer-live')?.checked || false
    };
    
    try {
      const result = await createTrailer(data);
      const trailerId = result.trailer?.id;
      
      if (targetDoor && trailerId) {
        await moveToDoor(trailerId, parseInt(targetDoor));
        showToast(`Trailer placed in Door ${targetDoor}!`, 'success');
      } else {
        showToast('Trailer created!', 'success');
      }
      
      closeModal('modal-create');
      form.reset();
      document.getElementById('quick-add-panel')?.classList.remove('hidden');
      form.classList.add('hidden');
      delete form.dataset.targetDoor;
      await fetchState();
    } catch (error) {
      showToast(error.message, 'error');
    }
  });

  // Appointment Queue drop zone
  const apptQueue = document.getElementById('appointment-queue-area');
  if (apptQueue) {
    apptQueue.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      apptQueue.classList.add('drop-hover');
    });
    apptQueue.addEventListener('drop', (e) => {
      e.preventDefault();
      apptQueue.classList.remove('drop-hover');
      handleDropToAppointmentQueue(e);
    });
    apptQueue.addEventListener('dragleave', (e) => {
      if (!apptQueue.contains(e.relatedTarget)) {
        apptQueue.classList.remove('drop-hover');
      }
    });
  }

  // Yard drop zone
  const yard = document.getElementById('yard-area');
  if (yard) {
    yard.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      yard.classList.add('drop-hover');
    });
    yard.addEventListener('drop', (e) => {
      e.preventDefault();
      yard.classList.remove('drop-hover');
      handleDropToYard(e);
    });
    yard.addEventListener('dragleave', (e) => {
      if (!yard.contains(e.relatedTarget)) {
        yard.classList.remove('drop-hover');
      }
    });
  }

  // Grid drop zones
  const grid = document.getElementById('dock-grid');
  if (grid) {
    grid.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const door = e.target.closest('.dock-door');
      if (door && !door.classList.contains('occupied')) {
        door.classList.add('drop-hover');
      }
    });
    grid.addEventListener('dragleave', (e) => {
      const door = e.target.closest('.dock-door');
      if (door) door.classList.remove('drop-hover');
    });
    grid.addEventListener('drop', (e) => {
      e.preventDefault();
      const door = e.target.closest('.dock-door');
      if (!door) return;
      
      // Use the new handleDrop function for all door drops
      handleDrop(e);
    });

  }

  // Carrier autocomplete
  setupCarrierAutocomplete();

  // History search with clear button
  const historySearch = document.getElementById('history-search');
  let searchDebounce;
  historySearch?.addEventListener('input', (e) => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => loadHistory(e.target.value), 300);
  });
  
  document.getElementById('history-clear')?.addEventListener('click', () => {
    if (historySearch) {
      historySearch.value = '';
      loadHistory('');
    }
  });
  
  // Date filters
  const dateFrom = document.getElementById('history-date-from');
  const dateTo = document.getElementById('history-date-to');
  
  dateFrom?.addEventListener('change', () => loadHistory(historySearch?.value || ''));
  dateTo?.addEventListener('change', () => loadHistory(historySearch?.value || ''));
  
  document.getElementById('history-date-clear')?.addEventListener('click', () => {
    if (dateFrom) dateFrom.value = '';
    if (dateTo) dateTo.value = '';
    loadHistory(historySearch?.value || '');
  });

  // Shipped orders search
  const shippedSearch = document.getElementById('shipped-search');
  shippedSearch?.addEventListener('input', (e) => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => loadShipped(e.target.value), 300);
  });
  
  document.getElementById('shipped-clear')?.addEventListener('click', () => {
    if (shippedSearch) {
      shippedSearch.value = '';
      loadShipped('');
    }
  });
  
  document.getElementById('shipped-refresh')?.addEventListener('click', () => {
    loadShipped(shippedSearch?.value || '');
    showToast('Shipped list refreshed', 'success');
  });

  // Carrier search
  const carrierSearch = document.getElementById('carrier-search');
  carrierSearch?.addEventListener('input', (e) => {
    renderCarriersList(e.target.value);
  });
  
  // Main search input
  const mainSearch = document.getElementById('search-input');
  let mainSearchDebounce;
  mainSearch?.addEventListener('input', (e) => {
    clearTimeout(mainSearchDebounce);
    mainSearchDebounce = setTimeout(() => performSearch(e.target.value), 300);
  });
  
  // Enter key opens search results modal
  mainSearch?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      showSearchResultsModal();
    }
  });
}

// ============================================================================
// History & Carriers
// ============================================================================

async function loadHistory(search = '') {
  const list = document.getElementById('history-list');
  const emptyMsg = document.getElementById('history-empty');
  if (!list) return;
  
  try {
    const dateFrom = document.getElementById('history-date-from')?.value;
    const dateTo = document.getElementById('history-date-to')?.value;
    
    const data = await getHistory(search, 100, 0, dateFrom, dateTo);
    if (data.entries.length === 0) {
      list.innerHTML = '';
      if (emptyMsg) emptyMsg.classList.remove('hidden');
      return;
    }
    
    if (emptyMsg) emptyMsg.classList.add('hidden');
    
    list.innerHTML = data.entries.map(h => {
      // Determine action styling and label
      let actionClass = 'updated';
      let actionLabel = 'Updated';
      
      if (h.action?.includes('CREATED')) { actionClass = 'created'; actionLabel = 'Created'; }
      else if (h.action?.includes('MOVED')) { actionClass = 'moved'; actionLabel = 'Moved'; }
      else if (h.action?.includes('DELETED')) { actionClass = 'deleted'; actionLabel = 'Deleted'; }
      else if (h.action === 'TRAILER_LOADED') { actionClass = 'loaded'; actionLabel = 'Loaded'; }
      else if (h.action === 'TRAILER_EMPTY') { actionClass = 'empty'; actionLabel = 'Empty'; }
      else if (h.action === 'TRAILER_SHIPPED') { actionClass = 'shipped'; actionLabel = 'Shipped'; }
      else if (h.action === 'SHIPPED_DELETED') { actionClass = 'deleted'; actionLabel = 'Deleted Record'; }
      
      // Get carrier from various sources (backwards compatible)
      const carrier = h.carrier || (h.updates?.carrier);
      const trailerNumber = h.trailerNumber || (h.updates?.number);
      
      // Build trailer identifier: "Carrier trailer" or "Carrier trailer 12345"
      let trailerIdText = carrier && trailerNumber 
        ? `${carrier} trailer ${trailerNumber}`
        : carrier 
          ? `${carrier} trailer`
          : 'Trailer';
      
      // Get location
      const atLocation = h.location || h.previousLocation || (h.doorNumber ? `Door ${h.doorNumber}` : '');
      
      // For TRAILER_UPDATED, build the change description
      let changeDesc = '';
      if (h.action === 'TRAILER_UPDATED' && h.changes?.length > 0) {
        const fieldLabels = {
          number: 'trailer number',
          loadNumber: 'load number',
          customer: 'customer',
          carrier: 'carrier',
          contents: 'notes',
          status: 'status'
        };
        const change = h.changes[0];
        const label = fieldLabels[change.field] || change.field;
        
        if (!change.from) {
          changeDesc = `added ${label} ${change.to}`;
        } else if (!change.to) {
          changeDesc = `removed ${label}`;
        } else {
          changeDesc = `changed ${label} ${change.from} → ${change.to}`;
        }
      } else if (h.action === 'TRAILER_UPDATED' && h.updates) {
        // Fallback for old entries without changes array
        const updatedFields = Object.keys(h.updates).filter(k => k !== 'carrier' && k !== 'status');
        if (updatedFields.length > 0) {
          const fieldLabels = {
            number: 'trailer number',
            loadNumber: 'load number',
            customer: 'customer',
            contents: 'notes'
          };
          const fields = updatedFields.map(f => fieldLabels[f] || f).join(', ');
          changeDesc = `updated ${fields}`;
        } else if (h.updates.status) {
          changeDesc = `marked ${h.updates.status}`;
        }
      }
      
      // Auto-assign info
      let autoAssignHtml = '';
      if (h.autoAssignedToDoor) {
        autoAssignHtml = `<div class="history-change" style="color:var(--accent-secondary)">↻ Auto-filled Door ${h.autoAssignedToDoor} with ${h.autoAssignedCarrier || 'next in queue'}</div>`;
      }

      // Build location line with arrows for movements
      let locationHtml = '';
      if (h.action?.includes('MOVED')) {
        const from = h.previousLocation || 'Yard';
        const to = h.toLocation || (h.doorNumber ? `Door ${h.doorNumber}` : h.yardSlotNumber ? `Yard Spot ${h.yardSlotNumber}` : 'Yard');
        locationHtml = `
          <div class="history-location">
            <span class="history-location-from">${from}</span>
            <span class="history-location-arrow">→</span>
            <span class="history-location-to">${to}</span>
          </div>
        `;
      } else if (h.action === 'TRAILER_SHIPPED') {
          // Special move display for shipped
          const from = h.from || atLocation || 'Dock';
          locationHtml = `
            <div class="history-location">
                <span class="history-location-from">${from}</span>
                <span class="history-location-arrow">→</span>
                <span class="history-location-to">Shipped 💨</span>
            </div>
          `;
      }
      
      return `
      <div class="history-item" data-trailer-id="${h.trailerId || ''}" title="Double-click to edit trailer">
        <div class="history-item-header">
          <span class="history-action ${actionClass}">${actionLabel}</span>
          <span class="history-time">${new Date(h.timestamp).toLocaleString()}</span>
        </div>
        <div class="history-trailer-info">
          ${trailerNumber ? `<span class="history-trailer-number">${trailerNumber}</span>` : ''}
          ${carrier ? `<span class="history-carrier">${carrier}</span>` : ''}
        </div>
        ${!locationHtml && atLocation ? `<div class="history-location">📍 ${atLocation}</div>` : ''}
        ${locationHtml}
        ${changeDesc ? `<div class="history-change">${changeDesc}</div>` : ''}
        ${autoAssignHtml}
      </div>
    `}).join('');
    
    // Add double-click handlers to history items
    list.querySelectorAll('.history-item[data-trailer-id]').forEach(item => {
      item.addEventListener('dblclick', () => {
        const trailerId = item.dataset.trailerId;
        if (trailerId) {
          // Find the trailer in current state (including shipped)
          const trailer = state.trailers.find(t => t.id === trailerId) || 
                         state.yardTrailers.find(t => t.id === trailerId) ||
                         state.shippedTrailers?.find(t => t.id === trailerId) ||
                         (state.staging?.id === trailerId ? state.staging : null) ||
                         state.queuedTrailers?.find(t => t.id === trailerId);
          if (trailer) {
            openTrailerEditModal(trailerId);
          } else {
            showToast('Trailer no longer exists', 'warning');
          }
        }
      });
    });
    
  } catch (error) {
    console.error('History load error:', error);
    list.innerHTML = '<div class="history-empty">Failed to load history</div>';
  }
}

// Load and display shipped orders
async function loadShipped(search = '') {
  const list = document.getElementById('shipped-list');
  const emptyMsg = document.getElementById('shipped-empty');
  const countEl = document.getElementById('shipped-count');
  if (!list) return;
  
  try {
    // Fetch current state to get shippedTrailers
    await fetchState();
    
    let shipped = state.shippedTrailers || [];
    
    // Filter by search term
    if (search) {
      const term = search.toLowerCase();
      shipped = shipped.filter(t => 
        (t.number && t.number.toLowerCase().includes(term)) ||
        (t.carrier && t.carrier.toLowerCase().includes(term)) ||
        (t.customer && t.customer.toLowerCase().includes(term)) ||
        (t.loadNumber && t.loadNumber.toLowerCase().includes(term)) ||
        (t.doorNumber && t.doorNumber.toString().includes(term))
      );
    }
    
    // Sort by shipped date (most recent first)
    shipped.sort((a, b) => new Date(b.shippedAt || b.updatedAt || b.createdAt) - new Date(a.shippedAt || a.updatedAt || a.createdAt));
    
    if (countEl) countEl.textContent = `${shipped.length} shipped order${shipped.length !== 1 ? 's' : ''}`;
    
    if (shipped.length === 0) {
      list.innerHTML = '';
      if (emptyMsg) emptyMsg.classList.remove('hidden');
      return;
    }
    
    if (emptyMsg) emptyMsg.classList.add('hidden');
    
    list.innerHTML = shipped.map(t => {
      const shippedDate = new Date(t.shippedAt || t.updatedAt || t.createdAt).toLocaleDateString();
      const shippedTime = new Date(t.shippedAt || t.updatedAt || t.createdAt).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
      
      return `
        <div class="shipped-item" data-trailer-id="${t.id}">
          <div class="shipped-item-header">
            <span class="shipped-carrier">${t.carrier ? t.carrier : 'Unknown'}</span>
            <div style="display: flex; gap: 0.5rem; align-items: center;">
              ${editMode ? `<button class="btn-delete-shipped" data-shipped-id="${t.id}" title="Delete shipped record">🗑️</button>` : ''}
              <span class="shipped-status">SHIPPED</span>
              <span class="shipped-date">${shippedDate} ${shippedTime}</span>
            </div>
          </div>
          <div class="shipped-details">
            ${t.number ? `<div class="shipped-detail"><span class="shipped-detail-label">Trailer:</span> ${t.number}</div>` : ''}
            ${t.customer ? `<div class="shipped-detail"><span class="shipped-detail-label">Customer:</span> ${t.customer}</div>` : ''}
            ${t.loadNumber ? `<div class="shipped-detail"><span class="shipped-detail-label">Load:</span> ${t.loadNumber}</div>` : ''}
            ${t.doorNumber ? `<div class="shipped-detail"><span class="shipped-detail-label">Door:</span> ${t.doorNumber}</div>` : ''}
            ${t.contents ? `<div class="shipped-detail"><span class="shipped-detail-label">Contents:</span> ${t.contents}</div>` : ''}
          </div>
        </div>
      `;
    }).join('');
    
    // Add double-click handlers to view trailer details (read-only)
    list.querySelectorAll('.shipped-item').forEach(item => {
      item.addEventListener('dblclick', () => {
        const trailerId = item.dataset.trailerId;
        if (trailerId) openTrailerEditModal(trailerId);
      });
    });
    
    // Add delete handlers for shipped items (edit mode only)
    list.querySelectorAll('.btn-delete-shipped').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const trailerId = btn.dataset.shippedId;
        if (!trailerId) return;
        
        const shipped = state.shippedTrailers?.find(t => t.id === trailerId);
        if (!shipped) return;
        
        if (!confirm(`Delete shipped order for ${shipped.carrier}${shipped.number ? ' trailer ' + shipped.number : ''}? This action cannot be undone.`)) return;
        
        try {
          await apiCall(`/shipped/${trailerId}`, 'DELETE');
          showToast('Shipped record deleted', 'success');
          loadShipped(search);
        } catch (err) {
          showToast(err.message || 'Failed to delete shipped record', 'error');
        }
      });
    });
    
  } catch (error) {
    console.error('Shipped load error:', error);
    list.innerHTML = '<div class="shipped-empty">Failed to load shipped orders</div>';
  }
}

function renderCarriersList(search = '') {
  const favoritesContainer = document.getElementById('favorite-carriers');
  const allContainer = document.getElementById('all-carriers');
  
  let carriers = state.carriers;
  if (search) {
    carriers = carriers.filter(c => c.name.toLowerCase().includes(search.toLowerCase()));
  }
  
  const favorites = carriers.filter(c => c.favorite).sort((a,b) => a.name.localeCompare(b.name));
  const others = carriers.filter(c => !c.favorite).sort((a,b) => a.name.localeCompare(b.name));
  
  const renderCarrier = (c) => `
    <div class="carrier-item">
      <span class="carrier-name">${c.name}${c.mcNumber ? ` (${c.mcNumber})` : ''}</span>
      <div class="carrier-actions">
        <button class="btn-favorite" data-carrier="${c.id}">${c.favorite ? '⭐' : '☆'}</button>
        ${editMode ? `<button class="btn-delete-carrier" data-carrier="${c.id}" title="Delete carrier">🗑️</button>` : ''}
      </div>
    </div>
  `;
  
  if (favoritesContainer) favoritesContainer.innerHTML = favorites.map(renderCarrier).join('');
  if (allContainer) allContainer.innerHTML = others.map(renderCarrier).join('');
  
  document.querySelectorAll('.btn-favorite').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const carrierId = e.target.dataset.carrier;
      const carrier = state.carriers.find(c => c.id === carrierId);
      if (carrier) {
        try {
          await apiCall(`/carriers/${carrierId}/favorite`, 'PUT', { favorite: !carrier.favorite });
          await fetchState();
          renderCarriersList(search);
        } catch (err) {
          showToast(err.message, 'error');
        }
      }
    });
  });
  
  // Delete carrier handler
  document.querySelectorAll('.btn-delete-carrier').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const carrierId = e.target.dataset.carrier;
      const carrier = state.carriers.find(c => c.id === carrierId);
      if (!carrier) return;
      
      // Check if carrier is in use
      const inUse = state.trailers.some(t => t.carrier === carrier.name) || 
                    state.yardTrailers.some(t => t.carrier === carrier.name);
      if (inUse) {
        showToast('Cannot delete: carrier is assigned to trailers', 'error');
        return;
      }
      
      if (!confirm(`Delete carrier "${carrier.name}"?`)) return;
      
      try {
        await apiCall(`/carriers/${carrierId}`, 'DELETE');
        await fetchState();
        renderCarriersList(search);
        showToast('Carrier deleted', 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });
}

// ============================================================================
// Input Sanitization
// ============================================================================

function formatPhoneNumber(value) {
  if (!value) return value;
  
  // Strip all non-numeric characters
  const phoneNumber = value.replace(/\D/g, '');
  
  // Check if it's 10 digits
  if (phoneNumber.length === 10) {
    return `${phoneNumber.slice(0, 3)}-${phoneNumber.slice(3, 6)}-${phoneNumber.slice(6)}`;
  }
  
  // If not 10 digits, return original input (user might be typing partial, or intl)
  return value;
}

function sanitizeInput(value) {
  // This frontend sanitizer is now just for UX (preventing invalid chars while typing)
  // The backend handles the real security sanitization/encoding.
  // We'll relax this to match the backend's allowed list so users don't get frustrated.
  if (!value) return '';
  // Allow almost everything except HTML tags
  // This regex allows letters, numbers, punctuation, spaces, etc.
  // It only strips < and > to prevent tag injection previews
  return value.replace(/[<>]/g, '');
}

function setupInputSanitization(inputElement) {
  if (!inputElement) return;
  
  inputElement.addEventListener('input', (e) => {
    const sanitized = sanitizeInput(e.target.value);
    if (sanitized !== e.target.value) {
      e.target.value = sanitized;
    }
  });
}

// Carrier Autocomplete
// ============================================================================

function setupCarrierAutocomplete(inputId = 'carrier-input', suggestionsId = 'carrier-suggestions') {
  const input = document.getElementById(inputId);
  const suggestions = document.getElementById(suggestionsId);
  
  if (!input) return;
  
  // Setup sanitization on the input
  setupInputSanitization(input);
  
  if (!suggestions) return;
  
  input.addEventListener('input', (e) => {
    const value = e.target.value.toLowerCase();
    if (value.length < 1) {
      suggestions.innerHTML = '';
      return;
    }
    
    const matches = state.carriers
      .filter(c => c.name.toLowerCase().includes(value))
      .sort((a, b) => {
        const aStarts = a.name.toLowerCase().startsWith(value) ? 0 : 1;
        const bStarts = b.name.toLowerCase().startsWith(value) ? 0 : 1;
        if (aStarts !== bStarts) return aStarts - bStarts;
        return a.name.localeCompare(b.name);
      })
      .slice(0, 5);
    
    if (matches.length === 0) {
      suggestions.innerHTML = '<div class="autocomplete-item">No carriers found</div>';
      return;
    }
    
    suggestions.innerHTML = matches.map(c => {
      const highlighted = c.name.replace(
        new RegExp(value, 'gi'),
        match => `<strong>${match}</strong>`
      );
      return `<div class="autocomplete-item" data-name="${c.name}">${highlighted}</div>`;
    }).join('');
    
    suggestions.querySelectorAll('.autocomplete-item').forEach(item => {
      item.addEventListener('click', () => {
        input.value = item.dataset.name;
        suggestions.innerHTML = '';
      });
    });
  });
  
  input.addEventListener('blur', () => {
    setTimeout(() => {
      suggestions.innerHTML = '';
    }, 200);
  });
  
  input.addEventListener('focus', () => {
    if (input.value.length > 0) {
      input.dispatchEvent(new Event('input'));
    }
  });
}

// Setup carrier autocomplete for edit modal
function setupEditModalCarrierAutocomplete() {
  const input = document.getElementById('edit-trailer-carrier');
  const suggestions = document.getElementById('edit-carrier-suggestions');
  
  if (!input || !suggestions) return;
  
  input.addEventListener('input', (e) => {
    const value = e.target.value.toLowerCase();
    if (value.length < 1) {
      suggestions.innerHTML = '';
      return;
    }
    
    const matches = state.carriers
      .filter(c => c.name.toLowerCase().includes(value))
      .sort((a, b) => {
        const aStarts = a.name.toLowerCase().startsWith(value) ? 0 : 1;
        const bStarts = b.name.toLowerCase().startsWith(value) ? 0 : 1;
        if (aStarts !== bStarts) return aStarts - bStarts;
        return a.name.localeCompare(b.name);
      })
      .slice(0, 5);
    
    if (matches.length === 0) {
      suggestions.innerHTML = '<div class="autocomplete-item">No carriers found</div>';
      return;
    }
    
    suggestions.innerHTML = matches.map(c => {
      const highlighted = c.name.replace(
        new RegExp(value, 'gi'),
        match => `<strong>${match}</strong>`
      );
      return `<div class="autocomplete-item" data-name="${c.name}">${highlighted}</div>`;
    }).join('');
    
    suggestions.querySelectorAll('.autocomplete-item').forEach(item => {
      item.addEventListener('click', () => {
        input.value = item.dataset.name;
        suggestions.innerHTML = '';
      });
    });
  });
  
  input.addEventListener('blur', () => {
    setTimeout(() => {
      suggestions.innerHTML = '';
    }, 200);
  });
  
  input.addEventListener('focus', () => {
    if (input.value.length > 0) {
      input.dispatchEvent(new Event('input'));
    }
  });
}

// ============================================================================
// Door Edit Modal
// ============================================================================

function openDoorEditor(doorId) {
  const door = state.doors.find(d => d.id === doorId);
  if (!door) return;
  
  const modal = document.createElement('div');
  modal.className = 'modal active';
  modal.id = 'modal-door-edit';
  modal.innerHTML = `
    <div class="modal-content">
      <div class="modal-header">
        <h3>⚙️ Edit Door</h3>
        <button class="close-modal">×</button>
      </div>
      <div class="modal-body">
        <!-- Door Type Selection -->
        <div class="door-type-section" style="margin-bottom:1.5rem; display:block !important;">
          <label class="section-label" style="display:block; font-size:0.875rem; font-weight:600; color:var(--text-secondary); margin-bottom:0.75rem; text-transform:uppercase; letter-spacing:0.05em;">Door Type</label>
          <div class="door-type-options" style="display:grid; grid-template-columns:repeat(3, 1fr); gap:0.75rem;">
            <button type="button" class="door-type-btn ${door.type !== 'blank' && door.inService !== false ? 'active' : ''}" data-type="normal" style="display:flex; flex-direction:column; align-items:center; gap:0.5rem; padding:1rem; background:var(--bg-tertiary); border:2px solid ${door.type !== 'blank' && door.inService !== false ? 'var(--accent-primary)' : 'var(--border-color)'}; border-radius:var(--radius-md); cursor:pointer; color:var(--text-secondary);">
              <span class="btn-icon" style="font-size:1.5rem;">🚪</span>
              <span class="btn-label" style="font-size:0.75rem; font-weight:600; text-align:center;">Normal<br><small style="font-weight:400; opacity:0.7;">Active door</small></span>
            </button>
            <button type="button" class="door-type-btn ${door.type === 'blank' ? 'active' : ''}" data-type="blank" style="display:flex; flex-direction:column; align-items:center; gap:0.5rem; padding:1rem; background:var(--bg-tertiary); border:2px solid ${door.type === 'blank' ? 'var(--accent-primary)' : 'var(--border-color)'}; border-radius:var(--radius-md); cursor:pointer; color:var(--text-secondary);">
              <span class="btn-icon" style="font-size:1.5rem;">⬜</span>
              <span class="btn-label" style="font-size:0.75rem; font-weight:600; text-align:center;">Blank<br><small style="font-weight:400; opacity:0.7;">Placeholder</small></span>
            </button>
            <button type="button" class="door-type-btn ${door.inService === false ? 'active' : ''}" data-type="out-of-service" style="display:flex; flex-direction:column; align-items:center; gap:0.5rem; padding:1rem; background:var(--bg-tertiary); border:2px solid ${door.inService === false ? 'var(--accent-primary)' : 'var(--border-color)'}; border-radius:var(--radius-md); cursor:pointer; color:var(--text-secondary);">
              <span class="btn-icon" style="font-size:1.5rem;">🔧</span>
              <span class="btn-label" style="font-size:0.75rem; font-weight:600; text-align:center;">Out of Service<br><small style="font-weight:400; opacity:0.7;">Disabled</small></span>
            </button>
          </div>
        </div>
        
        <!-- Door Label -->
        <div class="form-group">
          <label class="section-label">Door Label</label>
          <div class="door-label-options">
            <label class="radio-label">
              <input type="radio" name="label-type" value="number" ${!door.labelText ? 'checked' : ''}>
              <span>Number</span>
            </label>
            <label class="radio-label">
              <input type="radio" name="label-type" value="text" ${door.labelText ? 'checked' : ''}>
              <span>Custom Text</span>
            </label>
          </div>
          <input type="number" id="door-number" value="${door.number}" class="${door.labelText ? 'hidden' : ''}">
          <input type="text" id="door-label-text" value="${door.labelText || ''}" placeholder="e.g. RAMP" class="${!door.labelText ? 'hidden' : ''}" maxlength="10">
        </div>
        
        <div class="modal-actions">
          <button id="btn-save-door" class="btn btn-primary">💾 Save Changes</button>
          ${state.doors.length > 1 ? `<button id="btn-delete-door" class="btn btn-danger">🗑️ Delete Door</button>` : ''}
          <button class="btn btn-secondary close-modal">Cancel</button>
        </div>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  // Setup type buttons
  let selectedType = door.type === 'blank' ? 'blank' : (door.inService === false ? 'out-of-service' : 'normal');
  
  function updateTypeButtonStyles() {
    modal.querySelectorAll('.door-type-btn').forEach(btn => {
      const isActive = btn.dataset.type === selectedType;
      btn.classList.toggle('active', isActive);
      btn.style.borderColor = isActive ? 'var(--accent-primary)' : 'var(--border-color)';
      btn.style.background = isActive ? 'rgba(59, 130, 246, 0.1)' : 'var(--bg-tertiary)';
    });
  }
  
  updateTypeButtonStyles();
  
  modal.querySelectorAll('.door-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedType = btn.dataset.type;
      updateTypeButtonStyles();
    });
  });
  
  // Setup label type toggle
  const numberInput = document.getElementById('door-number');
  const textInput = document.getElementById('door-label-text');
  modal.querySelectorAll('input[name="label-type"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      if (e.target.value === 'number') {
        numberInput.classList.remove('hidden');
        textInput.classList.add('hidden');
      } else {
        numberInput.classList.add('hidden');
        textInput.classList.remove('hidden');
        textInput.focus();
      }
    });
  });
  
  // Sanitize text input
  setupInputSanitization(textInput);
  
  modal.querySelectorAll('.close-modal').forEach(btn => {
    btn.addEventListener('click', () => modal.remove());
  });
  
  document.getElementById('btn-save-door')?.addEventListener('click', async () => {
    const useTextLabel = document.querySelector('input[name="label-type"]:checked')?.value === 'text';
    const labelText = useTextLabel ? document.getElementById('door-label-text')?.value?.trim() : null;
    const number = parseInt(document.getElementById('door-number')?.value) || door.number;
    
    const updates = {
      inService: selectedType !== 'out-of-service',
      type: selectedType === 'blank' ? 'blank' : 'normal',
      number,
      labelText: labelText || null
    };
    
    try {
      await updateDoor(doorId, updates);
      showToast('Door updated', 'success');
      modal.remove();
      fetchState();
    } catch (error) {
      showToast(error.message, 'error');
    }
  });
  
  document.getElementById('btn-delete-door')?.addEventListener('click', async () => {
    if (!confirm(`Delete Door ${door.number}?\n\nThis will remove the door and move any trailer to the yard.`)) {
      return;
    }
    
    try {
      await deleteDoor(doorId);
      showToast('Door deleted', 'success');
      modal.remove();
      fetchState();
    } catch (error) {
      showToast(error.message, 'error');
    }
  });
}

function openAddDoorModal() {
  const modal = document.createElement('div');
  modal.className = 'modal active';
  modal.id = 'modal-add-door';
  
  let selectedType = 'normal'; // default
  
  modal.innerHTML = `
    <div class="modal-content">
      <div class="modal-header">
        <h3>➕ Add New Door</h3>
        <button class="close-modal">×</button>
      </div>
      <div class="modal-body">
        <!-- Door Type Selection -->
        <div class="door-type-section" style="margin-bottom:1rem;">
          <label style="display:block; font-size:0.875rem; font-weight:600; color:var(--text-secondary); margin-bottom:0.5rem;">Door Type</label>
          <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:0.5rem;">
            <button type="button" class="new-door-type-btn active" data-type="normal" style="display:flex; flex-direction:column; align-items:center; gap:0.25rem; padding:0.75rem; background:var(--bg-tertiary); border:2px solid var(--accent-primary); border-radius:var(--radius-md); cursor:pointer;">
              <span style="font-size:1.25rem;">🚪</span>
              <span style="font-size:0.6875rem; font-weight:600;">Normal</span>
            </button>
            <button type="button" class="new-door-type-btn" data-type="blank" style="display:flex; flex-direction:column; align-items:center; gap:0.25rem; padding:0.75rem; background:var(--bg-tertiary); border:2px solid var(--border-color); border-radius:var(--radius-md); cursor:pointer;">
              <span style="font-size:1.25rem;">⬜</span>
              <span style="font-size:0.6875rem; font-weight:600;">Blank</span>
            </button>
            <button type="button" class="new-door-type-btn" data-type="out-of-service" style="display:flex; flex-direction:column; align-items:center; gap:0.25rem; padding:0.75rem; background:var(--bg-tertiary); border:2px solid var(--border-color); border-radius:var(--radius-md); cursor:pointer;">
              <span style="font-size:1.25rem;">🔧</span>
              <span style="font-size:0.6875rem; font-weight:600;">Out of Service</span>
            </button>
          </div>
        </div>
        
        <!-- Label Type -->
        <div style="margin-bottom:1rem;">
          <label style="display:block; font-size:0.875rem; font-weight:600; color:var(--text-secondary); margin-bottom:0.5rem;">Door Label</label>
          <div style="display:flex; gap:1rem; margin-bottom:0.5rem;">
            <label style="display:flex; align-items:center; gap:0.25rem; cursor:pointer;">
              <input type="radio" name="add-door-label-type" value="number" checked>
              <span>Number</span>
            </label>
            <label style="display:flex; align-items:center; gap:0.25rem; cursor:pointer;">
              <input type="radio" name="add-door-label-type" value="text">
              <span>Custom Text</span>
            </label>
          </div>
          <div id="add-door-number-input">
            <input type="number" id="new-door-number" placeholder="e.g., 58" style="width:100%; padding:0.5rem; background:var(--bg-primary); border:1px solid var(--border-color); border-radius:var(--radius-sm); color:var(--text-primary);">
          </div>
          <div id="add-door-text-input" style="display:none;">
            <input type="text" id="new-door-label-text" placeholder="e.g., RAMP" maxlength="10" style="width:100%; padding:0.5rem; background:var(--bg-primary); border:1px solid var(--border-color); border-radius:var(--radius-sm); color:var(--text-primary);">
          </div>
        </div>
        
        <div class="modal-actions">
          <button id="btn-create-door" class="btn btn-primary">➕ Create Door</button>
          <button class="btn btn-secondary close-modal">Cancel</button>
        </div>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  // Setup type buttons
  modal.querySelectorAll('.new-door-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      modal.querySelectorAll('.new-door-type-btn').forEach(b => {
        b.classList.remove('active');
        b.style.borderColor = 'var(--border-color)';
      });
      btn.classList.add('active');
      btn.style.borderColor = 'var(--accent-primary)';
      selectedType = btn.dataset.type;
    });
  });
  
  // Setup label type toggle
  const numberInputDiv = document.getElementById('add-door-number-input');
  const textInputDiv = document.getElementById('add-door-text-input');
  
  modal.querySelectorAll('input[name="add-door-label-type"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      if (e.target.value === 'number') {
        numberInputDiv.style.display = 'block';
        textInputDiv.style.display = 'none';
      } else {
        numberInputDiv.style.display = 'none';
        textInputDiv.style.display = 'block';
        document.getElementById('new-door-label-text')?.focus();
      }
    });
  });
  
  modal.querySelectorAll('.close-modal').forEach(btn => {
    btn.addEventListener('click', () => modal.remove());
  });
  
  document.getElementById('btn-create-door')?.addEventListener('click', async () => {
    const useTextLabel = document.querySelector('input[name="add-door-label-type"]:checked')?.value === 'text';
    const labelText = useTextLabel ? document.getElementById('new-door-label-text')?.value?.trim() : null;
    const number = parseInt(document.getElementById('new-door-number')?.value);
    
    if (useTextLabel && !labelText) {
      showToast('Please enter a label text', 'warning');
      return;
    }
    if (!useTextLabel && !number) {
      showToast('Please enter a door number', 'warning');
      return;
    }
    
    // Debug: log what's being sent
    console.log('Creating door with selectedType:', selectedType);
    
    const doorData = { 
      number: useTextLabel ? 0 : number, // Assign 0 if using text label
      labelText: labelText,
      type: selectedType,
      inService: selectedType !== 'out-of-service'
    };
    
    console.log('Door data being sent:', doorData);
    
    try {
      const result = await createDoor(doorData);
      console.log('Door created:', result);
      const typeLabel = selectedType === 'normal' ? 'Normal' : selectedType === 'blank' ? 'Blank' : 'Out of Service';
      showToast(`${typeLabel} door ${labelText || number} created!`, 'success');
      modal.remove();
      fetchState();
    } catch (error) {
      showToast(error.message, 'error');
    }
  });
}

// ============================================================================
// ============================================================================
// Manual Staging Add Modal (Full Form)
// ============================================================================

function openManualStagingModal() {
  // Check if staging is already occupied
  if (state.staging) {
    showToast('Staging slot is already occupied', 'warning');
    return;
  }
  
  const modal = document.createElement('div');
  modal.className = 'modal active';
  modal.id = 'modal-manual-staging';
  
  modal.innerHTML = `
    <div class="modal-content">
      <div class="modal-header">
        <h3>⭐ Add to Staging</h3>
        <button class="close-modal">×</button>
      </div>
      <div class="modal-body">
        <div class="form-group carrier-autocomplete">
          <label>Carrier <span style="color:#ef4444">*</span></label>
          <input type="text" id="manual-staging-carrier" placeholder="e.g., FedEx" autocomplete="off">
          <div id="manual-staging-suggestions" class="autocomplete-list"></div>
        </div>
        <div class="form-row">
          <div class="form-group half">
            <label>Trailer Number</label>
            <input type="text" id="manual-staging-number" placeholder="e.g., 12345">
          </div>
          <div class="form-group half">
            <label>Load/Shipment #</label>
            <input type="text" id="manual-staging-load" placeholder="Optional">
          </div>
        </div>
        <div class="form-group">
          <label>Customer</label>
          <input type="text" id="manual-staging-customer" placeholder="Customer name (optional)">
        </div>
        <div class="form-group">
          <label>Status</label>
          <select id="manual-staging-status">
            <option value="loaded" selected>📦 Loaded</option>
            <option value="empty">📭 Empty</option>
          </select>
        </div>
        <div class="form-group">
          <label class="switch-container">
            <div class="switch">
              <input type="checkbox" id="manual-staging-live">
              <span class="slider"></span>
            </div>
            <span class="switch-label">LIVE LOAD/UNLOAD</span>
          </label>
        </div>
        <div class="form-group">
          <label>Notes</label>
          <textarea id="manual-staging-notes" rows="2" placeholder="Optional notes..."></textarea>
        </div>
        <div class="modal-actions">
          <button id="btn-create-manual-staging" class="btn btn-primary">➕ Add to Staging</button>
          <button class="btn btn-secondary close-modal">Cancel</button>
        </div>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  // Setup carrier autocomplete
  const carrierInput = document.getElementById('manual-staging-carrier');
  const suggestionsDiv = document.getElementById('manual-staging-suggestions');
  
  carrierInput?.addEventListener('input', (e) => {
    const value = e.target.value.toLowerCase().trim();
    if (!value) {
      suggestionsDiv.style.display = 'none';
      return;
    }
    
    const matches = state.carriers
      .filter(c => c.name.toLowerCase().startsWith(value))
      .slice(0, 5);
    
    if (matches.length > 0) {
      suggestionsDiv.innerHTML = matches.map(c => `
        <div class="autocomplete-item" data-carrier="${escapeHtml(c.name)}">
          ${escapeHtml(c.name)}
        </div>
      `).join('');
      suggestionsDiv.style.display = 'block';
      
      suggestionsDiv.querySelectorAll('.autocomplete-item').forEach(item => {
        item.addEventListener('click', () => {
          carrierInput.value = item.dataset.carrier;
          suggestionsDiv.style.display = 'none';
        });
      });
    } else {
      suggestionsDiv.style.display = 'none';
    }
  });
  
  // Close suggestions on click outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.carrier-autocomplete')) {
      suggestionsDiv.style.display = 'none';
    }
  });
  
  // Setup input sanitization
  setupInputSanitization(document.getElementById('manual-staging-number'));
  setupInputSanitization(document.getElementById('manual-staging-load'));
  setupInputSanitization(document.getElementById('manual-staging-customer'));
  setupInputSanitization(document.getElementById('manual-staging-notes'));
  setupInputSanitization(carrierInput);
  
  // Close handlers
  modal.querySelectorAll('.close-modal').forEach(btn => {
    btn.addEventListener('click', () => modal.remove());
  });
  
  // Create handler
  document.getElementById('btn-create-manual-staging')?.addEventListener('click', async () => {
    const carrier = document.getElementById('manual-staging-carrier')?.value?.trim();
    const number = document.getElementById('manual-staging-number')?.value?.trim() || null;
    const loadNumber = document.getElementById('manual-staging-load')?.value?.trim() || null;
    const customer = document.getElementById('manual-staging-customer')?.value?.trim() || null;
    const status = document.getElementById('manual-staging-status')?.value;
    const contents = document.getElementById('manual-staging-notes')?.value?.trim() || null;
    const isLive = document.getElementById('manual-staging-live')?.checked || false;
    
    if (!carrier) {
      showToast('Carrier is required', 'warning');
      return;
    }
    
    try {
      await addToStaging({ carrier, number, status, customer, loadNumber, contents, isLive });
      showToast('Trailer added to staging!', 'success');
      modal.remove();
      fetchState();
    } catch (error) {
      showToast(error.message, 'error');
    }
  });
  
  // Focus carrier input
  carrierInput?.focus();
  
  // Format phone on blur
  document.getElementById('driver-phone')?.addEventListener('blur', (e) => {
    e.target.value = formatPhoneNumber(e.target.value);
  });
}

// ============================================================================
// Trailer Edit Modal (Enhanced with Timeline)
// ============================================================================

function openTrailerEditModal(trailerId) {
  const trailer = state.trailers.find(t => t.id === trailerId) ||
                  state.yardTrailers.find(t => t.id === trailerId) ||
                  state.shippedTrailers?.find(t => t.id === trailerId) ||
                  (state.staging?.id === trailerId ? state.staging : null) ||
                  state.queuedTrailers?.find(t => t.id === trailerId) ||
                  state.appointmentQueue?.find(t => t.id === trailerId);
  if (!trailer) {
    showToast('Trailer not found', 'error');
    console.log('Trailer not found. ID:', trailerId, 'Staging:', state.staging);
    return;
  }

  const location = trailer.doorNumber ? `Door ${trailer.doorNumber}` : 
                   trailer.yardSlotNumber ? `Yard Spot ${trailer.yardSlotNumber}` : 
                   trailer.location === 'staging' ? '⭐ Staging' :
                   trailer.location === 'queued' ? `⏳ Queue (Door ${trailer.targetDoorNumber})` :
                   'Unassigned Yard';
  
  const dwellHours = getDwellTimeHours(trailer.createdAt);
  const dwellInfo = dwellHours !== null ? `⏱️ Dwell time: ${dwellHours} hour${dwellHours !== 1 ? 's' : ''}` : '';

  const modal = document.createElement('div');
  modal.className = 'modal active';
  modal.id = 'modal-trailer-edit';
  const isShipped = trailer.location === 'shipped';
  
  modal.innerHTML = `
    <div class="modal-content modal-large" style="position:relative;${isShipped ? ' overflow:hidden;' : ''}">
      ${isShipped ? `<div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-15deg);font-size:4rem;font-weight:900;color:rgba(239,68,68,0.3);pointer-events:none;z-index:100;border:4px solid rgba(239,68,68,0.3);padding:0.5rem 1rem;border-radius:8px;letter-spacing:0.2em;">SHIPPED</div>` : ''}
      <div class="modal-header">
        <h3>${isShipped ? '📦 SHIPPED Trailer (Read-Only)' : '🚛 Edit Trailer'}</h3>
        <button class="close-modal">×</button>
      </div>
      <div class="trailer-edit-preview">
        ${trailer.number ? `<div class="preview-number">${trailer.number}</div>` : ''}
        <div class="preview-carrier">${trailer.carrier}</div>
        ${trailer.isLive ? `<div class="preview-live" style="color:#ef4444;font-weight:bold;font-size:1.2em;margin:5px 0;">🔴 LIVE LOAD/UNLOAD</div>` : ''}
        <div class="preview-location">📍 ${location}</div>
        ${dwellInfo ? `<div class="preview-dwell ${getDwellTimeClass(trailer.createdAt)}">${dwellInfo}</div>` : ''}
        <button id="btn-reset-dwell" class="btn btn-small btn-secondary" title="Reset dwell time to now">🔄 Reset Dwell Time</button>
      </div>
      <div class="modal-body">
        <div class="trailer-edit-sections">
          <div class="edit-section">
            <div class="form-group${isShipped ? ' disabled-field' : ''}">
              <label>Customer</label>
              <input type="text" id="edit-trailer-customer" value="${trailer.customer || ''}" placeholder="Customer name (optional)"${isShipped ? ' disabled="disabled"' : ''}>
            </div>
            <div class="form-group carrier-autocomplete${isShipped ? ' disabled-field' : ''}">
              <label>Carrier</label>
              <input type="text" id="edit-trailer-carrier" value="${trailer.carrier}" autocomplete="off"${isShipped ? ' disabled="disabled"' : ''}>
              <div id="edit-carrier-suggestions" class="autocomplete-list"></div>
            </div>
            <div class="form-group${isShipped ? ' disabled-field' : ''}">
              <label>Status</label>
              <select id="edit-trailer-status"${isShipped ? ' disabled="disabled"' : ''}>
                <option value="loaded" ${trailer.status === 'loaded' ? 'selected' : ''}>📦 Loaded</option>
                <option value="empty" ${trailer.status === 'empty' ? 'selected' : ''}>📭 Empty</option>
              </select>
            </div>
            <div class="form-group${isShipped ? ' disabled-field' : ''}">
              <label class="switch-container">
                <div class="switch">
                  <input type="checkbox" id="edit-trailer-live" ${trailer.isLive ? 'checked' : ''} ${isShipped ? 'disabled' : ''}>
                  <span class="slider"></span>
                </div>
                <span class="switch-label">LIVE LOAD/UNLOAD</span>
              </label>
            </div>
            <div class="form-row">
              <div class="form-group half${isShipped ? ' disabled-field' : ''}">
                <label>Trailer Number</label>
                <input type="text" id="edit-trailer-number" value="${trailer.number || ''}" placeholder=""${isShipped ? ' disabled="disabled"' : ''}>
              </div>
              <div class="form-group half${isShipped ? ' disabled-field' : ''}">
                <label>Load/Shipment Number</label>
                <input type="text" id="edit-trailer-loadnumber" value="${trailer.loadNumber || ''}" placeholder="Optional"${isShipped ? ' disabled="disabled"' : ''}>
              </div>
            </div>
            <div class="form-group${isShipped ? ' disabled-field' : ''}">
              <label>Driver Name</label>
              <input type="text" id="edit-trailer-drivername" value="${trailer.driverName || ''}" placeholder="Driver name (optional)"${isShipped ? ' disabled="disabled"' : ''}>
            </div>
            <div class="form-group${isShipped ? ' disabled-field' : ''}">
              <label>Phone Number</label>
              <input type="tel" id="edit-trailer-phone" value="${trailer.driverPhone || ''}" placeholder="Optional"${isShipped ? ' disabled="disabled"' : ''}>
            </div>
            <div class="form-group${isShipped ? ' disabled-field' : ''}">
              <label>Appointment Time</label>
              <div class="time-input-wrapper">
                <input type="time" id="edit-trailer-appt" value="${trailer.appointmentTime || ''}"${isShipped ? ' disabled="disabled"' : ''}>
                ${!isShipped ? `<button type="button" class="btn btn-secondary btn-time-picker" title="Pick Time">🕒</button>` : ''}
              </div>
            </div>
            <div class="form-group${isShipped ? ' disabled-field' : ''}">
              <label>Notes</label>
              <textarea id="edit-trailer-notes" rows="2" placeholder="Optional notes..."${isShipped ? ' disabled="disabled"' : ''}>${trailer.contents || ''}</textarea>
            </div>
          </div>
          <div class="timeline-section">
            <h4>📜 Movement Timeline</h4>
            <div id="trailer-timeline" class="timeline-container">
              <div class="timeline-loading">Loading history...</div>
            </div>
          </div>
        </div>
        <div class="modal-actions">
          ${!isShipped ? `<button id="btn-save-trailer" class="btn btn-primary">💾 Save Changes</button>` : ''}
          ${!isShipped ? `<button id="btn-ship-trailer" class="btn btn-warning">📦 Mark as Shipped</button>` : ''}
          <button id="btn-delete-trailer-edit" class="btn btn-danger">🗑️ Delete Trailer</button>
          <button class="btn btn-secondary close-modal">Close</button>
        </div>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  // Load timeline
  loadTrailerTimeline(trailerId);
  
  // Setup sanitization on all text inputs
  setupInputSanitization(document.getElementById('edit-trailer-customer'));
  setupInputSanitization(document.getElementById('edit-trailer-carrier'));
  setupInputSanitization(document.getElementById('edit-trailer-number'));
  setupInputSanitization(document.getElementById('edit-trailer-loadnumber'));
  setupInputSanitization(document.getElementById('edit-trailer-drivername'));
  setupInputSanitization(document.getElementById('edit-trailer-phone'));
  setupInputSanitization(document.getElementById('edit-trailer-notes'));
  
  // Phone formatting on input
  const phoneInput = document.getElementById('edit-trailer-phone');
  if (phoneInput) {
    phoneInput.addEventListener('blur', (e) => {
      e.target.value = formatPhoneNumber(e.target.value);
    });
  }
  
  // Setup carrier autocomplete for edit modal (custom handler)
  setupEditModalCarrierAutocomplete();
  
  // Focus on customer field first
  setTimeout(() => {
    document.getElementById('edit-trailer-customer')?.focus();
  }, 100);
  
  // Close handlers
  modal.querySelectorAll('.close-modal').forEach(btn => {
    btn.addEventListener('click', () => modal.remove());
  });
  
  // Save handler - only send changed fields
  document.getElementById('btn-save-trailer')?.addEventListener('click', async () => {
    const newValues = {
      carrier: document.getElementById('edit-trailer-carrier')?.value?.trim(),
      status: document.getElementById('edit-trailer-status')?.value,
      contents: document.getElementById('edit-trailer-notes')?.value?.trim() || null,
      customer: document.getElementById('edit-trailer-customer')?.value?.trim() || null,
      driverName: document.getElementById('edit-trailer-drivername')?.value?.trim() || null,
      driverPhone: document.getElementById('edit-trailer-phone')?.value?.trim() || null,
      appointmentTime: document.getElementById('edit-trailer-appt')?.value || null,
      loadNumber: document.getElementById('edit-trailer-loadnumber')?.value?.trim() || null,
      number: document.getElementById('edit-trailer-number')?.value?.trim()  || null,
      isLive: document.getElementById('edit-trailer-live')?.checked || false
    };
    
    // Only include fields that actually changed
    const updates = {};
    
    // Compare each field with original (same pattern for all optional fields)
    if (newValues.carrier !== trailer.carrier) updates.carrier = newValues.carrier;
    if (newValues.status !== trailer.status) updates.status = newValues.status;
    if (newValues.isLive !== (trailer.isLive || false)) updates.isLive = newValues.isLive;
    if (newValues.contents !== (trailer.contents || null)) updates.contents = newValues.contents;
    if (newValues.customer !== (trailer.customer || null)) updates.customer = newValues.customer;
    if (newValues.driverName !== (trailer.driverName || null)) updates.driverName = newValues.driverName;
    if (newValues.driverPhone !== (trailer.driverPhone || null)) updates.driverPhone = newValues.driverPhone;
    if (newValues.appointmentTime !== (trailer.appointmentTime || null)) updates.appointmentTime = newValues.appointmentTime;
    if (newValues.loadNumber !== (trailer.loadNumber || null)) updates.loadNumber = newValues.loadNumber;
    if (newValues.number !== (trailer.number || null)) updates.number = newValues.number;
    
    // If nothing changed, just close the modal
    if (Object.keys(updates).length === 0) {
      modal.remove();
      return;
    }
    
    try {
      await updateTrailer(trailerId, updates);
      showToast('Trailer updated!', 'success');
      modal.remove();
      fetchState();
    } catch (error) {
      showToast(error.message, 'error');
    }
  });
  
  // Delete handler
  document.getElementById('btn-delete-trailer-edit')?.addEventListener('click', async () => {
    // Decode HTML entities for display in the confirm dialog
    const trailerName = trailer.number || trailer.carrier;
    const displayName = decodeHtml(trailerName);
    
    if (!confirm(`Delete trailer ${displayName}?\n\nThis cannot be undone.`)) {
      return;
    }
    try {
      await deleteTrailer(trailerId);
      showToast('Trailer deleted', 'success');
      modal.remove();
      fetchState();
    } catch (error) {
      showToast(error.message, 'error');
    }
  });
  
  // Ship trailer handler
  document.getElementById('btn-ship-trailer')?.addEventListener('click', async () => {
    if (!confirm(`📦 Mark trailer ${trailer.number || trailer.carrier} as SHIPPED?\n\nThe trailer will be:\n• Removed from active view\n• Preserved in history\n• Searchable by number/load\n• Reusable if it returns\n\nThis cannot be undone.`)) {
      return;
    }
    try {
      await shipTrailer(trailerId);
      showToast('Trailer marked as shipped', 'success');
      modal.remove();
      fetchState();
    } catch (error) {
      showToast(error.message, 'error');
    }
  });
  
  // Reset dwell time handler
  document.getElementById('btn-reset-dwell')?.addEventListener('click', async () => {
    const newCreatedAt = new Date().toISOString();
    try {
      await updateTrailer(trailerId, { createdAt: newCreatedAt });
      showToast('Dwell time reset!', 'success');
      // Update the preview text
      const dwellEl = modal.querySelector('.preview-dwell');
      if (dwellEl) {
        dwellEl.textContent = '⏱️ Dwell time: 0 hours';
        dwellEl.className = 'preview-dwell';
      }
    } catch (error) {
      showToast('Failed to reset dwell time: ' + error.message, 'error');
    }
  });
}

// ============================================================================
// Keyboard Shortcuts
// ============================================================================

function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Track shift key for bulk selection
    if (e.key === 'Shift') {
      isShiftPressed = true;
    }
    
    // Ctrl+K to focus search
    if (e.ctrlKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      const searchInput = document.getElementById('search-input');
      if (searchInput) {
        searchInput.focus();
        searchInput.select();
      }
    }
    
    // Esc to close modals
    if (e.key === 'Escape') {
      const activeModal = document.querySelector('.modal.active');
      if (activeModal && activeModal.id !== 'modal-trailer-edit' && activeModal.id !== 'modal-door-edit') {
        closeModal(activeModal.id);
      } else if (activeModal) {
        // Remove dynamically created modals
        if (activeModal.id === 'modal-trailer-edit' || activeModal.id === 'modal-door-edit' || activeModal.id === 'modal-add-door') {
          activeModal.remove();
        }
      }
      
      // Also clear selection if present
      if (selectedTrailers.size > 0) {
        clearSelection();
      }
    }
    
    // Ctrl+A to select all visible docked trailers
    if (e.ctrlKey && e.key.toLowerCase() === 'a' && !e.target.matches('input, textarea')) {
      e.preventDefault();
      const dockedTrailers = state.trailers.filter(t => t.doorNumber);
      dockedTrailers.forEach(t => selectedTrailers.add(t.id));
      updateSelectionUI();
      updateBulkActionUI();
      showToast(`Selected ${dockedTrailers.length} docked trailers`, 'info');
    }
  });
  
  document.addEventListener('keyup', (e) => {
    if (e.key === 'Shift') {
      isShiftPressed = false;
    }
  });
}

// ============================================================================
// Toast Notifications
// ============================================================================

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  
  container.appendChild(toast);
  
  // Trigger animation
  requestAnimationFrame(() => {
    toast.classList.add('show');
  });
  
  // Auto remove
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ============================================================================
// Time Picker Utility
// ============================================================================

function openTimePicker(targetInputId) {
  const input = document.getElementById(targetInputId);
  if (!input) return;

  const modal = document.createElement('div');
  modal.className = 'modal active';
  modal.id = 'modal-time-picker';
  
  // Default to current time or input value
  let currentHour = 12;
  let currentMinute = 0;
  
  if (input.value) {
    const [h, m] = input.value.split(':');
    currentHour = parseInt(h);
    currentMinute = parseInt(m);
  } else {
    const now = new Date();
    currentHour = now.getHours();
    // Round to nearest 15 min
    currentMinute = Math.ceil(now.getMinutes() / 15) * 15;
    if (currentMinute === 60) {
      currentMinute = 0;
      currentHour = (currentHour + 1) % 24;
    }
  }

  // Generate time slots (15 min intervals)
  // We'll show a grid of hours, then minutes? Or just a list of common times?
  // Let's do a smart list: 6AM to 10PM in 30 min increments
  const slots = [];
  for (let h = 6; h <= 22; h++) {
    for (let m = 0; m < 60; m += 30) {
      slots.push({ h, m });
    }
  }
  
  const timeButtons = slots.map(t => {
    const isPM = t.h >= 12;
    const displayH = t.h % 12 || 12;
    const displayM = t.m.toString().padStart(2, '0');
    const value = `${t.h.toString().padStart(2, '0')}:${t.m.toString().padStart(2, '0')}`;
    const label = `${displayH}:${displayM} ${isPM ? 'PM' : 'AM'}`;
    return `<button class="time-picker-btn" data-value="${value}">${label}</button>`;
  }).join('');

  modal.innerHTML = `
    <div class="modal-content" style="max-width: 500px;">
      <div class="modal-header">
        <h3>🕒 Select Time</h3>
        <button class="close-modal">&times;</button>
      </div>
      <div class="time-picker-grid">
        ${timeButtons}
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" onclick="document.getElementById('${targetInputId}').value = ''; document.getElementById('modal-time-picker').remove();">Clear</button>
        <button class="btn btn-secondary close-modal">Cancel</button>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  modal.querySelectorAll('.time-picker-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      input.value = btn.dataset.value;
      modal.remove();
    });
  });
  
  modal.querySelectorAll('.close-modal').forEach(btn => {
    btn.addEventListener('click', () => modal.remove());
  });
  
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });
}

// ============================================================================
// First-Run Setup
// ============================================================================

// Check if setup is needed
async function checkSetupStatus() {
  try {
    const res = await fetch('/api/setup/status');
    const data = await res.json();
    return data.setupNeeded;
  } catch (e) {
    console.error('Failed to check setup status:', e);
    return false; // Assume setup done if we can't check
  }
}

// Show setup modal
function showSetupModal() {
  const modal = document.getElementById('setup-modal');
  const loginScreen = document.getElementById('login-screen');
  if (!modal) return;

  // Hide login screen completely
  if (loginScreen) loginScreen.classList.add('hidden');

  // Show modal (needs both hidden removed AND active added)
  modal.classList.remove('hidden');
  modal.classList.add('active');

  // Update summary when inputs change
  const updateSummary = () => {
    const doors = parseInt(document.getElementById('setup-doors')?.value) || 0;
    const yardSlots = parseInt(document.getElementById('setup-yard-slots')?.value) || 0;
    const summary = document.getElementById('setup-summary');
    if (summary) {
      summary.innerHTML = `<p>Total: <strong>${doors}</strong> doors + <strong>${yardSlots}</strong> yard slots</p>`;
    }
  };

  // Attach listeners
  ['setup-doors', 'setup-yard-slots', 'setup-dumpsters', 'setup-ramps'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', updateSummary);
      el.addEventListener('change', updateSummary);
    }
  });

  // Setup submit handler
  const submitBtn = document.getElementById('btn-setup-submit');
  if (submitBtn) {
    submitBtn.addEventListener('click', async () => {
      const form = document.getElementById('setup-form');
      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }

      const config = {
        numDoors: parseInt(document.getElementById('setup-doors').value) || 57,
        numYardSlots: parseInt(document.getElementById('setup-yard-slots').value) || 30,
        numDumpsters: parseInt(document.getElementById('setup-dumpsters').value) || 0,
        numRamps: parseInt(document.getElementById('setup-ramps').value) || 0,
        doorStart: parseInt(document.getElementById('setup-doors-start')?.value) || 1,
        yardStart: parseInt(document.getElementById('setup-yard-start')?.value) || 1
      };

      submitBtn.disabled = true;
      submitBtn.textContent = 'Creating...';

      try {
        const res = await fetch('/api/setup', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authState.token}`
          },
          body: JSON.stringify(config)
        });

        const data = await res.json();

        if (data.success) {
          showToast('Facility created successfully! Loading...', 'success');
          // Reload page to complete initialization with event listeners
          window.location.reload();
        } else {
          throw new Error(data.error || 'Setup failed');
        }
      } catch (e) {
        console.error('Setup error:', e);
        showToast(e.message || 'Failed to create facility', 'error');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Create Facility';
      }
    });
  }
}

// ============================================================================
// Initialization
// ============================================================================

document.addEventListener('DOMContentLoaded', async () => {
  console.log('[Init] DOMContentLoaded fired');

  // Setup is checked AFTER login (in updateAuthUI) for security
  // Just check auth status here
  await checkAuthStatus();
  await loadSettings();

  // Polling is started by updateAuthUI() when authenticated, don't start here

  setupModals();
  setupKeyboardShortcuts();
  
  // Time Picker buttons
  document.addEventListener('click', (e) => {
    if (e.target.closest('.btn-time-picker')) {
      const btn = e.target.closest('.btn-time-picker');
      const input = btn.previousElementSibling; // Assuming input is right before button in wrapper
      if (input && input.tagName === 'INPUT') {
        openTimePicker(input.id);
      }
    }
  });

  // Auth buttons
  document.getElementById('btn-login')?.addEventListener('click', () => openModal('modal-login'));
  document.getElementById('btn-logout')?.addEventListener('click', logout);
  
  // Login form handler (Modal)
  document.getElementById('login-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('login-username').value;
    const password = document.getElementById('login-password').value;
    await login(username, password);
  });

  // Login form handler (Full Page)
  document.getElementById('full-page-login-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('fp-login-username').value;
    const password = document.getElementById('fp-login-password').value;
    await login(username, password);
  });
  
  // Set up edit mode toggle with auth check
  document.getElementById('btn-edit-mode')?.addEventListener('click', () => {
    if (!authState.isAuthenticated) { showToast('Login required', 'warning'); openModal('modal-login'); return; }
    if (!editMode && !confirm(`🚨 EDIT MODE ACTIVATION 🚨\n\nWelcome to the danger zone.\n\nIn Edit Mode, you have the power to:\n  • Delete doors (and any trailers inside evaporate)\n  • Add/remove yard slots\n  • Rearrange the door grid layout\n  • Manage carriers and clear analytics data\n\n⚠️ These changes are immediate and permanent.\n\nThere is no "undo" button for bad decisions.\n\nProceed only if you know what you're doing.`)) return;
    editMode = !editMode;
    const btn = document.getElementById('btn-edit-mode');
    if (btn) { btn.textContent = editMode ? '✅ Done Editing' : '✏️ Edit Mode'; btn.classList.toggle('btn-warning'); btn.classList.toggle('btn-success'); }
    document.body.classList.toggle('edit-mode-active', editMode);
    renderDoors();
  });
  
  // Protected buttons
  document.getElementById('btn-view-history')?.addEventListener('click', () => { if (requireAuth()) { openModal('modal-history'); loadHistory(); } });
  document.getElementById('btn-view-shipped')?.addEventListener('click', () => { openModal('modal-shipped'); loadShipped(); });
  document.getElementById('btn-analytics')?.addEventListener('click', () => { if (requireAuth()) showAnalyticsModal(); });
  document.getElementById('btn-manage-carriers')?.addEventListener('click', () => { if (requireAuth()) { openModal('modal-carriers'); renderCarriersList(); } });
  document.getElementById('btn-settings')?.addEventListener('click', () => { if (requireAuth()) openSettingsModal(); });
  
  // Staging manual add button (opens full form modal)
  document.getElementById('btn-add-staging')?.addEventListener('click', () => openManualStagingModal());
  
  // Initialize sidebar resizing
  setupSidebarResizing();
});

// Sidebar Resizing Logic
function setupSidebarResizing() {
  const handles = document.querySelectorAll('.resize-handle-vertical');
  
  handles.forEach(handle => {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      
      const prevSection = handle.previousElementSibling;
      const nextSection = handle.nextElementSibling;
      const sidebar = handle.closest('.yard-sidebar');
      const isBottomHandle = handle.classList.contains('sidebar-bottom-handle');
      
      if (!sidebar) return;
      if (!isBottomHandle && (!prevSection || !nextSection)) return;
      
      const startY = e.clientY;
      // For bottom handle, we resize sidebar. For others, we resize sections.
      const targetElement = isBottomHandle ? sidebar : prevSection;
      const startHeight = targetElement.getBoundingClientRect().height;
      
      // Only needed for internal splitters
      const startNextHeight = nextSection ? nextSection.getBoundingClientRect().height : 0;
      
      handle.classList.add('active');
      document.body.style.cursor = isBottomHandle ? 'ns-resize' : 'row-resize';
      
      const onMouseMove = (moveEvent) => {
        const deltaY = moveEvent.clientY - startY;
        
        if (isBottomHandle) {
            const newHeight = Math.max(400, startHeight + deltaY);
            sidebar.style.height = `${newHeight}px`;
            sidebar.style.maxHeight = 'none';
        } else if (prevSection.id === 'staging-section') {
            const newPrevHeight = Math.max(100, startHeight + deltaY); 
            prevSection.style.flex = `0 0 ${newPrevHeight}px`;
        } else if (prevSection.id === 'appointment-queue-section') {
            const newPrevHeight = Math.max(100, startHeight + deltaY);
            prevSection.style.flex = `0 0 ${newPrevHeight}px`;
        } else {
            // Adjusting Queue (vs Yard)
            const newPrevHeight = Math.max(100, startHeight + deltaY);
            prevSection.style.flex = `0 0 ${newPrevHeight}px`;
            if (nextSection) nextSection.style.flex = `1 1 auto`;
        }
      };
      
      const onMouseUp = () => {
        handle.classList.remove('active');
        document.body.style.cursor = '';
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        
        // Save sidebar layout settings
        const sidebarEl = document.querySelector('.yard-sidebar');
        const stagingEl = document.getElementById('staging-section');
        const apptQueueEl = document.getElementById('appointment-queue-section');
        const queueEl = document.getElementById('queue-section');
        
        if (sidebarEl && stagingEl && queueEl) {
            const layout = {
                sidebarHeight: sidebarEl.style.height,
                stagingFlex: stagingEl.style.flex,
                apptQueueFlex: apptQueueEl?.style.flex,
                queueFlex: queueEl.style.flex
            };
            // Save silently without toast to avoid spamming
            apiCall('/settings', 'POST', { sidebarLayout: layout })
                .then(resp => { settings = { ...settings, ...resp.settings }; })
                .catch(e => console.error('Failed to save layout', e));
        }
      };
      
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  });
}
