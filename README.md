# BTD Attendance App — Handoff Summary
**Date:** 2026-05-01  
**Stack:** React + Vite + Tailwind (frontend) | Node.js + Express + Socket.io + PostgreSQL (backend) | Expo (mobile)

---

## Infrastructure
| Component | Location | URL |
|-----------|----------|-----|
| Frontend (admin) | `~/attendance-app/attendance-admin` | `btdadmin.technodevenv.dpdns.org` |
| Backend API | `~/attendance-app/attendance-api` | `btdapp.technodevenv.dpdns.org:3000` |
| Mobile (Expo) | Windows machine | `attendance-mobile` |
| Database | PostgreSQL | `attendance_db` |

**Run commands:**
- Frontend: `npm run build && serve -s dist -l 5173`
- Backend: `npm run dev` (nodemon)

---

## Database — All Tables

### Core
```sql
employees         -- emp_id, name, designation, designation_id, phone, email, reports_to, 
                  -- enrollment_status, target_enrollment_device_id, profile_image, face_descriptor
devices           -- id, device_unique_id, device_name, friendly_name, is_active, is_online, last_seen_at
employee_devices  -- employee_id, device_id (many-to-many)
attendance_logs   -- id, employee_id, action_type (IN/OUT), log_time, latitude, longitude, site_id
sites             -- id, site_name, latitude, longitude, enrollment_status, location_id, supervisor_id
```

### Hierarchy & Reference
```sql
designations      -- id, name, level (1=TL, 2=Supervisor/Engineer, 3=Technician)
employee_portfolios -- emp_id, portfolio_id  (Team Lead → Portfolios)
pending_enrollments -- id, employee_id, device_id (multiple devices per employee)
```

### Location
```sql
emirates          -- id, name (7 UAE emirates, seeded)
locations         -- id, name, emirate_id
```

### Jobs & Contracts
```sql
job_categories    -- id, code (BTM/BTS/BTV), description
clients           -- id, name, client_category_id
client_categories -- id, name, description
client_representatives -- id, client_id, name, designation, email, phone
jobs              -- id, job_number, job_category_id, job_code, client_id, client_rep_id,
                  -- supervisor_id, team_lead_id, estimated_manhours, project_value, cost_incurred
job_portfolios    -- job_id, portfolio_id (many-to-many)
job_systems       -- job_id, system_id (many-to-many)
job_products      -- job_id, product_id (many-to-many)
site_jobs         -- id, site_id, job_id (many-to-many)
```

### Systems & Products
```sql
portfolios        -- id, name, description (FLS, ELV, etc.)
systems           -- id, name, description, portfolio_id (each system belongs to ONE portfolio)
products          -- id, system_id, manufacturer, brand, model, description
site_assets       -- id, site_id, job_id, product_id, quantity, serial_number (future use)
```

### Migrations Run
- `migration.sql` — base schema
- `migration_v2.sql` — job_products, supervisor/team_lead on jobs
- `migration_v3.sql` — designations, employee hierarchy, employee_portfolios
- `migration_v4.sql` — pending_enrollments table

---

## Backend Routes

| File | Mount | Key endpoints |
|------|-------|--------------|
| `employeeRoutes.js` | `/api/employees` | GET all (with designation, reports_to, portfolios, devices), POST, PATCH, DELETE, assign-device, unassign-device, enroll |
| `deviceRoutes.js` | `/api/devices` | GET, activate (auto-enrollment), toggle-active, friendly-name, trigger-enrollment, pending-enrollment |
| `siteRoutes.js` | `/api/sites` | GET (with jobs+clients+TL), POST, PATCH, DELETE, link-job, unlink-job |
| `attendanceRoutes.js` | `/api/attendance` | sync, logs, dashboard-stats |
| `locationRoutes.js` | `/api/locations` | GET, POST, PATCH, DELETE, reverse-geocode, emirates |
| `referenceRoutes.js` | `/api/ref` | job-categories, client-categories, portfolios, systems, products, clients, reps |
| `jobRoutes.js` | `/api/jobs` | GET (with sites, portfolios, systems, used_manhours auto-calc), POST, PATCH, DELETE |
| `clientRoutes.js` | `/api/clients` | GET (with jobs+sites+rep per job), POST, PATCH, DELETE, reps CRUD |
| `designationRoutes.js` | `/api/designations` | GET, POST, PATCH, DELETE |

---

## Frontend Pages & Routes

