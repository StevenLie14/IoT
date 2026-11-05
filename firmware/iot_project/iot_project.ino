// ESP32 firmware for the aquarium water monitor. Settings are in config.h.
// Libraries: Adafruit SSD1306 (+GFX, BusIO), Adafruit ADS1X15, OneWire,
//            DallasTemperature, PubSubClient, ArduinoJson (7.x)

#include <WiFi.h>
#include <time.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Adafruit_ADS1X15.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include "config.h"

Adafruit_SSD1306 oled(128, 64, &Wire, -1);
Adafruit_ADS1115 ads;
OneWire oneWire(PIN_TEMP);
DallasTemperature temps(&oneWire);
WiFiClient netClient;
PubSubClient mqtt(netClient);

bool oledOk = false, adsOk = false;
int tempCount = 0;
DeviceAddress tempAddr;

float tTank = NAN;
float tdsV = 0, tdsPpm = 0;
float turbV = 0, turbIdx = 0;
int   score = 100;

enum State { IDLE, DRAINING, SETTLING, FILLING };
const char* STATE_NAMES[] = {"idle", "draining", "settling", "filling"};
State state = IDLE;
bool autoMode = false; // off after power-on until "auto on" is sent
int lowCount = 0;
uint32_t stateSince = 0, cooldownUntil = 0;

// Manual test run (commands "drain N" / "fill N")
bool manualDrain = false, manualFill = false;
bool manualToFloat = false;   // manual run that goes on until its float, limited by the pump timeout
uint32_t manualUntil = 0;
uint32_t manualStart = 0, manualRunMs = 0;   // for the pump screen

bool drainOn = false, fillOn = false, buzzerOn = false;

int beepsLeft = 0;
bool beepPhase = false;
uint32_t beepNext = 0;

uint32_t cycleStart = 0;
int phase = 0;

String topic(const char* sub) { return String(TOPIC_BASE) + "/" + sub; }
uint32_t epochNow() {
  time_t t = time(nullptr);
  bool clockSet = t > 1600000000;   // a date before 2020 means NTP has not answered yet
  return clockSet ? (uint32_t)t : 0;
}

void relay(int pin, bool on) {
  bool pinHigh = RELAY_ACTIVE_LOW ? !on : on;
  digitalWrite(pin, pinHigh ? HIGH : LOW);
}

void publishEvent(const char* type, const char* name, float value, const String& detail) {
  JsonDocument doc;
  doc["ts"] = epochNow();
  doc["type"] = type;
  doc["name"] = name;
  doc["value"] = value;
  doc["detail"] = detail;
  char buf[256];
  size_t n = serializeJson(doc, buf, sizeof(buf));
  if (mqtt.connected()) mqtt.publish(topic("event").c_str(), (const uint8_t*)buf, n, false);
  Serial.printf("[event] %s %s %.2f %s\n", type, name, value, detail.c_str());
}

void setDrain(bool on, const char* why) {
  if (on == drainOn) return;
  if (on && fillOn) {
    fillOn = false;
    relay(PIN_RELAY_FILL, false);
  }
  drainOn = on;
  relay(PIN_RELAY_DRAIN, on);
  publishEvent("actuator", "drain", on ? 1 : 0, why);
}

void setFill(bool on, const char* why) {
  if (on == fillOn) return;
  if (on && drainOn) {
    drainOn = false;
    relay(PIN_RELAY_DRAIN, false);
  }
  fillOn = on;
  relay(PIN_RELAY_FILL, on);
  publishEvent("actuator", "fill", on ? 1 : 0, why);
}

void beep(int n) {
  beepsLeft = n;
  beepPhase = false;
  beepNext = millis();
}

void enterState(State s, const String& detail) {
  state = s;
  stateSince = millis();
  publishEvent("state", STATE_NAMES[s], 0, detail);
}

// Float switches are debounced: a new state only counts after it has held for
// FLOAT_DEBOUNCE_MS, so a spike from a pump or relay switching on cannot stop it.
struct FloatInput {
  int pin;
  int triggeredLevel;   // pin level that means "float triggered"
  bool stable;          // debounced state, the one the logic uses
  bool candidate;       // latest raw state, waiting to become stable
  uint32_t since;       // when the candidate state was first seen
};
FloatInput fTop = { PIN_FLOAT_TOP, FLOAT_TOP_TRIGGERED_LEVEL, false, false, 0 };
FloatInput fBot = { PIN_FLOAT_BOT, FLOAT_BOT_TRIGGERED_LEVEL, false, false, 0 };

