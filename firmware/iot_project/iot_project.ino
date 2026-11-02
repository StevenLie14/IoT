// IoT Project - main firmware (ESP32)
// Sensing -> score -> rule-based water change -> MQTT JSON every 5 s.
// Libraries: Adafruit SSD1306 (+GFX, BusIO), Adafruit ADS1X15, OneWire,
//            DallasTemperature, PubSubClient, ArduinoJson (7.x)
// All settings are in config.h.

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
#include "water_model.h"   // decision tree exported by ml/export_tree.py

// ---------------- Objects ----------------
Adafruit_SSD1306 oled(128, 64, &Wire, -1);
Adafruit_ADS1115 ads;
OneWire oneWire(PIN_TEMP);
DallasTemperature temps(&oneWire);
WiFiClient wifiClient;
PubSubClient mqtt(wifiClient);

bool oledOk = false, adsOk = false;
int tempCount = 0;

// ---------------- Latest readings ----------------
float tTank = NAN, tRes = NAN;
float tdsV = 0, tdsPpm = 0;
float turbV = 0, turbIdx = 0;
float phV = 0, phVal = NAN;
int   score = 100;
int   mlClass = -1;      // on-device water-condition prediction (-1 = no model)

// ---------------- State machine ----------------
enum State { IDLE, POSTPONED, DRAINING, SETTLING, FILLING, FAULT };
const char* STATE_NAMES[] = {"idle", "postponed", "draining", "settling", "filling", "fault"};
State state = IDLE;
bool autoMode = true, demoMode = false;
int lowCount = 0;
int changePct = 0;
float targetMl = 0, drainedMl = 0, filledMl = 0;
uint32_t stateSince = 0, postponeUntil = 0, cooldownUntil = 0;
String faultMsg = "";

// Manual test run (commands "drain N" / "fill N")
bool manualDrain = false, manualFill = false;
uint32_t manualUntil = 0;

// Actuator outputs
bool drainOn = false, fillOn = false, buzzerOn = false;
uint32_t pumpOnSince = 0;

// Buzzer pattern (non-blocking)
int beepsLeft = 0; bool beepPhase = false; uint32_t beepNext = 0; bool buzzerContinuous = false;

// Sensor cycle phases
uint32_t cycleStart = 0; int phase = 0;

// ---------------- Helpers ----------------
String topic(const char* sub) { return String(TOPIC_BASE) + "/" + sub; }
uint32_t postponeMs() { return demoMode ? 30000UL : POSTPONE_MS; }
uint32_t cooldownMs() { return demoMode ? 60000UL : COOLDOWN_MS; }
uint32_t epochNow() { time_t t = time(nullptr); return t > 1600000000 ? (uint32_t)t : 0; }

void relay(int pin, bool on) {
  digitalWrite(pin, (RELAY_ACTIVE_LOW ? !on : on) ? HIGH : LOW);
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
  if (on && fillOn) { fillOn = false; relay(PIN_RELAY_FILL, false); }
  drainOn = on; relay(PIN_RELAY_DRAIN, on);
  if (on) pumpOnSince = millis();
  publishEvent("actuator", "drain", on ? 1 : 0, why);
}

void setFill(bool on, const char* why) {
  if (on == fillOn) return;
  if (on && drainOn) { drainOn = false; relay(PIN_RELAY_DRAIN, false); }
  fillOn = on; relay(PIN_RELAY_FILL, on);
  if (on) pumpOnSince = millis();
  publishEvent("actuator", "fill", on ? 1 : 0, why);
}

void beep(int n) { beepsLeft = n; beepPhase = false; beepNext = millis(); }

void enterState(State s, const String& detail) {
  state = s; stateSince = millis();
  publishEvent("state", STATE_NAMES[s], changePct, detail);
}

void fault(const String& msg) {
  setDrain(false, "fault"); setFill(false, "fault");
  manualDrain = manualFill = false;
  faultMsg = msg;
  enterState(FAULT, msg);
  beep(5);
}

bool floatTop() { return USE_FLOATS && digitalRead(PIN_FLOAT_TOP) == FLOAT_TOP_TRIGGERED_LEVEL; }
bool floatBot() { return USE_FLOATS && digitalRead(PIN_FLOAT_BOT) == FLOAT_BOT_TRIGGERED_LEVEL; }

