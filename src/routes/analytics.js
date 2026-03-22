/**
 * Analytics routes
 * GET /analytics, GET /analytics/violations, GET /analytics/heatmap, etc.
 *
 * Provides dwell time statistics, violation tracking, and heatmap data
 * for analyzing trailer movement patterns and door utilization.
 */

/**
 * Analytics routes
 * GET /analytics, GET /analytics/violations, GET /analytics/heatmap, etc.
 *
 * Provides dwell time statistics, violation tracking, and heatmap data
 * for analyzing trailer movement patterns and door utilization.
 */

const express = require("express");
const router = express.Router();
const { requireAuth, requireRole } = require("../middleware");
const { MULTI_FACILITY_MODE } = require("../config");
const { getAllFacilities, getFacility } = require("../facilities");
const {
  loadState,
  loadSettings,
  loadHistory,
  saveSettings,
  addHistoryEntry,
  saveAnalytics,
} = require("../state");
const {
  loadAnalytics,
  getDwellViolations,
  recordDwellSnapshot,
  calculateDailyDwell,
  getEffectiveDwellHours,
} = require("../analytics");
const ExcelJS = require("exceljs");

/**
 * Load combined analytics from multiple facilities
 * @param {string[]} facilityIds - Array of facility IDs to include
 * @returns {Object} Combined analytics data
 */
function loadCombinedAnalytics(facilityIds) {
  const combined = {
    snapshots: [],
    dailyStats: {},
    weeklyStats: {},
    monthlyStats: {}
  };

  facilityIds.forEach(id => {
    const analytics = loadAnalytics(id);

    // Combine snapshots
    if (analytics.snapshots) {
      combined.snapshots.push(...analytics.snapshots);
    }

    // Merge daily stats (average when multiple facilities have data for same day)
    if (analytics.dailyStats) {
      Object.entries(analytics.dailyStats).forEach(([date, stats]) => {
        // Support both old format (avgDwellTime/totalTrailers) and new format (avgDwell/count)
        const avgDwell = stats.avgDwell ?? stats.avgDwellTime ?? 0;
        const count = stats.count ?? stats.totalTrailers ?? 0;
        if (!combined.dailyStats[date]) {
          combined.dailyStats[date] = {
            date: stats.date,
            avgDwell,
            maxDwell: stats.maxDwell ?? 0,
            count,
            violations: stats.violations ?? 0,
            violators: stats.violators || [],
            calculatedAt: stats.calculatedAt,
            _facilityCount: 1,
            _totalDwell: avgDwell * count
          };
        } else {
          // Combine stats - weighted average for dwell, sum for counts
          const existing = combined.dailyStats[date];
          existing._facilityCount++;
          existing._totalDwell += avgDwell * count;
          existing.count += count;
          existing.maxDwell = Math.max(existing.maxDwell, stats.maxDwell || 0);
          existing.violations += stats.violations || 0;
          if (stats.violators) {
            existing.violators.push(...stats.violators);
          }
          // Recalculate average
          existing.avgDwell = existing.count > 0 ?
            Math.round((existing._totalDwell / existing.count) * 100) / 100 : 0;
          // Keep only top 10 violators
          existing.violators = existing.violators.slice(0, 10);
        }
      });
    }

    // Merge weekly stats
    if (analytics.weeklyStats) {
      Object.assign(combined.weeklyStats, analytics.weeklyStats);
    }

    // Merge monthly stats
    if (analytics.monthlyStats) {
      Object.assign(combined.monthlyStats, analytics.monthlyStats);
    }
  });

  // Clean up temporary fields
  Object.values(combined.dailyStats).forEach(stats => {
    delete stats._facilityCount;
    delete stats._totalDwell;
  });

  return combined;
}

/**
 * Get facility filter from request
 * @param {Object} req - Express request
 * @param {Object} user - Current user
 * @returns {Object} { facilityIds: string[], isCombined: boolean }
 */
function getFacilityFilter(req, user) {
  const { facilities } = req.query;
  const currentFacility = user.currentFacility || user.homeFacility;

  // Single facility mode - always use current
  if (!MULTI_FACILITY_MODE) {
    return { facilityIds: [currentFacility], isCombined: false };
  }

  // Default to current facility
  if (!facilities || facilities === 'current') {
    return { facilityIds: [currentFacility], isCombined: false };
  }

  // All facilities
  if (facilities === 'all') {
    const allFacilities = getAllFacilities();
    return {
      facilityIds: allFacilities.map(f => f.id),
      isCombined: allFacilities.length > 1
    };
  }

  // Comma-separated list of facility IDs
  const facilityIds = facilities.split(',').map(id => id.trim()).filter(Boolean);
  return {
    facilityIds: facilityIds.length > 0 ? facilityIds : [currentFacility],
    isCombined: facilityIds.length > 1
  };
}

// Analytics endpoint - uses daily aggregates calculated from history
router.get("/", requireAuth, (req, res) => {
  const { period = "day" } = req.query;
  const { facilityIds, isCombined } = getFacilityFilter(req, req.user);

  // Load analytics (single or combined)
  const analytics = isCombined
    ? loadCombinedAnalytics(facilityIds)
    : loadAnalytics(facilityIds[0]);

  const now = new Date();
  const result = {
    period,
    generatedAt: now.toISOString(),
    data: [],
    facilities: facilityIds,
    isCombined,
  };

  // Calculate today's data if missing (only for current facility, not combined)
  const today = now.toISOString().split("T")[0];
  if (!isCombined && !analytics.dailyStats?.[today]) {
    const facility = getFacility(facilityIds[0]);
    // Get timezone from facility config (multi-facility) or settings (single facility)
    let timezone = facility?.config?.timezone;
    if (!timezone) {
      const settings = loadSettings(facilityIds[0]);
      timezone = settings?.timezone || "UTC";
    }
    const todaysStats = calculateDailyDwell(today, facilityIds[0], timezone);
    if (todaysStats) {
      analytics.dailyStats[today] = todaysStats;
    }
  }

  if (period === "day") {
    // Last 7 days
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dateKey = d.toISOString().split("T")[0];
      const stats = analytics.dailyStats?.[dateKey];
      // Support both old format (avgDwellTime) and new format (avgDwell)
      const avgDwell = stats?.avgDwell ?? stats?.avgDwellTime ?? 0;
      const maxDwell = stats?.maxDwell ?? stats?.maxDwellTime ?? 0;
      const count = stats?.count ?? stats?.totalTrailers ?? 0;
      const violations = stats?.violations ?? 0;
      result.data.push({
        date: dateKey,
        label: d.toLocaleDateString("en-US", { weekday: "short" }),
        avgDwell,
        maxDwell,
        count,
        violations,
      });
    }
  } else if (period === "week") {
    // Last 4 weeks - aggregate from daily stats
    const weeks = {};
    Object.entries(analytics.dailyStats || {}).forEach(([date, stats]) => {
      const d = new Date(date);
      const weekStart = new Date(d);
      weekStart.setDate(d.getDate() - d.getDay());
      const weekKey = weekStart.toISOString().split("T")[0];

      if (!weeks[weekKey])
        weeks[weekKey] = {
          totalDwell: 0,
          maxDwell: 0,
          count: 0,
          violations: 0,
          days: 0,
        };
      weeks[weekKey].totalDwell += stats.avgDwell * stats.count;
      weeks[weekKey].maxDwell = Math.max(
        weeks[weekKey].maxDwell,
        stats.maxDwell || 0,
      );
      weeks[weekKey].count += stats.count;
      weeks[weekKey].violations += stats.violations || 0;
      weeks[weekKey].days++;
    });

    result.data = Object.entries(weeks)
      .sort((a, b) => new Date(a[0]) - new Date(b[0]))
      .slice(-4)
      .map(([week, stats]) => ({
        date: week,
        label: `Week of ${new Date(week).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`,
        avgDwell:
          stats.count > 0
            ? Math.round((stats.totalDwell / stats.count) * 100) / 100
            : 0,
        maxDwell: stats.maxDwell,
        count: stats.count,
        violations: stats.violations,
      }));
  } else if (period === "month") {
    // Last 3 months - aggregate from daily stats
    const months = {};
    Object.entries(analytics.dailyStats || {}).forEach(([date, stats]) => {
      const d = new Date(date);
      const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

      if (!months[monthKey])
        months[monthKey] = {
          totalDwell: 0,
          maxDwell: 0,
          count: 0,
          violations: 0,
          days: 0,
        };
      months[monthKey].totalDwell += stats.avgDwell * stats.count;
      months[monthKey].maxDwell = Math.max(
        months[monthKey].maxDwell,
        stats.maxDwell || 0,
      );
      months[monthKey].count += stats.count;
      months[monthKey].violations += stats.violations || 0;
      months[monthKey].days++;
    });

    result.data = Object.entries(months)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-3)
      .map(([month, stats]) => ({
        date: month,
        label: new Date(month + "-01").toLocaleDateString("en-US", {
          month: "long",
        }),
        avgDwell:
          stats.count > 0
            ? Math.round((stats.totalDwell / stats.count) * 100) / 100
            : 0,
        maxDwell: stats.maxDwell,
        count: stats.count,
        violations: stats.violations,
      }));
  }

  res.json(result);
});

