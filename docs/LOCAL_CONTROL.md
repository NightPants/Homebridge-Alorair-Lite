# Zero-Cloud Local TCP Control Setup Guide

Even if ALORAIR's mobile apps and cloud servers are completely unreachable, your ALORAIR Smart WiFi LGR Dehumidifier can run **100% locally on your LAN** with `homebridge-alorair-lite`.

---

## How Local TCP Control Works

1. When powered on and connected to your 2.4 GHz Wi-Fi, the dehumidifier's embedded Wi-Fi controller queries DHCP DNS for **`online-app.toovem.com`**.
2. It opens a persistent, unencrypted outbound TCP connection to:
   - **Port `6100`** on **AlorAir-Lite / Storm Commercial LGR** units (`Storm Pro`, `Storm LGR Extreme`, `Storm LGR 850X / 1250X`, `SLGR`, `Ultra`, `Elite`)
   - **Port `6200`** on **Sentinel** and newer **`BK7231`** units (`HD55S`, `HDi65S`, `HDi90`, `HDi100`, `HDi120`, and `BK7231`-equipped LGR units)
   - *(When `controllerProfile` is set to `"auto"`, `homebridge-alorair-lite` automatically binds **both** port `6100` and companion port `6200` and supports multiple dehumidifiers simultaneously!)*
3. When `online-app.toovem.com` resolves to your **Homebridge server's LAN IP**, the dehumidifier connects straight to `homebridge-alorair-lite`:
   - Sends heartbeats (`fn=0x09, op=0x01`) every ~30 seconds, which the plugin acknowledges automatically (`0x00`).
   - Streams binary status frames (`fn=0x07` 34-byte Lite payload or `fn=0x0B` 45-byte Sentinel payload) with intake/outlet temperature, intake/outlet relative humidity, grains/lb, g/kg, draining state, power state, and humidity setpoint.
   - Accepts binary control frames (`fn=0x09`) for Power (`0x21`), Target Humidity / Continuous `"CO"` (`0x23`), and Temperature Display Unit (`0x24`).

> **Trade-off Note:** While DNS is pointed to Homebridge, the vendor mobile app/cloud will show the dehumidifier as offline because the unit maintains only a single outbound TCP connection.

---

## Step 1: Reserve a Static DHCP IP

1. Ensure **Homebridge** has a static LAN IP (e.g., `192.168.1.50`) and is running in **host networking** (or with TCP port **`6100`** exposed `-p 6100:6100` if running in Docker).
2. In your router's DHCP settings, reserve a static IP for your **AlorAir Dehumidifier** (e.g., `192.168.1.120`). You can optionally set `"allowedClientIp": "192.168.1.120"` in `config.json` so Homebridge rejects connections from any other LAN host.

---

## Step 2: Point `online-app.toovem.com` to Your Homebridge IP

Choose the DNS server or router you use on your network (replace `192.168.1.50` with your actual Homebridge LAN IP):

### Pi-hole (v5 / v6)

1. Open **Pi-hole Admin** -> **Local DNS** -> **DNS Records**.
2. Set:
   - **Domain**: `online-app.toovem.com`
   - **IP Address**: `192.168.1.50`
3. Click **Add**.

### AdGuard Home

1. Open **AdGuard Home** -> **Filters** -> **DNS rewrites** -> **Add DNS rewrite**.
2. Set:
   - **Domain name**: `online-app.toovem.com`
   - **IP address**: `192.168.1.50`
3. Click **Save**.

### Ubiquiti UniFi Network (UDM / UCG / CloudKey)

1. Open **UniFi Network** -> **Settings** -> **Routing** -> **DNS** -> **Create Entry**.
2. Set:
   - **Type**: `Host (A)`
   - **Domain Name**: `online-app.toovem.com`
   - **IPv4 Address**: `192.168.1.50`
3. Click **Add Entry**.

### pfSense (`DNS Resolver / Unbound`)

1. Navigate to **Services** -> **DNS Resolver** -> **General Settings** -> **Host Overrides** -> **Add**.
2. Set:
   - **Host**: `online-app`
   - **Domain**: `toovem.com`
   - **IP Address**: `192.168.1.50`
3. Save and **Apply Changes**.

### OPNsense (`Unbound DNS`)

1. Navigate to **Services** -> **Unbound DNS** -> **Overrides** -> **Host Overrides** -> **`+`**.
2. Set:
   - **Host**: `online-app`
   - **Domain**: `toovem.com`
   - **Type**: `A (IPv4 address)`
   - **IP**: `192.168.1.50`
3. Save and **Apply**.

### OpenWrt / `dnsmasq`

```sh
uci add dhcp domain
uci set dhcp.@domain[-1].name='online-app.toovem.com'
uci set dhcp.@domain[-1].ip='192.168.1.50'
uci commit dhcp
/etc/init.d/dnsmasq restart
```

Or in raw `/etc/dnsmasq.conf`:
```ini
address=/online-app.toovem.com/192.168.1.50
```

### MikroTik RouterOS

```routeros
/ip dns static add name=online-app.toovem.com type=A address=192.168.1.50 ttl=1m
```

---

## Step 3: Optional Firewall / Fallback-DNS Hardening

Some IoT Wi-Fi modules fall back to hardcoded public DNS (`8.8.8.8` or `114.114.114.114`) if DHCP DNS briefly times out, or cache an old IP across warm reboots. If your dehumidifier has not connected after a power-cycle:

1. **Power-cycle the dehumidifier completely** (unplug AC power for 15 seconds, then plug back in) so it flushes any cached DNS entry.
2. **Optional DNAT Safety Rule** (UniFi / pfSense / OPNsense / OpenWrt / iptables):
   Redirect any outbound TCP traffic from the dehumidifier's IP destined for port `6100` (or `6200`) straight to `<HOMEBRIDGE_IP>:6100`. That guarantees local capture even if the router's DNS isn't used!

---

## Step 4: Quick Verification Before Starting Homebridge

Want to confirm your dehumidifier connects and grab its 12-character MAC address right from the terminal? Stop Homebridge briefly (if already bound to `6100`) and run:

```bash
npx homebridge-alorair-lite-setup listen-local 6100
```

Power-cycle the dehumidifier. Within 15–45 seconds you will see:

```text
Listening on 0.0.0.0:6100 (profile=auto, read-only)...
[CONNECT] Session #1 from 192.168.1.120 — Device MAC: AA:BB:CC:11:22:33 (AABBCC112233)
[STATUS]  MAC=AA:BB:CC:11:22:33 profile=lite power=true inRH=58% inC=20°C target=50 draining=false
```

Press `Ctrl+C`, add `"transport": "local"` (and `"allowLocalPowerOn": true` when ready to allow remote start) to your Homebridge `config.json`, and restart Homebridge!

