# Sanjeevani rehearsal guide

## Start and protect the demo

Run `npm install`, set up the Python environment described in README, then run `npm start` from the repository. Open http://localhost:3000. The final isolated rehearsal server uses http://localhost:3300 and `data/rehearsal.json`; earlier workspaces were not reset.

Operational data and audit history are saved in `data/workspace.json` by default. Restarting restores them. Reset Demo and starting a fresh simulation explicitly replace the saved workspace with seed data. Do not reset incidents you need to keep. Use a separate `SANJEEVANI_STATE_FILE` for practice.

Run `npm test`: the final automated suite has 37 passing tests.

## One-minute backup demo / live narration

1. Start with a fresh, isolated demo workspace. Show the four seeded zones and 12 medical kits committed to Ward 3.
2. Report **Ward 9**, location **Ward 9, West District**, population **1000**. Select medical needs and **Rescue needed**. Review the fields and explicitly Confirm Report.
3. Explain the critical priority: rescue is a hard override. Accept the proposed diversion of 12 medical kits from Ward 3 to Ward 9. This is a coordinator decision, not an automatic delivery.
4. Open Ward 9 and confirm delivery of 12 kits. Show medical stock falling to zero.
5. Open Activity log, filter by the new zone ID (Z05 on a fresh seed), and expand entries. Show reporting, needs assessment, scoring, proposal, acceptance and delivery as distinct events.
6. Finish on the situation report: one emergency, one explainable priority decision, one coordinated delivery, and a traceable history.

The supplied `Sanjeevani-backup-demo.webm` is a silent, approximately 60-second recording of this actual browser workflow. Keep a local copy available before presenting; narrate the steps above while it plays.

## Optional voice and persistence proof

- Analyze a voice sample. Show the transcript and extracted form fields. Analysis creates only a draft, not an incident.
- Edit the transcript or fields, then use the normal review and Confirm Report steps. If audio has no transcript, supply details manually; no sample incident is invented.
- Restart the same server using the same snapshot path, then show that the incident, inventory and audit history remain.

## Limits to state honestly

- This is a single-process local-snapshot prototype, not a production database or authenticated emergency service. Keep snapshots backed up and avoid multiple processes sharing one snapshot file.
- Voice readiness checks the local audio-analysis runtime; it does not prove microphone permission or provide automatic transcription. Physical-phone and real-microphone testing remain separate checks.
- Offline reports queue in the browser and retry when the page is open and online. This is not background mobile sync. Request-ID deduplication survives server restarts through the snapshot.
- Claims reserve intent; only explicit delivery consumes stock. Simulation start resets its workspace after confirmation.
