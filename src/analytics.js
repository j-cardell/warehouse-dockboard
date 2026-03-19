const {
  loadState,
  saveAnalytics,
} = require("./state");
const { ANALYTICS_FILE } = require("./config");
const fs = require("fs");

// Helper: Get date string in facility's timezone
function getDateInTimezone(date, timezone = "UTC") {
  if (timezone === "UTC") {
    return date.toISOString().split("T")[0];
  }
  // Format date in facility's timezone
  return date.toLocaleDateString("en-CA", { timeZone: timezone }); // YYYY-MM-DD format
}

// Helper: Get start of day in facility's timezone (as timestamp)
function getDayStartInTimezone(dateStr, timezone = "UTC") {
  if (timezone === "UTC") {
    return new Date(dateStr + "T00:00:00Z").getTime();
  }
  // Parse the date in facility's timezone
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getTime();
}

function getEffectiveDwellHours(
  createdAt,
  resets = [],
  currentTime = Date.now(),
) {
  const created = new Date(createdAt).getTime();

  // If there were resets, calculate from the most recent one that's < 6h ago
  if (resets && resets.length > 0) {
    const recentResets = resets
      .map((r) => new Date(r).getTime())
      .filter((r) => currentTime - r < 6 * 60 * 60 * 1000) // < 6h ago
      .sort((a, b) => b - a); // Newest first

    if (recentResets.length > 0) {
      const hoursSinceReset =
        (currentTime - recentResets[0]) / (1000 * 60 * 60);
      return Math.min(hoursSinceReset, 6);
    }
  }

  const totalHours = (currentTime - created) / (1000 * 60 * 60);
  return Math.min(totalHours, 6);
}

function resetDwellTime(trailer) {
  if (!trailer) return;

  // Track the reset
  if (!trailer.dwellResets) trailer.dwellResets = [];
  trailer.dwellResets.push(new Date().toISOString());

  // Keep only last 10 resets
  if (trailer.dwellResets.length > 10) {
    trailer.dwellResets = trailer.dwellResets.slice(-10);
  }

  // Reset createdAt to now (optional - resets "age" display on UI too)
  trailer.createdAt = new Date().toISOString();
}

