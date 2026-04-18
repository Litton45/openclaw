# idle auto-compact backport notes

## Target baseline

- OpenClaw `v2026.4.15`
- validated against worktree based on live-aligned baseline

## Included changes

- add `idleAutoCompact` config shape under `agents.defaults.compaction`
- add `src/gateway/idle-auto-compact.ts`
- wire periodic sweep into `startGatewayMaintenanceTimers(...)`
- add focused tests:
  - `src/gateway/idle-auto-compact.test.ts`
  - `src/gateway/idle-auto-compact.sweep.test.ts`
  - `src/gateway/server-maintenance.idle-auto-compact.test.ts`

## Validation completed

- targeted tests passed:
  - `src/gateway/idle-auto-compact.test.ts`
  - `src/gateway/idle-auto-compact.sweep.test.ts`
  - `src/gateway/server-maintenance.idle-auto-compact.test.ts`
- full `pnpm build` passed

## Notes

- two 4.15 compatibility shims were needed in `idle-auto-compact.ts`:
  - use `../agents/agent-paths.js` for `resolveOpenClawAgentDir`
  - avoid importing `DEFAULT_AGENT_ID` from `config/sessions.js`; use 4.15-compatible fallback handling
- attempted isolated runtime launch hit a separate packaging/runtime artifact issue (`dist/entry.js` referenced a missing hashed chunk). This blocked end-to-end live gateway execution, but did not invalidate compile/test/build verification of the backport itself.
