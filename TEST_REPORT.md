# Sanjeevani end-to-end test report

## Repair verification — 12 September 2026

**Latest result: both reported defects repaired and verified on a fresh server at port 3100.** The original findings below are retained as historical evidence.

- Full suite after repairs: **34 passed, 0 failed** (`npm test`). This includes new simulation SSE and repeated voice-analysis regression checks.
- Browser voice checks: all three samples (Mayday, earthquake, routine SITREP) returned HTTP 200, `success: true`, engine `librosa`, and 13 MFCC coefficients.
- Natural simulation completion: page changed to `Simulation complete`, Launch enabled, Stop disabled. Manual stop also restored the button states after its response.
- Simulation log now receives named events with payload details instead of an object in the event-type field.
- All six desktop screens, the demo dialog, and mobile simulation overflow checks passed; no uncaught JavaScript errors were observed in the instrumented desktop page.
- This is a targeted browser retest plus the full automated suite, not a repeat of all 34 original exploratory checks. Original physical-device and real-microphone limitations still apply.

Changes: isolated project `.venv`, pinned audio requirements, server interpreter selection and subprocess error handling, corrected simulation event adapter, live/polling simulation status refresh. Audio runtime: Python 3.12.14, NumPy 2.2.6, Librosa 0.11.0, SoundFile 0.13.1, Numba 0.61.2 and llvmlite 0.44.0.

During repair, the initially resolved Numba 0.67.0 runtime passed a first audio request but crashed on subsequent pitch interpolation with a Windows access violation. Pinning Numba/llvmlite and testing repeated requests resolved the reproduced failure; the added regression requires the real Librosa engine.

The process on port 3000 was not restarted because its existing state is in memory. The fixed server is available on port 3100. Starting the app again on port 3000 will load these backend repairs, but restarting clears its existing in-memory demo state.

## Original test run (before repairs)

Date: 12 September 2026 (IST)  
Revision tested: `e32c5f0e35b92ca2040e17c54bb977e98f4a2e2d`  
Overall result: **Not a clean pass. Core response workflows pass; two defects remain.**

## Results

| Test group | Passed | Failed | Total |
|---|---:|---:|---:|
| Repository automated tests (`npm test`) | 31 | 1 | 32 |
| Additional browser and HTTP workflow checks | 32 | 2 | 34 |

The voice failure appears in both groups; there are **two distinct observed defects**, not three. These counts describe the checks executed, not exhaustive coverage of every possible input or device.

## Environment and isolation

- Windows, Node.js/Express, installed Microsoft Edge driven headlessly through Playwright.
- Separate fresh application process at `http://localhost:3100`, using the current source and seeded demo data.
- Desktop viewport: 1440 × 1000. Mobile emulation: 390 × 844 with touch enabled.
- The existing app on port 3000 was not restarted, reset, or used for test mutations.
- No application code or dependencies were changed during this test run. This report is the only repository addition.
- No uncaught browser JavaScript errors were observed in the instrumented desktop page. The expected voice HTTP 500 is still a functional failure.

## Defects

### D1 — Voice sample processing fails (high priority)

**Reproduction:** POST `/api/voice-report` with `{"sample_name":"critical_mayday.wav"}` on a fresh server. The repository voice ingestion test makes the same request.

**Expected:** HTTP 200 with acoustic analysis, parsed incident details and report result.

**Actual:** HTTP 500. Captured response identifies:

```text
Python distress script failed (code 1)
ai/processing/audio_distress.py, line 11
import numpy as np
ModuleNotFoundError: No module named 'numpy'
```

**Cause established:** `server.js` launches the `python` executable from PATH, and that interpreter lacks NumPy. NumPy is imported before the optional Librosa fallback logic. The voice sample catalog itself passes.

**Impact:** The tested sample cannot complete acoustic analysis or create its incident through this path. Other voice inputs using the same Python analyzer are at risk, but were not individually verified.

**Recommended next step:** Configure a reproducible Python environment for the server and install/verify the audio dependencies there. Retest the sample and a real uploaded recording. This run did not install dependencies or claim microphone accuracy.

### D2 — Simulation UI remains live after completion (medium priority)

**Reproduction:** Open Simulation, choose Flood Escalation, select 10×, launch, and wait 6.5 seconds.