function calculateDailyDwell(date, facilityId = null, timezone = "UTC") {
  const dateStr =
    typeof date === "string" ? date : getDateInTimezone(date, timezone);

  // Calculate day boundaries in facility's timezone
  const dayStart = getDayStartInTimezone(dateStr, timezone);
  const dayEnd = dayStart + (24 * 60 * 60 * 1000) - 1; // End of day in facility timezone

  const state = loadState(facilityId);
  const history = require("./state").loadHistory(facilityId);
  const analytics = loadAnalytics(facilityId);

  let totalDwell = 0;
  let count = 0;
  let maxDwell = 0;
  let violations = 0;
  const violatorList = [];

  // Track trailers that were at doors during this day
  // Map: trailerId -> { doorId, doorNumber, carrier, arrivedAt, departedAt, dwellAtEndOfDay }
  const trailerDoors = new Map();

  // Process history entries to find trailers at doors during this day
  const entries = history?.entries || [];

  // First pass: find trailers that arrived at doors on or before this day
  for (const entry of entries) {
    const entryTime = new Date(entry.timestamp).getTime();

    // Skip future entries
    if (entryTime > dayEnd) continue;

    // Track MOVED_TO_DOOR entries
    if (entry.action === "MOVED_TO_DOOR" && entry.trailerId) {
      // If trailer moved to door on or before this day
      if (!trailerDoors.has(entry.trailerId)) {
        trailerDoors.set(entry.trailerId, {
          doorId: entry.doorId || entry.doorNumber,
          doorNumber: entry.doorNumber,
          carrier: entry.carrier,
          trailerNumber: entry.number || entry.trailerNumber,
          customer: entry.customer,
          driverName: entry.driverName,
          loadNumber: entry.loadNumber,
          arrivedAt: entryTime,
          departedAt: null,
        });
      }
    }

    // Track departures (moved to yard, shipped, etc.)
    if ((entry.action === "MOVED_TO_YARD" ||
         entry.action === "TRAILER_SHIPPED" ||
         entry.action === "MOVED_TO_STAGING") &&
        entry.trailerId && trailerDoors.has(entry.trailerId)) {
      const trailer = trailerDoors.get(entry.trailerId);
      if (!trailer.departedAt || entryTime < trailer.departedAt) {
        trailer.departedAt = entryTime;
      }
    }
  }

  // Second pass: check current trailers for ongoing dwell
  state.trailers.forEach((t) => {
    if (!t.doorId) return;

    const createdTime = new Date(t.createdAt).getTime();

    // If trailer was created before or during this day, and still at door
    if (createdTime <= dayEnd) {
      if (!trailerDoors.has(t.id)) {
        // Trailer arrived earlier (before history or day start)
        const dwellResets = t.dwellResets || [];
        const recentResets = dwellResets
          .map((r) => new Date(r).getTime())
          .filter((r) => r <= dayEnd)
          .sort((a, b) => b - a);

        // Use most recent reset before day end, or creation time
        const startTime = recentResets.length > 0 ? recentResets[0] : createdTime;

        trailerDoors.set(t.id, {
          doorId: t.doorId,
          doorNumber: t.doorNumber,
          carrier: t.carrier,
          trailerNumber: t.number,
          customer: t.customer,
          driverName: t.driverName,
          loadNumber: t.loadNumber,
          arrivedAt: startTime, // Store actual arrival time, not capped
          departedAt: null,
        });
      }
    }
  });

  // Calculate dwell for each trailer
  for (const [trailerId, info] of trailerDoors) {
    // Determine end time: departure time, or end of day, or now if today
    const now = Date.now();
    let endTime;
    if (info.departedAt) {
      endTime = info.departedAt;
    } else if (dateStr === new Date().toISOString().split("T")[0]) {
      // Today - use current time
      endTime = now;
    } else {
      // Past day - use end of day
      endTime = dayEnd;
    }

    // Calculate the ACTUAL arrival time for this day's calculation
    // If trailer arrived before dayStart, we cap at dayStart for dwell calculation
    // BUT we track the original arrival for violation logic
    const originalArrival = info.arrivedAt;
    const cappedStartTime = Math.max(originalArrival, dayStart);
    const actualEndTime = Math.min(endTime, dayEnd + 1); // +1ms to include full day

    if (actualEndTime > cappedStartTime) {
      const dwellMs = actualEndTime - cappedStartTime;
      const dwellHours = dwellMs / (1000 * 60 * 60);

      // Cap at 6 hours for display
      const cappedDwell = Math.min(dwellHours, 6);

      if (cappedDwell > 0.1) {
        totalDwell += cappedDwell;
        count++;

        if (cappedDwell > maxDwell) {
          maxDwell = cappedDwell;
        }

        // VIOLATION LOGIC CHANGE:
        // Only count as violation if trailer accumulated >= 2 hours SPECIFICALLY ON THIS DAY
        // This means:
        // - If trailer arrived this day and stayed >= 2 hours → violation
        // - If trailer arrived previous day but accumulated < 2 hours before midnight
        //   AND more time today to reach >= 2 hours total → violation on TODAY
        // - If trailer already had >= 2 hours before this day started → don't count again

        let isViolation = false;

        if (originalArrival >= dayStart) {
          // Trailer arrived this day - check if it reached 2+ hours this day
          if (dwellHours >= 2) {
            isViolation = true;
          }
        } else {
          // Trailer arrived before this day - check if it was at the door
          // at day start AND the accumulated time from previous days was < 2 hours
          // (meaning it crosses the threshold during this day)

          // Calculate how much dwell time accumulated BEFORE this day
          const previousDwellMs = dayStart - originalArrival;
          const previousDwellHours = previousDwellMs / (1000 * 60 * 60);

          // Only count as violation if previous days had < 2 hours
          // AND this day pushed it over
          if (previousDwellHours < 2 && dwellHours >= 2) {
            isViolation = true;
          }
        }

        if (isViolation) {
          violations++;
          // Calculate total dwell time (not just today's capped dwell)
          const totalDwellMs = actualEndTime - originalArrival;
          const totalDwellHours = totalDwellMs / (1000 * 60 * 60);

          const violator = {
            trailerId,
            carrier: info.carrier,
            number: info.trailerNumber,
            customer: info.customer,
            driverName: info.driverName,
            loadNumber: info.loadNumber,
            dwellHours: Math.round(totalDwellHours * 100) / 100,
            doorNumber: info.doorNumber,
          };
          violatorList.push(violator);
        }
      }
    }
  }

  const avgDwell = count > 0 ? Math.round((totalDwell / count) * 100) / 100 : 0;


  // Store in analytics
  if (!analytics.dailyStats) analytics.dailyStats = {};

  analytics.dailyStats[dateStr] = {
    date: dateStr,
    avgDwell,
    maxDwell: Math.round(maxDwell * 100) / 100,
    count,
    violations,
    violators: violatorList,
    calculatedAt: new Date().toISOString(),
  };

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 90);
  Object.keys(analytics.dailyStats).forEach((dateKey) => {
    if (new Date(dateKey) < cutoffDate) {
      delete analytics.dailyStats[dateKey];
    }
  });

  saveAnalytics(analytics, facilityId);
  console.log(
    `[Analytics] Daily: ${dateStr} - avg ${avgDwell}h, max ${Math.round(maxDwell * 100) / 100}h, ${count} trailers, ${violations} violations`,
  );

  return analytics.dailyStats[dateStr];
}

