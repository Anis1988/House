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
| 📷 Wyze cameras | Wyze cloud; your login + free API key | Cameras · Settings |
| 📶 Wi-Fi | Finds devices itself; optional ASUS router sign-in for the full list | Devices · Settings |

Any side can be hidden in Settings → Devices in the app. Logins and keys stay on the phone.

- **Lights:** per bulb on/off and brightness (colour and warm–cool on bulbs that have them), rooms from the LIFX app, All lights switch and brightness, scenes (Bright, Movie, Night light, All off), daily Bedtime all-off, home-screen widget.
- **LG TV:** power (on via Wake-on-LAN), arrows/OK, back/home, volume and channel, mute, play/pause, apps and inputs.
- **Samsung screen:** arrows/OK, back/home/source, volume, mute, standby.
- **Nest:** thermostat dial (set temperature, Heat/Cool/Heat·Cool/Off, Eco, humidity), °C/°F. Doorbell is listed; live view and ring alerts are planned.
- **Wyze:** latest snapshot per camera, online state, on/off. Google-login accounts need a Wyze password first (Forgot password in the Wyze app).
- **Wi-Fi:** every device on the network, grouped and named where possible (LIFX, TV, screen, cameras, Apple, Cast, Tuya…); tap one to give it your own name.

## Planned next

- Nest doorbell live view and ring alerts (needs Google Pub/Sub)
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
