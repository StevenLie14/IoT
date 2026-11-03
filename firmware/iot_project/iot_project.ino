// IoT Project - main firmware (ESP32)
// Sensing -> score -> rule-based water change -> MQTT JSON every 3 s.
// Libraries: Adafruit SSD1306 (+GFX, BusIO), Adafruit ADS1X15, OneWire,
//            DallasTemperature, PubSubClient, ArduinoJson (7.x)
// All settings are in config.h.

#include <WiFi.h>
#include <WiFiClientSecure.h>
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
#include "mqtt_ca.h"

// ---------------- Objects ----------------
Adafruit_SSD1306 oled(128, 64, &Wire, -1);
Adafruit_ADS1115 ads;
OneWire oneWire(PIN_TEMP);
DallasTemperature temps(&oneWire);
#if MQTT_USE_TLS
WiFiClientSecure netClient;
#else
WiFiClient netClient;
#endif
PubSubClient mqtt(netClient);

bool oledOk = false, adsOk = false;
int tempCount = 0;
DeviceAddress tempAddr;

// ---------------- Latest readings ----------------
float tTank = NAN;
float tdsV = 0, tdsPpm = 0;
float turbV = 0, turbIdx = 0;
int   score = 100;
int   mlClass = -1;      // on-device water-condition prediction (-1 = no model)

// ---------------- State machine ----------------
enum State { IDLE, DRAINING, SETTLING, FILLING };
const char* STATE_NAMES[] = {"idle", "draining", "settling", "filling"};
State state = IDLE;
bool autoMode = true, demoMode = false;
int lowCount = 0;
uint32_t stateSince = 0, cooldownUntil = 0;

// Manual test run (commands "drain N" / "fill N")
bool manualDrain = false, manualFill = false;
uint32_t manualUntil = 0;

// Actuator outputs
bool drainOn = false, fillOn = false, buzzerOn = false;

// Buzzer pattern (non-blocking)
int beepsLeft = 0; bool beepPhase = false; uint32_t beepNext = 0;

// Sensor cycle phases
uint32_t cycleStart = 0; int phase = 0;

// ---------------- Helpers ----------------
String topic(const char* sub) { return String(TOPIC_BASE) + "/" + sub; }
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
  publishEvent("actuator", "drain", on ? 1 : 0, why);
}

void setFill(bool on, const char* why) {
  if (on == fillOn) return;
  if (on && drainOn) { drainOn = false; relay(PIN_RELAY_DRAIN, false); }
  fillOn = on; relay(PIN_RELAY_FILL, on);
  publishEvent("actuator", "fill", on ? 1 : 0, why);
}

void beep(int n) { beepsLeft = n; beepPhase = false; beepNext = millis(); }

void enterState(State s, const String& detail) {
  state = s; stateSince = millis();
  publishEvent("state", STATE_NAMES[s], 0, detail);
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
  // TDS (0.5)
  sum += 0.5f * lin(tdsPpm, TDS_GOOD, TDS_BAD); wSum += 0.5f;
  // Turbidity (0.375): index 0 = as clear as calibration, 100 = TURB_V_SPAN darker
  sum += 0.375f * (100.0f - turbIdx); wSum += 0.375f;
  // Temperature (0.125), left out if the DS18B20 gives no reading
  if (!isnan(tTank)) {
    float s = (tTank >= 24 && tTank <= 30) ? 100.0f
            : (tTank < 24 ? lin(tTank, 24, 20) : lin(tTank, 30, 34));
    sum += 0.125f * s; wSum += 0.125f;
  }
  return (int)roundf(sum / wSum);
}

// ---------------- Water change ----------------
void startChange(const char* reason) {
  if (state != IDLE) { Serial.println("Change already running"); return; }
  manualDrain = manualFill = false;
  enterState(DRAINING, reason);
  if (floatBot()) { enterState(SETTLING, "tank already low"); return; }
  setDrain(true, reason);
}

void stopAll(const char* why) {
  setDrain(false, why); setFill(false, why);
  manualDrain = manualFill = false;
  if (state != IDLE) enterState(IDLE, why);
}

void finishChange(const char* why) {
  setFill(false, why);
  cooldownUntil = millis() + cooldownMs();   // R3
  enterState(IDLE, "change done");
  lowCount = 0;
}

void runStateMachine() {
  uint32_t now = millis();

  // Manual test runs stop on time or at a float
  if (manualDrain && ((int32_t)(now - manualUntil) >= 0 || floatBot())) { setDrain(false, "manual end"); manualDrain = false; }
  if (manualFill && ((int32_t)(now - manualUntil) >= 0 || floatTop())) { setFill(false, "manual end"); manualFill = false; }

  switch (state) {
    case DRAINING:   // R2: bottom float ends draining
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
      if (floatTop()) finishChange("top float");
      break;
    default: break;
  }
}

// R1: called once per sensor cycle after the score is updated
void runRules() {
  if (score < SCORE_THRESHOLD) lowCount++; else lowCount = 0;
  bool cooling = (int32_t)(millis() - cooldownUntil) < 0;
  if (autoMode && state == IDLE && !cooling && lowCount >= LOW_READINGS_TO_ACT) {
    publishEvent("rule", "R1", score, String("score below ") + SCORE_THRESHOLD + " for " + LOW_READINGS_TO_ACT + " readings");
    beep(3);
    startChange("auto R1");
  }
}

