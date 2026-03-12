/**
 * Server-Sent Events (SSE) for real-time updates
 * GET /api/events - SSE endpoint for clients to connect
 *
 * Clients connect here and receive push notifications when:
 * - Trailers are created/moved/deleted/shipped
 * - Doors/yard slots are modified
 * - Settings change
 */

const express = require("express");
const router = express.Router();

// Connected SSE clients
const clients = new Set();

/**
 * Broadcast an event to all connected clients
 * @param {string} eventType - Type of event (trailer:update, door:update, etc)
 * @param {object} data - Event data
 */
function broadcastEvent(eventType, data) {
  const event = JSON.stringify({
    type: eventType,
    data,
    timestamp: new Date().toISOString(),
  });

  clients.forEach((client) => {
    try {
      client.write(`event: ${eventType}\n`);
      client.write(`data: ${event}\n\n`);
    } catch (err) {
      // Client disconnected, will be cleaned up on next heartbeat
      console.error("[SSE] Failed to send to client:", err.message);
    }
  });

  console.log(`[SSE] Broadcast ${eventType} to ${clients.size} clients`);
}

// SSE endpoint - clients connect here
router.get("/", (req, res) => {
  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // Disable Nginx buffering

  // Send initial connection event
  res.write(`event: connected\n`);
  res.write(`data: ${JSON.stringify({ message: "SSE connected" })}\n\n`);

  // Add client to set
  clients.add(res);
  console.log(`[SSE] Client connected. Total: ${clients.size}`);

  // Send heartbeat every 30 seconds to keep connection alive
  const heartbeat = setInterval(() => {
    try {
      res.write(`event: heartbeat\n`);
      res.write(`data: ${JSON.stringify({ time: Date.now() })}\n\n`);
    } catch (err) {
      clearInterval(heartbeat);
      clients.delete(res);
      console.log("[SSE] Client disconnected (heartbeat failed)");
    }
  }, 30000);

  // Handle client disconnect
  req.on("close", () => {
    clearInterval(heartbeat);
    clients.delete(res);
    console.log(`[SSE] Client disconnected. Total: ${clients.size}`);
  });

  req.on("error", (err) => {
    clearInterval(heartbeat);
    clients.delete(res);
    console.error("[SSE] Client error:", err.message);
  });
});

module.exports = { router, broadcastEvent };