void updateFloat(FloatInput& f, bool first = false) {
  bool raw = digitalRead(f.pin) == f.triggeredLevel;
  uint32_t now = millis();

  if (first) {
    f.stable = raw;
    f.candidate = raw;
    f.since = now;
    return;
  }

  if (raw != f.candidate) {
    f.candidate = raw;
    f.since = now;
  } else if (raw != f.stable && now - f.since >= FLOAT_DEBOUNCE_MS) {
    f.stable = raw;
  }
}

bool floatTop() { return fTop.stable; } // tank full
bool floatBot() { return fBot.stable; } // tank low

// Median of n samples, so a single noisy sample does not count
float readVoltsMedian(int ch, int n = 11) {
  float samples[16];
  if (n > 16) n = 16;
  for (int i = 0; i < n; i++) {
    samples[i] = ads.computeVolts(ads.readADC_SingleEnded(ch));
  }

  for (int i = 1; i < n; i++) {
    float value = samples[i];
    int j = i - 1;
    while (j >= 0 && samples[j] > value) {
      samples[j + 1] = samples[j];
      j--;
    }
    samples[j + 1] = value;
  }
  return samples[n / 2];
}

// Sub-score: 100 at the good value, 0 at the bad value, linear in between
float lin(float v, float good, float bad) {
  float t = (v - good) / (bad - good);   // 0 at good, 1 at bad
  t = constrain(t, 0.0f, 1.0f);
  return 100.0f * (1.0f - t);
}

int computeScore() {
  float weightedSum = 0;
  float totalWeight = 0;

  // TDS (weight 0.5)
  float tdsScore = lin(tdsPpm, TDS_GOOD, TDS_BAD);
  weightedSum += 0.5f * tdsScore;
  totalWeight += 0.5f;

  // Turbidity (weight 0.375): index 0 = as clear as calibration, 100 = TURB_V_SPAN darker
  float turbScore = 100.0f - turbIdx;
  weightedSum += 0.375f * turbScore;
  totalWeight += 0.375f;

  // Temperature (weight 0.125): full marks at 24-30 C, left out if the DS18B20 gives no reading
  if (!isnan(tTank)) {
    float tempScore;
    if (tTank < 24)      tempScore = lin(tTank, 24, 20);
    else if (tTank > 30) tempScore = lin(tTank, 30, 34);
    else                 tempScore = 100.0f;
    weightedSum += 0.125f * tempScore;
    totalWeight += 0.125f;
  }

  return (int)roundf(weightedSum / totalWeight);
}

void startChange(const char* reason) {
  if (state != IDLE) {
    Serial.println("Change already running");
    return;
  }
  manualDrain = false;
  manualFill = false;
  enterState(DRAINING, reason);

  if (floatBot()) {
    enterState(SETTLING, "tank already low");
    return;
  }
  setDrain(true, reason);
}

void stopAll(const char* why) {
  setDrain(false, why);
  setFill(false, why);
  manualDrain = false;
  manualFill = false;
  if (state != IDLE) enterState(IDLE, why);
}

void finishChange(const char* why) {
  setFill(false, why);
  cooldownUntil = millis() + COOLDOWN_MS;   // R3
  enterState(IDLE, "change done");
  lowCount = 0;
}

// Pump ran too long without reaching its float (stuck float, dry pump, leak)
void pumpFault(const char* what) {
  setDrain(false, what);
  setFill(false, what);
  manualDrain = false;
  manualFill = false;
  beep(5);
  publishEvent("fault", what, 0, "pumps stopped, auto mode off");

  if (autoMode) {
    autoMode = false;
    publishEvent("mode", "auto", 0, "off after fault");
  }
  enterState(IDLE, what);
}