// ---------------- Commands (MQTT JSON and Serial text) ----------------
void handleCommand(const String& cmd, int arg) {
  if (cmd == "change")        startChange("manual change");
  else if (cmd == "stop")     stopAll("stop command");
  else if (cmd == "auto")     { autoMode = arg != 0; publishEvent("mode", "auto", autoMode, ""); }
  else if (cmd == "demo")     { demoMode = arg != 0; publishEvent("mode", "demo", demoMode, ""); }
  else if (cmd == "beep")     beep(1);
  else if (cmd == "drain" || cmd == "fill") {            // manual test, stops at the floats
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
  // TLS checks certificate dates, so wait until NTP has set the clock
  if (MQTT_USE_TLS && epochNow() == 0) { mqtt.loop(); return; }
  if (!mqtt.connected() && millis() - lastMqttTry > 5000) {
    lastMqttTry = millis();
    String id = "iot-project-" + String((uint32_t)ESP.getEfuseMac(), HEX);
    const char* user = strlen(MQTT_USER) ? MQTT_USER : nullptr;
    const char* pass = strlen(MQTT_USER) ? MQTT_PASS : nullptr;
    if (mqtt.connect(id.c_str(), user, pass, topic("status").c_str(), 1, true, "offline")) {
      mqtt.publish(topic("status").c_str(), "online", true);
      mqtt.subscribe(topic("cmd").c_str());
      Serial.println("MQTT connected");
    } else {
      Serial.printf("MQTT connect failed, state %d\n", mqtt.state());
    }
  }
  mqtt.loop();
}

void publishData() {
  JsonDocument doc;
  doc["ts"] = epochNow();
  doc["src"] = "device";
  if (isnan(tTank)) doc["t_tank"] = nullptr; else doc["t_tank"] = roundf(tTank * 100) / 100;
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
  doc["demo"] = demoMode ? 1 : 0;
  char buf[768];
  size_t n = serializeJson(doc, buf, sizeof(buf));
  if (mqtt.connected()) mqtt.publish(topic("data").c_str(), (const uint8_t*)buf, n, false);
  Serial.println(buf);
}

// ---------------- Outputs ----------------
void updateBuzzer() {
  uint32_t now = millis();
  if (beepsLeft > 0 && (int32_t)(now - beepNext) >= 0) {
    beepPhase = !beepPhase; beepNext = now + 150;
    if (!beepPhase) beepsLeft--;
  }
  bool b = beepsLeft > 0 && beepPhase;
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
  if (state == DRAINING) oled.print("drain to bottom float");
  else if (state == FILLING) oled.print("fill to top float");
  else oled.printf("drain %s fill %s", drainOn ? "ON" : "-", fillOn ? "ON" : "-");
  oled.display();
}

// Reads by stored address (no bus search) and retries the read a few times, because a
// Wi-Fi interrupt can corrupt one OneWire transfer. Keeps the last good value for up to
// 5 failed cycles (15 s) and says why a read failed.
int tempFails = 0;
void readTemperature() {
  float v = DEVICE_DISCONNECTED_C;
  for (int i = 0; i < 3; i++) {
    v = temps.getTempC(tempAddr);
    if (v > -55 && v < 125 && v != 85.0f) { tTank = v; tempFails = 0; return; }
    delay(5);
  }
  tempFails++;
  Serial.printf("DS18B20 read failed (%.1f): %s\n", v,
                v <= -127 ? "no answer, check the data wire and the 4.7k pull-up" : "power-on value, check the power wire");
  if (tempFails > 5) tTank = NAN;
}

// ---------------- Sensor cycle (non-blocking) ----------------
// 0 s TDS power on + start temperature conversion
// 1 s read temperatures and TDS, TDS power off
// 1.5 s read turbidity, compute score, run rules
// 3 s (CYCLE_MS) publish
void sensorCycle() {
  uint32_t t = millis() - cycleStart;
  if (phase == 0) {
    digitalWrite(PIN_TDS_POWER, HIGH);
    temps.requestTemperatures();
    phase = 1;
  } else if (phase == 1 && t >= 1000) {
    if (tempCount >= 1) readTemperature();
    if (adsOk) {
      tdsV = readVoltsMedian(ADS_CH_TDS);
      float tc = isnan(tTank) ? 25.0f : tTank;
      float vc = tdsV / (1.0f + 0.02f * (tc - 25.0f));
      tdsPpm = (133.42f * vc * vc * vc - 255.86f * vc * vc + 857.39f * vc) * 0.5f * TDS_K;
    }
    digitalWrite(PIN_TDS_POWER, LOW);
    phase = 2;
  } else if (phase == 2 && t >= 1500) {
    if (adsOk) {
      turbV = readVoltsMedian(ADS_CH_TURB) * DIVIDER_RATIO;
      turbIdx = (TURB_V_CLEAR - turbV) / TURB_V_SPAN * 100.0f;
      if (turbIdx < 0) turbIdx = 0; if (turbIdx > 100) turbIdx = 100;
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
  if (tempCount >= 1 && !temps.getAddress(tempAddr, 0)) tempCount = 0;
  Serial.printf("OLED %s, ADS %s, DS18B20: %d\n", oledOk ? "OK" : "FAIL", adsOk ? "OK" : "FAIL", tempCount);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  lastWifiTry = millis();
  configTime(7 * 3600, 0, "pool.ntp.org", "time.google.com");   // WIB
#if MQTT_USE_TLS
  netClient.setCACert(MQTT_ROOT_CA);
#endif
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setBufferSize(1024);
  mqtt.setCallback(onMqtt);

  Serial.println("Commands: change | stop | auto on/off | demo on/off | beep | drain 3 | fill 3");
  cycleStart = millis();
}

void loop() {
  keepConnected();
  handleSerial();
  runStateMachine();
  sensorCycle();
  updateBuzzer();
}
