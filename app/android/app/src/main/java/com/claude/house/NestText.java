package com.claude.house;

import org.json.JSONObject;

/** Temperatures as the thermostat shows them: °C to the half degree, or whole °F. */
final class NestText {
    private NestText() {}

    static boolean fahrenheit(JSONObject state) {
        return "FAHRENHEIT".equals(state.optString("scale"));
    }

    static String temp(JSONObject state, double celsius) {
        if (fahrenheit(state)) return Math.round(celsius * 9 / 5 + 32) + "°";
        double half = Math.round(celsius * 2) / 2.0;
        return (half == Math.floor(half) ? String.valueOf((int) half) : String.valueOf(half)) + "°";
    }

    /** "Heat to 21°", "Cool to 24°", "21° – 24°", "Eco", "Off". */
    static String target(JSONObject s) {
        if ("MANUAL_ECO".equals(s.optString("eco"))) return "Eco (away)";
        switch (s.optString("mode")) {
            case "HEAT": return s.has("heat") ? "Heat to " + temp(s, s.optDouble("heat")) : "Heat";
            case "COOL": return s.has("cool") ? "Cool to " + temp(s, s.optDouble("cool")) : "Cool";
            case "HEATCOOL": return s.has("heat") && s.has("cool") ? temp(s, s.optDouble("heat")) + " – " + temp(s, s.optDouble("cool")) : "Heat · Cool";
            case "OFF": return "Off";
            default: return "";
        }
    }

    static String setpoint(JSONObject s) {
        if ("MANUAL_ECO".equals(s.optString("eco"))) return "Eco";
        switch (s.optString("mode")) {
            case "HEAT": return s.has("heat") ? temp(s, s.optDouble("heat")) : "—";
            case "COOL": return s.has("cool") ? temp(s, s.optDouble("cool")) : "—";
            case "HEATCOOL": return s.has("heat") ? temp(s, s.optDouble("heat")) + "–" + temp(s, s.optDouble("cool")) : "—";
            default: return "Off";
        }
    }
}
