# Windows process-loopback helper

This Windows x64 helper captures 48 kHz stereo s16le system audio while excluding the Electron main process tree. It uses `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` with `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE` and has no network or file output.

The Electron main process owns the executable and launches it without a shell. Arguments are fixed to the Electron root PID, 48 kHz, two channels, and 20 ms. Stdout is a versioned binary stream:

| Field | Size | Value |
| --- | ---: | --- |
| magic | 4 | `DPAL` little endian |
| version/type | 2 + 2 | `1` / PCM `1` |
| sequence/PTS | 8 + 8 | monotonic frame number and milliseconds |
| payload length/flags | 4 + 4 | `3840` / reserved |
| PCM | 3840 | one 20 ms stereo s16le frame |

The capture and pipe writer use a bounded 50-frame queue. When the consumer falls behind, the oldest frame is dropped and only a counter is written to stderr. Closing stdin, exiting the Electron parent, a protocol error, or an explicit stop terminates capture. PCM is never written to disk or diagnostics.

Build and verify on Windows:

```powershell
npm run build:native:win
```

The release workflow compiles with `/W4 /WX`, verifies the PE x64 header, and packages the executable at `resources/native/desktop-pet-process-loopback.exe`. Windows 11 fails the system-audio source closed when the helper is absent or fails; screen and microphone media remain active. Windows 10 deliberately uses TRTC's native full-system loopback. Set `TRTC_SYSTEM_AUDIO_EXCLUSION=disabled` before launching a Windows 11 client to disable only the system-audio source as an emergency rollback.
