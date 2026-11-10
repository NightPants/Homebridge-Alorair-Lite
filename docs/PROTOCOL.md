# AlorAir-Lite & Smart WiFi LGR Protocol Reference

This document details the four wire protocols implemented in `homebridge-alorair-lite`:

1. **AlorAir-Lite Cloud REST API** (`http://online-app1.toovem.com:8081/rest/api/`)
2. **Native Local TCP Protocol** (`online-app.toovem.com:6100` for Storm/Lite, `:6200` for Sentinel)
3. **Beken `BK7231` BLE GATT Provisioning** (Service `0xFFF0`)
4. **Hi-Flying `HF-LPB` SoftAP UDP Provisioning** (`10.10.100.254:48899`)

---

## 1. AlorAir-Lite Cloud REST API

- **Base URL**: `http://online-app1.toovem.com:8081/rest/api/` (unencrypted HTTP only)
- **Required Headers**:
  - `env: app`
  - `platform: 1`
  - `lang: en`
  - `App-Identity: 1`
  - `Accept: application/json`
  - `token: <session_token>` *(all authenticated endpoints)*
- **Response Envelope**:
  ```json
  {
    "code": 200,
    "msg": "success",
    "data": {}
  }
  ```
  Vendor codes `>= 10000` indicate expired or invalid authentication sessions, triggering a single serialized re-login for read endpoints.

### Authentication & Ownership Verification

1. **`POST user/login`**:
   ```json
   {
     "username": "user@example.com",
     "password": "<Base64(RSA_PKCS1v15_Encrypt(utf8_password, ALORAIR_LITE_PUBLIC_KEY))>",
     "method": 1
   }
   ```
   Returns `data.token`.
2. **`GET user/getUserInfo`**:
   Returns `data.uid` (authenticated account owner ID).
3. **`GET iot/device/getHistoryDeviceList?pageNum=1&pageSize=10`**:
   Paginated device history. Entries where `userId !== uid` (guest/shared history) are ignored.
4. **`GET iot/device/getDeviceDetail/{deviceId}`**:
   Returns full telemetry, `deviceNum` (`000000000000<12-hex-MAC>` or `<12-hex-MAC>`), `updateTimeStr` (naive UTC `YYYY-MM-DD HH:mm:ss`), and `filter[]`. Ownership (`detail.userId === uid`) and `deviceNum` match are enforced before exposing or controlling any device.

### Cloud Status Fields

| Field | Values | Meaning |
| :--- | :--- | :--- |
| `powerStatus` | `"00"`, `"01"`, `"02"` | `"00"` = Off, `"01"` = Dehumidifying, `"02"` = Enabled & Target Reached (Idle) |
| `currentHumidity` | `20` or `25..80` (step `5`) | Target setpoint (`20` = Continuous `"CO"` mode) |
| `inHumidity` / `outHumidity` | `0..100` | Intake / Outlet relative humidity (%) |
| `inCelsius` / `outCelsius` | `-50..100` | Intake / Outlet air temperature (°C) |
| `inGrlb` / `outGrlb` | `number` | Specific humidity in grains per pound (`gr/lb`) |
| `inGkg` / `outGkg` | `number` | Specific humidity in grams per kilogram (`g/kg`) |
| `drainStatus` | `"00"`, `"01"` | Condensate pump active (`"01"`) |
| `defrostingStatus` | `"00"`, `"01"` | Defrost cycle active (`"01"`) |
| `locateFunction` | `"00"`, `"01"` | Locate indicator active (`"01"`) |
| `temperatureUnit` | `0`, `1` | `0` = Celsius (`°C`), `1` = Fahrenheit (`°F`) |
| `humidityUnit` | `0`, `1` | `0` = `gr/lb`, `1` = `g/kg` |
| `errCode` | 2-digit hex | Bitmask: bit0=`E1`, bit1=`L0`, bit2=`HI`, bit3=`E5`, bit4=`E4`, bit5=`0x20` *(ignored)*, bit6=`E3`, bit7=`E7` |

