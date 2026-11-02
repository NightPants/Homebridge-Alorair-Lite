# Wi-Fi Recovery & Provisioning Guide (Without the AlorAir Mobile App)

If your **ALORAIR Smart WiFi LGR Dehumidifier** has been offline because the official mobile app (*AlorAir-R* or *AlorAir-Lite*) crashes, refuses to log in, or fails to discover the dehumidifier, use this guide to get your unit back onto your local **2.4 GHz Wi-Fi** network.

---

## 1. Identify Which Wi-Fi Controller Generation Your Unit Has

ALORAIR shipped Smart WiFi LGR dehumidifiers (Storm Pro, Storm LGR Extreme, Storm LGR 850X / 1250X, SLGR, Ultra, Elite) across two main Wi-Fi controller hardware generations:

| Feature | Generation 2: `AlorAir-Lite` (`BK7231`) | Generation 1: `AlorAir-R` (`HF-LPB`) |
| :--- | :--- | :--- |
| **Typical Manufacture Years** | ~2023 – Present | ~2019 – 2022 |
| **Original Vendor App** | **AlorAir-Lite** | **AlorAir-R** *(discontinued)* |
| **Wireless Onboarding Method** | **Bluetooth Low Energy (BLE)** (`bk7231`, Service `0xFFF0`) | **Temporary Open Wi-Fi Hotspot (SoftAP)** (`10.10.100.254`, UDP `48899`) |
| **LCD Menu "Wi-Fi Hotspot" Option?** | Usually **No** (or must be **OFF** for BLE pairing) | **Yes** — toggling Hotspot ON broadcasts `HF-LPB` / `hiflying_softap` / `ALORAIR_xxxx` |
| **Outbound TCP Port Once on Wi-Fi** | `online-app.toovem.com:6100` | `online-app.toovem.com:6100` (or configurable via `AT+NETP`) |

> **Not sure which one you have?**
> Put the unit into Wi-Fi pairing mode (Step 2 below), then check your phone or laptop's Wi-Fi network list:
> - If a new open Wi-Fi network named **`HF-LPB`**, **`hiflying_softap`**, or **`ALORAIR_xxxx`** appears, follow **Section 4 (SoftAP / Hi-Flying)**.
> - If no new Wi-Fi network appears while the Wi-Fi icon on the LCD is flashing, your unit uses **Bluetooth Low Energy (`BK7231`)** — follow **Section 3 (Web Bluetooth)**.

---

## 2. Put the Dehumidifier into Wi-Fi Pairing / Reset Mode

1. Plug in the dehumidifier and press the **POWER** button so the LCD display is illuminated.
2. Depending on your LGR control panel layout:
   - **4-Button Storm LGR / Storm Pro Panel (`POWER`, `PURGE`, `MENU`, `SET`)**:
     - If pressing `MENU` shows a **`Wi-Fi Hotspot`** screen:
       - Set **Wi-Fi Hotspot = OFF** for `BK7231` BLE units, or **ON** for legacy `HF-LPB` SoftAP units.
     - Press and hold **`PURGE + MENU`** simultaneously for **3–5 seconds** until the unit beeps and the **Wi-Fi icon flashes rapidly** on the LCD.
   - **Arrow-Button LGR / SLGR Panel**:
     - Press and hold **`UP + DOWN`** (or **`MODE + UP`**) for **3–5 seconds** until the Wi-Fi symbol flashes rapidly.

### 2.4 GHz Wi-Fi Network Checklist

Before sending credentials, verify your Wi-Fi router meets the embedded radio requirements:
- **Band**: **2.4 GHz (`802.11b/g/n`) only**. 5 GHz-only networks will never connect. If you use a dual-band mesh (eero, Google Nest WiFi, Orbi, UniFi), temporarily pause 5 GHz or use a dedicated 2.4 GHz IoT SSID if the module struggles with band-steering.
- **Security**: **WPA2-PSK (AES)** (or WPA2/WPA3 transitional with Protected Management Frames / `802.11w` set to *Optional* or *Disabled*).
- **Channel**: Channels `1`, `6`, or `11` (`20 MHz` width). Do not use Channel `12` or `13` on North American firmware.

---

## 3. Onboarding Generation 2 (`BK7231` Bluetooth Low Energy)

`homebridge-alorair-lite` includes a zero-dependency **Web Bluetooth** wizard that speaks directly to the dehumidifier's `BK7231` GATT service (`0xFFF0`, notify `0xFFF1`, write `0xFFF2`).

