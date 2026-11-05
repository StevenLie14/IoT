#pragma once

// Wi-Fi name and password are set in secrets.h, so copy secrets..example.h to secrets.h and fill the wifi config
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
#define ADS_CH_VCC 3 // supply monitor (see VCC_DIVIDER_RATIO)

#define RELAY_ACTIVE_LOW true

#define DIVIDER_RATIO 1.5f // 10k / 20k divider on the turbidity output
#define VCC_DIVIDER_RATIO 1.5f // A3: 5V -> 10k -> A3 -> 20k -> GND (1.5). 3.3V straight to A3: 1.0f
#define TURB_V_CLEAR 1.75f // (CAL) turbidity sensor voltage in clean water
#define TURB_V_SPAN 0.55f
#define TDS_K 1.00f // (CAL) TDS pen ppm / firmware ppm
#define TDS_GOOD 300.0f // (CAL) refill-water ppm + 100
#define TDS_BAD 700.0f // (CAL) refill-water ppm + 400
#define FLOAT_TOP_TRIGGERED_LEVEL HIGH // switch opens when the float rises (tested)
#define FLOAT_BOT_TRIGGERED_LEVEL LOW // same float type: closes when the float drops
#define FLOAT_DEBOUNCE_MS 500 // a float must hold its new state this long to count

#define SCORE_THRESHOLD 60
#define LOW_READINGS_TO_ACT 5
#define COOLDOWN_MS 1800000UL // 30 min
#define SETTLE_MS 3000UL // pause between drain and fill
#define CYCLE_MS 3000UL // sensor cycle and publish interval

#define AUTO_ON_BOOT false // auto mode after power-on; false = wait for "auto on"
#define TURB_V_FAULT 0.20f // turbidity below this = wire off or sensor unpowered, R1 is skipped
#define DRAIN_TIMEOUT_MS 120000UL // drain longer than this without the bottom float = fault
#define FILL_TIMEOUT_MS 120000UL // fill longer than this without the top float = fault
#define PUMP_QUIET_MS 5000UL // readings during a pump run and this long after it do not count for R1
#define TEMP_HOLD_MS 60000UL // keep the last good temperature this long when reads fail