void runStateMachine() {
  uint32_t now = millis();

  bool timeUp = (int32_t)(now - manualUntil) >= 0;
  if (manualToFloat && timeUp && (manualDrain || manualFill)) {   // never reached the float
    pumpFault(manualDrain ? "drain timeout" : "fill timeout");
    manualToFloat = false;
  }
  if (manualDrain && (timeUp || floatBot())) {
    setDrain(false, timeUp ? "manual end: time up" : "manual end: bottom float");
    manualDrain = false;
  }
  if (manualFill && (timeUp || floatTop())) {
    setFill(false, timeUp ? "manual end: time up" : "manual end: top float");
    manualFill = false;
  }
  if (!manualDrain && !manualFill) manualToFloat = false;

  switch (state) {
    case DRAINING:   // R2: bottom float ends draining
      if (now - stateSince >= DRAIN_TIMEOUT_MS) {
        pumpFault("drain timeout");
        break;
      }
      if (floatBot()) {
        setDrain(false, "bottom float");
        enterState(SETTLING, "bottom float reached");
      }
      break;
    case SETTLING:
      if (now - stateSince >= SETTLE_MS) {
        enterState(FILLING, "refill until top float");
        if (floatTop()) finishChange("tank already full");
        else setFill(true, "refill");
      }
      break;
    case FILLING:    // R3: top float ends the refill
      if (now - stateSince >= FILL_TIMEOUT_MS) {
        pumpFault("fill timeout");
        break;
      }
      if (floatTop()) finishChange("top float");
      break;
    default: break;
  }
}

// R1, checked once per sensor cycle
bool turbFault = false;
void runRules() {
  // A turbidity reading near 0 V means the signal wire is off or the sensor has no power,
  // not dirty water, so R1 must not drain the tank on it
  if (turbV < TURB_V_FAULT) {
    if (!turbFault) publishEvent("fault", "turbidity", turbV, "sensor reads near 0 V, R1 paused");
    turbFault = true;
    lowCount = 0;
    return;
  }
  turbFault = false;

  // A running pump stirs the water, so readings taken while it runs do not count
  if (drainOn || fillOn) {
    lowCount = 0;
    return;
  }

  if (score < SCORE_THRESHOLD) lowCount++;
  else lowCount = 0;

  bool cooling = (int32_t)(millis() - cooldownUntil) < 0;
  if (autoMode && state == IDLE && !cooling && lowCount >= LOW_READINGS_TO_ACT) {
    publishEvent("rule", "R1", score, String("score below ") + SCORE_THRESHOLD + " for " + LOW_READINGS_TO_ACT + " readings");
    beep(3);
    startChange("auto R1");
  }
}

void handleCommand(const String& cmd, int arg) {
  if (cmd == "change")        startChange("manual change");
  else if (cmd == "stop")     stopAll("stop command");
  else if (cmd == "auto") {
    autoMode = arg != 0;
    publishEvent("mode", "auto", autoMode, "");
  }
  else if (cmd == "beep")     beep(1);
  else if (cmd == "drain" || cmd == "fill" || cmd == "drain_float" || cmd == "fill_float") {
    // drain / fill: timed test (default 3 s, max 30 s). drain_float / fill_float: run until the
    // float, limited by DRAIN_TIMEOUT_MS / FILL_TIMEOUT_MS. All of them stop at the floats.
    if (state != IDLE) {
      Serial.println("Only when idle");
      return;
    }
    if (manualDrain || manualFill) {
      Serial.println("A pump test is already running");
      return;
    }
    bool drain = cmd.startsWith("drain");
    bool toFloat = cmd.endsWith("_float");

    // Refuse a run that would go past a float: no fill when full, no drain when low
    if (!drain && floatTop()) {
      publishEvent("refused", "fill", 0, "top float already reached");
      return;
    }
    if (drain && floatBot()) {
      publishEvent("refused", "drain", 0, "bottom float already reached");
      return;
    }

    uint32_t runMs;
    const char* why;
    if (toFloat) {
      runMs = drain ? DRAIN_TIMEOUT_MS : FILL_TIMEOUT_MS;
      why = drain ? "manual: drain to bottom float" : "manual: fill to top float";
    } else {
      int seconds = arg > 0 ? min(arg, 30) : 3;
      runMs = seconds * 1000UL;
      why = "manual test";
    }
    manualStart = millis();
    manualRunMs = runMs;
    manualUntil = manualStart + runMs;
    manualToFloat = toFloat;

    if (drain) {
      manualDrain = true;
      setDrain(true, why);
    } else {
      manualFill = true;
      setFill(true, why);
    }
  }
  else Serial.printf("Unknown command: %s\n", cmd.c_str());
}

void onMqtt(char* t, byte* payload, unsigned int len) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, len)) return;
  String cmd = doc["cmd"] | "";
  // The argument arrives as {"on": true/false} for modes or {"sec": N} for pump tests
  int arg;
  if (doc["on"].is<bool>()) arg = doc["on"].as<bool>() ? 1 : 0;
  else                      arg = doc["sec"] | 0;
  handleCommand(cmd, arg);
}