### Cloud Control Endpoint (`POST iot/device/control`)

| Action | `frameType` | `deviceNum` Included? | `data` |
| :--- | :---: | :---: | :--- |
| Power On / Off | `"21"` *(string)* | Yes | `"01"` (On) / `"00"` (Off) |
| Pump Purge | `"22"` *(string)* | Yes | `"01"` |
| Target Humidity / Continuous | `"23"` *(string)* | Yes | `"20"` (`CO`) or `"25"`..`"80"` (step `5`) |
| Locate On / Off | `"27"` *(string)* | Yes | `"01"` / `"00"` |
| Temperature Display Unit | `24` *(JSON number)* | **No** *(omitted)* | `"00"` (`°C`) / `"01"` (`°F`) |
| Moisture Display Unit | `25` *(JSON number)* | **No** *(omitted)* | `"00"` (`gr/lb`) / `"01"` (`g/kg`) |

Filter timer reset uses `POST iot/device/resetFilter/{deviceId}/{filterId}` with `{}`.

---

## 2. Native Local TCP Protocol (`6100` / `6200`)

Both AlorAir-Lite (`6100`) and Sentinel (`6200`) controllers use the same `29 + N` byte binary frame envelope:

```text
Offset  Size  Field
------  ----  -------------------------------------------------------------
0..1    2     Magic Header: 0x0D 0x0E
2..7    6     Reserved Header Zeros: 00 00 00 00 00 00
8..13   6     Appliance Wi-Fi MAC Address (raw 6 bytes)
14..17  4     Big-Endian UInt32 UNIX Timestamp (seconds)
18..19  2     Big-Endian UInt16 Data Length (N, 0..256)
20      1     Function Code (fn)
21      1     Opcode / Event Code (opcode)
22..25  4     Reserved Payload Prefix (00 00 00 00)
26..    N     Data Payload (N bytes)
26+N    1     Frame Class Byte: 0x02 (device keepalive), 0x04 (device status), 0x05 (cloud command / keepalive-ack)
27+N    1     8-Bit Additive Checksum: sum(raw[0 .. 25+N]) & 0xFF (class byte excluded from sum)
28+N    1     Frame Terminator: 0x16
```

### Keepalive Handshake

- **Appliance -> Homebridge**: `fn = 0x09`, `opcode = 0x01`, `N = 0` (29 bytes total)
- **Homebridge -> Appliance**: `fn = 0x09`, `opcode = 0x01`, `N = 1`, `data = [0x00]` (30 bytes total)

### Storm / AlorAir-Lite Status Frame (`fn = 0x07`, `N = 34`, Total `63` bytes)

| `data` Offset | Type | Field |
| :---: | :--- | :--- |
| `3` | `uint8` | Power enabled (`0` = Off, `1` = On) |
| `4` | `uint8` | Draining (`0` = Idle, `1` = Draining) |
| `8`, `9` | `int8`, `int8` | Intake °C and Intake °F (validated via `F === floor(C * 9 / 5 + 32)`) |
| `10` | `uint8` | Intake Relative Humidity (`0..100%`) |
| `11`, `12` | `int8`, `int8` | Outlet °C and Outlet °F |
| `13` | `uint8` | Outlet Relative Humidity (`0..100%`) |
| `14..15` | `uint16be` | Intake `gr/lb` |
| `16..17` | `uint16be` | Intake `g/kg` |
| `18..19` | `uint16be` | Outlet `gr/lb` |
| `20..21` | `uint16be` | Outlet `g/kg` |
| `23` | `uint8` | Target Humidity (`20` = Continuous `"CO"`, `25..80` step `5` = Auto) |
| `32` | `uint8` | LCD Temperature Display Unit (`0` = `°C`, `1` = `°F`) |

### Sentinel Status Frame (`fn = 0x0B`, `N = 45`, Total `74` bytes)

