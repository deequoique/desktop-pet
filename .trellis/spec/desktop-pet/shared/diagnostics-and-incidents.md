# Diagnostics Contract

## Scenario: Cross-layer incident and WebRTC diagnostics

### 1. Scope / Trigger

Use this contract whenever server, Electron main/preload, pet renderer, control renderer, Socket.IO, media capture, or WebRTC behavior is added or changed. Diagnostics are local-first: clients never upload automatically, and the server writes JSON lines for PM2.

### 2. Signatures

- Renderer bridge: `recordDiagnostic(input: RendererDiagnosticInput): void`
- Export bridge: `exportDiagnostics(): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>`
- Incident bridge: `getDiagnosticStatus()` and `dismissDiagnosticIncident(id)`
- RTC helper: `attachRtcDiagnostics(pc, { recorder, role, mediaKind, getCallId, configuration, onSample })`
- RTC sampler: `collectRtcNetworkSample(pc, configuration, baseline): Promise<RtcNetworkSample>`
- Server logger: `createServerDiagnostics().info|warn|error|fatal(domain, event, fields)`

Renderer events cross the preload boundary only through `diagnostics:record`; never expose filesystem or Electron primitives to renderers.

### 3. Contracts

Every event has `timestamp`, `level`, `domain`, `event`, `source`, `appVersion`, and `runtimeSessionId`. Add stable `errorCode` and `recoverability` (`automatic | retryable | user_action | fatal`) for failures. Put `callId`, `requestId`, `jobId`, or socket session ID in `correlation`.

Client retention is 2 MB current JSONL plus three rotations, at most 10 incidents with 200 breadcrumbs each, and five crash artifact metadata entries. Server PM2 retention is 20 MB × 7 compressed generations via `server/ecosystem.config.cjs` and `server/deploy/configure-pm2-logs.sh`.

Never record secrets, credentials, room/TTS/note content, binary media, full SDP, or raw ICE candidate strings. Exact structured ICE address, port, related address, protocol, and candidate type are allowed. Stable device/participant IDs must be represented as `sha256:<16 hex>`; `callId` remains intact for cross-layer correlation.

RTC periodic polling runs every 2 seconds for local UI/adaptation but records `webrtc.network-sample` only about every 10 seconds. A periodic record contains one compact selected pair plus inbound/outbound RTP summaries; lifecycle snapshots may include at most eight non-selected alternative pairs. Effective relay detection must include `relayProtocol`, configured TURN hosts, and same-port/same-ufrag `prflx` aliases.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Untrusted IPC sender | Reject with `untrusted_sender` or ignore one-way input |
| Renderer payload over 32 KB | Reject with `payload_too_large` |
| Event outside domain namespace | Reject with `invalid_event` / `domain_mismatch` |
| Permission or capture denial | `media_*_permission_denied` / `media_*_capture_failed`, `user_action` |
| ICE candidate add failure | `webrtc_add_ice_candidate_failed`, `retryable` |
| ICE candidate gathering error 600/701 | `warn`, `automatic`; no incident unless connection/ICE later fails |
| RTC polling or unsupported stats field | Keep partial sample, omit unavailable metric, do not interrupt call |
| Diagnostics handle closed | Clear interval before final snapshot; no later `getStats()` |
| Renderer/main crash | fatal incident plus crash metadata and abnormal-session marker |
| Diagnostic write failure | Warn locally; never interrupt the product operation |
| User cancels export | `{ ok: false, canceled: true }`; do not report as a product error |

### 5. Good/Base/Bad Cases

- Good: controller and pet record bounded selected-pair/RTP summaries under the same `callId`; server emits an aggregate signaling summary.
- Base: lifecycle success events use `info` without user interruption.
- Bad: storing every candidate pair every 2 seconds, creating an incident for each 600/701 interface error, or storing an SDP blob, raw `candidate:` line, secret, TTS text, or original stable device ID.

### 6. Tests Required

- Unit: redaction, device-ID hashing, payload limits, rotation, incident merge/acknowledge, session marker, crash metadata bounds, effective relay aliases, delta RTP rates/loss, bounded alternatives, and polling cleanup.
- Server: JSON envelope, credential/SDP/candidate redaction, ID hashing, request route normalization, and existing room integration tests.
- Build: `npm test --prefix server`, `npm test --prefix pet`, `npm run build:web`, and `npm run build:pet`.
- Fault matrix before release: permission denial, socket rejection/disconnect, host/srflx/relay candidate paths, addIceCandidate failure, renderer crash, abnormal restart, export/cancel/dismiss.

### 7. Wrong vs Correct

#### Wrong

```ts
console.warn('ICE failed', candidate.candidate, roomSecret);
```

#### Correct

```ts
recordDiagnostic({
  event: 'webrtc.network-sample',
  domain: 'webrtc',
  level: 'info',
  correlation: { callId },
  context: {
    selectedPair: compactSelectedPair,
    inboundVideo: compactInboundRtp,
    outboundVideo: compactOutboundRtp,
  },
});
```