### Step-by-Step

1. On a Windows PC, Mac, Linux laptop, or Android device with Bluetooth turned ON (within 6–10 feet of the dehumidifier), start the Setup Portal:
   ```bash
   npx homebridge-alorair-lite-setup portal
   ```
   *(Note: Web Bluetooth requires opening the portal on `http://127.0.0.1:8589` or `http://localhost:8589` in **Google Chrome** or **Microsoft Edge**. Safari and Firefox do not support Web Bluetooth.)*
2. Do **not** pair the dehumidifier in Windows/macOS system Bluetooth settings first — let Chrome/Edge connect directly.
3. In **Tab 1 (`BLE Wi-Fi Setup`)**:
   - Enter your **2.4 GHz Wi-Fi SSID** and **Password**.
   - Click **Scan & Connect via Web Bluetooth**.
   - Select **`bk7231`** (or `BK-alorair` / `alorair`) in the browser popup and click **Pair**.
   - Wait 1–2 seconds for the log to display `Ready! Characteristic 0xFFF2 acquired.`
   - Click **Send Wi-Fi Credentials (0xFFF2)**.
4. Watch the LCD Wi-Fi icon on the dehumidifier for 10–25 seconds:
   - **Solid Wi-Fi icon**: Success! Your dehumidifier is now connected to your 2.4 GHz Wi-Fi and has obtained a DHCP IP on your LAN.
   - **Still flashing after 30 seconds**: Switch the **BLE Credential Frame Format** dropdown to `Standard JSON — {"ssid":"...","password":"..."}` (or `AT Command`) and click **Send Wi-Fi Credentials** again.

---

## 4. Onboarding Generation 1 (`HF-LPB` SoftAP / `10.10.100.254`)

Earlier Smart WiFi LGR dehumidifiers use a Hi-Flying `HF-LPB` Wi-Fi module that broadcasts an open SoftAP hotspot (`10.10.100.254`) and accepts UDP AT configuration commands on port **`48899`**.

### Option A: Via the Setup Portal or CLI (Supports Direct Homebridge TCP Redirect!)

1. Enable **Wi-Fi Hotspot** in your dehumidifier's `MENU` (or hold `PURGE + MENU`).
2. Connect your computer's Wi-Fi to the dehumidifier's open hotspot (`HF-LPB`, `hiflying_softap`, or `ALORAIR_xxxx`). Verify your computer gets an IP like `10.10.100.x`.
3. Run the CLI command (or use **Tab 2** of `npx homebridge-alorair-lite-setup portal`):
   ```bash
   # Standard Wi-Fi join + direct TCP redirect to your Homebridge IP (no DNS override needed!)
   npx homebridge-alorair-lite-setup provision-softap \
     --ip 10.10.100.254 \
     --ssid "Your24GHzSSID" \
     --password "YourWifiPassword" \
     --redirect-host 192.168.1.50 \
     --redirect-port 6100
   ```
   *(Omit `--redirect-host` if you want the unit to keep using `online-app.toovem.com` or DNS override.)*
4. The module saves `STA` mode, writes your WPA2 credentials, optionally updates `AT+NETP=TCP,CLIENT,6100,<HomebridgeIP>`, and reboots (`AT+Z`) onto your home Wi-Fi!

### Option B: Built-In Module Web Page (`http://10.10.100.254`)

Many Hi-Flying `HF-LPB` modules also host an embedded web server while connected to their SoftAP:
1. Connect to the dehumidifier's hotspot (`HF-LPB` / `ALORAIR_xxxx`).
2. Open `http://10.10.100.254` in a browser (default credentials on standard Hi-Flying firmware: username **`admin`**, password **`admin`**).
3. Select **STA Setting**, scan/select your 2.4 GHz Wi-Fi SSID, enter your password, and under **Other / Network Setting** (if shown) you can view or point the TCP Client server address directly to your Homebridge IP on port `6100`.
4. Save and Restart.

---

## 5. Next Step: Connect to Homebridge

Once the Wi-Fi icon on your dehumidifier turns **solid**:
1. Check your router's DHCP client list for the new device (often named `bk7231`, `wlan0`, `HF-LPB`, or matching Beken/Hi-Flying MAC OUI) and **reserve a static DHCP IP** for it.
2. Follow **[docs/LOCAL_CONTROL.md](LOCAL_CONTROL.md)** to point `online-app.toovem.com` to your Homebridge IP for 100% local, zero-cloud Apple HomeKit control!