function recordDwellSnapshot(facilityId = null, timezone = "UTC") {
  const today = getDateInTimezone(new Date(), timezone);
  calculateDailyDwell(today, facilityId, timezone);
}

function getDwellViolations(period = "day", facilityId = null, timezone = "UTC") {
  const analytics = loadAnalytics(facilityId);
  const now = new Date();
  const result = [];

  if (period === "day") {
    for (let i = 6; i >= 0; i--) {
      // Calculate date in facility's timezone
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dateKey = getDateInTimezone(d, timezone);

      // Calculate if not exists or recalculate if data looks wrong
      // (detect old buggy data where violations equaled total count,
      // or violators array is truncated, or violators are missing number field)
      let dayStats = analytics.dailyStats?.[dateKey];
      const hasMissingFields = dayStats?.violators?.some(v => !v.number);
      if (!dayStats ||
          (dayStats.violations > 0 && dayStats.violations === dayStats.count) ||
          (dayStats.violators && dayStats.violators.length < dayStats.violations) ||
          hasMissingFields) {
        dayStats = calculateDailyDwell(dateKey, facilityId, timezone);
      }

      // Get weekday in facility's timezone
      const weekday = d.toLocaleDateString("en-US", {
        weekday: "short",
        timeZone: timezone
      });

      result.push({
        date: dateKey,
        label: weekday,
        count: dayStats?.violations || 0,
        avgDwell: dayStats?.avgDwell || 0,
        trailers: dayStats?.violators || [],
      });
    }
  }

  return result;
}

// Load analytics (re-export for convenience)
function loadAnalytics(facilityId = null) {
  // Use state.js loadAnalytics which supports multi-facility
  const { loadAnalytics: loadAnalyticsFromState } = require("./state");
  return loadAnalyticsFromState(facilityId);
}

module.exports = {
  getEffectiveDwellHours,
  resetDwellTime,
  calculateDailyDwell,
  recordDwellSnapshot,
  getDwellViolations,
  loadAnalytics,
};
