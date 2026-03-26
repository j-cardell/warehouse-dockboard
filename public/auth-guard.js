// Auth Guard: Redirect loader/loading-tablet users to /loader, keep users on main app
(function() {
  const token = localStorage.getItem('dockboard_token');
  if (!token) return;

  try {
    // Parse JWT payload
    const base64Url = token.split('.')[1];
    if (!base64Url) return;

    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split('')
        .map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );

    const payload = JSON.parse(jsonPayload);

    // Redirect loader/loading-tablet users to /loader
    // Regular users stay on main app and can optionally use /loader
    if (payload.role === 'loader' || payload.role === 'loading-tablet') {
      window.location.replace('/loader');
    }
  } catch (e) {
    // Invalid token, ignore
  }
})();
