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

  // Date filtering - handle timezone properly
  if (dateFrom || dateTo) {
    // Convert entry timestamp to YYYY-MM-DD in local timezone for comparison
    const getEntryDate = (timestamp) => {
      const d = new Date(timestamp);
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };

    entries = entries.filter((e) => {
      const entryDate = getEntryDate(e.timestamp);
      if (dateFrom && entryDate < dateFrom) return false;
      if (dateTo && entryDate > dateTo) return false;
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
