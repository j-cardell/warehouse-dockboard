#!/usr/bin/env node
/**
 * Multi-Facility Route Migration Helper
 *
 * This script analyzes route files and shows what changes are needed
 * to make them facility-aware.
 *
 * Usage: node scripts/migration-helper.js [file]
 * Example: node scripts/migration-helper.js src/routes/trailers.js
 */

const fs = require("fs");
const path = require("path");

// Pattern mappings for common changes
const PATTERNS = [
  {
    name: "loadState() without facilityId",
    regex: /const state = loadState\(\);/g,
    replacement: "const state = loadState(facilityId);",
    note: "Add 'const facilityId = req.user.currentFacility || req.user.homeFacility;' before this line",
  },
  {
    name: "saveState() without facilityId",
    regex: /saveState\(state\);/g,
    replacement: "saveState(state, facilityId);",
    note: "Must have facilityId defined earlier in the function",
  },
  {
    name: "addHistoryEntry() without facilityId",
    regex: /addHistoryEntry\(([^,]+),\s*([^,]+),\s*req\.user\);/g,
    replacement: "addHistoryEntry($1, $2, req.user, facilityId);",
    note: "Must have facilityId defined earlier in the function",
  },
  {
    name: "loadHistory() without facilityId",
    regex: /loadHistory\(\)/g,
    replacement: "loadHistory(facilityId)",
    note: "Must have facilityId defined earlier in the function",
  },
  {
    name: "loadSettings() without facilityId",
    regex: /loadSettings\(\)/g,
    replacement: "loadSettings(facilityId)",
    note: "Must have facilityId defined earlier in the function",
  },
  {
    name: "saveSettings() without facilityId",
    regex: /saveSettings\(([^)]+)\);/g,
    replacement: "saveSettings($1, facilityId);",
    note: "Must have facilityId defined earlier in the function",
  },
  {
    name: "loadUsers() without facilityId",
    regex: /loadUsers\(\)/g,
    replacement: "loadUsers(facilityId)",
    note: "Must have facilityId defined earlier in the function",
  },
  {
    name: "saveUsers() without facilityId",
    regex: /saveUsers\(([^)]+)\);/g,
    replacement: "saveUsers($1, facilityId);",
    note: "Must have facilityId defined earlier in the function",
  },
  {
    name: "findUserById without facilityId",
    regex: /findUserById\(([^)]+)\)/g,
    replacement: "findUserById($1, facilityId)",
    note: "Must have facilityId defined earlier in the function",
  },
  {
    name: "findUserByUsername without facilityId",
    regex: /findUserByUsername\(([^)]+)\)/g,
    replacement: "findUserByUsername($1, facilityId)",
    note: "Must have facilityId defined earlier in the function",
  },
];

function analyzeFile(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n");

  console.log(`\n========================================`);
  console.log(`Analyzing: ${filePath}`);
  console.log(`========================================\n`);

  let totalIssues = 0;
  const issues = [];

  // Check each pattern
  for (const pattern of PATTERNS) {
    const matches = [...content.matchAll(pattern.regex)];
    if (matches.length > 0) {
      for (const match of matches) {
        // Find line number
        const upToMatch = content.substring(0, match.index);
        const lineNum = upToMatch.split("\n").length;

        issues.push({
          pattern: pattern.name,
          line: lineNum,
          original: match[0],
          replacement: pattern.replacement,
          note: pattern.note,
        });
        totalIssues++;
      }
    }
  }

  // Check if facilityId is extracted from req.user
  const hasFacilityIdExtraction = /const facilityId = req\.user\.(currentFacility|homeFacility)/.test(content);

  if (totalIssues === 0) {
    console.log("✅ No issues found - file appears to be facility-aware!");
    if (hasFacilityIdExtraction) {
      console.log("✅ facilityId extraction found");
    }
    return;
  }

  // Group by line number
  const groupedByLine = {};
  for (const issue of issues) {
    if (!groupedByLine[issue.line]) {
      groupedByLine[issue.line] = [];
    }
    groupedByLine[issue.line].push(issue);
  }

  console.log(`Found ${totalIssues} issue(s) to fix:\n`);

  // Show issues grouped by function
  let currentFunction = "";
  let inRouteHandler = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Detect route handlers
    if (/(router\.(get|post|put|delete)|async function)/.test(line)) {
      currentFunction = line.trim();
      inRouteHandler = true;
      console.log(`\n--- Route/Function (line ${lineNum}):`);
      console.log(`    ${currentFunction.substring(0, 70)}...`);
    }

    // Show issues for this line
    if (groupedByLine[lineNum]) {
      for (const issue of groupedByLine[lineNum]) {
        console.log(`\n  Line ${issue.line}: ${issue.pattern}`);
        console.log(`    Current:  ${issue.original.trim()}`);
        console.log(`    Change to: ${issue.replacement.trim()}`);
      }
    }
  }

  console.log(`\n\n========================================`);
  console.log(`SUMMARY`);
  console.log(`========================================`);
  console.log(`Total issues: ${totalIssues}`);
  console.log(`Has facilityId extraction: ${hasFacilityIdExtraction ? "✅ Yes" : "❌ No"}`);

  if (!hasFacilityIdExtraction && totalIssues > 0) {
    console.log(`\n⚠️  IMPORTANT: Add this line at the start of each route handler:`);
    console.log(`   const facilityId = req.user.currentFacility || req.user.homeFacility;`);
  }
}

// Main
const filePath = process.argv[2];
if (!filePath) {
  console.log("Multi-Facility Route Migration Helper");
  console.log("=====================================\n");
  console.log("Usage: node scripts/migration-helper.js <file>");
  console.log("Example: node scripts/migration-helper.js src/routes/trailers.js\n");

  // Show quick reference
  console.log("Quick Reference - Common Changes:");
  console.log("-----------------------------------\n");
  for (const pattern of PATTERNS) {
    console.log(`${pattern.name}:`);
    console.log(`  From: ${pattern.regex.source}`);
    console.log(`  To:   ${pattern.replacement}`);
    console.log();
  }
  process.exit(0);
}

analyzeFile(path.resolve(filePath));
