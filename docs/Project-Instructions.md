# Foundation AI Infrastructure — Project Instructions

## What This Project Is
Enduring infrastructure project tracking the build-out, migration, maintenance, and evolution of Foundation's on-premises AI infrastructure — VM environment, DGX Spark nodes, and supporting services.

## Second Brain Location
`/Users/andrewhowerton/Documents/Second Brain/3. Planning/6. Work Projects/0. Active Priority/Foundation AI Infrastructure/`
Sync all session updates back here before closing.

## Session Protocol

### Starting a Session
1. Read `Overview.md` — current phase, active migration, hardware state
2. Read `Notes.md` — most recent dated entry to understand current infrastructure status
3. Read `Roadmap.md` — active phase, deployment tasks, and software roadmap
4. Briefly confirm current state before beginning work

### During a Session
- Mark tasks complete in `Roadmap.md` as they finish — do not batch at the end
- Add new tasks, issues, or configuration discoveries immediately

### Ending a Session
Before this session closes, write back:
1. **`Notes.md`** — dated entry: what changed, what was configured, current system state, what next session needs to know
2. **`Roadmap.md`** — completed tasks marked, new tasks added, phase status refreshed
3. **`Overview.md`** — update current phase and status if migration stage changed
4. **`Last Synced`** timestamp in `Roadmap.md` if repo sync was performed

## Project-Specific Rules
- **Never store credentials, API keys, or access tokens in project files**
- Document all infrastructure changes with before/after state — this is an operational record
- Test configuration changes on VM before touching DGX production nodes
- Hardware specs and network topology should be kept current in Overview
- When documenting issues, include error messages verbatim — exact errors matter for future debugging

## Key External Resources
- Proxmox dashboard (VM management)
- DGX Spark management UI
- Foundation network infrastructure documentation
