// Simple standalone script to fetch list
function switchTab(tab) {
    document.getElementById('tab-create').style.display = tab === 'create' ? 'block' : 'none';
    document.getElementById('tab-browse').style.display = tab === 'browse' ? 'block' : 'none';

    // Update active state on tab buttons
    const buttons = document.querySelectorAll('.search-tab');
    buttons.forEach((btn, index) => {
        if (index === 0) {
            // Create tab
            btn.classList.toggle('active', tab === 'create');
        } else {
            // Browse tab
            btn.classList.toggle('active', tab === 'browse');
        }
    });

    if (tab === 'browse') loadFiles();
}

async function loadFiles() {
    try {
        const res = await fetch('/api/archives', { headers: { 'Authorization': 'Bearer ' + localStorage.getItem('dockboard_token') } });
        const data = await res.json();

        // Update current facility display
        document.getElementById('facility-name-display').textContent = data.facilityName || 'Unknown Facility';

        if (data.archives.length === 0) {
            document.getElementById('file-list').innerHTML = '<p style="color:var(--text-muted); padding:2rem; text-align:center;">No archives found for this facility.</p>';
            return;
        }

        // Group archives by year/month
        const grouped = {};
        data.archives.forEach(f => {
            const date = new Date(f.created);
            const yearMonth = `${date.getFullYear()} / ${String(date.getMonth() + 1).padStart(2, '0')}`;
            if (!grouped[yearMonth]) grouped[yearMonth] = [];
            grouped[yearMonth].push(f);
        });

        // Sort year/month groups descending
        const sortedGroups = Object.keys(grouped).sort().reverse();

        let html = '';
        sortedGroups.forEach(yearMonth => {
            const [year, month] = yearMonth.split(' / ');
            html += `<div class="archive-month-group" style="margin-bottom:1.5rem;">`;
            html += `<h3 style="padding:0.5rem 1rem; background:var(--bg-primary); border-radius:var(--radius-md); margin-bottom:0.5rem; color:var(--text-secondary); font-size:1rem;">`;
            html += `📁 ${year} / ${month} <span style="color:var(--text-muted); font-size:0.85rem;">(${grouped[yearMonth].length} archive${grouped[yearMonth].length > 1 ? 's' : ''})</span>`;
            html += `</h3>`;
            html += `<div style="padding-left:1rem;">`;

            grouped[yearMonth].forEach(f => {
                const date = new Date(f.created).toLocaleString();
                const facilityBadge = f.facilityName
                    ? `<span style="background:var(--info); color:white; padding:2px 8px; border-radius:4px; font-size:0.75rem; margin-right:0.5rem;">${f.facilityName}</span>`
                    : '<span style="background:var(--text-muted); color:white; padding:2px 8px; border-radius:4px; font-size:0.75rem; margin-right:0.5rem;">Legacy</span>';

                html += `<div style="padding:12px; border-bottom:1px solid var(--border-color); display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">`;
                html += `<div style="display:flex; flex-direction:column; gap:0.25rem; flex:1;">`;
                html += `<div style="display:flex; align-items:center; gap:0.5rem;">`;
                html += `${facilityBadge}`;
                html += `<span style="font-weight:500;">${f.name}</span>`;
                html += `</div>`;
                html += `<span style="color:var(--text-muted); font-size:0.8rem;">${date} • ${(f.size/1024).toFixed(1)} KB</span>`;
                html += `</div>`;
                html += `<div style="display:flex; gap:0.5rem;">`;
                html += `<button class="btn btn-small btn-primary archive-action-btn" data-action="restore" data-filename="${encodeURIComponent(f.name)}">🔄 Restore</button>`;
                html += `<button class="btn btn-small btn-secondary archive-action-btn" data-action="download" data-filename="${encodeURIComponent(f.name)}">⬇️ Download</button>`;
                html += `<button class="btn btn-small btn-danger archive-action-btn" data-action="delete" data-filename="${encodeURIComponent(f.name)}">🗑️ Delete</button>`;
                html += `</div>`;
                html += `</div>`;
            });

            html += `</div></div>`;
        });

        document.getElementById('file-list').innerHTML = html;
    } catch (e) {
        document.getElementById('file-list').innerHTML = '<p style="color:var(--danger); padding:2rem;">Error: ' + e.message + '</p>';
    }
}

// Restore archive directly
async function restoreArchive(encodedFilename) {
    if (!confirm('⚠️ WARNING: This will overwrite ALL current data!\n\nAre you sure you want to restore from this archive?')) {
        return;
    }

    const resultDiv = document.getElementById('upload-result');
    resultDiv.innerHTML = '<p style="color:var(--text-secondary)">Downloading and restoring...</p>';

    try {
        // First download the archive (filename is already encoded from onclick)
        const res = await fetch(`/api/archives/${encodedFilename}`, {
            headers: { 'Authorization': 'Bearer ' + localStorage.getItem('dockboard_token') }
        });
        if (!res.ok) throw new Error('Failed to download archive');
        const data = await res.json();

        // Then perform restore
        await performRestore(data, false);
    } catch (e) {
        resultDiv.innerHTML = `<p style="color:#ef4444;">❌ Error: ${e.message}</p>`;
    }
}

