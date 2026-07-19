# Implementation Plan

## Scope and Ordering

1. Extend call-scoped contracts in `server/src/index.js` and `web/src/api.ts`:
   - include `cameraSenderDeviceId` in `call:start`;
   - add controller↔controller `webrtc:camera-signal` routing;
   - add acknowledged `webrtc:media-control` routing for screen and camera;
   - extend media status with camera and new reasons;
   - reject wrong role, wrong device, other-room and stale-call requests.
2. Add server integration coverage in `server/test/rooms.test.js` before UI wiring:
   - valid screen control reaches only paired pet;
   - valid camera control/signal reaches only designated sender controller;
   - sender local status reaches only viewer;
   - stale call, self-target, wrong role and unrelated room are rejected or ignored.
3. Implement controller-exclusive screen state in `pet/src/renderer/main.ts`:
   - track `screenRequestedByController`;
   - combine user request with confirmed P2P/relay route;
   - handle remote media-control and emit actual status;
   - preserve screen stream for quick resume, but stop it in teardown.
4. Implement camera ownership in `web/src/App.tsx`:
   - derive viewer/sender role from call metadata;
   - create the camera-only peer connection with candidate queue and teardown;
   - add sender camera capture, local preview, device enumeration/switching and `devicechange` fallback;
   - implement local and remote camera toggles through one state transition;
   - use `replaceTrack` for open/close and release hardware on close;
   - isolate camera failures from the existing screen/audio call.
5. Build the unified `MediaStage` in `web/src/App.tsx` and `web/src/control-panel.css`:
   - separate screen and camera video refs/streams;
   - default screen + camera inset layout;
   - hide camera, swap primary/inset, automatic camera promotion and layout restore;
   - add screen controller toggle, camera toggle, float, return and explicit hangup controls;
   - keep media aspect ratio and accessible button labels/status text.
6. Add native floating window support in `pet/src/main/index.js` and `pet/src/main/control-preload.js`:
   - allow only the named same-origin media child through `setWindowOpenHandler`;
   - apply persisted/clamped bounds, always-on-top and resize limits;
   - persist actual move/resize bounds and recover on display changes;
   - notify renderer on native close without touching call state;
   - add narrow bridge types/listener cleanup and browser-safe fallback behavior.
7. Add Electron camera permission and packaging support:
   - scope both media permission check/request handlers to trusted local app pages;
   - add macOS camera and microphone usage descriptions to `pet/package.json`;
   - add or extend pet main-process/source tests for float bounds, allowlist and cleanup.
8. Run builds to regenerate tracked `web/src/*.js`; never edit generated JavaScript by hand.
9. Perform full lifecycle review: call end, disconnect, replaced socket, renderer gone, float close, app quit, camera device loss, screen track end, ICE failure/recovery and relay transition.

## Expected Files

- `server/src/index.js`
- `server/test/rooms.test.js`
- `web/src/api.ts` and generated `web/src/api.js`
- `web/src/App.tsx` and generated `web/src/App.js`
- `web/src/control-panel.css`
- `pet/src/renderer/main.ts`
- `pet/src/main/index.js`
- `pet/src/main/control-preload.js`
- `pet/src/main/diagnostics.js` only if the existing bounds helper needs a media-window-specific extension
- `pet/test/*.test.cjs`
- `pet/package.json`

## Automated Validation

```bash
npm test --prefix server
npm test --prefix pet
npm run build:web
npm run build:pet
```

Before release packaging:

```bash
npm run pack --prefix pet
```

Verify the packaged macOS Info.plist contains `NSCameraUsageDescription` and `NSMicrophoneUsageDescription`; verify Windows and macOS builds can obtain camera permission from the control window.

## Manual Validation Matrix

- P2P happy path with two isolated Electron profiles:
  - start call with camera off;
  - open camera from viewer, then from sender local panel;
  - confirm local preview and remote camera show the same selected device;
  - close camera from both sides and confirm camera light turns off;
  - switch cameras and hot-unplug the selected device.
- Screen authority:
  - viewer stops and resumes target screen;
  - target pet/control UI has no local screen stop control;
  - camera and audio remain active while screen is stopped.
- Unified layout:
  - default inset, hide/show camera, swap primary, screen interruption auto-promotion, screen recovery layout restore.
- Floating window:
  - detach, move, resize, switch apps, minimize control panel, close-to-return;
  - reopen and restore bounds;
  - change display resolution and remove the saved display, confirming clamp to visible workArea.
- Network/failure:
  - camera permission denied, no camera, device lost and camera peer failure do not end screen/audio;
  - forced TURN sends no screen/camera video and preserves audio;
  - P2P recovery restores only media whose desired switch is on.
- Cleanup:
  - hangup, peer disconnect, control renderer reload, float render failure and app quit leave no camera light, active track, peer connection, timer or orphan window.

## Risk and Rollback Points

- Camera signaling and peer connection are separate from existing screen/audio. If camera recovery is unstable, disable the camera path while retaining the existing call.
- The media view always has an embedded render target. If child-window creation or portal rendering fails, close the child and continue embedded.
- Do not replace current call/ICE recovery wholesale. Any required change to the stable screen/audio negotiation must be isolated and reviewed separately.
- Keep `pet-state.json` backward-compatible: missing or invalid `mediaFloatBounds` falls back to defaults; never overwrite existing pet position/scale keys.
- Permission handlers must not accidentally block the existing pet microphone or desktop capture path; validate known pet and control origins before enabling the handler.

## Review Gate Before Start

- Confirm PRD, design and implementation plan match the intended authority model: screen is controller-exclusive, camera is two-party controlled, and camera media itself is one-way.
- Confirm the extra controller↔controller camera peer connection is acceptable as the isolation boundary.
- Only after user approval run `python3 ./.trellis/scripts/task.py start 07-19-camera-floating-video` and enter implementation.
