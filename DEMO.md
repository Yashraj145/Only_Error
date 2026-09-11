# PS20 rehearsal guide

## Start

In C:\Users\anujo\Documents\Codex\Only_Error run npm install, then npm start.
Open http://localhost:3000. The preview started during implementation uses http://localhost:3010.
Run npm test to execute the 23 unit, regression, offline-queue and HTTP integration tests.

## Six-minute demonstration

1. Reset Demo. Confirm exactly four zones: Ward 14 critical (60), Ward 3 high (44), Ward 7 moderate (18), Ward 11 low (10). Medical inventory is 12 kits, committed to Ward 3; no proposal is open.
2. Open Report. Enter Ward 9, location Ward 9, West District, population 1000. Deselect water; select medical. Enable Rescue needed. Review and Confirm Report, then open Dashboard.
3. Accept the proposal to divert 12 medical kits from Ward 3 to Ward 9. Inventory stays at 12. Open Ward 9 details and attempt a medical claim from Relief Corps: it is rejected with MedAir International named as the existing commitment holder. Confirm delivery (12). Inventory becomes zero; allocation becomes fulfilled.
4. Open Ward 7 details → Update Situation. Change population from 2000 to 4000 and save. Score rises from 18 to 55, tier becomes high. The resource-specific re-allocation check logs no change because no undelivered water allocation can be diverted. Use Audit Log, zone Z2, action REALLOCATION_CHECK to show this.
5. Demonstrate ordinary coordination in Ward 7: enter quantity 5000 and Claim with City Fire Department. The claim remains pending and water inventory stays 60000. A second agency claim is rejected. Confirm Delivery separately: water stock becomes 55000.
6. Submit another Ward 3 report at Ward 3, North District, population 1200, medical selected. Review the duplicate banner and Merge. For a separate optional demonstration, Keep as new report creates a scored zone instead of dropping the incoming report.
7. Open Ward 14 → Update Situation, add medical to shelter, save. Claim medical quantity 18, then Confirm Delivery. With zero medical inventory the result is partial, delivered 0, shortfall 18.
8. Open Audit Log and filter by Ward 9's zone ID (Z05 in a fresh run), or resource RES1. Expand entries to show proposal, acceptance and delivery as distinct actions. Clear filters to browse the complete activity history.

Reset before repeating the recording. Do not restock medical before the scarcity step.

## Optional offline demonstration

Keep the application loaded, disconnect the network, and submit a synthetic report. The report is saved in browser local storage and displayed as queued. Reconnect while the tab is open; the queue retries in order. Request IDs make retries idempotent within the current server session. Queued reports await authoritative server scoring; there is no provisional score displayed.

## Implementation decisions

- The client remains the responsive web fallback allowed by the architecture document.
- Ranking reserves higher-priority zones' shares before a lower-ranked zone can consume scarce stock, even when the higher-priority zone has not yet claimed it.
- Claims coordinate intent; delivery creates fulfilled/partial records. Accepted diversions remain confirmed until explicit delivery.
- Partial diversions and partial committed deliveries preserve the undelivered balance in a separate record.
- Restocking reactivates depleted inventory. Inventory cannot be reduced below its existing commitments.
- Every score refresh logs assessment, scoring and a re-allocation proposal or no-op check.
- Ward 7's starting population was adjusted to 2000 to obtain the specified moderate tier using actual scoring. The original 800-person fixture had no water deficit.
- All data except queued browser reports is in memory and resets on server restart. This is a demonstration prototype, without authentication or durable multi-user storage.
- Offline retry requires the page to remain open or be reopened when online; it is not an installed background-sync mobile application.
- GPS capture uses the browser's permission-based location feature, with manual landmark entry as fallback. It was not exercised using the user's real location.
