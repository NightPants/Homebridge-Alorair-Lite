# Changelog

All notable changes to `homebridge-alorair-lite` are documented in this file.

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
