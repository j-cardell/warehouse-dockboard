#!/usr/bin/env node
/**
 * Properly fix routes for multi-facility support
 * Handles edge cases correctly
 */

const fs = require("fs");
const path = require("path");

const files = process.argv.slice(2);

function processFile(filePath) {
  console.log(`Processing: ${filePath}`);

  let content = fs.readFileSync(filePath, "utf8");
  let modified = false;

  // Pattern 1: Add facilityId extraction after route handler declaration
  // Match: router.get("/", requireAuth, (req, res) => {
  // Replace with: router.get("/", requireAuth, (req, res) => {
  //   const facilityId = req.user.currentFacility || req.user.homeFacility;
  const routeHandlerPattern = /(router\.(get|post|put|delete)\([^)]+requireAuth[^)]*\)\s*\{)(\n)(\s*)(const\s+\{)/g;

  content = content.replace(routeHandlerPattern, (match, p1, p2, p3, p4, p5) => {
    modified = true;
    return `${p1}${p3}${p4}const facilityId = req.user.currentFacility || req.user.homeFacility;${p3}${p4}${p5}`;
  });

  // Pattern 2: Fix loadState() calls
  if (content.includes("loadState()") && !content.includes("loadState(facilityId)")) {
    content = content.replace(/loadState\((?!facilityId)/g, "loadState(facilityId");
    modified = true;
  }

  // Pattern 3: Fix saveState(state) calls
  if (content.includes("saveState(state)") && !content.includes("saveState(state, facilityId)")) {
    content = content.replace(/saveState\(state\)/g, "saveState(state, facilityId)");
    modified = true;
  }

  // Pattern 4: Fix addHistoryEntry calls
  if (content.includes("addHistoryEntry") && !content.includes("addHistoryEntry(")) {
    // This is complex - need to match addHistoryEntry calls and add facilityId
    content = content.replace(/addHistoryEntry\(([^,]+),\s*([^,]+),\s*req\.user\);/g,
      "addHistoryEntry($1, $2, req.user, facilityId);");
    modified = true;
  }

  // Pattern 5: Fix loadSettings
  if (content.includes("loadSettings()") && !content.includes("loadSettings(facilityId)")) {
    content = content.replace(/loadSettings\(\)/g, "loadSettings(facilityId)");
    modified = true;
  }

  // Pattern 6: Fix saveSettings
  if (content.includes("saveSettings(") && !content.includes("saveSettings(")) {
    content = content.replace(/saveSettings\(([^)]+)\);/g, (match, p1) => {
      if (p1.includes("facilityId")) return match;
      return `saveSettings(${p1}, facilityId);`;
    });
    modified = true;
  }

  // Pattern 7: Fix loadHistory
  if (content.includes("loadHistory()") && !content.includes("loadHistory(facilityId)")) {
    content = content.replace(/loadHistory\(\)/g, "loadHistory(facilityId)");
    modified = true;
  }

  if (modified) {
    fs.writeFileSync(filePath, content);
    console.log("  ✅ Fixed");
  } else {
    console.log("  ℹ️  No changes needed");
  }
}

if (files.length === 0) {
  console.log("Usage: node fix-facility-routes.js <file1> [file2] ...");
  process.exit(1);
}

for (const file of files) {
  processFile(path.resolve(file));
}