float readVoltsMedian(int ch, int n = 11) {
  float s[16];
  if (n > 16) n = 16;
  for (int i = 0; i < n; i++) s[i] = ads.computeVolts(ads.readADC_SingleEnded(ch));
  for (int i = 1; i < n; i++) {
    float x = s[i]; int j = i - 1;
    while (j >= 0 && s[j] > x) { s[j + 1] = s[j]; j--; }
    s[j + 1] = x;
  }
  return s[n / 2];
}

float lin(float v, float good, float bad) {   // 100 at good, 0 at bad, linear between
  float t = (v - good) / (bad - good);
  if (t < 0) t = 0; if (t > 1) t = 1;
  return 100.0f * (1.0f - t);
}

// ---------------- Score ----------------
int computeScore() {
  float wSum = 0, sum = 0;
  // TDS (0.4)
  sum += 0.4f * lin(tdsPpm, TDS_GOOD, TDS_BAD); wSum += 0.4f;
  // Turbidity (0.3): index 0 = as clear as calibration, 100 = TURB_V_SPAN darker
  sum += 0.3f * (100.0f - turbIdx); wSum += 0.3f;
  // pH (0.2), only if fitted
  if (USE_PH && !isnan(phVal)) {
    float s = (phVal >= 6.5f && phVal <= 7.5f) ? 100.0f
            : (phVal < 6.5f ? lin(phVal, 6.5f, 5.5f) : lin(phVal, 7.5f, 8.5f));
    sum += 0.2f * s; wSum += 0.2f;
  }
  // Temperature (0.1)
  if (!isnan(tTank)) {
    float s = (tTank >= 24 && tTank <= 30) ? 100.0f
            : (tTank < 24 ? lin(tTank, 24, 20) : lin(tTank, 30, 34));
    sum += 0.1f * s; wSum += 0.1f;
  }
  return (int)roundf(sum / wSum);
}

// ---------------- Water change ----------------
void startChange(int pct, const char* reason) {
  if (state == FAULT) { Serial.println("In fault: send reset first"); return; }
  if (state != IDLE && state != POSTPONED) { Serial.println("Change already running"); return; }
  if (pct < 5) pct = 5; if (pct > 50) pct = 50;
  changePct = pct;
  targetMl = TANK_WATER_ML * pct / 100.0f;
  drainedMl = filledMl = 0;
  // R2: temperature difference between tank and reservoir
  if (tempCount >= 2 && !isnan(tTank) && !isnan(tRes) && fabsf(tTank - tRes) > TEMP_DIFF_MAX_C) {
    postponeUntil = millis() + postponeMs();
    enterState(POSTPONED, String("temp diff ") + String(fabsf(tTank - tRes), 1) + " C");
    beep(2);
    return;
  }
  // R5 pre-check: water already below low float
  if (floatBot()) { fault("water already below low float"); return; }
  enterState(DRAINING, reason);
  setDrain(true, reason);
}

void stopAll(const char* why) {
  setDrain(false, why); setFill(false, why);
  manualDrain = manualFill = false;
  if (state != FAULT && state != IDLE) enterState(IDLE, why);
}

void runStateMachine() {
  uint32_t now = millis();

  // Safety that applies in every state
  if ((drainOn || fillOn) && now - pumpOnSince > PUMP_TIMEOUT_MS) fault("timeout: pump on > 3 min");          // R7
  if (fillOn && floatTop()) { setFill(false, "top float"); buzzerContinuous = true; publishEvent("alert", "overflow", 1, "top float"); if (state == FILLING) enterState(IDLE, "stopped by top float"); } // R4
  if (drainOn && floatBot()) { setDrain(false, "bottom float"); publishEvent("alert", "low_level", 1, "bottom float"); if (state == DRAINING) enterState(SETTLING, "stopped by bottom float"); } // R5
  if (!floatTop()) buzzerContinuous = false;

  // Manual test runs
  if ((manualDrain || manualFill) && (int32_t)(now - manualUntil) >= 0) {
    if (manualDrain) setDrain(false, "manual end");
    if (manualFill) setFill(false, "manual end");
    manualDrain = manualFill = false;
  }

  switch (state) {
    case POSTPONED:
      if ((int32_t)(now - postponeUntil) >= 0) { state = IDLE; startChange(changePct, "retry after postpone"); }
      break;
    case DRAINING:
      drainedMl = (now - stateSince) / 1000.0f * DRAIN_ML_PER_SEC;
      if (drainedMl >= targetMl) {                                                               // R3
        setDrain(false, "target reached");
        enterState(SETTLING, String("drained ") + String(drainedMl, 0) + " ml");
      }
      break;
    case SETTLING:
      if (now - stateSince >= SETTLE_MS) {
        enterState(FILLING, String("refill ") + String(drainedMl, 0) + " ml");
        setFill(true, "refill");
      }
      break;
    case FILLING:
      filledMl = (now - stateSince) / 1000.0f * FILL_ML_PER_SEC;
      if (filledMl >= drainedMl || !fillOn) {
        setFill(false, "refill done");
        cooldownUntil = now + cooldownMs();                                                      // R10
        enterState(IDLE, String("change done ") + changePct + "%");
        lowCount = 0;
      }
      break;
    default: break;
  }
}

