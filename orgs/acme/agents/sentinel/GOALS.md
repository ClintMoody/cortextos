# Current Goals

## Bottleneck
No existing monitoring baseline — building from scratch. Primary gap is establishing what "normal" looks like so anomalies are detectable.

## Goals

1. Ensure all active agents have live heartbeats with no silent failures (alert if boss stale >30 min)
2. Monitor and flag agent crash rate — alert if any agent crashes >2x in 24 hours
3. Track task completion rate — flag stale tasks with no updates in 2+ days
4. Monitor approval queue — alert if any approval pending >4h (day mode) or >8h (overnight)
5. Watch for session freezes on boss — flag if no activity for 30+ min without completion
6. Monitor GitHub CI for failed runs on main branch
7. Build runbooks from observed failure patterns as they emerge

## Updated
2026-03-30T21:00:00Z
