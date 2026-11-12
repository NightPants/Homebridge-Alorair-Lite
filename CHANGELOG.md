# Changelog

All notable changes to `homebridge-alorair-lite` are documented in this file.

## [1.0.12-beta.1] - 2026-11-12

### Fixed
- **Graceful TCP Shutdown (`socket.end()` FIN)**: Closes client sockets cleanly with TCP `FIN` on Homebridge shutdown so the embedded `BK7231` chip receives a standard disconnect rather than an abrupt `RST`, preventing socket deadlocks on the dehumidifier.
- **Active TCP Keep-Alive (`socket.setKeepAlive`)**: Enabled 10-second TCP keepalives on all local dehumidifier connections to detect and recover dropped sockets automatically.
- **Fast Startup Binding**: Starts the local TCP server immediately upon plugin initialization so the listening port is open when the dehumidifier attempts reconnection.

## [1.0.12-beta.0] - 2026-11-12

### Fixed
- **Restore Humidity Threshold Slider**: Guarded against `NaN` on initial coordinator startup so the Apple Home target humidity slider never disappears or becomes disabled.
- **Always Active Default (`dehumidifierIdleDisplayMode: "active"`)**: Default to keeping the HomeKit tile illuminated and showing the setpoint whenever the dehumidifier is powered on, preventing Apple Home from falsely labeling active/drying units as "Off".
- **Preserve Clean All-in-One Tile**: Intake temperature remains attached directly to the primary dehumidifier tile (with standalone accessories available as an opt-in via `exposeSeparateSensorAccessories`).

## [1.0.11] - 2026-11-12

### Added
- **Dedicated Ambient Humidity & Temperature Sensor accessories**: Exposes Intake Humidity (`<Device> Humidity`) and Intake Temperature (`<Device> Temperature`) as dedicated HomeKit sensor accessories by default. They appear as standalone tiles in Apple Home and populate Apple Home's room-level Climate summary bar (e.g., `72° · 55% Humidity`), so current ambient humidity and temperature are immediately visible alongside the target setpoint (e.g. `60%`).
- **Configurable HomeKit Idle Status (`dehumidifierIdleDisplayMode`)**: Added `dehumidifierIdleDisplayMode` with options `"idle"` (standard HomeKit HAP) and `"active"` (always show active). In Apple Home, dehumidifier tiles display "Off" when target humidity is reached because Apple Home condenses HAP `IDLE` to "Off" on dehumidifier tiles. Selecting `"active"` keeps the tile illuminated and displaying your setpoint whenever the dehumidifier is powered on, only showing "Off" when the unit is actually turned off.
- **Linked vs. Standalone Sensor layout (`linkInletSensorsToDehumidifier`)**: Added `linkInletSensorsToDehumidifier` (default `false`) for users who prefer bundling the sensors inside the primary dehumidifier accessory settings menu rather than exposing separate room tiles.

## [1.0.10] - 2026-11-11

### Security
- **Setup Portal CSRF & network exposure hardening**: All `/api/*` endpoints on the optional Setup Web Portal now strictly require `Content-Type: application/json` (HTTP `415` otherwise) and reject cross-site browser requests (`Sec-Fetch-Site: cross-site`). Binding the portal beyond `127.0.0.1` / `localhost` / `::1` now strictly requires `setupPortalToken` (and the standalone setup CLI auto-generates a one-time token when bound to a non-loopback address).

### Packaging & Documentation
- Enabled the **Verified by Homebridge** badge in `README.md`.
- Updated `.github/workflows/publish.yml` to publish real changelog release notes to GitHub Releases so Homebridge UI displays what changed in every update.

## [1.0.9] - 2026-11-10

### Added
- **Zero-Cloud Local TCP port `4802` + `BK7231` framing support**: Auto-binds port `4802` alongside `6100` and `6200` in `controllerProfile: "auto"` mode for newer Storm LGR Extreme WiFi units, and supports `<class><checksum8>0x16` frame trailers alongside multi-device concurrent sessions.
- **Unconfigured startup guard & npm file whitelist**: Prevents binding network ports before plugin configuration is saved and limits the published tarball to compiled `dist/`, schema, branding, and documentation files.

### Fixed
- **iOS HomeKit tile humidity scaling**: Expose `0..100` HAP bounds on `RelativeHumidityDehumidifierThreshold` so the iOS Home screen small tile displays the exact target humidity instead of rescaling `20..80`.
- **BLE Wi-Fi Provisioning (`0xFFF2`)**: Updated `BK7231` onboarding default to `<SSID>;P:<PASSWORD>` with accurate `0xFFF1` notification status decoding (`0x01` Joined, `0x02` Connecting, `0x03` Failed).
- **CI compatibility**: Fixed Node.js 20 compatibility in the cloud API unit test suite (`RSA_PKCS1_PADDING` verification).