// R1: called once per sensor cycle after the score is updated
void runRules() {
  if (score < SCORE_THRESHOLD) lowCount++; else lowCount = 0;
  bool cooling = (int32_t)(millis() - cooldownUntil) < 0;
  if (autoMode && state == IDLE && !cooling && lowCount >= LOW_READINGS_TO_ACT) {
    int pct = score < 40 ? 30 : (score < 50 ? 20 : 10);
    publishEvent("rule", "R1", score, String("score low ") + LOW_READINGS_TO_ACT + "x -> " + pct + "%");
    startChange(pct, "auto R1");
  }
  if (USE_PH && !isnan(phVal) && (phVal < 5.5f || phVal > 8.5f)) publishEvent("alert", "ph", phVal, "pH out of range"); // R8
}

// ---------------- Commands (MQTT JSON and Serial text) ----------------
void handleCommand(const String& cmd, int arg) {
  if (cmd == "change")        startChange(arg > 0 ? arg : 20, "manual change");
  else if (cmd == "stop")     stopAll("stop command");
  else if (cmd == "reset")    { stopAll("reset"); faultMsg = ""; enterState(IDLE, "reset"); }
  else if (cmd == "auto")     { autoMode = arg != 0; publishEvent("mode", "auto", autoMode, ""); }
  else if (cmd == "demo")     { demoMode = arg != 0; publishEvent("mode", "demo", demoMode, ""); }
  else if (cmd == "beep")     beep(1);
  else if (cmd == "drain" || cmd == "fill") {            // manual test, still under safety rules
    if (state != IDLE) { Serial.println("Only when idle"); return; }
    int sec = arg > 0 ? min(arg, 30) : 3;
    manualUntil = millis() + sec * 1000UL;
    if (cmd == "drain") { manualDrain = true; setDrain(true, "manual test"); }
    else                { manualFill = true;  setFill(true, "manual test"); }
  }
  else Serial.printf("Unknown command: %s\n", cmd.c_str());
}

void onMqtt(char* t, byte* payload, unsigned int len) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, len)) return;
  String cmd = doc["cmd"] | "";
  int arg = doc["pct"] | (doc["on"].is<bool>() ? (doc["on"].as<bool>() ? 1 : 0) : (doc["sec"] | 0));
  handleCommand(cmd, arg);
}

void handleSerial() {
  static String line;
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\r') continue;
    if (c != '\n') { line += c; continue; }
    line.trim();
    if (line.length()) {
      int sp = line.indexOf(' ');
      String cmd = sp < 0 ? line : line.substring(0, sp);
      String a = sp < 0 ? "" : line.substring(sp + 1);
      int arg = (a == "on") ? 1 : (a == "off") ? 0 : a.toInt();
      handleCommand(cmd, arg);
    }
    line = "";
  }
}

// ---------------- Network ----------------
uint32_t lastWifiTry = 0, lastMqttTry = 0;