void handleSerial() {
  static String line;
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\r') continue;
    if (c != '\n') {
      line += c;
      continue;
    }

    line.trim();
    if (line.length()) {
      int space = line.indexOf(' ');
      String cmd = space < 0 ? line : line.substring(0, space);
      String argText = space < 0 ? "" : line.substring(space + 1);

      int arg;
      if (argText == "on")       arg = 1;
      else if (argText == "off") arg = 0;
      else                       arg = argText.toInt();
      handleCommand(cmd, arg);
    }
    line = "";
  }
}

uint32_t lastWifiTry = 0, lastMqttTry = 0;

// Reconnects in the background so the loop never blocks
void keepConnected() {
  if (WiFi.status() != WL_CONNECTED) {
    if (millis() - lastWifiTry > 10000) {
      lastWifiTry = millis();
      WiFi.disconnect();
      WiFi.begin(WIFI_SSID, WIFI_PASS);
    }
    return;
  }

  if (!mqtt.connected() && millis() - lastMqttTry > 5000) {
    lastMqttTry = millis();
    String id = "iot-project-" + String((uint32_t)ESP.getEfuseMac(), HEX);
    if (mqtt.connect(id.c_str(), topic("status").c_str(), 1, true, "offline")) {
      mqtt.publish(topic("status").c_str(), "online", true);
      mqtt.subscribe(topic("cmd").c_str());
      Serial.println("MQTT connected");
    } else {
      Serial.printf("MQTT connect failed, state %d\n", mqtt.state());
    }
  }
  mqtt.loop();
}

// Readings without a temperature are not sent
void publishData() {
  if (isnan(tTank)) return;
  JsonDocument doc;
  doc["ts"] = epochNow();
  doc["src"] = "device";
  doc["t_tank"] = roundf(tTank * 100) / 100;
  doc["tds"] = roundf(tdsPpm * 10) / 10;
  doc["tds_v"] = roundf(tdsV * 1000) / 1000;
  doc["turb"] = roundf(turbIdx * 10) / 10;
  doc["turb_v"] = roundf(turbV * 1000) / 1000;
  doc["f_top"] = floatTop() ? 1 : 0;
  doc["f_bot"] = floatBot() ? 1 : 0;
  doc["score"] = score;
  doc["state"] = STATE_NAMES[state];
  doc["drain"] = drainOn ? 1 : 0;
  doc["fill"] = fillOn ? 1 : 0;
  doc["buzzer"] = buzzerOn ? 1 : 0;
  doc["auto"] = autoMode ? 1 : 0;
  char buf[768];
  size_t n = serializeJson(doc, buf, sizeof(buf));
  if (mqtt.connected()) mqtt.publish(topic("data").c_str(), (const uint8_t*)buf, n, false);
  Serial.println(buf);
}

void updateBuzzer() {
  uint32_t now = millis();
  if (beepsLeft > 0 && (int32_t)(now - beepNext) >= 0) {
    beepPhase = !beepPhase;
    beepNext = now + 150;
    if (!beepPhase) beepsLeft--;   // one beep = one on phase + one off phase
  }
  buzzerOn = beepsLeft > 0 && beepPhase;
  digitalWrite(PIN_BUZZER, buzzerOn);
}

void oledCentered(const char* text, int y, int size) {
  int16_t x1, y1;
  uint16_t w, h;
  oled.setTextSize(size);
  oled.getTextBounds(text, 0, 0, &x1, &y1, &w, &h);
  oled.setCursor((128 - w) / 2, y);
  oled.print(text);
}

void oledRight(const char* text, int y) {
  oled.setTextSize(1);
  oled.setCursor(128 - 6 * strlen(text), y);
  oled.print(text);
}