**Expected:** Six events complete, status changes to complete, Launch becomes enabled and Stop becomes disabled.

**Actual:** `/api/simulate/status` reports `running: false` and `events_completed: 6`, but the page still displays:

```text
LIVE — Flood Escalation · 1/6 events · Speed 10×
```

Launch remains disabled. All six simulation audit records are present and contain action, actor and description fields.

**Code observation:** Live events append simulation log entries, but the handler does not refresh the simulation status controls on completion.

**Recommended next step:** Refresh status on simulation progress/completion events and verify button states after both natural completion and manual stopping.

## Additional workflow results

| # | Check | Result |
|---:|---|---|
| 1 | Fresh dashboard displays four seeded zones | Pass |
| 2–7 | Navigate to report, resources, SITREP, simulation, audit and overview | Pass (6 checks) |
| 8 | Header demo button opens dialog; Escape closes and restores focus | Pass |
| 9 | Dark-mode selection survives page reload | Pass |
| 10 | Required incident fields prevent advancing an empty form | Pass |
| 11 | Four-step form submits a new incident through the real API | Pass |
| 12 | Rescue request is scored critical | Pass |
| 13 | Submitted incident appears in audit history | Pass |
| 14 | Audit zone/action filters return the expected report-created entry | Pass |
| 15 | Resource quantity saved in the UI is reflected in server inventory | Pass |
| 16 | Text parser presents extracted incident details for review | Pass |
| 17 | Confirming parsed text creates the incident | Pass |
| 18 | Sample voice report produces acoustic analysis and incident | Fail — D1 |
| 19 | Flood simulation executes all six events | Pass |
| 20 | Simulation UI resets controls on completion | Fail — D2 |
| 21 | Simulation creates six complete audit records | Pass |
| 22 | SITREP produces a successful `.md` download | Pass |
| 23 | Submitting while offline saves the report in local storage | Pass |
| 24 | Reconnecting empties the queue and creates exactly one matching incident | Pass |
| 25–30 | All six mobile screens are visible without horizontal page overflow | Pass (6 checks) |
| 31 | Touch swipe over the incident map scrolls the page | Pass |
| 32 | Reduced-motion preference disables screen animation | Pass |
| 33 | Audit page receives a newly submitted external report through live updates | Pass |
| 34 | Expanded activity entry remains open across an 8.5-second refresh interval | Pass |

## Repository suite coverage

The 32 automated tests cover needs assessment; severity and rescue overrides; duplicate detection and merge/dismiss paths; priority ranking; allocation scarcity and shortfalls; inventory conservation; delivery idempotency; reallocation acceptance and no-op logging; demo reset; natural-language parsing; forecasting; SITREP generation; offline queue order and concurrent additions; simulation metadata; audit schema validation; simulation-to-agent audit history; and voice catalog/ingestion.

The HTTP integration scenario passes report creation → diversion → delivery → zone update → duplicate handling → scarcity → audit. These backend workflows are covered by repository tests; they were not all repeated as browser button sequences.

Command run:

```powershell
npm test
```

Observed summary: **32 tests, 31 passed, 1 failed**. Failing test: `voice agent: POST /api/voice-report ingests critical radio dispatch via Librosa`, at `tests/voice_agent.test.js:49`; assertion expected 200 and received 500.

## Limits and release assessment

- This is local functional testing, not a production readiness certification, load test, security audit or full accessibility audit.
- Mobile behavior was emulated in Edge; physical Android/iPhone devices and Safari/Firefox were not tested.
- Live microphone capture, real audio transcription/accuracy, geolocation permissions, audible voice briefing, and fresh offline page loading were not validated.
- SITREP export was checked for successful download and filename, not independently validated for every calculated field.
- Existing data storage is intentionally in memory. History survives page navigation/refresh but is not durable across server restart or demo reset. Restart recovery was not tested as a supported feature.
- Browser workflow checks ran interactively through Playwright; no reusable browser test runner was added. `npm test` remains the reproducible repository suite.

Core text/manual incident reporting, coordination logic, inventory, audit history and offline submission recovery passed the executed checks. Fix D1 and D2, rerun the affected workflows, and complete physical-device/audio validation before treating the whole application as fully tested.
