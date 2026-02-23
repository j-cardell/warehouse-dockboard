# 📦 Warehouse Dock Board

A real-time dock management application for warehouses, distribution centers, and logistics facilities. Track trailers, manage dock doors, organize yard slots, and maintain complete movement history with a drag-and-drop interface.

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-4.x-blue)](https://expressjs.com/)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## 📋 Table of Contents

- [Features](#-features)
- [Screenshots](#-screenshots)
- [Quick Start](#-quick-start)
- [Installation](#-installation)
- [Configuration](#-configuration)
- [Usage](#-usage)
- [Architecture](#-architecture)
- [API Documentation](#-api-documentation)
- [Security](#-security)
- [Contributing](#-contributing)
- [License](#-license)

---

## ✨ Features

### Core Functionality
- **🔐 Secure Authentication** - JWT-based authentication with rate limiting
- **🚪 Dock Door Management** - Configurable dock doors with custom starting numbers
- **🅿️ Yard Organization** - Numbered yard slots with customizable ranges
- **📦 Trailer Tracking** - Real-time trailer status (empty, loaded, in-transit)
- **🗑️ Facility Features** - Support for dumpsters and ramps as non-trailer locations
- **📜 Movement History** - Complete audit trail with pagination (500 entries per page)
- **📊 Analytics Dashboard** - Dwell time tracking, violations, and heatmaps
- **🗄️ Data Archives** - Create and restore point-in-time backups

### User Interface
- **Drag & Drop** - Move trailers between doors, yard, and staging
- **Bulk Selection** - Ctrl+Click to select multiple trailers
- **Search & Filter** - Real-time search with carrier, trailer, and door filters
- **Keyboard Shortcuts** - Ctrl+K for quick search
- **Responsive Design** - Works on desktop and tablet devices
- **Dark Theme** - Easy on the eyes during long shifts

### Advanced Features
- **Auto-Assignment** - Automatically assigns next trailer from queue when door clears
- **Dwell Time Tracking** - Tracks how long trailers sit at dock doors (6-hour max display)
- **Queue System** - FCFS queue for specific doors and appointment scheduling
- **Carrier Management** - Registry with usage tracking
- **Edit Mode** - Protected mode for dangerous operations (delete doors, clear data)

---

## 📸 Screenshots

*Main dashboard showing dock doors, yard slots, and staging area*
<img width="2304" height="1356" alt="image" src="https://github.com/user-attachments/assets/1e8a98e3-35ba-46fc-905d-d02c7ec3fffd" />

*Movement history with search and date filtering*
<img width="910" height="1124" alt="image" src="https://github.com/user-attachments/assets/8396fdd0-78ee-4db6-ad1d-6769fd3d68f4" />

*Setup wizard for initial configuration*                                                                               

<img width="619" height="693" alt="image" src="https://github.com/user-attachments/assets/d42dd6e5-7216-4d45-a54f-67fb27c18239" />

---

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- npm or yarn
- Environment variables configured

### Run Locally

```bash
# Clone the repository
git clone https://github.com/yourusername/warehouse-dockboard.git
cd warehouse-dockboard

# Set environment variables
export AUTH_USER=dockadmin
export AUTH_PASS=your-secure-password
export JWT_SECRET=$(openssl rand -hex 32)

# Install dependencies
npm install

# Start the server
npm start

# Or for development with auto-reload
npm run dev
```

The application will be available at `http://localhost:3000`

### First Run

On first startup, the application requires initial configuration before use:

#### Step 1: Login

1. Navigate to `http://localhost:3000`
2. Enter your configured credentials (`AUTH_USER` and `AUTH_PASS` from environment variables)
3. Click **Login**
4. The system verifies credentials and issues a JWT token (stored in browser localStorage)

#### Step 2: Setup Wizard

After first login, the setup wizard appears automatically. This one-time configuration creates your facility layout:

| Setting | Description | Example Values |
|---------|-------------|----------------|
| **Number of dock doors** | Total doors in your facility | 10, 50, 100 |
| **Starting door number** | First door label (supports any starting number) | 1, 100, 1000, 5000 |
| **Number of yard slots** | Outdoor storage positions | 20, 50, 100 |
| **Starting yard slot number** | First yard slot label | 1, 101, 1001 |
| **Number of dumpsters** | Dumpster locations (created as blank-type doors) | 2, 4 |
| **Number of ramps** | Ramp locations (created as blank-type doors) | 1, 2 |

**How to complete the wizard:**
1. Fill in each field with your facility's specifications
2. Click **"Create Facility"**
3. The system generates:
   - Dock doors with sequential numbers (e.g., 100, 101, 102...)
   - Yard slots with your numbering scheme
   - Blank-type doors for dumpsters and ramps (display custom labels instead of numbers)
4. Upon completion, the main dashboard loads automatically

#### Step 3: Dashboard Overview

After setup, you see the main dock board interface with three primary zones:

**Dock Doors**
- Grid layout showing all configured doors
- Empty doors show large background numbers
- Occupied doors display trailer cards with:
  - Trailer number (bold, top left)
  - Carrier name (bottom of card)
  - Status badge (📦 Loaded / 📭 Empty)
  - Dwell time (⏱️ hours:minutes)

**Staging Area**
- Pre-door holding area for trailers awaiting assignment
- Drag trailers here when they're checked in but not ready for a door

**Yard Slots**
- Numbered grid matching your configuration
- Shows current occupancy status
- Click "+ Add" to create trailers directly in yard

**Queues**
- **FCFS Queue**: Trailers waiting for specific doors (first-come-first-served)
- **Appointment Queue**: Scheduled arrivals with check-in functionality

### Daily Operation Workflows

#### Morning Startup
1. Open the dock board URL
2. Review overnight status (check dwell times on trailers)
3. Look at queued trailers for today's schedule
4. Check carrier summary for expected volumes

#### Receiving a Trailer
1. **Create** trailer with details
2. **Assign** to yard slot or staging
3. When ready: **drag** to appropriate door
4. Monitor dwell time (yellow/red badges indicate long stays)

#### Shipping a Trailer
1. Verify load completion (toggle status if needed)
2. **Ship** via trailer menu
3. Door auto-assigns next queued trailer (if any)

#### End of Shift
1. Review any trailers with red dwell time badges (over 6 hours)
2. Check **History** for day's activity
3. Create an **Archive** backup (Edit Mode → Archives → Create)

### Understanding Visual Indicators

| Indicator | Meaning | Action Needed |
|-----------|---------|---------------|
| ⏱️ 2:30 | Trailer at door 2h 30m | Monitor |
| ⏱️ 5:45 (red) | Trailer over 6 hours | Priority unload |
| ⏳ 3 | 3 trailers queued | Prepare next |
| 🔧 | Door out of service | Use alternate door |
| 📦 | Trailer loaded | Ready to ship |
| 📭 | Trailer empty | Ready to load |

---

## 🔧 Installation

### Docker

```bash
# Build and run with Docker Compose
docker-compose up --build

# The app will be available on port 3456
```

### Manual Installation

1. **Install Node.js 18+**
   ```bash
   # Ubuntu/Debian
   curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
   sudo apt-get install -y nodejs

   # macOS
   brew install node@18
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment**
   ```bash
   cp .env.example .env
   # Edit .env with your settings
   ```

4. **Start the server**
   ```bash
   npm start
   ```

---

## ⚙️ Configuration

### Required Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `AUTH_USER` | Username for login | `dockadmin` |
| `AUTH_PASS` | Password for login | `SecureP@ssw0rd!` |
| `JWT_SECRET` | Secret key for JWT tokens | `a1b2c3d4...` (64 hex chars) |
| `PORT` | Server port (optional) | `3000` |
| `JWT_EXPIRES_IN` | Token expiration (optional) | `24h` |

### Generating JWT Secret

```bash
# Generate a secure 256-bit secret
openssl rand -hex 32
```

### Docker Environment

```yaml
environment:
  - NODE_ENV=production
  - AUTH_USER=dockadmin
  - AUTH_PASS=${AUTH_PASS}
  - JWT_SECRET=${JWT_SECRET}
  - PORT=3456
```

---

## 📖 Usage

### First Run Setup

On first access to a fresh installation:

1. **Login**: Enter the credentials configured via environment variables (`AUTH_USER` and `AUTH_PASS`)
2. **Setup Wizard**: Configure your facility layout:
   - **Number of dock doors** - How many doors your facility has
   - **Starting door number** - First door label (e.g., 1, 100, 1000)
   - **Number of yard slots** - Yard storage positions
   - **Starting yard slot number** - First yard slot label
   - **Dumpsters** - Number of dumpster locations (created as blank-type doors)
   - **Ramps** - Number of ramp locations (created as blank-type doors)
3. **Dashboard**: After setup, the main interface loads with your configured layout

### Dashboard Overview

The main interface is organized into sections:

| Section | Description |
|---------|-------------|
| **Dock Doors** | Grid showing all configured doors with their current trailer |
| **Yard Slots** | Numbered yard positions for trailers waiting for dock |
| **Staging Area** | Pre-door holding area for trailers not yet assigned |
| **Queues** | FCFS queue and appointment queue for scheduled arrivals |
| **Carrier Summary** | Real-time bar showing active carriers and their locations |

### Managing Trailers - Complete Workflow

#### 1. Creating Trailers

Click **"➕ Add Trailer"** to open the creation form:

- **Required fields**: Trailer number, Carrier name
- **Optional fields**: Load number, Customer name, Driver name, Status (loaded/empty)
- **Live Load checkbox**: Mark if the trailer is actively being loaded/unloaded
- **Location options**:
  - **Yard slot**: Specific numbered yard position
  - **Staging area**: General holding area
  - **Specific door**: Pre-assign to a dock door
  - **Queued**: Add to FCFS queue for a specific door

Once created, the trailer appears in the selected location and an entry is logged in the movement history.

#### 2. Moving Trailers

There are two ways to move trailers:

**Drag and Drop** (recommended):
1. Click and hold on a trailer card
2. Drag it to a destination:
   - Another dock door
   - An empty yard slot
   - The staging area
   - A different yard slot
3. Release to drop

**Move Menu**:
1. Click the trailer card to select it
2. Use the **Actions** dropdown or right-click menu
3. Select "Move to..." and choose destination

Both methods automatically log the movement in history with timestamp and user info.

#### 3. Shipping Trailers

When a trailer is ready to depart:

1. Click the trailer card to select it
2. Choose **Actions → Ship** (or right-click menu)
3. The trailer moves to the "Shipped" archive
4. The dock door becomes empty and available
5. If trailers are queued for this door, the next one is automatically assigned (if auto-assignment is enabled)

Shipped trailers can be viewed via the **Shipped Trailers** button and can be restored if shipped by mistake.

### Door-Specific Features

#### Door Status Badges

Each occupied door shows:
- **Status badge** (📦 Loaded / 📭 Empty) - Click to toggle status
- **Dwell time** - How long the trailer has been at the door
- **Queue indicator** (⏳ N) - Shows number of trailers queued for this door

#### Click Interactions

- **Single click on door**: Opens door details/analytics
- **Click on trailer card**: Selects trailer and shows actions
- **Click status badge**: Toggles loaded/empty status
- **Click queue indicator**: Shows queued trailers for this door

### Yard Slot Management

Yard slots function similarly to doors but for outdoor storage:

- **Visual states**: Empty slots show only the slot number; occupied slots show trailer cards
- **Drag and drop**: Move trailers between yard slots or to/from doors
- **Quick add**: Click "+ Add" on an empty door to create a trailer and assign it there

### Queue System

Two queue types manage trailer flow:

#### FCFS Queue (First-Come-First-Served)

1. Create a trailer and select "Queue" as the location
2. Choose the target door from the dropdown
3. The trailer appears in the FCFS queue section
4. When the target door becomes empty, the next queued trailer auto-assigns

#### Appointment Queue

1. Select "Appointment" when creating a trailer
2. Set the appointment time
3. Trailers appear in the appointment queue sorted by time
4. Click "Check In" when the trailer arrives to move it to staging

### Search & Filter

#### Quick Search (Ctrl+K)

The search bar filters visible trailers in real-time:
- Searches trailer numbers, carriers, load numbers, and customers
- Results highlight matching trailers
- Non-matching trailers are dimmed for focus
- Press **Ctrl+K** from anywhere to activate

#### History Search

In the Movement History modal:
- **Text search**: Find by trailer number, carrier, or door
- **Date range**: Filter by specific dates
- **Pagination**: History loads 500 entries at a time; click "Load More" for older entries

### Edit Mode (Protected Operations)

Edit mode enables dangerous configuration changes. Click **"✏️ Edit"** to enter edit mode.

**Visual indicators in edit mode:**
- Edit button changes to "✅ Done Editing"
- Draggable handles appear on doors and yard slots
- Additional buttons appear (delete, add, configure)

**Edit mode operations:**

| Action | How To |
|--------|--------|
| **Reorder doors** | Drag door headers to new positions |
| **Delete a door** | Click ⚙️ → Delete on the door |
| **Add a door** | Click "+ Add Door" card at end of grid |
| **Add yard slots** | Scroll to end of yard section, click "+ Add Slot" |
| **Delete yard slots** | Click 🗑️ on empty yard slots |
| **Configure door** | Click ⚙️ → Edit to set custom labels or mark out-of-service |
| **Access archives** | "🗄️ Archives" button appears in header |
| **Clear data** | "🧹 Clear Data" button appears (with confirmation) |

**Warning**: Edit mode changes save immediately. There is no undo—use archives to backup before major changes.

### Archives & Backups

#### Creating an Archive

1. Enter **Edit Mode**
2. Click **"🗄️ Archives"** button
3. Switch to **"📥 Create"** tab
4. Click **"📦 Create Archive Now"**
5. A timestamped JSON file is saved to the server's `data/archives/` folder

#### Downloading Archives

1. In Archives page, switch to **"📂 Browse"** tab
2. See list of all archives with file sizes
3. Click **"Download"** to save to your computer

#### Restoring from Archive

1. In Archives page, switch to **"📥 Create"** tab
2. Click **"📤 Upload Archive"**
3. Select a previously downloaded archive JSON file
4. Confirm the overwrite warning
5. The server validates the archive, creates a backup of current state, then restores
6. Page reloads automatically with restored data

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+K` | Focus search bar |
| `Escape` | Close modals, exit edit mode |
| `Ctrl+Click` | Multi-select trailers |

### Analytics & Reporting

#### Heatmap View

Click **"🔥 Heatmap"** to see:
- Visual heat map of door usage frequency
- Color-coded intensity (darker = more usage)
- Pattern analysis showing which doors are most popular

#### Carrier Pattern Analysis

Click a door number to see:
- Which carriers use this door most
- Customer distribution
- Frequency statistics
- Export to CSV option

#### Dwell Time Tracking

Doors show dwell time badges:
- **Green**: Under 2 hours
- **Yellow**: 2-4 hours
- **Red**: Over 4 hours (6 hours max displayed)

### Data Safety Features

- **Auto-backup**: Before any archive restore, current state is automatically backed up
- **Validation**: Archives are validated for structure and data integrity before restore
- **Security**: Archive upload/download requires authentication

---

## 🏗️ Architecture

### Tech Stack

| Layer | Technology |
|-------|------------|
| Backend | Node.js, Express |
| Frontend | Vanilla JavaScript (SPA) |
| Styling | CSS3 with CSS Variables |
| Data | JSON files (no database required) |
| Auth | JWT with Basic Auth fallback |

### File Structure

```
warehouse-dockboard/
├── src/
│   └── server.js          # Express server (~1100 lines)
├── public/
│   ├── index.html         # Main application UI
│   ├── app.js             # Frontend logic (~6000 lines)
│   ├── styles.css         # Application styles (~4000 lines)
│   └── archives.html      # Archive management page
├── data/                   # Data storage (created at runtime)
│   ├── state.json         # Current application state
│   ├── history.json       # Movement history
│   ├── analytics.json     # Analytics data
│   └── archives/          # Archive snapshots
├── scripts/
│   └── generate-history.js # Test data generator
└── docker-compose.yml
```

### Data Models

**Door**
```json
{
  "id": "door-1",
  "number": 1,
  "order": 0,
  "type": "normal",
  "trailerId": null,
  "status": "empty",
  "inService": true
}
```

**Trailer**
```json
{
  "id": "trailer-uuid",
  "number": "TR12345",
  "carrier": "FedEx",
  "status": "loaded",
  "doorId": "door-1",
  "createdAt": "2024-01-01T00:00:00Z",
  "dwellResets": []
}
```

**History Entry**
```json
{
  "id": "hist-uuid",
  "trailerId": "trailer-uuid",
  "action": "TRAILER_MOVED",
  "timestamp": "2024-01-01T00:00:00Z",
  "from": "Door 1",
  "to": "Door 2"
}
```

---

## 🔌 API Documentation

### Authentication

All protected endpoints require a Bearer token in the Authorization header:

```
Authorization: Bearer <jwt-token>
```

### Endpoints

#### Auth
- `POST /api/auth/login` - Authenticate and get JWT
- `GET /api/auth/status` - Check authentication status

#### State
- `GET /api/state` - Get current application state
- `GET /api/settings` - Get display settings
- `POST /api/settings` - Update settings

#### Trailers
- `POST /api/trailers` - Create trailer
- `PUT /api/trailers/:id` - Update trailer
- `DELETE /api/trailers/:id` - Delete trailer
- `POST /api/trailers/:id/ship` - Ship trailer

#### Movement
- `POST /api/move-to-door` - Move trailer to door
- `POST /api/move-to-yard` - Move trailer to yard
- `POST /api/move-to-yard-slot` - Move to specific yard slot

#### Queue
- `GET /api/staging` - Get staging area
- `GET /api/queue` - Get FCFS queue
- `GET /api/appointment-queue` - Get appointment queue

#### Doors
- `PUT /api/doors/:id` - Update door
- `POST /api/doors/reorder` - Reorder doors
- `POST /api/doors/:id/assign-next` - Auto-assign next trailer

#### History
- `GET /api/history` - Get movement history (supports pagination)

#### Archives
- `GET /api/archives` - List archives
- `POST /api/archives` - Create archive
- `GET /api/archives/:filename` - Download archive
- `POST /api/archives/restore` - Restore from archive

### Example: Create Archive

```bash
curl -X POST http://localhost:3000/api/archives \
  -H "Authorization: Bearer $TOKEN"
```

### Example: Restore Archive

```bash
curl -X POST http://localhost:3000/api/archives/restore \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d @archive-file.json
```

---

## 🔒 Security

### Implemented Protections

- **JWT Authentication** - Stateless token-based auth
- **Rate Limiting** - Login endpoint limited to 5 attempts per 15 minutes
- **Input Sanitization** - XSS protection via HTML entity encoding
- **Prototype Pollution Prevention** - Blocks `__proto__`, `constructor`, `prototype` keys
- **No Code Execution** - Rejects content containing `eval`, `exec`, `require`, `import`
- **File Upload Validation** - Strict archive validation before restore
- **Auto-Backup** - Creates backup before any restore operation
- **Directory Traversal Prevention** - Filename sanitization for archive downloads

### Security Best Practices

1. **Use strong passwords** - Minimum 12 characters with mixed case, numbers, symbols
2. **Generate secure JWT secrets** - Use `openssl rand -hex 32`
3. **Run behind HTTPS** - In production, use a reverse proxy with SSL
4. **Restrict network access** - Bind to localhost or use firewall rules
5. **Regular backups** - Create archives before major changes

---

## 🤝 Contributing

### Development Setup

```bash
# Fork and clone
git clone https://github.com/yourusername/warehouse-dockboard.git

# Install dependencies
npm install

# Create .env file
echo "AUTH_USER=admin" > .env
echo "AUTH_PASS=test123" >> .env
echo "JWT_SECRET=$(openssl rand -hex 32)" >> .env

# Run in dev mode
npm run dev
```

### Code Style

- Follow existing patterns in the codebase
- Use camelCase for JavaScript variables
- Add comments for complex logic
- Keep functions focused and small

### Submitting Changes

1. Create a feature branch
2. Make your changes
3. Test thoroughly
4. Submit a pull request with clear description

---

## 📄 License

MIT License - See [LICENSE](LICENSE) for details.

---

## 🙏 Acknowledgments

- Icons provided by [Twemoji](https://twemoji.twitter.com/)
- Inspired by warehouse management needs in logistics industry

---

## 📞 Support

For issues and feature requests, please use the [GitHub Issues](https://github.com/j-cardell/warehouse-dockboard/issues) page.

---

<p align="center">
  Made with ❤️ for warehouse workers everywhere
</p>
