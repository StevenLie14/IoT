// ===== IoT Project configuration =====
// Edit this file only. Values marked (CAL) come from your own calibration.
#pragma once

// ---------- Wi-Fi and MQTT ----------
// Wi-Fi name/password and MQTT login live in secrets.h (copy secrets.example.h)
#if __has_include("secrets.h")
#include "secrets.h"
#else
#error "secrets.h not found: copy secrets.example.h to secrets.h and fill it in"
#endif
#define MQTT_HOST     "broker.hivemq.com"   // e.g. "xxxx.s1.eu.hivemq.cloud" for a private broker
#define MQTT_PORT     1883                  // 8883 when MQTT_USE_TLS is true
#define MQTT_USE_TLS  false                 // true: encrypted connection, checked against mqtt_ca.h
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

// ---------- Parts that are fitted ----------
#define USE_FLOATS  true    // top float = tank full, bottom float = tank low
#define RELAY_ACTIVE_LOW true

// ---------- Calibration (CAL) ----------
#define DIVIDER_RATIO      1.5f     // 10k / 20k divider on the turbidity output
#define TURB_V_CLEAR       2.93f    // (CAL) turbidity sensor voltage in clean water
#define TURB_V_SPAN        1.5f     // volts darker than clear = index 100
#define TDS_K              1.00f    // (CAL) TDS pen ppm / firmware ppm
#define TDS_GOOD           300.0f   // (CAL) refill-water ppm + 100
#define TDS_BAD            700.0f   // (CAL) refill-water ppm + 400
#define FLOAT_TOP_TRIGGERED_LEVEL LOW
#define FLOAT_BOT_TRIGGERED_LEVEL HIGH

// ---------- Automation ----------
#define SCORE_THRESHOLD        60
#define LOW_READINGS_TO_ACT     5
#define COOLDOWN_MS       1800000UL   // 30 min (60 s in demo mode)
#define SETTLE_MS            3000UL   // pause between drain and fill
#define CYCLE_MS             3000UL   // sensor cycle and publish interval
#define TEMP_HOLD_MS        60000UL   // keep the last good temperature this long when reads fail