void drawStatusScreen() {
  oled.setTextSize(1);
  oled.setCursor(0, 0);
  oled.print(autoMode ? "AUTO" : "MANUAL");
  const char* link = mqtt.connected() ? "online" : (WiFi.status() == WL_CONNECTED ? "no mqtt" : "no wifi");
  oledRight(link, 0);
  oled.drawFastHLine(0, 10, 128, SSD1306_WHITE);

  char buf[16];
  snprintf(buf, sizeof(buf), "%d", score);
  oled.setTextSize(3);
  oled.setCursor(score >= 100 ? 0 : 9, 16);
  oled.print(buf);
  oled.setTextSize(1);
  oled.setCursor(9, 42);
  oled.print("score");

  oled.fillRoundRect(62, 14, 66, 13, 3, SSD1306_WHITE);
  oled.setTextColor(SSD1306_BLACK);
  oled.setTextSize(1);
  const char* water = score >= SCORE_THRESHOLD ? "GOOD" : "POOR";
  oled.setCursor(62 + (66 - 6 * (int)strlen(water)) / 2, 17);
  oled.print(water);
  oled.setTextColor(SSD1306_WHITE);

  if (isnan(tTank)) snprintf(buf, sizeof(buf), "--.-C");
  else              snprintf(buf, sizeof(buf), "%.1fC", tTank);
  oled.setTextSize(2);
  oled.setCursor(66, 32);
  oled.print(buf);

  oled.drawFastHLine(0, 52, 128, SSD1306_WHITE);
  oled.setTextSize(1);
  oled.setCursor(0, 56);
  oled.printf("TDS %.0f ppm", tdsPpm);
  snprintf(buf, sizeof(buf), "Turb %.0f%%", turbIdx);
  oledRight(buf, 56);
}

void drawPumpScreen() {
  uint32_t now = millis();
  bool waterChange = state != IDLE;
  bool draining = waterChange ? state == DRAINING : drainOn;
  bool settling = state == SETTLING;

  oled.fillRect(0, 0, 128, 11, SSD1306_WHITE);
  oled.setTextColor(SSD1306_BLACK);
  oledCentered(waterChange ? "WATER CHANGE" : "PUMP TEST", 2, 1);
  oled.setTextColor(SSD1306_WHITE);

  const char* action = settling ? "WAITING" : (draining ? "DRAINING" : "FILLING");
  oledCentered(action, 16, 2);

  const char* until;
  uint32_t elapsed, limit;
  if (waterChange) {
    elapsed = now - stateSince;
    if (settling)      { until = "before filling";      limit = SETTLE_MS; }
    else if (draining) { until = "until bottom float";  limit = DRAIN_TIMEOUT_MS; }
    else               { until = "until top float";     limit = FILL_TIMEOUT_MS; }
  } else {
    elapsed = now - manualStart;
    limit = manualRunMs;
    if (manualToFloat) until = draining ? "until bottom float" : "until top float";
    else               until = "timed test";
  }
  oledCentered(until, 34, 1);

  // Progress towards the time limit (the timeout for float runs)
  elapsed = min(elapsed, limit);
  oled.drawRect(0, 45, 128, 7, SSD1306_WHITE);
  int fill = limit ? (int)((uint64_t)elapsed * 124 / limit) : 0;
  oled.fillRect(2, 47, fill, 3, SSD1306_WHITE);

  char buf[24];
  oled.setTextSize(1);
  oled.setCursor(0, 56);
  oled.printf("%lu s", (unsigned long)(elapsed / 1000));
  bool floatRun = !settling && (waterChange || manualToFloat);
  snprintf(buf, sizeof(buf), floatRun ? "max %lu s" : "of %lu s", (unsigned long)(limit / 1000));
  oledRight(buf, 56);
}

bool pumpScreenActive() {
  return state != IDLE || drainOn || fillOn;
}

uint32_t oledDrawnAt = 0;
void drawOled() {
  if (!oledOk) return;
  oledDrawnAt = millis();
  oled.clearDisplay();
  oled.setTextColor(SSD1306_WHITE);
  if (pumpScreenActive()) drawPumpScreen();
  else                    drawStatusScreen();
  oled.display();
}

// A failed read leaves t_tank empty, and that reading is not published
void readTemperature() {
  float v = DEVICE_DISCONNECTED_C;
  // Search the bus again so a loose wire can recover without a reset
  if (tempCount < 1) {
    temps.begin();
    if (temps.getDeviceCount() >= 1 && temps.getAddress(tempAddr, 0)) {
      tempCount = 1;
      Serial.println("DS18B20 found");
    }
  }

  for (int i = 0; tempCount >= 1 && i < 3; i++) {
    v = temps.getTempC(tempAddr);
    // -127 = no answer, 85 = power-on value before any conversion
    bool valid = v > -55 && v < 125 && v != 85.0f;
    if (valid) {
      tTank = v;
      return;
    }
    delay(5);
  }

  tTank = NAN;
}