// Force analytics snapshot (for testing)
router.post("/snapshot", requireAuth, requireRole("user"), (req, res) => {
  try {
    const facilityId = req.user.currentFacility || req.user.homeFacility;
    recordDwellSnapshot(facilityId);
    res.json({ success: true, message: "Snapshot recorded" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Clear all analytics history
router.delete("/", requireAuth, requireRole("admin"), (req, res) => {
  try {
    const facilityId = req.user.currentFacility || req.user.homeFacility;
    const { mode } = req.query;

    if (mode === "reset_start_date") {
      const settings = loadSettings(facilityId);
      settings.analyticsStartDate = new Date().toISOString();
      const { saveSettings } = require("../state");
      saveSettings(settings, facilityId);

      addHistoryEntry("ANALYTICS_START_DATE_RESET", {
        timestamp: settings.analyticsStartDate,
      }, req.user, facilityId);
      return res.json({
        success: true,
        message: "Analytics start date reset to now",
      });
    }

    const emptyAnalytics = {
      snapshots: [],
      dailyStats: {},
      weeklyStats: {},
      monthlyStats: {},
    };
    saveAnalytics(emptyAnalytics, facilityId);
    addHistoryEntry("ANALYTICS_CLEARED", {
      timestamp: new Date().toISOString(),
    }, req.user, facilityId);
    res.json({ success: true, message: "Analytics history cleared" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/violations", requireAuth, (req, res) => {
  try {
    const { period = "day", direction } = req.query;
    const { facilityIds, isCombined } = getFacilityFilter(req, req.user);

    // For combined view, aggregate from all facilities
    let combinedData = [];
    if (isCombined) {
      facilityIds.forEach(id => {
        const facility = getFacility(id);
        const timezone = facility?.config?.timezone || "UTC";
        const violations = getDwellViolations(period, id, timezone, direction);
        violations.forEach(v => {
          v._facility = id; // Tag with facility
        });
        combinedData.push(...violations);
      });

      // Merge by date
      const mergedByDate = {};
      combinedData.forEach(v => {
        if (!mergedByDate[v.date]) {
          mergedByDate[v.date] = { ...v, count: 0, avgDwellSum: 0, _facilityCount: 0 };
        }
        mergedByDate[v.date].count += v.count;
        mergedByDate[v.date].avgDwellSum += v.avgDwell || 0;
        mergedByDate[v.date]._facilityCount++;
        if (v.trailers) {
          mergedByDate[v.date].trailers = mergedByDate[v.date].trailers || [];
          mergedByDate[v.date].trailers.push(...v.trailers);
        }
        delete mergedByDate[v.date]._facility;
      });

      // Finalize
      combinedData = Object.values(mergedByDate).map(v => ({
        ...v,
        avgDwell: v._facilityCount > 0 ? v.avgDwellSum / v._facilityCount : 0,
        trailers: (v.trailers || []).slice(0, 20)
      }));
      combinedData.sort((a, b) => new Date(a.date) - new Date(b.date));
    }

    // For single facility, get timezone and pass to analytics
    let data;
    if (isCombined) {
      data = combinedData;
    } else {
      const facility = getFacility(facilityIds[0]);
      // Get timezone from facility config (multi-facility) or settings (single facility)
      let timezone = facility?.config?.timezone;
      if (!timezone) {
        const settings = loadSettings(facilityIds[0]);
        timezone = settings?.timezone || "UTC";
      }
      data = getDwellViolations(period, facilityIds[0], timezone, direction);
    }

    res.json({
      period,
      title: "Trailers Over 2 Hours",
      description:
        "Count of docked trailers exceeding 2 hours dwell time (excludes >6h)",
      generatedAt: new Date().toISOString(),
      data,
      facilities: facilityIds,
      isCombined,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get current violations (real-time) - docked trailers only
router.get("/current-violations", requireAuth, (req, res) => {
  try {
    const { facilityIds, isCombined } = getFacilityFilter(req, req.user);
    const { direction } = req.query;
    const now = Date.now();
    const allViolations = [];

    // Calculate actual dwell hours (not capped at 6) for violation detection
    const getActualDwellHours = (createdAt, resets = []) => {
      const created = new Date(createdAt).getTime();

      // If there were resets within 6h, calculate from the most recent one
      if (resets && resets.length > 0) {
        const recentResets = resets
          .map((r) => new Date(r).getTime())
          .filter((r) => now - r < 6 * 60 * 60 * 1000) // < 6h ago
          .sort((a, b) => b - a); // Newest first

        if (recentResets.length > 0) {
          return (now - recentResets[0]) / (1000 * 60 * 60);
        }
      }

      return (now - created) / (1000 * 60 * 60);
    };

    // Check violations across all selected facilities
    facilityIds.forEach((facilityId) => {
      const state = loadState(facilityId);
      const facilityViolations = [];

      // Only check live docked trailers (with door assignment)
      state.trailers.forEach((t) => {
        if (!t.createdAt || !t.doorId || !t.doorNumber) return;
        if (t.isLive !== true && t.isLive !== 'true') return; // Only count live trailers

        // Filter by direction if specified
        if (direction && t.direction !== direction) return;

        const resets = t.dwellResets || [];
        const actualDwellHours = getActualDwellHours(t.createdAt, resets);

        // 2+ hours is a violation (use actual hours, not capped)
        if (actualDwellHours >= 2) {
          facilityViolations.push({
            id: t.id,
            carrier: t.carrier,
            number: t.number,
            loadNumber: t.loadNumber,
            customer: t.customer,
            dwellHours: Math.round(actualDwellHours * 100) / 100,
            doorNumber: t.doorNumber,
            location: `Door ${t.doorNumber}`,
            status: t.status,
            direction: t.direction,
            facility: isCombined ? facilityId : undefined,
          });
        }
      });

      allViolations.push(...facilityViolations);
    });

    // Sort by dwell time descending (longest first)
    allViolations.sort((a, b) => b.dwellHours - a.dwellHours);

    res.json({
      count: allViolations.length,
      generatedAt: new Date().toISOString(),
      trailers: allViolations,
      facilities: facilityIds,
      isCombined,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get door heatmap data (carrier/customer filterable) - current facility only
router.get("/heatmap", requireAuth, (req, res) => {
  try {
    // Heatmap always shows current facility only - no multi-facility combining
    const facilityId = req.user.currentFacility || req.user.homeFacility;
    const state = loadState(facilityId);
    const { carrier, customer } = req.query;

    // Build door usage map
    const doorStats = {};

    // Initialize all doors
    state.doors.forEach((d) => {
      if (d.type !== "blank" && d.inService !== false) {
        doorStats[d.number] = {
          doorNumber: d.number,
          trailerCount: 0,
          loadedCount: 0,
          emptyCount: 0,
          carriers: {},
          customers: {},
        };
      }
    });

    // Count trailers at each door
    state.trailers.forEach((t) => {
      if (!t.doorNumber || !doorStats[t.doorNumber]) return;

      // Apply filters if provided
      if (carrier && t.carrier !== carrier) return;
      if (customer && t.customer !== customer) return;

      const stats = doorStats[t.doorNumber];
      stats.trailerCount++;

      if (t.status === "loaded") {
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
    const allCarriers = [
      ...new Set(state.trailers.map((t) => t.carrier).filter(Boolean)),
    ].sort();
    const allCustomers = [
      ...new Set(state.trailers.map((t) => t.customer).filter(Boolean)),
    ].sort();

    res.json({
      generatedAt: new Date().toISOString(),
      filters: { carrier, customer },
      availableCarriers: allCarriers,
      availableCustomers: allCustomers,
      facility: facilityId,
      doors: Object.values(doorStats).sort(
        (a, b) => a.doorNumber - b.doorNumber,
      ),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get position patterns from history (where do carrier/customer combos usually go)
router.get("/position-patterns", requireAuth, (req, res) => {
  try {
    const { facilityIds, isCombined } = getFacilityFilter(req, req.user);
    const { carrier, customer, dateFrom, dateTo, direction } = req.query;

    // Load and combine history from all selected facilities
    const allHistory = [];
    const allCarriersSet = new Set();
    const allCustomersSet = new Set();
    const trailerCustomers = {};

    const getCustomerFromChanges = (changes) => {
      if (!changes || !Array.isArray(changes)) return null;
      const customerChange = changes.find((c) => c.field === "customer");
      return customerChange ? customerChange.to : null;
    };

    // Get earliest analytics start date across all facilities
    let startDate = 0;
    facilityIds.forEach((facilityId) => {
      const settings = loadSettings(facilityId);
      if (settings.analyticsStartDate) {
        const facilityStart = new Date(settings.analyticsStartDate).getTime();
        startDate = Math.max(startDate, facilityStart);
      }
    });

    const fromDateParam = dateFrom ? new Date(dateFrom).getTime() : 0;
    const fromDate = Math.max(fromDateParam, startDate);
    const toDate = dateTo
      ? new Date(dateTo).getTime() + 24 * 60 * 60 * 1000
      : null;

    // Load current state to get customer data for trailers (fallback for old entries)
    const allTrailers = {};
    facilityIds.forEach((facilityId) => {
      const state = loadState(facilityId);
      state.trailers?.forEach((t) => {
        if (t.customer) allTrailers[t.id] = { customer: t.customer };
      });
      state.yardTrailers?.forEach((t) => {
        if (t.customer) allTrailers[t.id] = { customer: t.customer };
      });
      state.queuedTrailers?.forEach((t) => {
        if (t.customer) allTrailers[t.id] = { customer: t.customer };
      });
      if (state.staging?.customer) {
        allTrailers[state.staging.id] = { customer: state.staging.customer };
      }
    });

    // Load history from all selected facilities
    facilityIds.forEach((facilityId) => {
      const historyData = loadHistory(facilityId);
      const history = historyData.entries || historyData;

      history.forEach((entry) => {
        // Add facility info for combined view
        if (isCombined) {
          entry._facility = facilityId;
        }
        allHistory.push(entry);

        const entryCustomer =
          entry.customer ||
          entry.details?.customer ||
          getCustomerFromChanges(entry.changes) ||
          getCustomerFromChanges(entry.details?.changes) ||
          allTrailers[entry.trailerId]?.customer; // Fallback to current state

        if (entryCustomer && entry.trailerId) {
          trailerCustomers[entry.trailerId] = entryCustomer;
        }

        if (entry.carrier) allCarriersSet.add(entry.carrier);
        if (entryCustomer) allCustomersSet.add(entryCustomer);
      });
    });

    const doorFrequency = {};
    const comboStats = {};
    const trailerDirections = {}; // Track direction per trailer

    // Pre-load trailer directions from state
    facilityIds.forEach((facilityId) => {
      const state = loadState(facilityId);
      state.trailers?.forEach((t) => {
        if (t.id && t.direction) {
          trailerDirections[t.id] = t.direction;
        }
      });
      state.yardTrailers?.forEach((t) => {
        if (t.id && t.direction) {
          trailerDirections[t.id] = t.direction;
        }
      });
      state.queuedTrailers?.forEach((t) => {
        if (t.id && t.direction) {
          trailerDirections[t.id] = t.direction;
        }
      });
    });

    allHistory.forEach((entry) => {
      const entryTime = new Date(entry.timestamp).getTime();
      if (fromDate && entryTime < fromDate) return;
      if (toDate && entryTime > toDate) return;

      const doorNum = entry.doorNumber || entry.toDoorNumber;
      if (!doorNum) return;
      if (
        entry.action !== "MOVED_TO_DOOR" &&
        entry.action !== "TRAILER_CREATED"
      )
        return;

      const entryCustomer =
        trailerCustomers[entry.trailerId] ||
        entry.customer ||
        entry.details?.customer ||
        allTrailers[entry.trailerId]?.customer;
      const entryCarrier = entry.carrier;
      const entryDirection = entry.direction ||
        entry.details?.direction ||
        trailerDirections[entry.trailerId] ||
        'outbound'; // Default to outbound for backward compatibility

      if (carrier && entryCarrier !== carrier) return;
      if (customer && entryCustomer !== customer) return;
      if (direction && entryDirection !== direction) return;

      // For combined view, prefix door number with facility
      const doorKey = isCombined ? `${entry._facility}-Door ${doorNum}` : doorNum;

      if (!doorFrequency[doorKey]) {
        doorFrequency[doorKey] = { count: 0, carriers: {}, customers: {}, facility: entry._facility };
      }
      doorFrequency[doorKey].count++;

      if (entryCarrier) {
        doorFrequency[doorKey].carriers[entryCarrier] =
          (doorFrequency[doorKey].carriers[entryCarrier] || 0) + 1;
      }
      if (entryCustomer) {
        doorFrequency[doorKey].customers[entryCustomer] =
          (doorFrequency[doorKey].customers[entryCustomer] || 0) + 1;
      }

      if (entryCarrier && entryCustomer) {
        const comboKey = `${entryCarrier}|${entryCustomer}`;
        if (!comboStats[comboKey]) {
          comboStats[comboKey] = {
            carrier: entryCarrier,
            customer: entryCustomer,
            doors: {},
            total: 0,
          };
        }
        comboStats[comboKey].doors[doorNum] =
          (comboStats[comboKey].doors[doorNum] || 0) + 1;
        comboStats[comboKey].total++;
      }
    });

    const doorStats = Object.entries(doorFrequency)
      .map(([door, stats]) => ({
        doorNumber: parseInt(door),
        frequency: stats.count,
        carriers: Object.entries(stats.carriers).sort((a, b) => b[1] - a[1]),
        customers: Object.entries(stats.customers).sort((a, b) => b[1] - a[1]),
      }))
      .sort((a, b) => b.frequency - a.frequency);

    const allDoors = doorStats.map((d) => d.doorNumber).sort((a, b) => a - b);
    let doorRange = null;
    if (allDoors.length > 0) {
      const min = allDoors[0];
      const max = allDoors[allDoors.length - 1];
      const avg = allDoors.reduce((a, b) => a + b, 0) / allDoors.length;
      doorRange = { min, max, avg: Math.round(avg * 10) / 10 };
    }

    const allCarriers = [...allCarriersSet].sort();
    const allCustomers = [...allCustomersSet].sort();

    res.json({
      generatedAt: new Date().toISOString(),
      filters: { carrier: carrier || null, customer: customer || null },
      availableCarriers: allCarriers,
      availableCustomers: allCustomers,
      totalPlacements: Object.values(doorFrequency).reduce(
        (a, b) => a + b.count,
        0,
      ),
      doorRange,
      doorStats,
      topCombos: Object.values(comboStats)
        .sort((a, b) => b.total - a.total)
        .slice(0, 10)
        .map((c) => ({
          carrier: c.carrier,
          customer: c.customer,
          total: c.total,
          preferredDoors: Object.entries(c.doors)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([door, count]) => ({
              door: parseInt(door),
              count,
              percentage: Math.round((count / c.total) * 100),
            })),
        })),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Export violations to Excel with multiple sheets and chart
router.get("/export-violations", requireAuth, async (req, res) => {
  try {
    const { facilityIds, isCombined } = getFacilityFilter(req, req.user);
    const { direction } = req.query;
    const now = Date.now();

    // Modern color palette
    const colors = {
      primary: 'FF2563EB',
      primaryLight: 'FFDBEAFE',
      secondary: 'FF059669',
      secondaryLight: 'FFD1FAE5',
      accent: 'FF7C3AED',
      accentLight: 'FFE9D5FF',
      dark: 'FF1E293B',
      gray: 'FFF1F5F9',
      white: 'FFFFFFFF',
      border: 'FFE2E8F0',
      danger: 'FFDC2626',
      dangerLight: 'FFFEE2E2'
    };

    // Create workbook
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Warehouse Dock Board';
    workbook.created = new Date();

    // Get timezone from first facility
    const facility = getFacility(facilityIds[0]);
    let timezone = facility?.config?.timezone;
    if (!timezone) {
      const settings = loadSettings(facilityIds[0]);
      timezone = settings?.timezone || "UTC";
    }

    // Get actual dwell hours (not capped at 6)
    const getActualDwellHours = (createdAt, resets = []) => {
      const created = new Date(createdAt).getTime();
      if (resets && resets.length > 0) {
        const recentResets = resets
          .map((r) => new Date(r).getTime())
          .filter((r) => now - r < 6 * 60 * 60 * 1000)
          .sort((a, b) => b - a);
        if (recentResets.length > 0) {
          return (now - recentResets[0]) / (1000 * 60 * 60);
        }
      }
      return (now - created) / (1000 * 60 * 60);
    };

    // Helper functions
    const applyZebraStriping = (sheet, startRow, endRow) => {
      const colKeys = sheet.columns.map(col => col.key);
      for (let row = startRow; row <= endRow; row++) {
        if (row % 2 === 0) {
          colKeys.forEach(key => {
            const cell = sheet.getRow(row).getCell(key);
            cell.fill = {
              type: 'pattern',
              pattern: 'solid',
              fgColor: { argb: colors.gray.replace('FF', '') }
            };
          });
        }
      }
    };

    // === SHEET 1: Summary with metadata and historical counts ===
    const summarySheet = workbook.addWorksheet('Summary');

    // Title
    summarySheet.mergeCells('A1:E1');
    summarySheet.getCell('A1').value = 'Violations Report';
    summarySheet.getCell('A1').font = {
      size: 20,
      bold: true,
      color: { argb: 'FFFFFFFF' }
    };
    summarySheet.getCell('A1').fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFDC2626' }
    };
    summarySheet.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
    summarySheet.getRow(1).height = 35;

    // Metadata section
    summarySheet.getCell('A3').value = 'Export Details';
    summarySheet.getCell('A3').font = { size: 14, bold: true, color: { argb: 'FF1E293B' } };
    summarySheet.getCell('A3').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
    summarySheet.mergeCells('A3:E3');

    const metaData = [
      ['Generated', new Date().toLocaleString()],
      ['Facility Filter', isCombined ? 'all' : facilityIds[0]],
      ['Direction Filter', direction || 'all'],
    ];

    metaData.forEach((row, idx) => {
      const rowNum = 4 + idx;
      summarySheet.getCell(`A${rowNum}`).value = row[0];
      summarySheet.getCell(`B${rowNum}`).value = row[1];
      summarySheet.getCell(`A${rowNum}`).font = { bold: true, color: { argb: 'FF64748B' } };
      summarySheet.getCell(`B${rowNum}`).font = { color: { argb: 'FF1E293B' } };
      if (idx % 2 === 0) {
        summarySheet.getRow(rowNum).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
      }
    });

    // Current violations count
    let currentCount = 0;
    facilityIds.forEach((facilityId) => {
      const state = loadState(facilityId);
      state.trailers.forEach((t) => {
        if (!t.createdAt || !t.doorId || !t.doorNumber) return;
        if (t.isLive !== true && t.isLive !== 'true') return;
        if (direction && t.direction !== direction) return;

        const resets = t.dwellResets || [];
        const actualDwellHours = getActualDwellHours(t.createdAt, resets);
        if (actualDwellHours >= 2) currentCount++;
      });
    });

    summarySheet.getCell('A8').value = 'Current Violations (Trailers exceeding 2 hours)';
    summarySheet.getCell('A8').font = { size: 14, bold: true, color: { argb: 'FFFFFFFF' } };
    summarySheet.getCell('A8').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDC2626' } };
    summarySheet.mergeCells('A8:E8');
    summarySheet.getCell('A8').alignment = { horizontal: 'center' };

    summarySheet.getCell('A9').value = currentCount;
    summarySheet.getCell('A9').font = { size: 24, bold: true, color: { argb: 'FFDC2626' } };
    summarySheet.getCell('A9').alignment = { horizontal: 'center', vertical: 'middle' };
    summarySheet.mergeCells('A9:E9');
    summarySheet.getRow(9).height = 40;

    // Historical counts section
    summarySheet.getCell('A11').value = 'Historical Violation Counts (Last 7 days)';
    summarySheet.getCell('A11').font = { size: 14, bold: true, color: { argb: 'FF1E293B' } };
    summarySheet.getCell('A11').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
    summarySheet.mergeCells('A11:E11');

    // Headers
    summarySheet.getCell('A12').value = 'Date';
    summarySheet.getCell('B12').value = 'Day';
    summarySheet.getCell('C12').value = 'Inbound';
    summarySheet.getCell('D12').value = 'Outbound';
    summarySheet.getCell('E12').value = 'Total';
    // Style each header cell individually
    ['A', 'B', 'C', 'D', 'E'].forEach(col => {
      const cell = summarySheet.getCell(`${col}12`);
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });

    // Data rows
    const historicalData = [];
    const today = new Date();
    for (let i = 1; i <= 7; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      const dayOfWeek = date.toLocaleDateString('en-US', { weekday: 'short' });

      let inboundCount = 0;
      let outboundCount = 0;

      facilityIds.forEach((facilityId) => {
        const analytics = loadAnalytics(facilityId);
        const dailyStats = analytics.dailyStats?.[dateStr];

        if (dailyStats?.violators) {
          dailyStats.violators.forEach((v) => {
            if (direction && v.direction !== direction) return;
            if (v.direction === 'inbound') inboundCount++;
            else outboundCount++;
          });
        }
      });

      const row = 12 + i;
      summarySheet.getCell(`A${row}`).value = dateStr;
      summarySheet.getCell(`B${row}`).value = dayOfWeek;
      summarySheet.getCell(`C${row}`).value = inboundCount;
      summarySheet.getCell(`D${row}`).value = outboundCount;
      summarySheet.getCell(`E${row}`).value = inboundCount + outboundCount;
      summarySheet.getCell(`A${row}`).alignment = { horizontal: 'left' };
      summarySheet.getCell(`B${row}`).alignment = { horizontal: 'center' };
      summarySheet.getCell(`C${row}`).alignment = { horizontal: 'center' };
      summarySheet.getCell(`D${row}`).alignment = { horizontal: 'center' };
      summarySheet.getCell(`E${row}`).alignment = { horizontal: 'center' };

      // Zebra striping - only apply to cells with data
      if (i % 2 === 0) {
        ['A', 'B', 'C', 'D', 'E'].forEach(col => {
          summarySheet.getCell(`${col}${row}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
        });
      }

      historicalData.push({
        date: dateStr,
        dayOfWeek,
        inbound: inboundCount,
        outbound: outboundCount,
        total: inboundCount + outboundCount
      });
    }

    summarySheet.columns = [
      { width: 15 },
      { width: 10 },
      { width: 12 },
      { width: 12 },
      { width: 10 }
    ];

    // === SHEET 2: Current Violations Detail ===
    const currentViolations = [];
    facilityIds.forEach((facilityId) => {
      const state = loadState(facilityId);
      state.trailers.forEach((t) => {
        if (!t.createdAt || !t.doorId || !t.doorNumber) return;
        if (t.isLive !== true && t.isLive !== 'true') return;
        if (direction && t.direction !== direction) return;

        const resets = t.dwellResets || [];
        const actualDwellHours = getActualDwellHours(t.createdAt, resets);

        if (actualDwellHours >= 2) {
          currentViolations.push({
            trailerId: t.id,
            number: t.number || '',
            carrier: t.carrier || '',
            loadNumber: t.loadNumber || '',
            customer: t.customer || '',
            door: t.doorNumber,
            dwellHours: Math.round(actualDwellHours * 100) / 100,
            status: t.status,
            direction: t.direction || 'outbound',
            facility: facilityId,
            createdAt: new Date(t.createdAt).toLocaleString(),
          });
        }
      });
    });

    currentViolations.sort((a, b) => b.dwellHours - a.dwellHours);

    if (currentViolations.length > 0) {
      const currentSheet = workbook.addWorksheet('Current Violations');
      currentSheet.columns = [
        { header: 'Trailer ID', key: 'trailerId', width: 38 },
        { header: 'Number', key: 'number', width: 15 },
        { header: 'Carrier', key: 'carrier', width: 20 },
        { header: 'Load #', key: 'loadNumber', width: 15 },
        { header: 'Customer', key: 'customer', width: 20 },
        { header: 'Door', key: 'door', width: 10 },
        { header: 'Dwell Hours', key: 'dwellHours', width: 13 },
        { header: 'Status', key: 'status', width: 10 },
        { header: 'Direction', key: 'direction', width: 10 },
        { header: 'Facility', key: 'facility', width: 15 },
        { header: 'Created At', key: 'createdAt', width: 20 },
      ];

      currentViolations.forEach(v => currentSheet.addRow(v));

      // Modern header styling - apply to each column header individually
      const currentColKeys = ['trailerId', 'number', 'carrier', 'loadNumber', 'customer', 'door', 'dwellHours', 'status', 'direction', 'facility', 'createdAt'];
      currentColKeys.forEach(key => {
        const cell = currentSheet.getRow(1).getCell(key);
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFDC2626' }
        };
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
      });

      // Center align numeric columns
      currentSheet.getColumn('door').alignment = { horizontal: 'center' };
      currentSheet.getColumn('dwellHours').alignment = { horizontal: 'center' };
      currentSheet.getColumn('direction').alignment = { horizontal: 'center' };

      // Apply zebra striping
      applyZebraStriping(currentSheet, 2, currentViolations.length + 1);
    }

    // === SHEETS 3-9: Daily Historical Violation Detail ===
    for (let i = 1; i <= 7; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      const dayOfWeek = date.toLocaleDateString('en-US', { weekday: 'short' });
      const sheetName = `${dateStr} (${dayOfWeek})`;

      const violationsForDay = [];

      facilityIds.forEach((facilityId) => {
        const analytics = loadAnalytics(facilityId);
        const dailyStats = analytics.dailyStats?.[dateStr];

        if (dailyStats?.violators) {
          dailyStats.violators.forEach((v) => {
            if (direction && v.direction !== direction) return;

            violationsForDay.push({
              trailerId: v.trailerId || '',
              number: v.number || '',
              carrier: v.carrier || '',
              loadNumber: v.loadNumber || '',
              customer: v.customer || '',
              door: v.doorNumber || '',
              dwellHours: v.dwellHours ? v.dwellHours.toFixed(1) : 'N/A',
              direction: v.direction || 'outbound',
              facility: facilityId,
              recordedAt: v.recordedAt ? new Date(v.recordedAt).toLocaleString() : '',
            });
          });
        }
      });

      violationsForDay.sort((a, b) => parseFloat(b.dwellHours || 0) - parseFloat(a.dwellHours || 0));

      if (violationsForDay.length > 0) {
        const daySheet = workbook.addWorksheet(sheetName);
        daySheet.columns = [
          { header: 'Trailer ID', key: 'trailerId', width: 38 },
          { header: 'Number', key: 'number', width: 15 },
          { header: 'Carrier', key: 'carrier', width: 20 },
          { header: 'Load #', key: 'loadNumber', width: 15 },
          { header: 'Customer', key: 'customer', width: 20 },
          { header: 'Door', key: 'door', width: 10 },
          { header: 'Dwell Hours', key: 'dwellHours', width: 13 },
          { header: 'Direction', key: 'direction', width: 10 },
          { header: 'Facility', key: 'facility', width: 15 },
          { header: 'Recorded At', key: 'recordedAt', width: 20 },
        ];

        violationsForDay.forEach(v => daySheet.addRow(v));

        // Modern header styling with blue gradient effect - apply to each column individually
        const dayColKeys = ['trailerId', 'number', 'carrier', 'loadNumber', 'customer', 'door', 'dwellHours', 'direction', 'facility', 'recordedAt'];
        dayColKeys.forEach(key => {
          const cell = daySheet.getRow(1).getCell(key);
          cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF2563EB' }
          };
          cell.alignment = { vertical: 'middle', horizontal: 'center' };
        });

        // Center align numeric columns
        daySheet.getColumn('door').alignment = { horizontal: 'center' };
        daySheet.getColumn('dwellHours').alignment = { horizontal: 'center' };
        daySheet.getColumn('direction').alignment = { horizontal: 'center' };

        // Apply zebra striping
        applyZebraStriping(daySheet, 2, violationsForDay.length + 1);
      }
    }

    // Generate filename - prefix with facilityId or 'all'
    const facilityLabel = isCombined ? 'all' : facilityIds[0];
    const directionLabel = direction ? `${direction}-` : '';
    const filename = `${facilityLabel}-violations-${directionLabel}${new Date().toISOString().split('T')[0]}.xlsx`;

    // Write to buffer and send
    const buffer = await workbook.xlsx.writeBuffer();

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (error) {
    console.error('Excel export error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Export patterns to Excel
router.get("/export-patterns", requireAuth, async (req, res) => {
  try {
    const { facilityIds, isCombined } = getFacilityFilter(req, req.user);
    const { carrier, customer, dateFrom, dateTo, direction } = req.query;

    // Load and combine history from all selected facilities (same logic as /position-patterns)
    const allHistory = [];
    const allCarriersSet = new Set();
    const allCustomersSet = new Set();
    const trailerCustomers = {};

    const getCustomerFromChanges = (changes) => {
      if (!changes || !Array.isArray(changes)) return null;
      const customerChange = changes.find((c) => c.field === "customer");
      return customerChange ? customerChange.to : null;
    };

    // Get earliest analytics start date across all facilities
    let startDate = 0;
    facilityIds.forEach((facilityId) => {
      const settings = loadSettings(facilityId);
      if (settings.analyticsStartDate) {
        const facilityStart = new Date(settings.analyticsStartDate).getTime();
        startDate = Math.max(startDate, facilityStart);
      }
    });

    const fromDateParam = dateFrom ? new Date(dateFrom).getTime() : 0;
    const fromDate = Math.max(fromDateParam, startDate);
    const toDate = dateTo
      ? new Date(dateTo).getTime() + 24 * 60 * 60 * 1000
      : null;

    // Load current state to get customer data for trailers (fallback for old entries)
    const allTrailers = {};
    facilityIds.forEach((facilityId) => {
      const state = loadState(facilityId);
      state.trailers?.forEach((t) => {
        if (t.customer) allTrailers[t.id] = { customer: t.customer };
      });
      state.yardTrailers?.forEach((t) => {
        if (t.customer) allTrailers[t.id] = { customer: t.customer };
      });
      state.queuedTrailers?.forEach((t) => {
        if (t.customer) allTrailers[t.id] = { customer: t.customer };
      });
      if (state.staging?.customer) {
        allTrailers[state.staging.id] = { customer: state.staging.customer };
      }
    });

    // Load history from all selected facilities
    facilityIds.forEach((facilityId) => {
      const historyData = loadHistory(facilityId);
      const history = historyData.entries || historyData;

      history.forEach((entry) => {
        // Add facility info for combined view
        if (isCombined) {
          entry._facility = facilityId;
        }
        allHistory.push(entry);

        const entryCustomer =
          entry.customer ||
          entry.details?.customer ||
          getCustomerFromChanges(entry.changes) ||
          getCustomerFromChanges(entry.details?.changes) ||
          allTrailers[entry.trailerId]?.customer;

        if (entryCustomer && entry.trailerId) {
          trailerCustomers[entry.trailerId] = entryCustomer;
        }

        if (entry.carrier) allCarriersSet.add(entry.carrier);
        if (entryCustomer) allCustomersSet.add(entryCustomer);
      });
    });

    // Pre-load trailer directions from state
    const trailerDirections = {};
    facilityIds.forEach((facilityId) => {
      const state = loadState(facilityId);
      state.trailers?.forEach((t) => {
        if (t.id && t.direction) {
          trailerDirections[t.id] = t.direction;
        }
      });
      state.yardTrailers?.forEach((t) => {
        if (t.id && t.direction) {
          trailerDirections[t.id] = t.direction;
        }
      });
      state.queuedTrailers?.forEach((t) => {
        if (t.id && t.direction) {
          trailerDirections[t.id] = t.direction;
        }
      });
    });

    // Calculate door frequency and combo stats
    const doorFrequency = {};
    const comboStats = {};

    allHistory.forEach((entry) => {
      const entryTime = new Date(entry.timestamp).getTime();
      if (fromDate && entryTime < fromDate) return;
      if (toDate && entryTime > toDate) return;

      const doorNum = entry.doorNumber || entry.toDoorNumber;
      if (!doorNum) return;
      if (
        entry.action !== "MOVED_TO_DOOR" &&
        entry.action !== "TRAILER_CREATED"
      )
        return;

      const entryCustomer =
        trailerCustomers[entry.trailerId] ||
        entry.customer ||
        entry.details?.customer ||
        allTrailers[entry.trailerId]?.customer;
      const entryCarrier = entry.carrier;
      const entryDirection = entry.direction ||
        entry.details?.direction ||
        trailerDirections[entry.trailerId] ||
        'outbound';

      if (carrier && entryCarrier !== carrier) return;
      if (customer && entryCustomer !== customer) return;
      if (direction && entryDirection !== direction) return;

      // For combined view, prefix door number with facility
      const doorKey = isCombined ? `${entry._facility}-Door ${doorNum}` : doorNum;

      if (!doorFrequency[doorKey]) {
        doorFrequency[doorKey] = { count: 0, carriers: {}, customers: {}, facility: entry._facility };
      }
      doorFrequency[doorKey].count++;

      if (entryCarrier) {
        doorFrequency[doorKey].carriers[entryCarrier] =
          (doorFrequency[doorKey].carriers[entryCarrier] || 0) + 1;
      }
      if (entryCustomer) {
        doorFrequency[doorKey].customers[entryCustomer] =
          (doorFrequency[doorKey].customers[entryCustomer] || 0) + 1;
      }

      if (entryCarrier && entryCustomer) {
        const comboKey = `${entryCarrier}|${entryCustomer}`;
        if (!comboStats[comboKey]) {
          comboStats[comboKey] = {
            carrier: entryCarrier,
            customer: entryCustomer,
            doors: {},
            total: 0,
          };
        }
        comboStats[comboKey].doors[doorNum] =
          (comboStats[comboKey].doors[doorNum] || 0) + 1;
        comboStats[comboKey].total++;
      }
    });

    // Create workbook
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Warehouse Dock Board';
    workbook.created = new Date();

    // Modern color palette
    const colors = {
      primary: 'FF2563EB',
      primaryLight: 'FFDBEAFE',
      secondary: 'FF059669',
      secondaryLight: 'FFD1FAE5',
      accent: 'FF7C3AED',
      accentLight: 'FFE9D5FF',
      dark: 'FF1E293B',
      gray: 'FFF1F5F9',
      white: 'FFFFFFFF',
      border: 'FFE2E8F0'
    };

    // === SHEET 1: Summary ===
    const summarySheet = workbook.addWorksheet('Summary');

    // Title with gradient-like effect (solid color with styling)
    summarySheet.mergeCells('A1:D1');
    summarySheet.getCell('A1').value = 'Position Patterns Export';
    summarySheet.getCell('A1').font = {
      size: 20,
      bold: true,
      color: { argb: 'FFFFFFFF' }
    };
    summarySheet.getCell('A1').fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF2563EB' }
    };
    summarySheet.getCell('A1').alignment = {
      horizontal: 'center',
      vertical: 'middle'
    };
    summarySheet.getRow(1).height = 35;

    // Section header for metadata
    summarySheet.getCell('A3').value = 'Export Details';
    summarySheet.getCell('A3').font = {
      size: 14,
      bold: true,
      color: { argb: 'FF1E293B' }
    };
    summarySheet.getCell('A3').fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE2E8F0' }
    };
    summarySheet.mergeCells('A3:D3');

    // Metadata with modern styling
    const metaData = [
      ['Generated', new Date().toLocaleString()],
      ['Facility Filter', isCombined ? 'all' : facilityIds[0]],
      ['Carrier Filter', carrier || 'all'],
      ['Customer Filter', customer || 'all'],
      ['Direction Filter', direction || 'all'],
    ];

    metaData.forEach((row, idx) => {
      const rowNum = 4 + idx;
      summarySheet.getCell(`A${rowNum}`).value = row[0];
      summarySheet.getCell(`B${rowNum}`).value = row[1];
      summarySheet.getCell(`A${rowNum}`).font = { bold: true, color: { argb: 'FF64748B' } };
      summarySheet.getCell(`B${rowNum}`).font = { color: { argb: 'FF1E293B' } };
      if (idx % 2 === 0) {
        summarySheet.getRow(rowNum).fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFF8FAFC' }
        };
      }
    });

    // Total placements section
    summarySheet.getCell('A10').value = 'Total Placements';
    summarySheet.getCell('A10').font = {
      size: 14,
      bold: true,
      color: { argb: 'FFFFFFFF' }
    };
    summarySheet.getCell('A10').fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF059669' }
    };
    summarySheet.mergeCells('A10:D10');
    summarySheet.getCell('A10').alignment = { horizontal: 'center' };

    const totalPlacements = Object.values(doorFrequency).reduce((a, b) => a + b.count, 0);
    summarySheet.getCell('A11').value = totalPlacements;
    summarySheet.getCell('A11').font = {
      size: 24,
      bold: true,
      color: { argb: 'FF059669' }
    };
    summarySheet.getCell('A11').alignment = { horizontal: 'center', vertical: 'middle' };
    summarySheet.mergeCells('A11:D11');
    summarySheet.getRow(11).height = 40;

    // Auto-size columns
    summarySheet.columns = [
      { width: 22 },
      { width: 35 },
    ];
    // Helper function to apply zebra striping
    const applyZebraStriping = (sheet, startRow, endRow) => {
      const colKeys = sheet.columns.map(col => col.key).filter(Boolean);
      for (let row = startRow; row <= endRow; row++) {
        if (row % 2 === 0) {
          colKeys.forEach(key => {
            const cell = sheet.getRow(row).getCell(key);
            cell.fill = {
              type: 'pattern',
              pattern: 'solid',
              fgColor: { argb: colors.gray.replace('FF', '') }
            };
          });
        }
      }
    };

    // Helper function to style headers with section colors
    const styleHeader = (sheet, color) => {
      const colKeys = sheet.columns.map(col => col.key).filter(Boolean);
      colKeys.forEach(key => {
        const cell = sheet.getRow(1).getCell(key);
        cell.font = {
          bold: true,
          color: { argb: 'FFFFFFFF' },
          size: 11
        };
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: color.replace('FF', '') }
        };
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: false };
      });
    };

    // === SHEET 2: Door Statistics (Summary) ===
    const doorStatsSheet = workbook.addWorksheet('Door Statistics');

    // Get all unique carriers and customers across all doors
    const allCarriers = new Set();
    const allCustomers = new Set();
    Object.values(doorFrequency).forEach(stats => {
      Object.keys(stats.carriers).forEach(c => allCarriers.add(c));
      Object.keys(stats.customers).forEach(c => allCustomers.add(c));
    });

    // Create door stats with separate columns for top 5 carriers and customers
    const doorStatsData = Object.entries(doorFrequency)
      .map(([door, stats]) => {
        const sortedCarriers = Object.entries(stats.carriers).sort((a, b) => b[1] - a[1]);
        const sortedCustomers = Object.entries(stats.customers).sort((a, b) => b[1] - a[1]);

        const row = {
          doorNumber: isCombined ? door : parseInt(door),
          frequency: stats.count,
        };

        for (let i = 0; i < 5; i++) {
          if (sortedCarriers[i]) {
            row[`carrier${i+1}`] = sortedCarriers[i][0];
            row[`carrier${i+1}Count`] = sortedCarriers[i][1];
          } else {
            row[`carrier${i+1}`] = '';
            row[`carrier${i+1}Count`] = '';
          }
        }

        for (let i = 0; i < 5; i++) {
          if (sortedCustomers[i]) {
            row[`customer${i+1}`] = sortedCustomers[i][0];
            row[`customer${i+1}Count`] = sortedCustomers[i][1];
          } else {
            row[`customer${i+1}`] = '';
            row[`customer${i+1}Count`] = '';
          }
        }

        return row;
      })
      .sort((a, b) => b.frequency - a.frequency);

    if (doorStatsData.length > 0) {
      const columns = [
        { header: 'Door', key: 'doorNumber', width: 10 },
        { header: 'Total', key: 'frequency', width: 9 },
      ];

      for (let i = 1; i <= 5; i++) {
        columns.push({ header: `Carrier ${i}`, key: `carrier${i}`, width: 20 });
        columns.push({ header: `#`, key: `carrier${i}Count`, width: 5 });
      }

      for (let i = 1; i <= 5; i++) {
        columns.push({ header: `Customer ${i}`, key: `customer${i}`, width: 20 });
        columns.push({ header: `#`, key: `customer${i}Count`, width: 5 });
      }

      doorStatsSheet.columns = columns;
      doorStatsData.forEach(d => doorStatsSheet.addRow(d));

      styleHeader(doorStatsSheet, colors.primary);

      // Center align the door and total columns
      doorStatsSheet.getColumn('doorNumber').alignment = { horizontal: 'center' };
      doorStatsSheet.getColumn('frequency').alignment = { horizontal: 'center' };

      // Center align count columns
      for (let i = 1; i <= 5; i++) {
        doorStatsSheet.getColumn(`carrier${i}Count`).alignment = { horizontal: 'center' };
        doorStatsSheet.getColumn(`customer${i}Count`).alignment = { horizontal: 'center' };
      }

      applyZebraStriping(doorStatsSheet, 2, doorStatsData.length + 1);
      doorStatsSheet.views = [{ state: 'frozen', ySplit: 1 }];
    }

    // === SHEET 3: Carrier-Door Matrix ===
    const carrierMatrixSheet = workbook.addWorksheet('Carrier-Door Matrix');
    const sortedCarriers = [...allCarriers].sort();
    const sortedDoors = Object.entries(doorFrequency)
      .map(([door]) => isCombined ? door : parseInt(door))
      .sort((a, b) => {
        if (typeof a === 'number' && typeof b === 'number') return a - b;
        return String(a).localeCompare(String(b));
      });

    if (sortedCarriers.length > 0 && sortedDoors.length > 0) {
      const headerRow = ['Carrier'];
      sortedDoors.forEach(door => headerRow.push(String(door)));
      headerRow.push('Total');
      carrierMatrixSheet.addRow(headerRow);

      sortedCarriers.forEach(carrierName => {
        const row = [carrierName];
        let carrierTotal = 0;

        sortedDoors.forEach(doorKey => {
          const doorEntry = Object.entries(doorFrequency).find(([k]) =>
            isCombined ? k === doorKey : parseInt(k) === doorKey
          );
          if (doorEntry) {
            const count = doorEntry[1].carriers[carrierName] || 0;
            row.push(count || '');
            carrierTotal += count;
          } else {
            row.push('');
          }
        });

        row.push(carrierTotal);
        carrierMatrixSheet.addRow(row);
      });

      styleHeader(carrierMatrixSheet, colors.secondary);

      // Center all numeric columns
      sortedDoors.forEach((_, idx) => {
        carrierMatrixSheet.getColumn(idx + 2).alignment = { horizontal: 'center' };
      });
      carrierMatrixSheet.getColumn(sortedDoors.length + 2).alignment = { horizontal: 'center' };
      carrierMatrixSheet.getColumn(sortedDoors.length + 2).font = { bold: true };

      applyZebraStriping(carrierMatrixSheet, 2, sortedCarriers.length + 1);
      carrierMatrixSheet.views = [{ state: 'frozen', xSplit: 1, ySplit: 1 }];

      carrierMatrixSheet.columns.forEach((col, idx) => {
        col.width = idx === 0 ? 22 : 7;
      });
    }

    // === SHEET 4: Customer-Door Matrix ===
    const customerMatrixSheet = workbook.addWorksheet('Customer-Door Matrix');
    const sortedCustomers = [...allCustomers].sort();

    if (sortedCustomers.length > 0 && sortedDoors.length > 0) {
      const headerRow = ['Customer'];
      sortedDoors.forEach(door => headerRow.push(String(door)));
      headerRow.push('Total');
      customerMatrixSheet.addRow(headerRow);

      sortedCustomers.forEach(customerName => {
        const row = [customerName];
        let customerTotal = 0;

        sortedDoors.forEach(doorKey => {
          const doorEntry = Object.entries(doorFrequency).find(([k]) =>
            isCombined ? k === doorKey : parseInt(k) === doorKey
          );
          if (doorEntry) {
            const count = doorEntry[1].customers[customerName] || 0;
            row.push(count || '');
            customerTotal += count;
          } else {
            row.push('');
          }
        });

        row.push(customerTotal);
        customerMatrixSheet.addRow(row);
      });

      styleHeader(customerMatrixSheet, colors.accent);

      // Center all numeric columns
      sortedDoors.forEach((_, idx) => {
        customerMatrixSheet.getColumn(idx + 2).alignment = { horizontal: 'center' };
      });
      customerMatrixSheet.getColumn(sortedDoors.length + 2).alignment = { horizontal: 'center' };
      customerMatrixSheet.getColumn(sortedDoors.length + 2).font = { bold: true };

      applyZebraStriping(customerMatrixSheet, 2, sortedCustomers.length + 1);
      customerMatrixSheet.views = [{ state: 'frozen', xSplit: 1, ySplit: 1 }];

      customerMatrixSheet.columns.forEach((col, idx) => {
        col.width = idx === 0 ? 25 : 7;
      });
    }

    // === SHEET 5: Top Carrier-Customer Combinations ===
    const combosSheet = workbook.addWorksheet('Top Combinations');
    const topCombos = Object.values(comboStats)
      .sort((a, b) => b.total - a.total)
      .slice(0, 20)
      .map((c) => ({
        carrier: c.carrier,
        customer: c.customer,
        total: c.total,
        preferredDoors: Object.entries(c.doors)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([door, count]) => `Door ${door} (${count})`)
          .join(', ') || 'N/A',
      }));

    if (topCombos.length > 0) {
      combosSheet.columns = [
        { header: 'Carrier', key: 'carrier', width: 22 },
        { header: 'Customer', key: 'customer', width: 22 },
        { header: 'Total', key: 'total', width: 10 },
        { header: 'Preferred Doors', key: 'preferredDoors', width: 45 },
      ];

      topCombos.forEach(c => combosSheet.addRow(c));

      styleHeader(combosSheet, colors.dark);

      // Center align total column
      combosSheet.getColumn('total').alignment = { horizontal: 'center' };

      applyZebraStriping(combosSheet, 2, topCombos.length + 1);
    }

    // Generate filename - prefix with facilityId or 'all'
    const facilityLabel = isCombined ? 'all' : facilityIds[0];
    const filename = `${facilityLabel}-patterns-${new Date().toISOString().split('T')[0]}.xlsx`;

    // Write to buffer and send
    const buffer = await workbook.xlsx.writeBuffer();

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (error) {
    console.error('Patterns export error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
