/**
 * Server-Sent Events (SSE) module
 * Pushes real-time updates to connected clients
 */

const { JWT_SECRET } = require("./config");
const jwt = require("jsonwebtoken");

// Connected clients Map: token -> res
const clients = new Map();

/**
 * Validate JWT token from SSE connection
 * Supports both Authorization header and query parameter
 */
function validateToken(authHeader, queryToken) {
  let token = null;

  // Try Authorization header first
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.substring(7);
  }
  // Fall back to query parameter (for EventSource which can't set headers)
  else if (queryToken) {
    token = queryToken;
  }

  if (!token) return null;

  try {
    return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  } catch (err) {
    return null;
  }
}

/**
 * Handle SSE connection
 * GET /api/events?token=xxx
 */
function handleSSE(req, res) {
  const token = validateToken(req.headers.authorization, req.query.token);
  if (!token) {
    return res.status(401).json({ error: "Authentication required" });
  }

  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering

  // Send initial connection event
  res.write(`event: connected\ndata: ${JSON.stringify({ userId: token.userId })}\n\n`);

  // Store client connection with facility context
  const clientId = `${token.userId}-${Date.now()}`;
  clients.set(clientId, { res, userId: token.userId, currentFacility: token.currentFacility });

  console.log(`[SSE] Client connected: ${clientId} (total: ${clients.size})`);

  // Send heartbeat every 30 seconds to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(":heartbeat\n\n");
  }, 30000);

  // Handle client disconnect
  req.on("close", () => {
    clearInterval(heartbeat);
    clients.delete(clientId);
    console.log(`[SSE] Client disconnected: ${clientId} (total: ${clients.size})`);
  });

  // Handle errors
  req.on("error", (err) => {
    console.error(`[SSE] Connection error: ${err.message}`);
    clearInterval(heartbeat);
    clients.delete(clientId);
  });
}

/**
 * Broadcast an event to all connected clients in a specific facility
 * @param {string} eventType - Type of event (update, delete, etc.)
 * @param {object} data - Event data
 * @param {string} excludeUserId - Optional user ID to exclude from broadcast
 * @param {string} facilityId - Facility ID to filter by (optional)
 */
function broadcast(eventType, data, excludeUserId = null, facilityId = null) {
  const message = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;

  for (const [clientId, client] of clients.entries()) {
    if (excludeUserId && client.userId === excludeUserId) continue;

    // If facilityId is specified, only send to clients in that facility
    if (facilityId && client.currentFacility !== facilityId) continue;

    try {
      client.res.write(message);
    } catch (err) {
      console.error(`[SSE] Failed to send to ${clientId}:`, err.message);
      clients.delete(clientId);
    }
  }
}

/**
 * Broadcast state change to clients in a specific facility
 * Used by routes after modifying state
 * @param {string} entity - Entity type (trailer, door, yard, etc.)
 * @param {string} action - Action performed (create, update, delete, move)
 * @param {object} data - Changed data
 * @param {string} facilityId - Facility ID to filter by (required for multi-facility)
 */
function broadcastStateChange(entity, action, data, facilityId) {
  broadcast("stateChange", {
    entity,
    action,
    data,
    facilityId,
    timestamp: new Date().toISOString(),
  }, null, facilityId);
}

/**
 * Broadcast a toast notification to all clients in a specific facility
 * Used for loader actions and other user-initiated events
 * @param {string} type - Toast type (success, info, warning, error)
 * @param {string} message - Toast message
 * @param {object} data - Additional data (loader name, trailer info, etc.)
 * @param {string} facilityId - Facility ID to filter by
 * @param {string} excludeUserId - Optional user ID to exclude (the user who triggered it)
 */
function broadcastToast(type, message, data = {}, facilityId, excludeUserId = null) {
  broadcast("toast", {
    type,
    message,
    data,
    facilityId,
    timestamp: new Date().toISOString(),
  }, excludeUserId, facilityId);
}

module.exports = {
  handleSSE,
  broadcast,
  broadcastStateChange,
  broadcastToast,
  clients,
};