| Route | Page | Status |
|-------|------|--------|
| `/` | Dashboard | ✅ Live stats, socket, movements |
| `/employees` | Employees | ✅ Full hierarchy, designations, portfolios, enrollment |
| `/employees/designations` | Designations | ✅ CRUD with levels |
| `/logs` | AttendanceLogs | ✅ Basic filters |
| `/sites` | Sites | ✅ Cards, job linking, collapsible filters |
| `/sites/locations` | Locations | ✅ Flat table with pagination |
| `/jobs` | Jobs | ✅ Full form, supervisor/TL auto, portfolio cascade |
| `/jobs/categories` | JobCategories | ✅ CRUD |
| `/clients` | Clients | ✅ Cards, reps, job linking |
| `/clients/categories` | ClientCategories | ✅ CRUD |
| `/systems/portfolios` | Portfolios | ✅ Accordion with systems |
| `/systems/products` | Products | ✅ Table with filters |
| `/devices` | Devices | ✅ Online/offline, active/inactive, friendly name |

---

## Key Components
| File | Location | Purpose |
|------|----------|---------|
| `SearchableSelect.jsx` | `src/components/` | Portal-based searchable dropdown (escapes overflow) |
| `Sidebar.jsx` | `src/components/` | Collapsible nav with sections |
| `RefPage.jsx` | `src/pages/` | Factory for simple CRUD reference pages |

---

## Business Logic

### Org Hierarchy
```
Team Lead (level 1) → owns Portfolios
  └── Supervisor / Engineer (level 2) → reports_to = Team Lead
        └── Technician (level 3) → reports_to = Supervisor or Engineer
```
- `employees.reports_to` = direct manager's emp_id
- Portfolio inheritance: employee shows TL's portfolio if no direct assignment
- Jobs: supervisor selected → team_lead auto-filled from supervisor.reports_to

### Manhour Calculation (auto, no manual entry)
```sql
-- Pairs IN/OUT punches, sums actual duration in hours
SUM(out_time - in_time) for each employee IN/OUT pair at job's sites
```

### Enrollment Flow
1. Employee created → manager's device auto-assigned + enrollment triggered
2. Employee installs app → own device registered → enrollment triggered on own device too
3. Both devices show enrollment task simultaneously (first to capture wins)
4. `pending_enrollments` table tracks all pending devices per employee
5. On face capture → all pending_enrollments for that employee deleted
6. Admin can: "+ Add Device" (additive) or "Reassign" (cancels old, sends to new)

### Device Activation Flow
```
Mobile: POST /devices/activate {employee_id, device_unique_id, device_name}
→ Creates/updates device record
→ Sets friendly_name = "{Employee Name}'s Phone"  
→ Links device to employee (employee_devices)
→ Triggers enrollment on own device (pending_enrollments insert + socket)
→ Does NOT cancel manager's pending enrollment
```

### Real-time (Socket.io)
- All pages listen to `dashboard-update` event → refetch data
- Specific device events: `device-status-changed`, `new-enrollment-task`, `cancel-enrollment-task`, `new-site-task`

---

## Sidebar Navigation
```
Dashboard
Employees
  ├── Employees
  ├── Employee Attendance
  └── Designations
Sites
  ├── Service Sites
  └── Locations
Jobs
  ├── All Jobs
  └── Job Categories
Clients
  ├── All Clients
  └── Client Categories
Systems & Portfolios
  ├── Portfolios & Systems
  └── Products
Devices
```

---

## Pending / TODO

### Admin Frontend
- [ ] **Employee Attendance (Logs) page** — needs redesign with filters by employee, site, job, date range, designation
- [ ] **Dashboard** — update stats cards to reflect new data model (jobs, clients, manhours)
- [ ] **Site card** — show manhours and cost summary per site (from linked jobs)
- [ ] **Jobs page** — link sites FROM job side (currently only from site side)
- [ ] **Asset List** — `site_assets` table exists, UI not built yet
- [ ] **GPS modal** — show friendly device name instead of OS name in dropdown

### Mobile (Expo)
- [ ] `device-status-changed` socket listener → show notification + disable attendance tile when deactivated
- [ ] `new-enrollment-task` socket listener → trigger face capture flow
- [ ] `cancel-enrollment-task` socket listener → cancel pending capture
- [ ] Test full enrollment flow end-to-end

### Infrastructure  
- [ ] Set up Nginx for production (CORS + WebSocket proxy)
- [ ] PM2 for process management
- [ ] SSL/HTTPS

---