// The DS18B20 is measured and read while the TDS board is off, because TDS current
// in the water can disturb the temperature sensor in the same tank.
// 0 s   TDS power off, start temperature conversion
// 1 s   read temperature, then TDS power on
// 1.8 s read TDS (0.8 s settle), TDS power off
// 1.9 s read turbidity, compute score, run rules
// 3 s (CYCLE_MS) publish
void sensorCycle() {
  uint32_t t = millis() - cycleStart;
  if (phase == 0) {
    digitalWrite(PIN_TDS_POWER, LOW);
    temps.requestTemperatures();
    phase = 1;
  } else if (phase == 1 && t >= 1000) {
    readTemperature();
    digitalWrite(PIN_TDS_POWER, HIGH);
    phase = 2;
  } else if (phase == 2 && t >= 1800) {
    if (adsOk) {
      tdsV = readVoltsMedian(ADS_CH_TDS);
      // Compensate to 25 C (2 % per degree), then the sensor's standard voltage-to-ppm curve
      float waterTemp = isnan(tTank) ? 25.0f : tTank;
      float v25 = tdsV / (1.0f + 0.02f * (waterTemp - 25.0f));
      float curve = 133.42f * v25 * v25 * v25 - 255.86f * v25 * v25 + 857.39f * v25;
      tdsPpm = curve * 0.5f * TDS_K;
    }
    digitalWrite(PIN_TDS_POWER, LOW);
    phase = 3;
  } else if (phase == 3 && t >= 1900) {
    if (adsOk) {
      turbV = readVoltsMedian(ADS_CH_TURB) * DIVIDER_RATIO;
      // 0 = as clear as calibration, 100 = TURB_V_SPAN volts darker
      turbIdx = (TURB_V_CLEAR - turbV) / TURB_V_SPAN * 100.0f;
      turbIdx = constrain(turbIdx, 0.0f, 100.0f);
    }
    score = computeScore();
    runRules();
    phase = 4;
  } else if (phase == 4 && t >= CYCLE_MS) {
    publishData();
    drawOled();
    cycleStart = millis();
    phase = 0;
  }
}

void setup() {
  Serial.begin(115200);
  delay(300);
  pinMode(PIN_RELAY_DRAIN, OUTPUT); relay(PIN_RELAY_DRAIN, false);
  pinMode(PIN_RELAY_FILL, OUTPUT);  relay(PIN_RELAY_FILL, false);
  pinMode(PIN_BUZZER, OUTPUT); digitalWrite(PIN_BUZZER, LOW);
  pinMode(PIN_TDS_POWER, OUTPUT); digitalWrite(PIN_TDS_POWER, LOW);
  pinMode(PIN_FLOAT_TOP, INPUT_PULLUP); pinMode(PIN_FLOAT_BOT, INPUT_PULLUP);
  updateFloat(fTop, true); updateFloat(fBot, true);

  Wire.begin(PIN_SDA, PIN_SCL);
  bool foundOled = false, foundAds = false;
  for (uint8_t a = 1; a < 127; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) { if (a == OLED_ADDR) foundOled = true; if (a == ADS_ADDR) foundAds = true; }
  }
  oledOk = foundOled && oled.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR);
  adsOk  = foundAds && ads.begin(ADS_ADDR, &Wire);
  if (adsOk) ads.setGain(GAIN_ONE);
  if (oledOk) { oled.setTextColor(SSD1306_WHITE); oled.clearDisplay(); oled.setCursor(0, 0); oled.print("IoT Project"); oled.display(); }

  temps.begin();
  temps.setWaitForConversion(false);
  tempCount = temps.getDeviceCount();
  if (tempCount >= 1 && !temps.getAddress(tempAddr, 0)) tempCount = 0;
  Serial.printf("OLED %s, ADS %s, DS18B20: %d\n", oledOk ? "OK" : "FAIL", adsOk ? "OK" : "FAIL", tempCount);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  lastWifiTry = millis();
  configTime(7 * 3600, 0, "pool.ntp.org", "time.google.com");   // WIB
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setBufferSize(1024);
  mqtt.setCallback(onMqtt);

  Serial.println("Commands: change | stop | auto on/off | beep | drain 3 | fill 3 | drain_float | fill_float");
  cycleStart = millis();
}

void loop() {
  updateFloat(fTop); updateFloat(fBot);
  keepConnected();
  handleSerial();
  runStateMachine();
  sensorCycle();
  updateBuzzer();
  // The pump screen counts seconds, so redraw it more often than once per sensor cycle
  if (pumpScreenActive() && millis() - oledDrawnAt >= 500) drawOled();
}
