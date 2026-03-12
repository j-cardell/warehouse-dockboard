/**
 * History routes
 * GET /history
 */

const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware");
const { loadHistory } = require("../state");

// Get history
router.get("/", requireAuth, (req, res) => {
  const facilityId = req.user.currentFacility || req.user.homeFacility;
  const { search, limit = 50, offset = 0, dateFrom, dateTo } = req.query;
  const history = loadHistory(facilityId);
  let entries = history.entries;

  // Date filtering
  if (dateFrom || dateTo) {
    const fromTime = dateFrom ? new Date(dateFrom).setHours(0, 0, 0, 0) : null;
    const toTime = dateTo ? new Date(dateTo).setHours(23, 59, 59, 999) : null;

    entries = entries.filter((e) => {
      const entryTime = new Date(e.timestamp).getTime();
      if (fromTime && entryTime < fromTime) return false;
      if (toTime && entryTime > toTime) return false;
      return true;
    });
  }

  if (search) {
    const searchLower = search.toLowerCase();
    entries = entries.filter((e) => {
      // Check basic fields
      const basicMatch =
        (e.trailerId && e.trailerId.toLowerCase().includes(searchLower)) ||
        (e.carrier && e.carrier.toLowerCase().includes(searchLower)) ||
        (e.doorNumber && e.doorNumber.toString().includes(searchLower)) ||
        (e.action && e.action.toLowerCase().includes(searchLower));

      if (basicMatch) return true;

      // Check trailer number (top-level or in updates)
      const trailerNum =
        e.trailerNumber || e.updates?.number || e.updates?.trailerNumber;
      if (
        trailerNum &&
        trailerNum.toString().toLowerCase().includes(searchLower)
      )
        return true;

      // Check load/shipment number (top-level or in updates)
      const loadNum = e.loadNumber || e.updates?.loadNumber;
      if (loadNum && loadNum.toString().toLowerCase().includes(searchLower))
        return true;

      // Check changes array for load numbers
      if (e.changes?.length > 0) {
        for (const change of e.changes) {
          const val = change.to?.toString().toLowerCase() || "";
          const fromVal = change.from?.toString().toLowerCase() || "";
          if (val.includes(searchLower) || fromVal.includes(searchLower))
            return true;
        }
      }

      return false;
    });
  }

  const total = entries.length;
  entries = entries.slice(parseInt(offset), parseInt(offset) + parseInt(limit));

  res.json({
    entries,
    total,
    offset: parseInt(offset),
    limit: parseInt(limit),
  });
});

module.exports = router;