void keepConnected() {
  if (WiFi.status() != WL_CONNECTED) {
    if (millis() - lastWifiTry > 10000) { lastWifiTry = millis(); WiFi.disconnect(); WiFi.begin(WIFI_SSID, WIFI_PASS); }
    return;
  }
  if (!mqtt.connected() && millis() - lastMqttTry > 5000) {
    lastMqttTry = millis();
    String id = "iot-project-" + String((uint32_t)ESP.getEfuseMac(), HEX);
    if (mqtt.connect(id.c_str(), topic("status").c_str(), 1, true, "offline")) {
      mqtt.publish(topic("status").c_str(), "online", true);
      mqtt.subscribe(topic("cmd").c_str());
      Serial.println("MQTT connected");
    }
  }
  mqtt.loop();
}

void publishData() {
  JsonDocument doc;
  doc["ts"] = epochNow();
  doc["src"] = "device";
  if (isnan(tTank)) doc["t_tank"] = nullptr; else doc["t_tank"] = roundf(tTank * 100) / 100;
  if (isnan(tRes)) doc["t_res"] = nullptr; else doc["t_res"] = roundf(tRes * 100) / 100;
  doc["tds"] = roundf(tdsPpm * 10) / 10;
  doc["tds_v"] = roundf(tdsV * 1000) / 1000;
  doc["turb"] = roundf(turbIdx * 10) / 10;
  doc["turb_v"] = roundf(turbV * 1000) / 1000;
  if (USE_PH && !isnan(phVal)) { doc["ph"] = roundf(phVal * 100) / 100; doc["ph_v"] = roundf(phV * 1000) / 1000; }
  else { doc["ph"] = nullptr; doc["ph_v"] = nullptr; }
  doc["flow"] = drainOn ? DRAIN_ML_PER_SEC * 60.0f / 1000.0f : 0;
  doc["vol_ml"] = roundf(drainedMl);
  doc["f_top"] = floatTop() ? 1 : 0;
  doc["f_bot"] = floatBot() ? 1 : 0;
  doc["score"] = score;
  doc["state"] = STATE_NAMES[state];
  doc["drain"] = drainOn ? 1 : 0;
  doc["fill"] = fillOn ? 1 : 0;
  doc["feeder"] = 0;
  doc["buzzer"] = buzzerOn ? 1 : 0;
  doc["auto"] = autoMode ? 1 : 0;
  doc["demo"] = demoMode ? 1 : 0;
  doc["fault"] = faultMsg;
  if (WATER_MODEL_AVAILABLE && mlClass >= 0 && mlClass < WATER_MODEL_CLASSES) doc["ml"] = WATER_LABELS[mlClass];
  else doc["ml"] = nullptr;
  char buf[768];
  size_t n = serializeJson(doc, buf, sizeof(buf));
  if (mqtt.connected()) mqtt.publish(topic("data").c_str(), (const uint8_t*)buf, n, false);
  Serial.println(buf);
}

// ---------------- Outputs ----------------
void updateBuzzer() {
  uint32_t now = millis();
  bool b = buzzerContinuous;
  if (!b && beepsLeft > 0 && (int32_t)(now - beepNext) >= 0) {
    beepPhase = !beepPhase; beepNext = now + 150;
    if (!beepPhase) beepsLeft--;
  }
  if (!b) b = beepsLeft > 0 && beepPhase;
  buzzerOn = b;
  digitalWrite(PIN_BUZZER, b);
}

void drawOled() {
  if (!oledOk) return;
  oled.clearDisplay();
  oled.setTextSize(1);
  oled.setCursor(0, 0);
  oled.printf("%s %s %s", WiFi.status() == WL_CONNECTED ? "W" : "-", mqtt.connected() ? "M" : "-",
              demoMode ? "DEMO" : (autoMode ? "AUTO" : "MAN"));
  oled.setCursor(80, 0); oled.print(STATE_NAMES[state]);
  oled.setTextSize(2); oled.setCursor(0, 12); oled.printf("%3d", score);
  oled.setTextSize(1); oled.setCursor(40, 12); oled.print("score");
  if (WATER_MODEL_AVAILABLE && mlClass >= 0 && mlClass < WATER_MODEL_CLASSES) { oled.setCursor(86, 12); oled.print(WATER_SHORT[mlClass]); }
  oled.setCursor(40, 22);
  if (!isnan(tTank)) oled.printf("%.1fC", tTank); else oled.print("--C");
  oled.setCursor(0, 34); oled.printf("TDS  %.0f ppm", tdsPpm);
  oled.setCursor(0, 44); oled.printf("Turb %.2fV (%.0f)", turbV, turbIdx);
  oled.setCursor(0, 54);
  if (state == FAULT) oled.print(faultMsg.substring(0, 21));
  else if (state != IDLE) oled.printf("%d%% %.0f/%.0f ml", changePct, state == FILLING ? filledMl : drainedMl, targetMl);
  else oled.printf("drain %s fill %s", drainOn ? "ON" : "-", fillOn ? "ON" : "-");
  oled.display();
}