// Delete archive
async function deleteArchive(encodedFilename) {
    if (!confirm(`Are you sure you want to delete "${decodeURIComponent(encodedFilename)}"?\n\nThis action cannot be undone.`)) {
        return;
    }

    try {
        const res = await fetch(`/api/archives/${encodedFilename}`, {
            method: 'DELETE',
            headers: { 'Authorization': 'Bearer ' + localStorage.getItem('dockboard_token') }
        });
        const data = await res.json();

        if (data.success) {
            alert('Archive deleted successfully');
            loadFiles(); // Refresh the list
        } else {
            throw new Error(data.error || 'Failed to delete');
        }
    } catch (e) {
        alert('Error: ' + e.message);
    }
}

async function createArchive() {
    const btn = document.querySelector('#tab-create button');
    const result = document.getElementById('create-result');
    btn.disabled = true;
    btn.textContent = 'Creating...';
    result.innerHTML = '';

    try {
        const res = await fetch('/api/archives', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + localStorage.getItem('dockboard_token') }
        });
        const data = await res.json();
        if (data.success) {
            const facilityInfo = data.facilityName
                ? `<br><small style="color:var(--text-muted)">📍 Facility: ${data.facilityName}</small>`
                : '';
            result.innerHTML = `<p style="color:var(--success)">✅ Archive created: ${data.filename}${facilityInfo}</p>`;
        } else {
            throw new Error(data.error || 'Failed to create archive');
        }
    } catch (e) {
        result.innerHTML = `<p style="color:#ef4444;">❌ Error: ${e.message}</p>`;
    } finally {
        btn.disabled = false;
        btn.textContent = '📦 Create Archive Now';
    }
}

async function downloadArchive(encodedFilename) {
    const filename = decodeURIComponent(encodedFilename);
    try {
        const res = await fetch(`/api/archives/${encodedFilename}`, {
            headers: { 'Authorization': 'Bearer ' + localStorage.getItem('dockboard_token') }
        });
        if (!res.ok) throw new Error('Download failed');
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
    } catch (e) {
        alert('Download failed: ' + e.message);
    }
}

// Auth handling
function getToken() { return localStorage.getItem('dockboard_token'); }

async function checkAuth() {
    const token = getToken();
    if (!token) {
        showLogin();
        return false;
    }
    // Verify token is valid
    try {
        const res = await fetch('/api/auth/status', { headers: { 'Authorization': `Bearer ${token}` } });
        const data = await res.json();
        if (data.authenticated) {
            hideLogin();
            return true;
        } else {
            localStorage.removeItem('dockboard_token');
            showLogin();
            return false;
        }
    } catch (e) {
        showLogin();
        return false;
    }
}

function showLogin() {
    document.getElementById('login-screen').style.display = 'flex';
    document.querySelector('.archive-container').style.display = 'none';
}

function hideLogin() {
    document.getElementById('login-screen').style.display = 'none';
    document.querySelector('.archive-container').style.display = 'block';
}

// Global variable to store current facility name
let currentFacilityName = 'Current Facility';

// Check auth on page load
checkAuth().then(() => {
    // Load current facility info for display
    loadCurrentFacilityInfo();
});

// Load current facility info
async function loadCurrentFacilityInfo() {
    try {
        const token = localStorage.getItem('dockboard_token');
        const res = await fetch('/api/auth/status', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();

        if (data.authenticated && data.user) {
            const facilityName = data.user.currentFacilityName || data.user.homeFacilityName || 'Unknown Facility';
            currentFacilityName = facilityName;
            document.getElementById('create-facility-name').textContent = facilityName;
        }
    } catch (e) {
        console.error('Failed to load facility info:', e);
    }
}

// Archive upload handler
async function handleArchiveUpload(input) {
    const file = input.files[0];
    if (!file) return;

    const resultDiv = document.getElementById('upload-result');
    resultDiv.innerHTML = '<p style="color:var(--text-secondary)">Reading file...</p>';

    try {
        // Read file
        const text = await file.text();
        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            throw new Error('Invalid JSON file');
        }

        // Extract facility info from archive metadata
        const sourceFacilityId = data._archiveMetadata?.facilityId;
        const sourceFacilityName = data._archiveMetadata?.facilityName || 'Unknown Facility';
        const archiveCreatedAt = data._archiveMetadata?.createdAt;
        const hasMetadata = !!data._archiveMetadata;

        // Show initial confirmation with facility info
        let confirmMessage = `⚠️ WARNING: This will overwrite ALL current data!\n\n`;

        if (hasMetadata) {
            confirmMessage += `📍 Source Facility: ${sourceFacilityName}\n`;
        } else {
            confirmMessage += `📍 Source Facility: Unknown (legacy archive)\n`;
        }
        confirmMessage += `📍 Target Facility: ${currentFacilityName}\n\n`;
        confirmMessage += `File: ${file.name}\n`;
        confirmMessage += `Size: ${(file.size/1024).toFixed(1)} KB\n`;
        if (hasMetadata && archiveCreatedAt) {
            confirmMessage += `📅 Created: ${new Date(archiveCreatedAt).toLocaleString()}\n`;
        }
        confirmMessage += `\nContinue with restore?`;

        if (!confirm(confirmMessage)) {
            resultDiv.innerHTML = '';
            input.value = '';
            return;
        }

        await performRestore(data, false);
    } catch (e) {
        resultDiv.innerHTML = `<p style="color:#ef4444;">❌ Error: ${e.message}</p>`;
    } finally {
        input.value = '';
    }
}

