# House

One Android app for the smart-home devices.

**Install:** open the [latest release](https://github.com/Anis1988/House/releases/latest) on the phone and tap the `.apk`.
Every push to `main` builds and publishes the next version, and the app shows an "Update available" banner.

## Now: lights (LIFX)

- Finds the LIFX bulbs on the home Wi-Fi (LAN protocol, UDP 56700). No LIFX account needed.
- Rooms and names come from the LIFX app.
- Per bulb: on/off, brightness, plus warm–cool and color on bulbs that support them.
- All lights: one switch and one brightness slider. Each room has its own on/off.
- Scenes: Bright, Movie, Night light, All off.
- Bedtime: all lights off every day at a set time.
- Home-screen widget: All on / All off.
- Light, dark, or auto theme.

If no lights show up, use Settings → scan every address (some routers block broadcasts).

## Planned next

- Nest thermostat and doorbell (Google Device Access: $5 sign-up, OAuth)
- Samsung microwave status (SmartThings token)
- Tesla Model 3 (Fleet API)
- Wyze cameras (unofficial API)
- Router device list (only if you type the router password into the app yourself)

Not possible: MyQ garage (Chamberlain blocks other apps), Echo Show (no API).

## Build

`app/` is a Capacitor 8 app: web UI in `app/www`, LIFX networking in Java (`app/android/app/src/main/java/com/claude/house`).

```
cd app
npm ci
npm run sync
cd android && ./gradlew assembleDebug
```
