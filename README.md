# House

One Android app for the smart-home devices. Each device has its own side: pick it from the switch at the top and you get its own colours, bottom tabs, Settings and Guide (the ? button), like separate apps.

**Install:** open the [latest release](https://github.com/Anis1988/House/releases/latest) on the phone and tap the `.apk`.
Every push to `main` builds and publishes the next version, and the app shows an "Update available" banner.

## Devices

| Side | How it talks | Tabs |
|---|---|---|
| 💡 Lights (8 LIFX) | Home Wi-Fi, no account | Lights · Scenes · Timers · Settings |
| 📺 LG TV (OLED65C3) | Home Wi-Fi; accept once on the TV | Remote · Apps · Settings |
| 🖥️ Samsung screen (Odyssey G7) | Home Wi-Fi; Allow once on the screen | Remote · Settings |
| 🌡️ Nest thermostat + doorbell | Google Device Access (your own project, $5 once) | Thermostat · Doorbell · Settings |
| 📷 Wyze cameras | Wyze cloud; your login + free API key | Cameras · Events · Settings |
| 📶 Wi-Fi | Finds devices itself; optional ASUS router sign-in for the full list | Devices · Tools · Settings |

Any side can be hidden in Settings → Devices in the app. Logins and keys stay on the phone.

- **Scenes and timers (Lights side):** house scenes: one tap sets the lights (each On with a brightness, Off, or left as is), the LG TV (on/off, an app, volume), the Samsung screen, Nest (mode and temperature, or Eco) and the Wyze cameras. Pick an icon and colour per scene (also on the Scenes widget). A scene can turn its lights off by itself after 5 min–2 h (e.g. "Movie-eat": living room on for 20 min); the card counts down with ✕ to keep them on. Bright, Movie, Night light and All off come built in; edit or delete any scene (Lights → Settings brings the built-ins back). Timers run any scene at a time or before/after sunset or sunrise (set your city once), on chosen days, with an optional slow fade; daily Bedtime all-off; Vacation mode (random lights from sunset or a set time until a set time). Timers run with the app closed.
- **Lights:** per bulb on/off and brightness (colour and warm–cool on bulbs that have them), rooms from the LIFX app, All lights switch and brightness. Home-screen widgets: All lights, Lights on/off (1×1), One light (1×1, pick a bulb), Scenes (4 or 8 buttons by size), Rooms, Brightness, Vacation and Bedtime.
- **LG TV:** power (on via Wake-on-LAN), arrows/OK, back/home, volume and channel, mute, play/pause, apps and inputs.
- **Samsung screen:** arrows/OK, back/home/source, volume, mute, standby.
- **Nest:** thermostat dial (set temperature, Heat/Cool/Heat·Cool/Off, Eco, humidity), °C/°F. Doorbell live view (WebRTC, video and sound); ring, person and motion alerts via your Pub/Sub subscription (checked every ~2 min); temperature and humidity history (day/week chart); humidity alert. Big I'm away / I'm home button (Eco).
- **Wyze:** latest snapshot per camera (tap for full screen and Refresh), Live view (beta, the Wyze Web Portal stream), online state, on/off; Events tab with video clips when Wyze kept one; with the last two days of motion/sound/person alerts and their snapshots. Google-login accounts need a Wyze password first (Forgot password in the Wyze app).
- **Wi-Fi:** every device on the network, grouped and named where possible (LIFX, TV, screen, cameras, Apple, Cast, Tuya…); tap one to give it your own name. New device alert (notification, checked every ~15 min), Who's home (mark phones as people; this phone updates right away, others every ~15 min; run a scene when someone arrives or everyone leaves; with a LIFX cloud token the lights also work when you're away), speed test with history, guest Wi-Fi QR code. History tab: devices coming and going, internet outage log (checked every ~5 min at home). Pause a device's internet through the ASUS router (router sign-in; beta).

## Planned next


- Tesla Model 3 (Fleet API)
- Samsung microwave (SmartThings)

Not possible: MyQ garage (Chamberlain blocks other apps), Echo (no API).

## Build

`app/` is a Capacitor 8 app: web UI in `app/www` (`js/core.js` is the shell, one file per device side), native code in `app/android/app/src/main/java/com/claude/house` (`Lifx` for bulbs, `NetPlugin` for TV sockets, LAN sweep, SSDP/mDNS, Wake-on-LAN). Cloud calls use Capacitor's native HTTP.

```
cd app
npm ci
npm run sync
cd android && ./gradlew assembleDebug
```