Supported automatically when `controllerProfile` is `"auto"` or `"sentinel"`:
- `data[3]`: Power (`0` = Off, `1` = Active, `2` = Idle)
- `data[4]`: Draining (`0`/`1`), `data[6]`: Compressor (`0`/`1`), `data[7]`: Fan (`0`/`1`)
- `data[8..10]`: Intake °C, °F, RH%
- `data[22]`: Signed Coil °C, `data[23]`: Target RH%, `data[28..29]`: Working hours (`uint16be`)
- `data[30]`: Locate (`0`/`1`), `data[44]`: Mode (`0x02` = Continuous, `0x01` = Auto)

### Outbound Local Control Frames (`fn = 0x09`, `N = 1`, Total `30` bytes)

| Action | `opcode` | `data[0]` | Verification |
| :--- | :---: | :--- | :--- |
| Power On / Off | `0x21` | `0x01` / `0x00` | Verified on Storm Pro / Lite & Sentinel |
| Target Humidity | `0x23` | Raw integer byte (`0x14` = `20`, `0x19`..`0x50` = `25..80`) | Verified on Storm Pro / Lite & Sentinel |
| Temperature Unit | `0x24` | `0x00` (`°C`) / `0x01` (`°F`) | Verified on Storm Pro / Lite |
| Pump Purge | `0x22` | `0x01` | Sentinel + optional experimental flag on Lite |
| Locate | `0x27` | `0x01` / `0x00` | Sentinel + optional experimental flag on Lite |

Outbound local commands enforce `>= 1.1s` spacing, monotonically increasing UNIX timestamps, and strictly match acknowledgement status frames arriving **after** the outbound TCP receive-sequence and byte-offset boundary.

---

## 3. Beken `BK7231` BLE Provisioning (`0xFFF0`)

- **Advertised Name Prefixes**: `bk7231`, `BK-alorair`, `BK-abestorm`, `BK-baseaire`, `alorair`
- **Primary GATT Service**: `0xFFF0` (`0000fff0-0000-1000-8000-00805f9b34fb`)
- **Notify Characteristic (`0xFFF1`)**: `0000fff1-0000-1000-8000-00805f9b34fb`
  - Emits 13-byte status frames: `00 00 00 00 00 00 <6-byte Wi-Fi MAC> <status>`
  - Status codes:
    - `0x01`: **Joined Wi-Fi (Success)** — Unit has associated with the 2.4 GHz AP and obtained a DHCP lease.
    - `0x02`: **Credentials Received / Connecting** — Immediate acknowledgement sent upon receiving a `0xFFF2` write while the radio attempts association.
    - `0x03`: **Idle / Not Connected / Join Failed** — Periodic heartbeat (~60s) before Wi-Fi association or if association timed out.
- **Write Characteristic (`0xFFF2`)**: `0000fff2-0000-1000-8000-00805f9b34fb`
  - **Payload Format (`ssid_p`)**: Single GATT write of raw ASCII bytes `<SSID>;P:<PASSWORD>` (no trailing newline or null terminator).

---

## 4. Hi-Flying `HF-LPB` SoftAP UDP Provisioning (`10.10.100.254:48899`)

1. Send ASCII `HF-A11ASSISTHREAD` to `10.10.100.254:48899` (or `255.255.255.255:48899`) -> Module replies `<ip>,<mac>,<modelId>`.
2. Send `+ok` -> Module enters UDP AT command mode and replies `+ok`.
3. Send `AT+WMODE=STA\r` -> Switch to Wi-Fi station mode.
4. Send `AT+WSSSID=<ssid>\r` -> Set 2.4 GHz SSID.
5. Send `AT+WSKEY=WPA2PSK,AES,<password>\r` -> Set WPA2 passphrase.
6. *(Optional)* Send `AT+NETP=TCP,CLIENT,6100,<homebridge_ip>\r` -> Point outbound TCP client directly at Homebridge.
7. Send `AT+Z\r` -> Reboot onto local Wi-Fi.

