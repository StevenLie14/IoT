// ===== IoT Project configuration =====
// Edit this file only. Values marked (CAL) come from your own calibration.
#pragma once

// ---------- Wi-Fi and MQTT ----------
#define WIFI_SSID     "YOUR_WIFI_NAME"
#define WIFI_PASS     "YOUR_WIFI_PASSWORD"
#define MQTT_HOST     "broker.hivemq.com"
#define MQTT_PORT     1883
// Use something unique so nobody else on the public broker uses the same topics
#define TOPIC_BASE    "iot-project/steven-2802941592"

// ---------- Pins (ESP32 30-pin on expansion board) ----------
#define PIN_SDA          21
#define PIN_SCL          22
#define PIN_TEMP          4    // DS18B20 data, 4.7k pull-up to 3.3V
#define PIN_TDS_POWER    13    // TDS board VCC (switched by firmware)
#define PIN_RELAY_DRAIN  26    // relay IN1 -> drain pump
#define PIN_RELAY_FILL   25    // relay IN2 -> fill pump
#define PIN_BUZZER       33
#define PIN_FLOAT_TOP    19
#define PIN_FLOAT_BOT    18

#define OLED_ADDR 0x3C
#define ADS_ADDR  0x48
#define ADS_CH_TDS   0
#define ADS_CH_TURB  1
#define ADS_CH_PH    2

// ---------- Parts that are fitted ----------
#define USE_PH      false   // pH probe not fitted
#define USE_FLOATS  true    // top float = tank full, bottom float = tank low
#define RELAY_ACTIVE_LOW true

// ---------- Calibration (CAL) ----------
#define DIVIDER_RATIO      1.5f     // 10k / 20k divider on turbidity and pH
#define TURB_V_CLEAR       3.87f    // (CAL) turbidity sensor voltage in clean water
#define TURB_V_SPAN        1.5f     // volts darker than clear = index 100
#define TDS_K              1.00f    // (CAL) TDS pen ppm / firmware ppm
#define TDS_GOOD           300.0f   // (CAL) refill-water ppm + 100
#define TDS_BAD            700.0f   // (CAL) refill-water ppm + 400
#define PH_SLOPE          -4.863f   // (CAL) only if USE_PH
#define PH_OFFSET         19.075f
#define DRAIN_ML_PER_SEC   15.8f    // (CAL) measured: 236.59 ml in 15 s
#define TANK_WATER_ML      7000.0f  // (CAL) water volume in the tank
#define FLOAT_TOP_TRIGGERED_LEVEL LOW
#define FLOAT_BOT_TRIGGERED_LEVEL HIGH

// ---------- Automation ----------
#define SCORE_THRESHOLD        60
#define LOW_READINGS_TO_ACT     3
#define CHANGE_PCT             20     // share of the tank drained per water change
#define COOLDOWN_MS       1800000UL   // 30 min (60 s in demo mode)
#define SETTLE_MS            3000UL   // pause between drain and fill
#define CYCLE_MS             5000UL   // sensor cycle and publish interval
