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
} = require("../state");
const {
  loadAnalytics,
  saveAnalytics,
  getDwellViolations,
  recordDwellSnapshot,
  calculateDailyDwell,
  getEffectiveDwellHours,
} = require("../analytics");

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
    const { period = "day" } = req.query;
    const { facilityIds, isCombined } = getFacilityFilter(req, req.user);

    // For combined view, aggregate from all facilities
    let combinedData = [];
    if (isCombined) {
      facilityIds.forEach(id => {
        const facility = getFacility(id);
        const timezone = facility?.config?.timezone || "UTC";
        const violations = getDwellViolations(period, id, timezone);
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
      data = getDwellViolations(period, facilityIds[0], timezone);
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
    const { carrier, customer, dateFrom, dateTo } = req.query;

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

      if (carrier && entryCarrier !== carrier) return;
      if (customer && entryCustomer !== customer) return;

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

module.exports = router;
