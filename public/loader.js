        // State
        // IMPORTANT: loading-tablet role is for SHARED DEVICES only
        // currentLoader = the tablet login (loading-tablet user)
        // selectedOperatorName = the actual loader who selected their name from the list
        // For individual loader accounts (loader role), currentLoader and selectedOperatorName are the same
        let currentLoader = null;        // The logged-in user (loading-tablet tablet or loader)
        let selectedOperatorName = null; // The selected loader for history tracking (only different for shared tablet)
        let currentDoorNumber = '';
        let currentTrailer = null;
        let token = localStorage.getItem('dockboard_token');
        let currentPin = '';
        let currentUserRole = null;      // Store role to determine if back button should show

        // Screens
        const screens = {
            pin: document.getElementById('screen-pin'),
            names: document.getElementById('screen-names'),
            door: document.getElementById('screen-door'),
            verify: document.getElementById('screen-verify'),
            notes: document.getElementById('screen-notes'),
            status: document.getElementById('screen-status'),
            confirm: document.getElementById('screen-confirm'),
            error: document.getElementById('screen-error'),
        };

        // Show a specific screen
        function showScreen(name) {
            console.log('[showScreen] Switching to:', name);
            Object.values(screens).forEach(s => {
                if (s) {
                    s.classList.remove('active');
                }
            });
            if (screens[name]) {
                screens[name].classList.add('active');
            } else {
                console.error('[showScreen] Screen not found:', name);
            }

            // Hide loader name on PIN screen, show on others
            const loaderDiv = document.getElementById('current-loader');
            if (loaderDiv) {
                if (name === 'pin') {
                    loaderDiv.style.visibility = 'hidden';
                } else {
                    loaderDiv.style.visibility = 'visible';
                }
            }
        }

        // Check auth and role
        async function checkAuth() {
            if (!token) {
                // Redirect to main login page
                window.location.href = '/';
                return false;
            }

            try {
                const res = await fetch('/api/auth/status', {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                const data = await res.json();

                if (!data.authenticated) {
                    // Token invalid/expired - redirect to main login page
                    token = null;
                    localStorage.removeItem('dockboard_token');
                    window.location.href = '/';
                    return false;
                }

                // Check if user is loading-tablet, loader, user, or admin
                if (!['loading-tablet', 'loader', 'user', 'admin'].includes(data.user.role)) {
                    // Wrong role - redirect to main app
                    window.location.href = '/';
                    return false;
                }

                // Always show the actual logged-in user in header
                currentLoader = data.user.username;
                currentUserRole = data.user.role;
                updateLoaderDisplay();

                // Show/hide back button based on role
                // Only show for user/admin - loader/loading-tablet stay on loader page
                const mainViewBtn = document.getElementById('btn-main-view');
                if (mainViewBtn) {
                    mainViewBtn.style.display = (data.user.role === 'user' || data.user.role === 'admin') ? '' : 'none';
                }

                // If loading-tablet role, show name selection for history tracking
                // Loader, user, and admin go straight to door entry
                if (data.user.role === 'loading-tablet') {
                    showScreen('names');
                } else {
                    // Regular loader, user, or admin - go straight to door entry
                    showScreen('door');
                }

                return true;
            } catch (err) {
                console.error('Auth check failed:', err);
                showScreen('pin');
                return false;
            }
        }

        // Handle PIN login
        async function loginWithPin(pin) {
            const username = document.getElementById('tablet-username')?.value?.trim();

            if (!username) {
                document.getElementById('pin-error').textContent = 'Enter username';
                document.getElementById('pin-error').style.display = 'block';
                return;
            }

            document.getElementById('loading').classList.add('active');
            document.getElementById('pin-error').style.display = 'none';

            try {
                const res = await fetch('/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: username, password: pin })
                });

                const data = await res.json();

                if (!res.ok || !data.success) {
                    throw new Error(data.error || 'Invalid credentials');
                }

                // Check if user has a facility assigned (loading-tablet or regular user)
                if (!data.user.homeFacility && !data.selectFacilityRequired) {
                    throw new Error('User not assigned to a facility');
                }

                // Store token
                token = data.token;
                localStorage.setItem('dockboard_token', token);

                // Set current loader username and update display
                currentLoader = data.user.username;
                updateLoaderDisplay();

                // Clear inputs
                document.getElementById('tablet-username').value = '';
                currentPin = '';
                updatePinDisplay();

                // Show name selection screen
                await loadLoaderNames();
                showScreen('names');

            } catch (err) {
                console.error('Login failed:', err);
                document.getElementById('pin-error').textContent = err.message || 'Invalid credentials';
                document.getElementById('pin-error').style.display = 'block';
                currentPin = '';
                updatePinDisplay();
            } finally {
                document.getElementById('loading').classList.remove('active');
            }
        }

        // Update PIN display
        function updatePinDisplay() {
            const display = document.getElementById('pin-display-content');
            const placeholder = document.getElementById('pin-placeholder');

            if (currentPin.length === 0) {
                // Show placeholder dots that don't reveal length
                if (placeholder) {
                    placeholder.style.display = '';
                } else {
                    display.innerHTML = '<span id="pin-placeholder" style="color: var(--text-muted); opacity: 0.5;">•••</span>';
                }
            } else {
                // Hide placeholder and show filled bullets
                if (placeholder) placeholder.style.display = 'none';
                // Create bullets for entered digits only, scale to fit container
                const bullets = '●'.repeat(currentPin.length);
                // Calculate letter spacing based on number of bullets (tighter spacing for more bullets)
                const letterSpacing = currentPin.length > 8 ? '0.05em' : currentPin.length > 5 ? '0.1em' : '0.2em';
                const fontSize = currentPin.length > 10 ? 'clamp(0.875rem, 2vw, 1.1rem)' : 'var(--font-md)';
                display.innerHTML = `<span style="color: var(--accent-light); letter-spacing: ${letterSpacing}; font-size: ${fontSize};">${bullets}</span>`;
            }
        }

        // Load loader names (for name selection - admin users with loader role)
        async function loadLoaderNames() {
            try {
                const res = await fetch('/api/loader/loaders', {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                const data = await res.json();
                console.log('[Loader] Loaders response:', data);

                // Loaders are already filtered by the API
                const loaders = data.loaders || [];
                console.log('[Loader] Loaders:', loaders);
                loaders.sort((a, b) => a.username.localeCompare(b.username));

                const grid = document.getElementById('name-grid');
                grid.innerHTML = '';

                loaders.forEach(loader => {
                    const btn = document.createElement('button');
                    btn.className = 'name-btn';
                    btn.textContent = loader.username;
                    btn.onclick = () => selectLoader(loader.username);
                    grid.appendChild(btn);
                });

                if (loaders.length === 0) {
                    grid.innerHTML = '<div style="grid-column: span 2; text-align: center; color: var(--text-muted); padding: 2rem;">No loader accounts found. Contact admin.</div>';
                }
            } catch (err) {
                console.error('Failed to load loaders:', err);
            }
        }

        // Select loader (for history tracking - actual user stays loading-tablet)
        function selectLoader(loaderName) {
            // Store the selected loader name for API calls
            selectedOperatorName = loaderName;
            currentDoorNumber = '';
            updateDoorDisplay();
            showScreen('door');
        }

        // Update loader display with logout menu
        function updateLoaderDisplay() {
            const loaderDiv = document.getElementById('current-loader');
            if (currentLoader) {
                // Keep the logout menu, just update the text
                const textSpan = loaderDiv.querySelector('.loader-text') || document.createElement('span');
                textSpan.className = 'loader-text';
                textSpan.textContent = currentLoader;
                if (!loaderDiv.querySelector('.loader-text')) {
                    loaderDiv.insertBefore(textSpan, loaderDiv.firstChild);
                }
            }
        }

        // Toggle logout menu - support both click and touch
        const currentLoaderBtn = document.getElementById('current-loader');
        function toggleLogoutMenu(e) {
            if (e) {
                e.stopPropagation();
            }
            const menu = document.getElementById('logout-menu');
            menu?.classList.toggle('active');
        }

        currentLoaderBtn?.addEventListener('click', toggleLogoutMenu);
        currentLoaderBtn?.addEventListener('touchend', (e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleLogoutMenu(e);
        }, { passive: false });

        // Close menu when clicking elsewhere (but not when clicking the toggle button itself)
        document.addEventListener('click', (e) => {
            const menu = document.getElementById('logout-menu');
            const loaderBtn = document.getElementById('current-loader');
            if (menu?.classList.contains('active') && !loaderBtn?.contains(e.target)) {
                menu.classList.remove('active');
            }
        });

        // Show logout confirmation modal
        function confirmLogout() {
            const logoutModal = document.getElementById('logout-modal');
            if (logoutModal) {
                logoutModal.style.display = 'flex';
            }
            // Close the dropdown menu
            const menu = document.getElementById('logout-menu');
            if (menu) menu.classList.remove('active');
        }

        // Perform actual logout
        function doLogout() {
            // Clear token and state
            token = null;
            localStorage.removeItem('dockboard_token');
            currentLoader = null;
            selectedOperatorName = null;
            currentPin = '';
            updatePinDisplay();
            // Clear the username input
            const usernameInput = document.getElementById('tablet-username');
            if (usernameInput) usernameInput.value = '';
            // Clear the loader name text
            const loaderDiv = document.getElementById('current-loader');
            const textSpan = loaderDiv?.querySelector('.loader-text');
            if (textSpan) textSpan.remove();
            // Clear any error message
            const pinError = document.getElementById('pin-error');
            if (pinError) {
                pinError.textContent = 'Invalid credentials';
                pinError.style.display = 'none';
            }
            // Hide logout modal
            const logoutModal = document.getElementById('logout-modal');
            if (logoutModal) {
                logoutModal.style.display = 'none';
            }
            // Redirect to main login page
            window.location.href = '/';
        }

        // Cancel logout
        function cancelLogout() {
            const logoutModal = document.getElementById('logout-modal');
            if (logoutModal) {
                logoutModal.style.display = 'none';
            }
        }

        // Update door display
        function updateDoorDisplay() {
            const display = document.getElementById('door-display-content');
            if (currentDoorNumber) {
                display.innerHTML = `<span class="door-number">${currentDoorNumber}</span>`;
            } else {
                display.innerHTML = `<span class="door-placeholder">Enter door number</span>`;
            }
        }

        // PIN keypad handling
        document.querySelectorAll('[data-pin]').forEach(key => {
            key.addEventListener('click', () => {
                const k = key.dataset.pin;

                if (k === 'backspace') {
                    currentPin = currentPin.slice(0, -1);
                } else if (k === 'submit') {
                    if (currentPin.length >= 4) {
                        loginWithPin(currentPin);
                    }
                    return;
                } else {
                    currentPin += k;
                }

                updatePinDisplay();
            });

            // Remove active state after touch
            key.addEventListener('touchend', () => {
                key.blur();
            });
            key.addEventListener('touchcancel', () => {
                key.blur();
            });
        });

        // Door keypad handling
        document.querySelectorAll('[data-key]').forEach(key => {
            key.addEventListener('click', () => {
                const k = key.dataset.key;

                if (k === 'backspace') {
                    currentDoorNumber = currentDoorNumber.slice(0, -1);
                } else if (k === 'submit') {
                    submitDoor();
                } else if (currentDoorNumber.length < 3) {
                    currentDoorNumber += k;
                }

                updateDoorDisplay();
            });

            // Remove active state after touch
            key.addEventListener('touchend', () => {
                key.blur();
            });
            key.addEventListener('touchcancel', () => {
                key.blur();
            });
        });

        // Submit door number
        async function submitDoor() {
            if (!currentDoorNumber) return;

            document.getElementById('loading').classList.add('active');

            try {
                const res = await fetch('/api/loader/door', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify({ doorNumber: parseInt(currentDoorNumber) })
                });

                const data = await res.json();

                if (!res.ok) {
                    throw new Error(data.error || 'Failed to get door info');
                }

                if (!data.trailer) {
                    // No trailer at door - show error
                    showScreen('error');
                    return;
                }

                currentTrailer = data.trailer;

                // Show verification screen
                document.getElementById('verify-door-num').textContent = currentDoorNumber;
                document.getElementById('verify-trailer-num').textContent = data.trailer.number;
                document.getElementById('verify-carrier').textContent = data.trailer.carrier;
                showScreen('verify');

            } catch (err) {
                console.error('Error:', err);
                alert('Error: ' + err.message);
            } finally {
                document.getElementById('loading').classList.remove('active');
            }
        }

        // Helper to decode HTML entities
        function decodeHtmlEntities(text) {
            if (!text) return '';
            const textarea = document.createElement('textarea');
            textarea.innerHTML = text;
            return textarea.value;
        }

        // Verification buttons
        document.getElementById('btn-yes').addEventListener('click', () => {
            // Check if trailer has notes
            if (currentTrailer?.notes && currentTrailer.notes.trim()) {
                // Show notes screen first
                document.getElementById('trailer-notes-text').textContent = decodeHtmlEntities(currentTrailer.notes);
                showScreen('notes');
            } else {
                // No notes, go straight to status selection
                showStatusScreen();
            }
        });

        // Notes screen tap to dismiss
        document.getElementById('screen-notes').addEventListener('click', () => {
            showStatusScreen();
        });

        // Helper to show status screen
        function showStatusScreen() {
            document.getElementById('status-door-num').textContent = currentDoorNumber;
            document.getElementById('status-trailer-info').textContent = `${currentTrailer.carrier} ${currentTrailer.number}`;

            // Show direction badge
            const isInbound = currentTrailer.direction === 'inbound';
            const directionBadge = document.getElementById('trailer-direction-badge');
            if (isInbound) {
                directionBadge.innerHTML = '<span style="color: #3b82f6;">📥 INBOUND</span>';
            } else {
                directionBadge.innerHTML = '<span style="color: #f59e0b;">📤 OUTBOUND</span>';
            }

            // Build status buttons based on direction
            const buttonsContainer = document.getElementById('status-buttons-container');
            buttonsContainer.innerHTML = '';

            if (isInbound) {
                // Inbound: Loaded (green), Empty (amber), Received (blue final state)
                buttonsContainer.innerHTML = `
                    <button class="status-btn status-btn-loaded" id="btn-loaded">
                        <span class="status-label">LOADED</span>
                    </button>
                    <button class="status-btn status-btn-empty" id="btn-empty">
                        <span class="status-label">EMPTY</span>
                    </button>
                    <button class="status-btn status-btn-received" id="btn-received">
                        <span class="status-label">RECEIVED</span>
                    </button>
                `;
            } else {
                // Outbound: Empty (amber), Loaded (green), Shipped (final state)
                buttonsContainer.innerHTML = `
                    <button class="status-btn status-btn-empty" id="btn-empty">
                        <span class="status-label">EMPTY</span>
                    </button>
                    <button class="status-btn status-btn-loaded" id="btn-loaded">
                        <span class="status-label">LOADED</span>
                    </button>
                    <button class="status-btn status-btn-shipped" id="btn-shipped">
                        <span class="status-label">SHIPPED</span>
                    </button>
                `;
            }

            // Add event listeners to new buttons
            document.getElementById('btn-empty')?.addEventListener('click', () => updateStatus('empty'));
            document.getElementById('btn-loaded')?.addEventListener('click', () => updateStatus('loaded'));
            document.getElementById('btn-shipped')?.addEventListener('click', () => updateStatus('shipped'));
            document.getElementById('btn-received')?.addEventListener('click', () => updateStatus('received'));

            showScreen('status');
        }

        document.getElementById('btn-no').addEventListener('click', () => {
            showScreen('error');
        });

        // Update status
        async function updateStatus(status) {
            document.getElementById('loading').classList.add('active');

            try {
                let res, data;
                const operatorName = selectedOperatorName || currentLoader;

                if (status === 'shipped') {
                    // Ship the trailer
                    res = await fetch(`/api/trailers/${currentTrailer.id}/ship`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`
                        },
                        body: JSON.stringify({
                            loaderName: operatorName
                        })
                    });
                    data = await res.json();
                } else if (status === 'received') {
                    // Receive the trailer
                    res = await fetch(`/api/trailers/${currentTrailer.id}/receive`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`
                        },
                        body: JSON.stringify({
                            loaderName: operatorName
                        })
                    });
                    data = await res.json();
                } else {
                    // Regular status update (empty/loaded)
                    res = await fetch('/api/loader/status', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`
                        },
                        body: JSON.stringify({
                            doorNumber: parseInt(currentDoorNumber),
                            status: status,
                            loaderName: operatorName
                        })
                    });
                    data = await res.json();
                }

                if (!res.ok) {
                    throw new Error(data.error || 'Failed to update status');
                }

                // Show confirmation with operator name
                document.getElementById('confirm-details').textContent =
                    `${operatorName} marked ${currentTrailer.carrier} ${currentTrailer.number} as ${status.toUpperCase()} at Door ${currentDoorNumber}`;
                showScreen('confirm');

                // Auto-return after 3 seconds
                setTimeout(() => {
                    resetToNameSelection();
                }, 3000);

            } catch (err) {
                console.error('Error:', err);
                alert('Error: ' + err.message);
            } finally {
                document.getElementById('loading').classList.remove('active');
            }
        }

        // Reset to name selection (operator must re-select their name)
        function resetToNameSelection() {
            currentDoorNumber = '';
            currentTrailer = null;
            selectedOperatorName = null; // Clear operator so they must select again
            updateDoorDisplay();
            showScreen('names');
        }

        // Error screen tap to reset
        document.getElementById('screen-error').addEventListener('click', resetToNameSelection);

        // Confirmation screen tap to reset
        document.getElementById('screen-confirm').addEventListener('click', resetToNameSelection);

        // iOS Safari fix: ensure logout item is clickable via touch events
        const logoutItem = document.querySelector('.logout-item');
        if (logoutItem) {
            logoutItem.addEventListener('touchend', (e) => {
                e.preventDefault();
                e.stopPropagation();
                confirmLogout();
            });
            // Also ensure click works
            logoutItem.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                confirmLogout();
            });
        }

        // Logout modal button handlers
        document.getElementById('btn-confirm-logout')?.addEventListener('click', doLogout);
        document.getElementById('btn-cancel-logout')?.addEventListener('click', cancelLogout);
        document.getElementById('logout-modal')?.addEventListener('click', (e) => {
            // Close if clicking outside the card
            if (e.target.id === 'logout-modal') {
                cancelLogout();
            }
        });

        // Header click to refresh page
        document.getElementById('header-title')?.addEventListener('click', () => {
            window.location.reload();
        });

        // Back to main app button - only show for user/admin roles (not loading-tablet or loader)
        document.getElementById('btn-main-view')?.addEventListener('click', () => {
            window.location.href = '/';
        });

        // Initialize
        async function init() {
            // Quick synchronous check - if no token, redirect to main login immediately
            if (!token) {
                window.location.href = '/';
                return;
            }

            // Show loading state while we verify
            document.body.style.opacity = '0.5';
            const authed = await checkAuth();
            document.body.style.opacity = '1';

            // checkAuth() already shows the correct screen:
            // - loading-tablet: shows name selection (then we load names)
            // - loader/admin: shows door entry (no name selection needed)
            if (authed) {
                await loadLoaderNames();
            }
        }

        init();