## Known Issues / Notes
- `referenceRoutes.js` has duplicate client CRUD — `clientRoutes.js` is authoritative
- Existing jobs in DB may have NULL supervisor_id (created before column added) — edit and resave to fix
- `site_jobs` junction table used for site↔job (many-to-many), not a FK on jobs
- Job portfolio filter on Sites page uses portfolio name string match (not ID) — works but fragile if names change
- `used_manhours` on jobs is auto-calculated at query time, not stored — good for accuracy, slightly heavier query


**Date:** 02/05/2026

## What was completed this session:
### Mobile (Expo)

Unified fetchTaskQueue() replacing all per-task fetch functions — TASK_DEFINITIONS array makes adding future tasks a one-liner
Reusable <TaskTile> component in HomePage — badge count, consistent sizing, highlighted border for tasks
device-status-changed socket listener + deactivated banner + attendance tile disabled
Enrollment count badge (was just a dot before)
Account modal with proper backend device deletion on reset
SiteSetupPage sends device_unique_id with GPS capture

### Admin Frontend (Sites.jsx)

4×3 grid (12 per page) with compact cards
GPS Info collapsible panel — pending devices list with online/offline per device, last capture timestamp + which device
Update GPS modal → team-based supervisor picker with search, replaces single device dropdown
Pending badge shows count on card

### Backend

siteRoutes.js — trigger-gps-enrollment fans out to full team via pending_site_enrollments junction table, cancels old device on reassign, update-gps has dual strategy for capturing device ID
deviceRoutes.js — pending-site-tasks uses junction table, device delete cleans up junction table
migration_v5.sql — gps_captured_by_device_id column
migration_v6.sql — pending_site_enrollments junction table, gps_requested_by_emp_id


## Extra done


### Mobile App (Expo)

Unified fetchTaskQueue() with TASK_DEFINITIONS — one function handles all task types
Reusable <TaskTile> component — adding future tiles is one line
device-status-changed socket listener + deactivated banner
Enrollment count badge (was just a dot)
Account modal with proper backend device deletion
Full AttendancePage redesign — centered loading with GPS pulse animation, polished site card with green/red status border, icons on punch buttons, clean camera screen with punch type badge

### Admin Frontend

Sites page: 4×3 compact grid (12 per page), GPS info collapsible panel showing all pending devices with online/offline status, last capture timestamp + which device
Team-based GPS assignment — pick supervisor → fans out to entire team
Supervisor filter added to sites page
Result count banner
Mobile-responsive toolbar and pagination
Filter auto-close on mobile

### Backend

pending_site_enrollments junction table replacing single target_device_id
First-capture-wins GPS logic with dual device identification strategy
siteRoutes.js — cancel old device on reassign, track which device captured GPS
migration_v5 and migration_v6 SQL


Session Summary — Phase 2
🔐 Auth & Roles

Login page redesign (dark glassmorphism), dev bypass via VITE_DEV_BYPASS
PrivateRoute.jsx with JWT expiry check + dev token support
RolesSettings.jsx — permissions matrix per role, employee account management, password set/reset
roleRoutes.js — Admin-only endpoints for role/permission CRUD
authRoutes.js — proper logging, better error messages
insert-admin.sql, setup-admin.sql, setAdminPassword.js

🗄️ DB Tools

DB Clearance — 13 tables, FK-safe single TRUNCATE RESTART IDENTITY, fixed cascade bug
DB Seed — realistic UAE dummy data, all tables, Seed All in order
clearanceRoutes.js, seedRoutes.js

📊 Logging Fixes

Live tail socket reconnect fix (useEffect empty deps + refs)
ts vs timestamp field mismatch fixed
/api/logs feedback loop broken in httpLogger.js + App.jsx + logger.js

🎨 UI/UX

Skeleton loading on all 10+ pages (desktop + mobile)
Collapsible filters on all pages (mobile)
Products — full rewrite with 4 filters, sort, pagination
Portfolios — 4×3 card grid, system filter dedup
Locations — emirate-grouped mobile cards
ClientCategories, JobCategories — clean mobile rewrite
AttendanceLogs — paired IN/OUT sessions view with duration, status badges
Sidebar closes on tap (mobile), hydration error fixed

🏗️ Attendance Job Logic (Major Feature)

migration_v9.sql — job_id on attendance_logs, active_sessions table
attendanceRoutes.js — /punch-in, /punch-out, /active-session, /site-jobs/:id
AttendancePage.js — job picker modal for multi-job sites, auto-select for single job, server-side session for cross-device punch-out
jobRoutes.js — manhours fixed to use job_id directly (no more double-counting)