// ---------------- Sensor cycle (non-blocking) ----------------
// 0 s TDS power on + start temperature conversion
// 1 s read temperatures and TDS, TDS power off
// 4 s read turbidity (and pH), compute score, run rules
// 5 s publish
void sensorCycle() {
  uint32_t t = millis() - cycleStart;
  if (phase == 0) {
    digitalWrite(PIN_TDS_POWER, HIGH);
    temps.requestTemperatures();
    phase = 1;
  } else if (phase == 1 && t >= 1000) {
    if (tempCount >= 1) { float v = temps.getTempCByIndex(0); tTank = (v > -55 && v < 125 && v != 85.0f) ? v : NAN; }
    if (tempCount >= 2) { float v = temps.getTempCByIndex(1); tRes  = (v > -55 && v < 125 && v != 85.0f) ? v : NAN; }
    if (adsOk) {
      tdsV = readVoltsMedian(ADS_CH_TDS);
      float tc = isnan(tTank) ? 25.0f : tTank;
      float vc = tdsV / (1.0f + 0.02f * (tc - 25.0f));
      tdsPpm = (133.42f * vc * vc * vc - 255.86f * vc * vc + 857.39f * vc) * 0.5f * TDS_K;
    }
    digitalWrite(PIN_TDS_POWER, LOW);
    phase = 2;
  } else if (phase == 2 && t >= 4000) {
    if (adsOk) {
      turbV = readVoltsMedian(ADS_CH_TURB) * DIVIDER_RATIO;
      turbIdx = (TURB_V_CLEAR - turbV) / TURB_V_SPAN * 100.0f;
      if (turbIdx < 0) turbIdx = 0; if (turbIdx > 100) turbIdx = 100;
      if (USE_PH) { phV = readVoltsMedian(ADS_CH_PH) * DIVIDER_RATIO; phVal = PH_SLOPE * phV + PH_OFFSET; }
      mlClass = classifyWaterFromReadings(tdsPpm, tdsV, turbIdx, turbV, isnan(tTank) ? 25.0f : tTank);
    }
    score = computeScore();
    runRules();
    phase = 3;
  } else if (phase == 3 && t >= CYCLE_MS) {
    publishData();
    drawOled();
    cycleStart = millis();
    phase = 0;
  }
}

// ---------------- Setup / loop ----------------
void setup() {
  Serial.begin(115200);
  delay(300);
  pinMode(PIN_RELAY_DRAIN, OUTPUT); relay(PIN_RELAY_DRAIN, false);
  pinMode(PIN_RELAY_FILL, OUTPUT);  relay(PIN_RELAY_FILL, false);
  pinMode(PIN_BUZZER, OUTPUT); digitalWrite(PIN_BUZZER, LOW);
  pinMode(PIN_TDS_POWER, OUTPUT); digitalWrite(PIN_TDS_POWER, LOW);
  if (USE_FLOATS) { pinMode(PIN_FLOAT_TOP, INPUT_PULLUP); pinMode(PIN_FLOAT_BOT, INPUT_PULLUP); }

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
  Serial.printf("OLED %s, ADS %s, DS18B20: %d\n", oledOk ? "OK" : "FAIL", adsOk ? "OK" : "FAIL", tempCount);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  lastWifiTry = millis();
  configTime(7 * 3600, 0, "pool.ntp.org", "time.google.com");   // WIB
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setBufferSize(1024);
  mqtt.setCallback(onMqtt);

  Serial.println("Commands: change 20 | stop | reset | auto on/off | demo on/off | beep | drain 3 | fill 3");
  cycleStart = millis();
}

void loop() {
  keepConnected();
  handleSerial();
  runStateMachine();
  sensorCycle();
  updateBuzzer();
}