// Perform restore with optional confirmation for cross-facility
async function performRestore(data, confirmed = false) {
    const resultDiv = document.getElementById('upload-result');
    resultDiv.innerHTML = '<p style="color:var(--text-secondary)">Validating and restoring...</p>';

    // Build request body
    const requestBody = confirmed ? { ...data, confirmed: true } : data;

    // Send to server
    const res = await fetch('/api/archives/restore', {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + localStorage.getItem('dockboard_token'),
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
    });

    const result = await res.json();

    // Handle cross-facility warning (409)
    if (res.status === 409 && result.requiresConfirmation && result.warning) {
        const warning = result.warning;
        const crossFacilityMessage =
            `⚠️ CROSS-FACILITY RESTORE WARNING\n\n` +
            `This archive is from a different facility:\n` +
            `📍 Source: ${warning.sourceFacilityName}\n` +
            `📍 Target: ${warning.targetFacilityName || 'Current Facility'}\n\n` +
            `Are you sure you want to restore this data to your current facility?\n` +
            `This will overwrite all existing data!`;

        if (confirm(crossFacilityMessage)) {
            // Retry with confirmed flag
            await performRestore(data, true);
        } else {
            resultDiv.innerHTML = '<p style="color:var(--text-muted);">Restore cancelled.</p>';
        }
        return;
    }

    if (result.success) {
        const sourceInfo = result.sourceFacilityName
            ? `<br><small>📍 Source: ${result.sourceFacilityName}</small>`
            : '';

        resultDiv.innerHTML = `
            <div style="color:#4ade80; margin-top:1rem;">
                ✅ Restore successful!<br>
                Doors: ${result.doors}<br>
                Trailers: ${result.trailers}<br>
                Yard Slots: ${result.yardSlots}<br>
                <small>Backup created: ${result.backupCreated}</small>
                ${sourceInfo}
            </div>`;
        // Reload page after 2 seconds
        setTimeout(() => window.location.reload(), 2000);
    } else {
        throw new Error(result.error || 'Restore failed');
    }
}

// Setup event listeners for CSP compliance (no inline handlers)
document.addEventListener('DOMContentLoaded', () => {
    // Login form handler
    document.getElementById('login-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = document.getElementById('login-username').value;
        const password = document.getElementById('login-password').value;
        const errorDiv = document.getElementById('login-error');

        try {
            const res = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const data = await res.json();

            if (data.token) {
                localStorage.setItem('dockboard_token', data.token);
                errorDiv.style.display = 'none';
                hideLogin();
            } else {
                throw new Error('Login failed');
            }
        } catch (e) {
            errorDiv.textContent = 'Invalid credentials';
            errorDiv.style.display = 'block';
        }
    });

    // Tab buttons
    document.getElementById('tab-btn-create')?.addEventListener('click', () => switchTab('create'));
    document.getElementById('tab-btn-browse')?.addEventListener('click', () => switchTab('browse'));

    // Create archive button
    document.getElementById('btn-create-archive')?.addEventListener('click', createArchive);

    // Upload archive buttons
    document.getElementById('btn-upload-archive')?.addEventListener('click', () => {
        document.getElementById('archive-upload').click();
    });
    document.getElementById('archive-upload')?.addEventListener('change', (e) => {
        handleArchiveUpload(e.target);
    });

    // Archive action buttons (event delegation for dynamically created buttons)
    document.getElementById('file-list')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.archive-action-btn');
        if (!btn) return;

        const action = btn.dataset.action;
        const filename = btn.dataset.filename;

        if (action === 'restore') restoreArchive(filename);
        else if (action === 'download') downloadArchive(filename);
        else if (action === 'delete') deleteArchive(filename);
    });
});
