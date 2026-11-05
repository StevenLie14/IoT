#pragma once

// Wi-Fi name and password are set in secrets.h, so copy secrets.example.h to secrets.h and fill the wifi config
#if __has_include("secrets.h")
#include "secrets.h"
#else
#error "secrets.h not found: copy secrets.example.h to secrets.h and fill it in"
#endif


// MQTT Config and topic
#define MQTT_HOST "broker.hivemq.com"
#define MQTT_PORT 1883
#define TOPIC_BASE "iot-project/steven-2802941592"

// PIN Configuration based on IoT
#define PIN_SDA 21
#define PIN_SCL 22
#define PIN_TEMP 4
#define PIN_TDS_POWER 13
#define PIN_RELAY_DRAIN 26
#define PIN_RELAY_FILL 25
#define PIN_BUZZER 33
#define PIN_FLOAT_TOP 18
#define PIN_FLOAT_BOT 19

#define OLED_ADDR 0x3C
#define ADS_ADDR 0x48
#define ADS_CH_TDS 0
#define ADS_CH_TURB 1

#define RELAY_ACTIVE_LOW true

// 10k / 20k divider (resistornya)
#define DIVIDER_RATIO 1.5f
#define TURB_V_CLEAR 1.75f
#define TURB_V_SPAN 0.55f
#define TDS_K 1.00f
#define TDS_GOOD 300.0f
#define TDS_BAD 700.0f
#define FLOAT_TOP_TRIGGERED_LEVEL HIGH
#define FLOAT_BOT_TRIGGERED_LEVEL LOW
#define FLOAT_DEBOUNCE_MS 500

#define SCORE_THRESHOLD 60

// Config berapa x consecutive read dan cooldowny brp lama
#define LOW_READINGS_TO_ACT 5
#define COOLDOWN_MS 1800000UL

// Rule AI (R4): model harus bilang dirty 5x berturut-turut dan yakin minimal 60% (6 dari 10 tree setuju)
// SCORE_THRESHOLD dan LOW_READINGS_TO_ACT (R1) cuma dipake kalau ga ada model
#define ML_DIRTY_READINGS 5
#define ML_MIN_CONFIDENCE 0.6f

// Delay 3 detik dari drain, bis tu fill
#define SETTLE_MS 3000U

// cycle sensor tiap 3 detik
#define CYCLE_MS 3000UL

// pump max 2 menit kalau lebih dari itu fault (takot bocor)
#define DRAIN_TIMEOUT_MS 120000UL
#define FILL_TIMEOUT_MS 120000UL