### Still pending for future sessions:

Asset List UI
Today's Schedules and Employee Assessment mobile tiles
Correction Request workflow — missed punch-out detection, employee submits correction, TL approves/rejects, score flag
Notification system — Nodemailer (Gmail SMTP) + CallMeBot (WhatsApp), wired into correction workflow and 24h timeout
Tables needed: correction_requests, attendance_logs.score_flag


#### Tdays session to be worked 03/05/2025

1. The "Correction & Multi-Type" Logic ExplainedTo achieve your goal, we need to transition from a binary IN/OUT system to a Status-Based Workflow.A. New Punch Types & HierarchyDuty Start / Duty End: The "Container" for the day. (Home or Office).Site IN / Site OUT: Tied to a specific job_id and site_id. (Man-hour calculation).Activity IN / Activity OUT: Sub-types like Material Purchase, Site Survey, Others. (Non-site productivity).Travel Time: Automatically calculated as the gap between any OUT and the next IN.B. The "Ghost Session" Detection (The Correction Trigger)When the employee opens the app, the server performs a Pre-Check:Condition: Does active_sessions have a record for this emp_id from a previous date or a different location?Action: If yes, the app blocks the normal "Punch In" UI and displays the Correction Request Tile.Data Entry: The employee must provide the "Missed Time" and a "Reason." Until this is submitted, they cannot start a new duty.C. Unauthorized LocationsThe "Home" Location: Added to employees table. Puncing within $X$ meters of home is auto-approved as "Duty Start/End."Ad-hoc Sites: For "Site Survey" or "Material Purchase," the employee selects the Job Code manually. The TL approval "validates" these hours into the project cost.2. Structural Changes NeededDatabase Updatesattendance_logs: Add type (Duty, Site, Activity), sub_type (Survey, Purchase, etc.), and is_approved (boolean).correction_requests: New table to store log_id, requested_time, reason, status (Pending/Approved/Rejected), and tl_id.employees: Add home_latitude, home_longitude.3. The Development PromptUse the prompt below with your AI model (like Gemini or GPT-4) to generate the code for this specific feature.Prompt for AI:"I am developing an Attendance App using React/Expo, Node.js, and PostgreSQL. I need to implement a Correction Request Workflow and Advanced Punch Types.1. Data Model Changes:Update attendance_logs to include punch_type (Duty, Site, Activity) and sub_type (Survey, Purchase, Forgot).Create a correction_requests table: id, emp_id, log_id, suggested_time, reason, status (pending/approved/rejected), reviewer_id.Add home_lat and home_lng to the employees table.2. Backend Logic (Node.js):Create an endpoint GET /attendance/check-status/:emp_id. It must check if there is an unclosed session (active_sessions). If the session is >14 hours old or at a different GPS location than the current one, flag it as 'requires_correction'.Create a POST /attendance/correction endpoint that saves the request and notifies the Team Lead via Socket.io.Update the Man-hour calculation logic: Only 'Approved' Activity punches or 'Site' punches contribute to job_manhours.3. Mobile UI (Expo):Logic: On App Load, call check-status. If requires_correction is true, hide the 'Attendance' tile and show a 'Pending Correction' tile.Form: The Correction form should allow the user to pick a 'Missed Out-Time' and a reason from a dropdown (Forgot, Device Battery, Technical Issue).Unauthorized Locations: If GPS doesn't match a site, show a 'Special Punch' menu with options: 'Material Purchase', 'Site Survey', or 'Home (Duty Start/End)'.4. Admin/TL UI (React):Create a 'Pending Approvals' view for Team Leads to see their team's corrections.Include an 'Approve' button (updates the log and moves it to history) and a 'Reject' button (marks the log with a 'penalty_score' flag).Please provide the SQL migration, the Express route logic for the status check, and the Expo component logic for the conditional tile rendering."4. Pro-Tips for your "Efficiency Analytics"Travel Time: To calculate this, query the time difference between Duty Start and the first Site IN.Map Routes: Since you already have latitude and longitude in attendance_logs, you can use the Google Maps Snap-to-Roads API later to visualize the drive paths between sites.The Penalty System: When a TL rejects a correction, instead of deleting the time (which might be illegal/incorrect for payroll), keep the time but set score_impact = true. You can then generate a monthly report of "Most Forgetful Employees."

