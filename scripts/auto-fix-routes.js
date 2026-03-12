#!/usr/bin/env node
/**
 * Auto-fix routes for multi-facility support
 * Handles the common patterns automatically
 */

const fs = require("fs");
const path = require("path");

const files = process.argv.slice(2);

// Patterns to fix
const FIXES = [
  // Add facilityId extraction after route handler declaration
  {
    pattern: /(router\.(get|post|put|delete)\([^)]+,\s*requireAuth,\s*(async\s*)?\([^)]*\)\s*=\>\s*\{)(\s*)(const\s+\{)/g,
    replacement: "$1$3const facilityId = req.user.currentFacility || req.user.homeFacility;$3$4",
    description: "Add facilityId extraction to protected routes",
  },
  // Fix loadState() - but not if already has facilityId
  {
    pattern: /loadState\((?!facilityId)\)/g,
    replacement: "loadState(facilityId)",
    description: "Add facilityId to loadState calls",
  },
  // Fix saveState(state) - but not if already has facilityId
  {
    pattern: /saveState\(state\)(?!\s*,)/g,
    replacement: "saveState(state, facilityId)",
    description: "Add facilityId to saveState calls",
  },
  // Fix saveSettings(settings)
  {
    pattern: /saveSettings\((newSettings|settings)\)(?!\s*,)/g,
    replacement: "saveSettings($1, facilityId)",
    description: "Add facilityId to saveSettings calls",
  },
  // Fix loadSettings()
  {
    pattern: /loadSettings\((?!facilityId)\)/g,
    replacement: "loadSettings(facilityId)",
    description: "Add facilityId to loadSettings calls",
  },
  // Fix loadHistory()
  {
    pattern: /loadHistory\((?!facilityId)\)/g,
    replacement: "loadHistory(facilityId)",
    description: "Add facilityId to loadHistory calls",
  },
  // Fix findUserById
  {
    pattern: /findUserById\(([^,)]+)\)(?!\s*,)/g,
    replacement: "findUserById($1, facilityId)",
    description: "Add facilityId to findUserById calls",
  },
  // Fix findUserByUsername
  {
    pattern: /findUserByUsername\(([^,)]+)\)(?!\s*,)/g,
    replacement: "findUserByUsername($1, facilityId)",
    description: "Add facilityId to findUserByUsername calls",
  },
];

function processFile(filePath) {
  console.log(`\nProcessing: ${filePath}`);

  if (!fs.existsSync(filePath)) {
    console.log(`  ❌ File not found`);
    return;
  }

  let content = fs.readFileSync(filePath, "utf8");
  let modified = false;
  let changes = [];

  for (const fix of FIXES) {
    const original = content;
    content = content.replace(fix.pattern, fix.replacement);
    if (content !== original) {
      modified = true;
      changes.push(fix.description);
    }
  }

  if (modified) {
    fs.writeFileSync(filePath, content);
    console.log(`  ✅ Fixed: ${changes.join(", ")}`);
  } else {
    console.log(`  ℹ️  No changes needed`);
  }
}

if (files.length === 0) {
  console.log("Usage: node auto-fix-routes.js <file1> [file2] ...");
  console.log("Example: node auto-fix-routes.js src/routes/carriers.js");
  process.exit(1);
}

for (const file of files) {
  processFile(path.resolve(file));
}

console.log("\n✨ Done! Run migration-helper.js to verify fixes.");
