/**
 * Middleware module
 *
 * Express middleware functions for authentication, rate limiting, and headers.
 * All routes that need protection should use `requireAuth` middleware.
 *
 * Authentication flow:
 * 1. Client POSTs /api/auth/login with username/password
 * 2. Server validates credentials and returns JWT token
 * 3. Client includes token in Authorization header: "Bearer <token>"
 * 4. `requireAuth` middleware verifies token on protected routes
 *
 * To add a new protected route:
 * router.get('/my-route', requireAuth, (req, res) => { ... })
 */

const rateLimit = require("express-rate-limit");
const basicAuth = require("basic-auth");
const jwt = require("jsonwebtoken");
const {
  JWT_SECRET,
  JWT_EXPIRES_IN,
  AUTH_USER,
  AUTH_PASS,
  MULTI_FACILITY_MODE,
  DEFAULT_FACILITY_ID,
} = require("./config");
const { verifyPassword, findUserByUsername, updateLastLogin, hasUsers } = require("./users");

/**
 * Rate limiter for login attempts - per username.
 * Allows 5 attempts per 15 minutes per username.
 * Prevents brute force attacks on single accounts.
 */
const loginLimiterUsername = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  standardHeaders: true,
  message: { error: "Too many login attempts for this username. Please try again later." },
  keyGenerator: (req) => req.body?.username || req.ip,
  skipSuccessfulRequests: true, // Don't count successful logins against the limit
});

/**
 * Rate limiter for login attempts - per IP.
 * Allows 20 attempts per 15 minutes per IP.
 * Prevents username spraying attacks from single IP.
 */
const loginLimiterIP = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  message: { error: "Too many login attempts from your network. Please try again later." },
  skipSuccessfulRequests: true, // Don't count successful logins against the limit
});

// Combined login limiter (both username and IP)
const loginLimiter = (req, res, next) => {
  // Apply IP-based rate limit first
  loginLimiterIP(req, res, (err) => {
    if (err) return next(err);
    // Then apply username-based rate limit
    loginLimiterUsername(req, res, next);
  });
};

/**
 * Generate a JWT token for the given user.
 * Token expires based on JWT_EXPIRES_IN env var (default: 24h).
 *
 * @param {object} user - User object with id, username, role, homeFacility, currentFacility
 * @returns {string} - Signed JWT token
 */
function generateToken(user) {
  return jwt.sign(
    {
      userId: user.id,
      username: user.username,
      role: user.role,
      homeFacility: user.homeFacility,
      currentFacility: user.currentFacility,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

/**
 * Express middleware to require authentication.
 * Checks Authorization header for "Bearer <token>" or falls back to Basic auth.
 * Sets req.user on successful auth.
 *
 * @param {object} req - Express request
 * @param {object} res - Express response
 * @param {function} next - Express next function
 */
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    console.log("[Auth] No authorization header");
    return res
      .status(401)
      .json({ error: "Authentication required", code: "AUTH_REQUIRED" });
  }

  // Support both "Bearer <token>" and legacy basic auth for migration
  if (authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7);
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = {
        userId: decoded.userId,
        username: decoded.username,
        role: decoded.role,
        homeFacility: decoded.homeFacility,
        currentFacility: decoded.currentFacility,
        isVisiting: decoded.isVisiting || false,
      };
      return next();
    } catch (err) {
      console.log("[Auth] Token verification failed:", err.message);
      return res
        .status(401)
        .json({ error: "Invalid or expired token", code: "TOKEN_INVALID" });
    }
  }

  // Legacy: check for Basic auth (for migration period)
  const credentials = basicAuth(req);
  if (credentials) {
    // Try to authenticate against users.json first
    // In multi-facility mode, search across all facilities
    let user = null;
    let facilityId = DEFAULT_FACILITY_ID;

    if (MULTI_FACILITY_MODE) {
      const { findUserByUsernameGlobal } = require("./users");
      const result = findUserByUsernameGlobal(credentials.name);
      if (result) {
        user = result.user;
        facilityId = result.facilityId;
      }
    } else {
      user = await findUserByUsername(credentials.name);
    }

    if (user) {
      const isValid = await verifyPassword(credentials.pass, user.passwordHash);
      if (isValid) {
        req.user = {
          userId: user.id,
          username: user.username,
          role: user.role,
          homeFacility: user.homeFacility || facilityId,
          currentFacility: facilityId,
          isVisiting: false,
        };
        return next();
      }
    }
  }

  return res
    .status(401)
    .json({ error: "Authentication required", code: "AUTH_REQUIRED" });
}

/**
 * Express middleware to require a specific role or higher.
 * Hierarchy: admin > user/loader > viewer
 * Must be used after requireAuth middleware.
 *
 * @param {string} minRole - Minimum required role ('admin', 'user', 'loader', or 'viewer')
 */
function requireRole(minRole) {
  const roleHierarchy = { viewer: 0, user: 1, loader: 1, 'loading-tablet': 1, admin: 2 };

  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Authentication required", code: "AUTH_REQUIRED" });
    }

    const userRoleLevel = roleHierarchy[req.user.role] ?? 0;
    const requiredLevel = roleHierarchy[minRole] ?? 0;

    if (userRoleLevel < requiredLevel) {
      return res.status(403).json({
        error: "Insufficient permissions",
        code: "FORBIDDEN",
        required: minRole,
        current: req.user.role,
      });
    }

    next();
  };
}

/**
 * Set cache control headers to prevent API response caching.
 * Important for auth endpoints - prevents cached 401/403 responses.
 */
function cacheHeaders(req, res, next) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  next();
}

/**
 * Validate auth configuration at startup.
 * Exits process if required env vars are missing or insecure.
 * Called once in server.js before starting the server.
 */
function validateAuthConfig() {
  if (!JWT_SECRET) {
    console.error(
      "❌ FATAL ERROR: JWT_SECRET environment variable is not set.",
    );
    console.error("You must set a secure random string for JWT signing.");
    process.exit(1);
  }

  if (JWT_SECRET === "change-this-secret-in-production") {
    console.error("❌ FATAL ERROR: JWT_SECRET is set to the insecure default.");
    console.error("Please change this to a secure random string.");
    process.exit(1);
  }

  if (!AUTH_PASS) {
    console.error("❌ FATAL ERROR: AUTH_PASS environment variable is not set.");
    console.error("You must set a secure password for initial admin creation.");
    process.exit(1);
  }

  if (AUTH_PASS.length < 8) {
    console.error("❌ FATAL ERROR: AUTH_PASS must be at least 8 characters.");
    process.exit(1);
  }

  console.log(`🔒 Security active: Bootstrap user=${AUTH_USER}`);
}

module.exports = {
  loginLimiter,
  generateToken,
  requireAuth,
  requireRole,
  cacheHeaders,
  validateAuthConfig,
};
