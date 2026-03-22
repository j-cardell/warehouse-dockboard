# Warehouse Dock Board

A real-time dock management application for warehouses, distribution centers, and logistics facilities. Track trailers, manage dock doors, organize yard slots, and maintain complete movement history with a drag-and-drop interface.

> **Note:** This tool complements existing warehouse management systems (SAP, WMS, ERP) **it does not replace them**. It provides quick visual access to dock operations without navigating complex enterprise systems. Data accuracy depends entirely on user input. Always verify critical information in your official systems.

---
<img width="2322" height="1365" alt="image" src="https://github.com/user-attachments/assets/52d2bbbc-e3e3-45ba-bcb0-e97e7b013de4" />

## Table of Contents

- [Features](#features)
- [Quick Start](#quick-start)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
- [Architecture](#architecture)
- [Data Models](#data-models)
- [API Documentation](#api-documentation)
- [Security](#security)
- [Development](#development)

---

## Features

### Core Functionality
- **Secure Authentication** - JWT-based authentication with rate limiting
- **User Management** - Admin users can create, manage, and reset passwords for other users
- **Multi-Facility Support** - Manage multiple warehouse facilities with facility switching
- **Dock Door Management** - Configurable dock doors with custom starting numbers
- **Facility Features** - Support for dumpsters and ramps as non-trailer locations
- **Yard Organization** - Numbered yard slots with customizable ranges
- **Trailer Tracking** - Real-time trailer status (empty, loaded) with LIVE load/unload indicator
- **Inbound/Outbound Management** - Track both incoming and outgoing trailers with different workflows:
  - **Outbound**: Empty → Loaded → Shipped (amber/green colors)
  - **Inbound**: Loaded → Empty → Received (blue/light blue colors)
- **Loader Tablet Interface** (WIP) - Simplified `/loader.html` interface for forklift operators:
  - User/PIN-based facility selection via tablet role
  - Quick status updates (Empty/Loaded/Shipped/Received)
  - Visual color-coded status buttons matching dashboard
- **Staging Area** - Single pre-door slot for trailers awaiting assignment
- **Queue System** - FCFS queue for specific doors and appointment scheduling
- **Movement History** - Complete audit trail with pagination and search
- **Analytics Dashboard** - Dwell time tracking, violations, heatmaps, and position patterns
- **Data Archives** - Create and restore point-in-time backups
- **Demo Data** - Generate sample data for testing (bootstrap admin only)
- **Real-Time Updates** - Server-Sent Events (SSE) for live synchronization

### User Interface
- **Drag & Drop** - Move trailers between doors, yard, and staging
- **Bulk Selection** - Ctrl+Click to select multiple trailers, Ctrl+A to select all
- **Search & Filter** - Real-time search with carrier, trailer, and door filters
- **Keyboard Shortcuts** - Ctrl+K for quick search, Escape to close modals
- **Responsive Design** - Works on desktop and tablet devices
- **Customizable Display** - Adjustable fonts, colors, and grid layout

### Advanced Features
- **Auto-Assignment** - Automatically assigns next trailer from queue when door clears
- **Dwell Time Tracking** - Tracks how long trailers sit at dock doors (6-hour max display)
- **Carrier Management** - Registry with favorites and usage tracking
- **Canvas-Based Analytics** - No external chart dependencies

---

## Quick Start

### Prerequisites
- Node.js 18+
- npm

### Run Locally

```bash
# Clone the repository
git clone https://github.com/j-cardell/warehouse-dockboard.git
cd warehouse-dockboard

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your secure values:
# - AUTH_PASS: your secure password (min 8 chars)
# - JWT_SECRET: run `openssl rand -hex 32` to generate

# Start the server
npm start
```

The application will be available at `http://localhost:3000`

### First Run

1. **Login**: Use credentials from your `.env` file
2. **Setup Wizard**: Configure your facility:
   - Set facility name and **timezone** (from dropdown - affects all timestamps)
   - Configure doors, yard slots, dumpsters, ramps
3. **Dashboard**: Start managing trailers

---

## Installation

### Docker

```bash
# Build and run with Docker Compose
docker-compose up --build

# The app will be available on port 3456
```

### Manual Installation

```bash
# Install Node.js 18+ first, then:
npm install

# Configure environment
cp .env.example .env
# Edit .env with your settings

# Start the server
npm start
```

---

## Configuration

### Required Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `AUTH_USER` | Username for login (default: dockadmin) | Yes |
| `AUTH_PASS` | Password for web login (min 8 chars) | Yes |
| `JWT_SECRET` | Secret for JWT signing (64 hex chars) | Yes |
| `PORT` | Server port (default: 3000, Docker: 3456) | No |
| `JWT_EXPIRES_IN` | Token expiration (default: 24h) | No |

### Generating JWT Secret

```bash
openssl rand -hex 32
```

### Docker Environment

```yaml
environment:
  - AUTH_USER=${AUTH_USER}
  - AUTH_PASS=${AUTH_PASS}
  - JWT_SECRET=${JWT_SECRET}
  - PORT=3456
```

### Security Validation

The server will refuse to start if:
- `JWT_SECRET` is not set or is the default value
- `AUTH_PASS` is not set or is less than 8 characters

---

## Usage

### Dashboard Overview

| Section | Description |
|---------|-------------|
| **Dock Doors** | Grid showing all configured doors with current trailers |
| **Yard Slots** | Numbered yard positions for trailers waiting for dock |
| **Staging Area** | Single slot for pre-door trailers |
| **Queues** | FCFS queue and appointment queue for scheduled arrivals |
| **Carrier Summary** | Real-time carrier filtering bar |

### Managing Trailers

**Creating Trailers:**
- Click "+ Add" on a door to add directly to that door
- Or click "Add Trailer" button to add to Staging
- Fill in: Number, Carrier, Status
- Trailer is created at the clicked location

**Moving Trailers:**
- Drag and drop trailer cards between doors, yard slots, and staging
- Double-click a trailer to edit before moving

**Editing Trailers:**
- Double-click any trailer card to open the edit modal
- Edit fields: Customer, Carrier, Status, Trailer Number, Load Number, Driver Info, Appointment Time, Notes
- Toggle LIVE LOAD/UNLOAD status
- Click "Save Changes" to apply edits

**Shipping Trailers (Outbound):**
- Open the trailer edit modal (double-click)
- Click "Mark as Shipped" button
- Trailer moves to shipped archive and door becomes available

**Receiving Trailers (Inbound):**
- Open the trailer edit modal (double-click)
- Click "Mark as Received" button
- Trailer moves to received archive and door becomes available

### Loader Tablet Interface (WIP)

A simplified interface at `/loader.html` for forklift operators to quickly update trailer status without accessing the full dashboard.

<img width="464" height="600" alt="image" src="https://github.com/user-attachments/assets/faf047d9-03d6-4c90-a186-9eb34af2fdd1" />

**Current Implementation:**
1. **Create Tablet User** (Admin): In User Management, create a user with "tablet" role. Since this is WIP, use the facility ID as the username. Currently, this is how the facility is identified. Future state, create full Loader users with their own username and hashed password to log into the tablet with. This is set up as if each facility is using a shared device.
2. **Create Loaders** (Admin): Create users with "loader" role - these only need names (no passwords) and appear in the loader selection list after logging in with the tablet user assigned to the facility. This populates the correct users per facility.
3. **Access**: Loaders go to `/loader.html`, enter the tablet username to select the facility, enter the pin set by the creating admin, then select their name from the loader list.

<img width="462" height="596" alt="image" src="https://github.com/user-attachments/assets/e6fdaed1-c75f-4678-8620-3b609a5d35c2" />


4. **Status Updates**: Loaders enter the door number, confirm the carrier/trailer number. The loader is then shown any notes added to the load. After dismissing the notes, they are displayed 3 buttons. Empty/Loaded and either Shipped (if an outbound load) or Received (if an inbound load). Any of the selections will update the door grid accordingly. It will mark a loaded trailer empty, an empty trailer loaded, mark a trailer as loaded and shipped, mark a trailer as empty and received. 

<img width="467" height="603" alt="image" src="https://github.com/user-attachments/assets/79fa8680-ae91-40af-bd01-403cce9a73a7" />

<img width="464" height="597" alt="image" src="https://github.com/user-attachments/assets/bc7bb0f2-5063-4fd4-b8fe-6105843aa907" />

<img width="469" height="602" alt="image" src="https://github.com/user-attachments/assets/38e83e82-d750-4e57-9a4c-5c79b69c9197" />

<img width="461" height="595" alt="image" src="https://github.com/user-attachments/assets/00d8f638-c6aa-4407-b90e-ed8dd5f83b15" />

**Note:** To repeat, this is currently designed for shared tablet scenarios. Future versions will support individual devices with distinct user credentials.

**Staging Area** - Use this for trailers awaiting assignment:
- Driver arrived but door isn't ready yet
- Waiting for appointment time
- Entering details before directing to a door
- Access via "Add Trailer" button

**Unassigned Yard** - System-managed only:
- Trailers appear here automatically when a door is deleted that contains a trailer
- Users can never manually place trailers here
- Use Staging for intentional temporary holding

### LIVE Load/Unload Indicator

The **LIVE** indicator marks trailers with drivers currently waiting onsite:

- **Visual:** Red "LIVE" badge on trailer card
- **Purpose:** Alerts staff that a driver is waiting
- **Toggle:** Check "LIVE LOAD/UNLOAD" in trailer edit modal

Use for live unloads, live loads.

### User Management

Admins manage users through the user menu (top right) → "Manage Users":

**Creating Users:**
1. Click "Add User"
2. Enter username, email (optional), select role (admin/user/viewer)
3. Admin creates a temporary password
4. Share credentials with user

**Password Resets:**
- Admin clicks "Reset Password" → confirms "Require password reset?"
- User is **forced to set new password on next login** (any password works, then immediate prompt for new password)
- No SMTP/email needed - assumes user requested through other channels
- **Password reset flag expires in 10 minutes**

**Security Note:** Only the **bootstrap admin** (`AUTH_USER` env var) can reset another admin's password. Bootstrap admin password must be changed via environment variables.

### Demo Data Generation

Generate sample data for testing (bootstrap admin only):

1. Enter **Edit Mode**
2. Click "🎲 Demo Data" button
3. Confirm to generate trailers scaled to your facility size

Clears existing trailers, preserves door/yard configuration.

### Edit Mode

Click "Edit" button to enable configuration changes:
- Reorder doors by dragging
- Add/remove doors and yard slots
- Configure door settings (type, label, in-service status)
- Access archives
- Generate demo data
- Manage users and facilities (admin only)

### Multi-Facility Mode

**Facility Switching:**
- Admins can switch facilities via user menu → "Switch Facility"
- JWT regenerated with new facility context
- History entries tagged with origin facility

**Creating Facilities:**
- Bootstrap admin can create new facilities
- Each facility has isolated data (state, history, analytics)
- Users can have different roles per facility

---

## Architecture

### Tech Stack

| Layer | Technology |
|-------|------------|
| Backend | Node.js, Express |
| Frontend | Vanilla JavaScript (SPA) |
| Styling | CSS3 with CSS custom properties |
| Data | JSON files |
| Auth | JWT with Basic auth fallback |
| Real-Time | Server-Sent Events (SSE) |

**Why JSON files?** No database server to configure, backup, or manage. Data is human-readable, portable, and stored directly in the filesystem. Simply copy the `data/` directory to migrate or archive. Perfect for single-facility deployments where simplicity and minimal infrastructure matters more than concurrent access patterns.

### File Structure

```
warehouse-dockboard/
├── src/
│   ├── server.js               # Main entry point
│   ├── config.js               # Environment variables and constants
│   ├── state.js                # Data persistence (load/save JSON)
│   ├── utils.js                # Helper functions (sanitize, uuid)
│   ├── middleware.js           # Auth, rate limiting
│   ├── analytics.js            # Dwell time calculations
│   ├── sse.js                  # Server-Sent Events handler
│   ├── facilities.js           # Multi-facility management
│   └── routes/                 # API routes (modular)
│       ├── auth.js             # Authentication endpoints
│       ├── users.js            # User CRUD
│       ├── user-settings.js    # User preferences
│       ├── setup.js            # First-run configuration
│       ├── settings.js         # UI settings
│       ├── archives.js         # Backup/restore
│       ├── demo.js             # Demo data generation
│       ├── state.js            # Current state endpoint
│       ├── history.js          # Audit log
│       ├── trailers.js         # Trailer CRUD
│       ├── moves.js            # Movement operations
│       ├── doors.js            # Door management
│       ├── yard.js             # Yard slot management
│       ├── queues.js           # FCFS and appointment queues
│       ├── carriers.js         # Carrier registry
│       ├── analytics.js        # Statistics endpoints
│       ├── facilities.js       # Facility CRUD
│       ├── loader.js           # Loader tablet API
│       └── events.js           # Server-Sent Events endpoint
├── public/                     # Frontend files
│   ├── index.html              # Main HTML template
│   ├── loader.html             # Tablet interface for forklift operators
│   ├── archives.html           # Archive management UI
│   ├── app.js                  # Frontend logic (~7,500 lines)
│   ├── styles.css              # Main stylesheet
│   ├── carrier-summary.css
│   ├── door-edit.css
│   ├── auth.css
│   └── time-picker.css
├── data/                       # Runtime data storage
│   ├── state.json              # Current doors, trailers, yard, queues, carriers (single-facility mode)
│   ├── history.json            # Audit log of all trailer movements and changes
│   ├── analytics.json          # Daily dwell statistics and violation tracking
│   ├── settings.json           # UI preferences (fonts, colors, display options)
│   ├── users.json              # User accounts and credentials (single-facility mode)
│   ├── facilities.json         # Facility definitions and configuration
│   ├── archives/               # Point-in-time backups
│   └── facilities/             # Per-facility data (multi-facility mode)
│       └── {facilityId}/
│           ├── state.json      # Current doors, trailers, yard, queues, carriers for this facility
│           ├── history.json    # Audit log for this facility
│           ├── analytics.json  # Statistics for this facility
│           ├── settings.json   # UI preferences for this facility
│           └── users.json      # User accounts for this facility
├── .env.example
├── docker-compose.yml
├── Dockerfile
└── README.md
```

### Module Structure

The server is organized into modules:

- **config.js** - Centralized configuration constants, file paths, multi-facility flag
- **state.js** - JSON file persistence layer with load/save helpers
- **utils.js** - Shared utility functions (sanitizeInput, uuid)
- **middleware.js** - Express middleware (auth, rate limiting, headers)
- **analytics.js** - Dwell time calculations and statistics
- **sse.js** - Real-time updates via Server-Sent Events
- **facilities.js** - Multi-facility data organization
- **routes/** - API endpoints organized by domain

### Authentication Flow

1. **Bootstrap Mode**: If no users exist, first login with `AUTH_USER/AUTH_PASS` auto-creates an admin user
2. **Normal Login**: Credentials verified against `users.json` (hashed with bcrypt)
3. **Password Reset Flow**: Admin can trigger reset; user must verify temp password, then set new password
4. **Token Generation**: JWT contains userId, username, role, homeFacility, currentFacility, isVisiting flag
5. **Token Validation**: `requireAuth` middleware validates Bearer tokens on protected routes

**Role Hierarchy:**
- `viewer` (0) - Read-only access
- `user` (1) - Standard operations
- `admin` (2) - Full access including user management and facility switching

### Real-Time Updates (SSE)

**Connection Management:**
- Endpoint: `GET /api/events?token=xxx`
- Supports token via Authorization header or query parameter
- Heartbeat sent every 30 seconds
- Automatic reconnection with exponential backoff

**Events:**
- `stateChange` - Entity changes (trailer, door, carrier, yard, queue)
- `heartbeat` - Connection keepalive

**Fallback:** If SSE fails, automatic polling every 5 seconds

---

## Data Models

### Door

```json
{
  "id": "door-1",
  "number": 1,
  "order": 0,
  "type": "normal",
  "trailerId": "uuid",
  "status": "loaded",
  "inService": true,
  "labelText": null
}
```

**Types:**
- `normal`: Standard numbered dock door
- `blank`: Visual spacer or facility features (dumpsters, ramps)
- `out-of-service`: Disabled door

### Trailer (at doors)

```json
{
  "id": "uuid",
  "number": "TR12345",
  "carrier": "FedEx",
  "status": "loaded",
  "direction": "outbound",
  "customer": "Acme Corp",
  "loadNumber": "LD1234567",
  "driverName": "John Smith",
  "driverPhone": "555-1234",
  "contents": "Electronics",
  "appointmentTime": "14:30",
  "isLive": true,
  "location": "door",
  "doorId": "door-1",
  "doorNumber": 1,
  "createdAt": "2026-01-01T00:00:00Z",
  "dwellResets": ["2026-01-01T06:00:00Z"],
  "moveHistory": [
    {
      "fromDoor": 5,
      "toDoor": 1,
      "movedAt": "2026-01-01T06:00:00Z",
      "action": "MOVED_TO_DOOR"
    }
  ]
}
```

**Direction:** `outbound` (default) | `inbound`
- **Outbound**: Empty → Loaded → Shipped (amber → green)
- **Inbound**: Loaded → Empty → Received (blue → light blue)

### Yard Trailer (unassigned)

```json
{
  "id": "uuid",
  "number": "TR67890",
  "carrier": "UPS",
  "status": "empty",
  "location": "yard",
  "yardSlotId": "yard-5",
  "yardSlotNumber": 5,
  "createdAt": "2026-01-01T00:00:00Z",
  "dwellResets": []
}
```

### Queued Trailer

```json
{
  "id": "uuid",
  "number": "TR11111",
  "carrier": "Amazon",
  "status": "loaded",
  "location": "queued",
  "targetDoorId": "door-5",
  "targetDoorNumber": 5,
  "queuedAt": "2026-01-01T10:00:00Z",
  "isLive": true
}
```

### Appointment Queue

```json
{
  "id": "uuid",
  "number": "TR22222",
  "carrier": "Walmart",
  "status": "loaded",
  "location": "appointment",
  "appointmentTime": "15:30",
  "driverPhone": "555-5678",
  "createdAt": "2026-01-01T00:00:00Z"
}
```

### Shipped Trailer (archived - outbound)

```json
{
  "id": "uuid",
  "number": "TR33333",
  "carrier": "Target",
  "status": "shipped",
  "shippedAt": "2026-01-01T18:00:00Z",
  "previousLocation": "Door 12",
  "createdAt": "2026-01-01T00:00:00Z"
}
```

### Received Trailer (archived - inbound)

```json
{
  "id": "uuid",
  "number": "TR44444",
  "carrier": "Walmart",
  "status": "received",
  "receivedAt": "2026-01-01T18:00:00Z",
  "previousLocation": "Door 8",
  "createdAt": "2026-01-01T00:00:00Z"
}
```

### Carrier

```json
{
  "id": "uuid",
  "name": "FedEx",
  "mcNumber": "MC123456",
  "favorite": true,
  "usageCount": 42,
  "createdAt": "2026-01-01T00:00:00Z"
}
```

### History Entry

```json
{
  "id": "hist-uuid",
  "action": "MOVED_TO_DOOR",
  "timestamp": "2026-01-01T12:00:00Z",
  "userId": "user-uuid",
  "username": "dockadmin",
  "trailerId": "uuid",
  "trailerNumber": "TR12345",
  "carrier": "FedEx",
  "customer": "Acme Corp",
  "doorNumber": 5,
  "previousLocation": "Yard Slot 3"
}
```

### User

```json
{
  "id": "uuid",
  "username": "dockadmin",
  "passwordHash": "$2b$10$...",
  "email": "admin@example.com",
  "role": "admin",
  "authType": "local",
  "active": true,
  "homeFacility": "facility-uuid",
  "createdAt": "2026-01-01T00:00:00Z",
  "lastLogin": "2026-01-01T12:00:00Z",
  "isBootstrap": true
}
```

### Facility

```json
{
  "id": "facility-uuid",
  "name": "Main Warehouse",
  "description": "Primary facility",
  "createdAt": "2026-01-01T00:00:00Z",
  "updatedAt": "2026-01-01T00:00:00Z",
  "active": true,
  "config": {
    "doorCount": 57,
    "yardSlotCount": 30,
    "dumpsterCount": 2,
    "rampCount": 3
  }
}
```

---

## API Documentation

### Authentication

All protected endpoints require a Bearer token:

```
Authorization: Bearer <jwt-token>
```

### Rate Limiting

- **Login per username**: 5 attempts per 15 minutes
- **Login per IP**: 20 attempts per 15 minutes
- Successful logins do not count against limits

### Endpoints

#### Auth
- `POST /api/auth/login` - Authenticate and get JWT
- `GET /api/auth/status` - Check authentication status
- `GET /api/auth/config` - Get auth configuration
- `POST /api/auth/change-password` - Change own password
- `POST /api/auth/set-new-password` - Set password after reset
- `POST /api/auth/switch-facility` - Switch facility (admin only)
- `POST /api/auth/set-home-facility` - Set home facility

#### Users
- `GET /api/users` - List all users (admin only)
- `POST /api/users` - Create user (admin only)
- `PUT /api/users/:id` - Update user
- `DELETE /api/users/:id` - Deactivate user
- `POST /api/users/:id/reset-password` - Initiate password reset

#### User Settings
- `GET /api/user/settings` - Get user settings
- `POST /api/user/settings` - Update user settings

#### Facilities (Multi-Facility Mode)
- `GET /api/facilities` - List all facilities (admin only)
- `POST /api/facilities` - Create facility (bootstrap admin only)
- `GET /api/facilities/:id` - Get facility details
- `PUT /api/facilities/:id` - Update facility
- `DELETE /api/facilities/:id` - Deactivate facility

#### Setup
- `GET /api/setup/status` - Check if setup needed (public)
- `POST /api/setup` - Create initial facility config
- `DELETE /api/setup` - Clear facility data
- `POST /api/setup/reset` - Reset facility

#### State
- `GET /api/state` - Get current application state
- `GET /api/health` - Health check

#### Settings
- `GET /api/settings` - Get display settings
- `POST /api/settings` - Update settings

#### Trailers
- `POST /api/trailers` - Create trailer
- `PUT /api/trailers/:id` - Update trailer
- `DELETE /api/trailers/:id` - Delete trailer
- `POST /api/trailers/:id/ship` - Ship outbound trailer
- `POST /api/trailers/:id/receive` - Receive inbound trailer
- `DELETE /api/shipped/:id` - Delete shipped trailer record
- `DELETE /api/received/:id` - Delete received trailer record

#### Movement
- `POST /api/move-to-door` - Move trailer to door
- `POST /api/move-to-yard` - Move trailer to yard
- `POST /api/move-to-yard-slot` - Move to yard slot
- `POST /api/move-from-yard-slot` - Move from slot to unassigned

#### Doors
- `POST /api/doors` - Create door
- `PUT /api/doors/:id` - Update door
- `DELETE /api/doors/:id` - Delete door
- `POST /api/doors/reorder` - Reorder doors
- `POST /api/doors/:id/assign-next` - Assign next queued trailer

#### Yard
- `GET /api/yard-slots` - List yard slots
- `POST /api/yard-slots` - Create slot
- `PUT /api/yard-slots/:id` - Update slot
- `DELETE /api/yard-slots/:id` - Delete slot
- `POST /api/yard-slots/reorder` - Reorder slots

#### Queues
- `GET /api/staging` - Get staging area trailer
- `POST /api/staging` - Add to staging
- `GET /api/queue` - List FCFS queue
- `POST /api/queue` - Add to queue
- `POST /api/queue/:id/cancel` - Remove from queue
- `POST /api/queue/:id/reassign` - Change target door
- `GET /api/appointment-queue` - List appointments
- `POST /api/appointment-queue` - Add appointment
- `POST /api/appointment-queue/:id/cancel` - Cancel appointment
- `POST /api/appointment-queue/reorder` - Reorder appointments

#### Carriers
- `GET /api/carriers` - List carriers
- `POST /api/carriers` - Create carrier
- `PUT /api/carriers/:id/favorite` - Toggle favorite
- `POST /api/carriers/:id/use` - Increment usage
- `DELETE /api/carriers/:id` - Delete carrier

#### History
- `GET /api/history` - Get movement history
  - Query params: `search`, `limit`, `offset`, `dateFrom`, `dateTo`

#### Archives
- `GET /api/archives` - List archives
- `POST /api/archives` - Create archive
- `GET /api/archives/:filename` - Download archive
- `POST /api/archives/restore` - Restore from archive
- `GET /api/archives/export?type=shipped|received` - Export shipped or received trailers to Excel

#### Analytics
- `GET /api/analytics` - Get dwell statistics
  - Query params: `period` (day/week/month), `facilities`, `direction` (inbound/outbound/all)
- `POST /api/analytics/snapshot` - Create analytics snapshot
- `DELETE /api/analytics` - Clear analytics data
- `GET /api/analytics/violations` - Get 2+ hour violations
- `GET /api/analytics/current-violations` - Real-time violations
- `GET /api/analytics/heatmap` - Door usage heatmap
  - Query params: `carrier`, `customer`
- `GET /api/analytics/position-patterns` - Carrier/door patterns
  - Query params: `carrier`, `customer`, `dateFrom`, `dateTo`

#### Demo
- `POST /api/demo/generate` - Generate demo data (bootstrap admin only)

#### Events (SSE)
- `GET /api/events` - Real-time updates stream

### Example Requests

#### Login

```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"dockadmin","password":"yourpass"}'
```

#### Create Trailer

```bash
curl -X POST http://localhost:3000/api/trailers \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "number": "TR12345",
    "carrier": "FedEx",
    "status": "loaded",
    "customer": "Acme Corp"
  }'
```

#### Move to Door

```bash
curl -X POST http://localhost:3000/api/move-to-door \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "trailerId": "uuid",
    "doorId": "door-1"
  }'
```

#### Get History

```bash
# With search and pagination
curl "http://localhost:3000/api/history?search=FedEx&limit=50&offset=0" \
  -H "Authorization: Bearer $TOKEN"

# With date range
curl "http://localhost:3000/api/history?dateFrom=2026-01-01&dateTo=2026-01-31" \
  -H "Authorization: Bearer $TOKEN"
```

---

## Security

### Implemented Protections

- **JWT Authentication** - Stateless token-based auth
- **Rate Limiting** - Login limited to 5 attempts per username per 15 minutes
- **Input Sanitization** - XSS protection via HTML entity encoding
- **Prototype Pollution Prevention** - Blocks `__proto__`, `constructor`, `prototype`
- **Archive Validation** - Validates structure before restore
- **Auto-Backup** - Creates backup before any restore
- **Role-Based Access Control** - viewer/user/admin hierarchy
- **No Caching** - Cache-control headers on all API responses


---

## Development

### Health Check

```bash
# Check server health
curl http://localhost:3456/api/health
```

### Generate Demo Data

```bash
# Generate trailers with history
node scripts/generate-demo-data.js

# Generate for specific facility
node scripts/generate-demo-data.js facility-id
```

### File Locations

When running locally (without Docker), the server writes to `../data/` relative to `src/server.js`.

---

Prototyped and iterated using local open-source LLMs and made for warehouse workers everywhere.
