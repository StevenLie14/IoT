
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
#include "water_model.h"

Adafruit_SSD1306 oled(128, 64, &Wire, -1);
Adafruit_ADS1115 ads;
OneWire oneWire(PIN_TEMP);
DallasTemperature temperatureSensors(&oneWire);
WiFiClient wifiClient;
PubSubClient mqtt(wifiClient);

// State
bool oledOk = false;
bool adsOk = false;
int temperatureSensorCount = 0;
DeviceAddress temperatureSensorAddress;

// Statet Sensor
float tankTemperature = NAN;
float tdsVoltage = 0;
float tdsPpm = 0;
float turbidityVoltage = 0;
float turbidityIndex = 0;
int score = 100;

// Hasil model: index label (clear / dirty / slightly_turbid), -1 = belum ada, dan confidence 0 - 1
int modelClass = -1;
float modelConfidence = 0;

// State skrg lagi ngapain
enum State { IDLE, DRAINING, SETTLING, FILLING };
const char* STATE_NAMES[] = {"idle", "draining", "settling", "filling"};
State state = IDLE;
bool autoMode = false;
int lowScoreCount = 0;
int modelDirtyCount = 0;
uint32_t stateStartedAt = 0;
uint32_t cooldownUntil = 0;

// Ini buat testing manual
bool manualDrain = false;

bool manualFill = false;
bool manualToFloat = false;
uint32_t manualUntil = 0;
uint32_t manualStart = 0;
uint32_t manualRunMs = 0;

// State aktuator
bool drainOn = false;
bool fillOn = false;
bool buzzerOn = false;

int beepsLeft = 0;
bool beepPhase = false;
uint32_t nextBeepAt = 0;

uint32_t cycleStart = 0;
int phase = 0;

// dapetin sub topic (data /cmd /event / status)
String topic(const char* sub) { return String(TOPIC_BASE) + "/" + sub; }

// Dapetin waktu sekarang 
uint32_t epochNow() {
  time_t now = time(nullptr);
  bool clockSet = now > 1600000000;
  return clockSet ? (uint32_t)now : 0;
}

// Buat switch relay
void relay(int pin, bool on) {
  bool pinHigh = RELAY_ACTIVE_LOW ? !on : on;
  digitalWrite(pin, pinHigh ? HIGH : LOW);
}



// Kirim event ke MQTT
void publishEvent(const char* type, const char* name, float value, const String& detail) {
  JsonDocument message;
  message["ts"] = epochNow();
  message["type"] = type;
  message["name"] = name;
  message["value"] = value;
  message["detail"] = detail;
  char buffer[256];
  size_t length = serializeJson(message, buffer, sizeof(buffer));
  if (mqtt.connected()) mqtt.publish(topic("event").c_str(), (const uint8_t*)buffer, length, false);
  Serial.printf("[event] %s %s %.2f %s\n", type, name, value, detail.c_str());
}

// Buat switch pompa buang
void setDrain(bool on, const char* reason) {
  if (on == drainOn) return; // sudah di kondisi itu, tidak usah apa-apa
  if (on && fillOn) {
    fillOn = false;
    relay(PIN_RELAY_FILL, false);
  }
  drainOn = on;
  relay(PIN_RELAY_DRAIN, on);
  publishEvent("actuator", "drain", on ? 1 : 0, reason);
}

// Buat switch pompa isi
void setFill(bool on, const char* reason) {
  if (on == fillOn) return;
  if (on && drainOn) {
    drainOn = false;
    relay(PIN_RELAY_DRAIN, false);
  }
  fillOn = on;
  relay(PIN_RELAY_FILL, on);
  publishEvent("actuator", "fill", on ? 1 : 0, reason);
}

// Buat bunyiin buzzer
void beep(int count) {
  beepsLeft = count;
  beepPhase = false;
  nextBeepAt = millis();
}

void enterState(State newState, const String& detail) {
  state = newState;
  stateStartedAt = millis();
  publishEvent("state", STATE_NAMES[newState], 0, detail);
}

// Float
struct FloatInput {
  int pin;
  int triggeredLevel;
  bool stable;

  bool candidate;
  uint32_t since;
};

FloatInput topFloat = { PIN_FLOAT_TOP, FLOAT_TOP_TRIGGERED_LEVEL, false, false, 0 };
FloatInput bottomFloat = { PIN_FLOAT_BOT, FLOAT_BOT_TRIGGERED_LEVEL, false, false, 0 };

// update status float
void updateFloat(FloatInput& floatInput, bool first = false) {
  bool raw = digitalRead(floatInput.pin) == floatInput.triggeredLevel; 
  uint32_t now = millis();

  if (first) {
    floatInput.stable = raw;
    floatInput.candidate = raw;
    floatInput.since = now;
    return;
  }

  if (raw != floatInput.candidate) {
    floatInput.candidate = raw;
    floatInput.since = now;
  } else if (raw != floatInput.stable && now - floatInput.since >= FLOAT_DEBOUNCE_MS) {
    floatInput.stable = raw;
  }
}

bool floatTop() { return topFloat.stable; }
bool floatBottom() { return bottomFloat.stable; }

// ambil median dari sample ADC biar ga noise 
float readVoltageMedian(int channel, int sampleCount = 11) {
  float samples[16];
  if (sampleCount > 16){
     sampleCount = 16;
  }
  

  for (int i = 0; i < sampleCount; i++) {
    samples[i] = ads.computeVolts(ads.readADC_SingleEnded(channel));
  }

  for (int i = 1; i < sampleCount; i++) {
    float value = samples[i];
    int j = i - 1;
    while (j >= 0 && samples[j] > value) {
      samples[j + 1] = samples[j];
      j--;
    }
    samples[j + 1] = value;
  }




  return samples[sampleCount / 2];
}

// Buat itung subscore dari nilai sensor antar 0 - 100
float linearScore(float value, float good, float bad) {
  float position = (value - good) / (bad - good);



  position = constrain(position, 0.0f, 1.0f);
  return 100.0f * (1.0f - position);
}

// Itung Health Score dari rumus weight TDS 50%, turbidity 37.5%, temperature 12.5%
int computeScore() {
  float weightedSum = 0;
  float totalWeight = 0;

  float tdsScore = linearScore(tdsPpm, TDS_GOOD, TDS_BAD);
  weightedSum += 0.5f * tdsScore;
  totalWeight += 0.5f;

  float turbidityScore = 100.0f - turbidityIndex;
  weightedSum += 0.375f * turbidityScore;
  totalWeight += 0.375f;

  if (!isnan(tankTemperature)) {
    float temperatureScore;
    if (tankTemperature < 24) temperatureScore = linearScore(tankTemperature, 24, 20);
    else if (tankTemperature > 30) temperatureScore = linearScore(tankTemperature, 30, 34);
    else temperatureScore = 100.0f;
    weightedSum += 0.125f * temperatureScore;
    totalWeight += 0.125f;
  }

  return (int)roundf(weightedSum / totalWeight);
}

// Start ganti air
void startChange(const char* reason) {
  if (state != IDLE) {
    Serial.println("Change already running");
    return;
  }
  manualDrain = false;
  manualFill = false;
  enterState(DRAINING, reason);

  if (floatBottom()) {
    enterState(SETTLING, "tank already low");
    return;

  }



  setDrain(true, reason);
}

// Function buat reset semua pump
void stopAll(const char* reason) {
  setDrain(false, reason);
  setFill(false, reason);
  manualDrain = false;
  manualFill = false;
  if (state != IDLE) enterState(IDLE, reason);
}


// Selesai ganti air buat jalanin cooldown
void finishChange(const char* reason) {
  setFill(false, reason);
  cooldownUntil = millis() + COOLDOWN_MS;
  enterState(IDLE, "change done");


  lowScoreCount = 0; 
  modelDirtyCount = 0;
}

// Matiin semua pompa kalau dia jalan kelamaan tapi ga kena float
void pumpFault(const char* reason) {
  setDrain(false, reason);
  setFill(false, reason);
  manualDrain = false;
  manualFill = false;
  beep(5);
  publishEvent("fault", reason, 0, "pumps stopped, auto mode off");

  if (autoMode) {
    autoMode = false;
    publishEvent("mode", "auto", 0, "off after fault");
  }
  enterState(IDLE, reason);
}

// dipanggil terus buat tau lagi state apa skrg buat jalanin commandnya (otomatis / manual)
void runStateMachine() {
  uint32_t now = millis();

  bool timeUp = (int32_t)(now - manualUntil) >= 0;
  if (manualToFloat && timeUp && (manualDrain || manualFill)) { // never reached the float
    pumpFault(manualDrain ? "drain timeout" : "fill timeout");
    manualToFloat = false;
  }
  if (manualDrain && (timeUp || floatBottom())) {
    setDrain(false, timeUp ? "manual end: time up" : "manual end: bottom float");
    manualDrain = false;
  }
  if (manualFill && (timeUp || floatTop())) {
    setFill(false, timeUp ? "manual end: time up" : "manual end: top float");
    manualFill = false;
  }
  if (!manualDrain && !manualFill) manualToFloat = false;

  // proses ganti air dari drain ke pause ke fill
  switch (state) {
    case DRAINING:
      if (now - stateStartedAt >= DRAIN_TIMEOUT_MS) {

        pumpFault("drain timeout");
        break;

      }
      if (floatBottom()) {

        setDrain(false, "bottom float");
        enterState(SETTLING, "bottom float reached");
      }
      break;
    case SETTLING:
      if (now - stateStartedAt >= SETTLE_MS) {
        
        enterState(FILLING, "refill until top float");
        if (floatTop()) finishChange("tank already full");
        else setFill(true, "refill");

      }
      break;
    case FILLING:
      if (now - stateStartedAt >= FILL_TIMEOUT_MS) {
        pumpFault("fill timeout");
        break;
      }
      if (floatTop()) finishChange("top float");
      break;
    default: break;
  }
}


// Cek prediksi terakhir model "dirty" dan cukup yakin (minimal 60%)
bool modelSaysDirty() {
  if (!WATER_MODEL_AVAILABLE || modelClass < 0 || modelClass >= WATER_MODEL_CLASSES) return false;
  return strcmp(WATER_LABELS[modelClass], "dirty") == 0 && modelConfidence >= ML_MIN_CONFIDENCE;
}

// Rule AI (R4): kalau model bilang dirty 5x berturut-turut, auto mode on dan lagi ga cooldown, maka jalanin ganti air otomatis
// R1 (health score rendah) cuma dipake kalau firmware ga ada modelnya
void runRules() {
  if (drainOn || fillOn) {
    lowScoreCount = 0;
    modelDirtyCount = 0;
    return;
  }

  if (score < SCORE_THRESHOLD) lowScoreCount++;
  else lowScoreCount = 0;

  if (modelSaysDirty()) modelDirtyCount++;
  else modelDirtyCount = 0;

  bool cooling = (int32_t)(millis() - cooldownUntil) < 0;
  if (!autoMode || state != IDLE || cooling) return;

  if (WATER_MODEL_AVAILABLE) {
    if (modelDirtyCount >= ML_DIRTY_READINGS) {
      publishEvent("rule", "R4", modelConfidence, String("model predicts dirty (") + (int)roundf(modelConfidence * 100) + " %) for " + ML_DIRTY_READINGS + " readings");
      beep(3);
      startChange("auto R4 (AI)");
    }
  } else if (lowScoreCount >= LOW_READINGS_TO_ACT) {
    publishEvent("rule", "R1", score, String("score below ") + SCORE_THRESHOLD + " for " + LOW_READINGS_TO_ACT + " readings");
    beep(3);
    startChange("auto R1");
  }
}

// ini buat handle command dari MQTT / serial monitor 
void handleCommand(const String& command, int argument) {
  if (command == "change") startChange("manual change");
  else if (command == "stop") stopAll("stop command");
  else if (command == "auto") {
    autoMode = argument != 0;
    publishEvent("mode", "auto", autoMode, "");
  }
  else if (command == "beep") beep(1);
  else if (command == "drain" || command == "fill" || command == "drain_float" || command == "fill_float") {


    if (state != IDLE) {
      Serial.println("Only when idle");
      return;
    }


    if (manualDrain || manualFill) {
      Serial.println("A pump test is already running");
      return;
    }

    bool drain = command.startsWith("drain");
    bool toFloat = command.endsWith("_float");

    // ga bole jalanin pompa kalau lewat float
    if (!drain && floatTop()) {
      publishEvent("refused", "fill", 0, "top float already reached");
      return;
    }
    if (drain && floatBottom()) {
      publishEvent("refused", "drain", 0, "bottom float already reached");
      return;
    }

    uint32_t runMs;
    const char* reason;
    if (toFloat) {
      runMs = drain ? DRAIN_TIMEOUT_MS : FILL_TIMEOUT_MS; // batas maksimal = timeout (2 menit)
      reason = drain ? "manual: drain to bottom float" : "manual: fill to top float";
    } else {
      int seconds = argument > 0 ? min(argument, 30) : 3; // default 3 detik, paling lama 30
      runMs = seconds * 1000UL;
      reason = "manual test";
    }
    manualStart = millis();
    manualRunMs = runMs;
    manualUntil = manualStart + runMs;
    manualToFloat = toFloat;

    if (drain) {
      manualDrain = true;
      setDrain(true, reason);
    } else {
      manualFill = true;
      setFill(true, reason);
    }
  }
  else Serial.printf("Unknown command: %s\n", command.c_str());
}


// kalau ada command masuk dari dashboard 
void onMqtt(char* topicName, byte* payload, unsigned int length) {
  JsonDocument message;
  if (deserializeJson(message, payload, length)) return;
  String command = message["cmd"] | "";

  int argument;
  if (message["on"].is<bool>()) argument = message["on"].as<bool>() ? 1 : 0;
  else argument = message["sec"] | 0;
  handleCommand(command, argument);
}

// Ini kalau ketik manual dari serial monitor di arduino ide
void handleSerial() {
  static String line;
  while (Serial.available()) {
    char character = Serial.read();
    if (character == '\r') continue;
    if (character != '\n') {
      line += character;
      continue;
    }

    line.trim();

    if (line.length()) {
      int space = line.indexOf(' ');
      String command = space < 0 ? line : line.substring(0, space);
      String argumentText = space < 0 ? "" : line.substring(space + 1);

      int argument;
      if (argumentText == "on") argument = 1;
      else if (argumentText == "off") argument = 0;
      else argument = argumentText.toInt();


      handleCommand(command, argument);
    }
    line = "";
  }
}

uint32_t lastWifiTry = 0;
uint32_t lastMqttTry = 0;

// Reconnect ke wifi ama MQTT
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
    String clientId = "iot-project-" + String((uint32_t)ESP.getEfuseMac(), HEX);
    if (mqtt.connect(clientId.c_str(), topic("status").c_str(), 1, true, "offline")) {


      // buat kasih tau dashboard kalo online
      mqtt.publish(topic("status").c_str(), "online", true);

      mqtt.subscribe(topic("cmd").c_str());
      Serial.println("MQTT connected");
    } else {
      Serial.printf("MQTT connect failed, state %d\n", mqtt.state());
    }
  }
  mqtt.loop();
}

// kirim semua data sensor dan statusnya lewat topic data per 3s
void publishData() {
  if (isnan(tankTemperature)) return;
  JsonDocument message;
  message["ts"] = epochNow();
  message["src"] = "device";
  message["t_tank"] = roundf(tankTemperature * 100) / 100;
  message["tds"] = roundf(tdsPpm * 10) / 10;
  message["tds_v"] = roundf(tdsVoltage * 1000) / 1000;
  message["turb"] = roundf(turbidityIndex * 10) / 10;
  message["turb_v"] = roundf(turbidityVoltage * 1000) / 1000;
  message["f_top"] = floatTop() ? 1 : 0;
  message["f_bot"] = floatBottom() ? 1 : 0;
  message["score"] = score;
  message["state"] = STATE_NAMES[state];
  message["drain"] = drainOn ? 1 : 0;
  message["fill"] = fillOn ? 1 : 0;
  message["buzzer"] = buzzerOn ? 1 : 0;
  message["auto"] = autoMode ? 1 : 0;
  // prediksi model ikut dikirim (label + confidence)
  if (WATER_MODEL_AVAILABLE && modelClass >= 0 && modelClass < WATER_MODEL_CLASSES) {
    message["ml"] = WATER_LABELS[modelClass];
    message["ml_conf"] = roundf(modelConfidence * 100) / 100;
  }
  char buffer[768];
  size_t length = serializeJson(message, buffer, sizeof(buffer));
  if (mqtt.connected()) mqtt.publish(topic("data").c_str(), (const uint8_t*)buffer, length, false);
  Serial.println(buffer);
}

// Bunyiin buzzer kalau ada antrian per 150ms
void updateBuzzer() {
  uint32_t now = millis();
  if (beepsLeft > 0 && (int32_t)(now - nextBeepAt) >= 0) {
    beepPhase = !beepPhase;
    nextBeepAt = now + 150;
    if (!beepPhase) beepsLeft--;
  }
  buzzerOn = beepsLeft > 0 && beepPhase;
  digitalWrite(PIN_BUZZER, buzzerOn);
}

// Buat draw di OLED

void oledCentered(const char* text, int y, int size) {
  int16_t boundsX;
  int16_t boundsY;
  uint16_t width;
  uint16_t height;
  oled.setTextSize(size);
  oled.getTextBounds(text, 0, 0, &boundsX, &boundsY, &width, &height); // ukur lebar teks
  oled.setCursor((128 - width) / 2, y);
  oled.print(text);
}



void oledRight(const char* text, int y) {
  oled.setTextSize(1);
  oled.setCursor(128 - 6 * strlen(text), y);

  oled.print(text);
}

// Main screen kalo ga ada pompa jalan
void drawStatusScreen() {
  oled.setTextSize(1);
  oled.setCursor(0, 0);
  oled.print(autoMode ? "AUTO" : "MANUAL");
  const char* link = mqtt.connected() ? "online" : (WiFi.status() == WL_CONNECTED ? "no mqtt" : "no wifi");
  oledRight(link, 0);
  oled.drawFastHLine(0, 10, 128, SSD1306_WHITE);

  char buffer[16];
  snprintf(buffer, sizeof(buffer), "%d", score);
  oled.setTextSize(3);
  oled.setCursor(score >= 100 ? 0 : 9, 16); // angka 3 digit digeser ke kiri biar muat
  oled.print(buffer);
  oled.setTextSize(1);
  oled.setCursor(9, 42);
  oled.print("score");

  oled.fillRoundRect(62, 14, 66, 13, 3, SSD1306_WHITE);
  oled.setTextColor(SSD1306_BLACK);
  oled.setTextSize(1);
  // kotak kanan atas isinya prediksi model (CLEAR / SLIGHT / DIRTY)
  bool hasModel = WATER_MODEL_AVAILABLE && modelClass >= 0 && modelClass < WATER_MODEL_CLASSES;
  const char* water = hasModel ? WATER_SHORT[modelClass] : "NO MODEL";
  oled.setCursor(62 + (66 - 6 * (int)strlen(water)) / 2, 17);
  oled.print(water);
  oled.setTextColor(SSD1306_WHITE);

  if (isnan(tankTemperature)) snprintf(buffer, sizeof(buffer), "--.-C");
  else snprintf(buffer, sizeof(buffer), "%.1fC", tankTemperature);
  oled.setTextSize(2);
  oled.setCursor(66, 32);
  oled.print(buffer);

  oled.drawFastHLine(0, 52, 128, SSD1306_WHITE);
  oled.setTextSize(1);
  oled.setCursor(0, 56);
  oled.printf("TDS %.0f ppm", tdsPpm);
  snprintf(buffer, sizeof(buffer), "Turb %.0f%%", turbidityIndex);
  oledRight(buffer, 56);
}

// Layar waktu pompa jalan (statenya)
void drawPumpScreen() {
  uint32_t now = millis();
  bool waterChange = state != IDLE; // ganti air (bukan tes manual)
  bool draining = waterChange ? state == DRAINING : drainOn;
  bool settling = state == SETTLING;



  oled.fillRect(0, 0, 128, 11, SSD1306_WHITE);
  oled.setTextColor(SSD1306_BLACK);
  oledCentered(waterChange ? "WATER CHANGE" : "PUMP TEST", 2, 1);
  oled.setTextColor(SSD1306_WHITE);

  const char* action = settling ? "WAITING" : (draining ? "DRAINING" : "FILLING");
  oledCentered(action, 16, 2);

  const char* until;
  uint32_t elapsed;
  uint32_t limit;
  if (waterChange) {
    elapsed = now - stateStartedAt;
    if (settling) {
      until = "before filling";
      limit = SETTLE_MS;
    } else if (draining) {
      until = "until bottom float";
      limit = DRAIN_TIMEOUT_MS;
    } else {
      until = "until top float";
      limit = FILL_TIMEOUT_MS;
    }
  } else {
    elapsed = now - manualStart;
    limit = manualRunMs;
    if (manualToFloat) until = draining ? "until bottom float" : "until top float";
    else until = "timed test";
  }
  oledCentered(until, 34, 1);

  // Progress by time limit
  elapsed = min(elapsed, limit);
  oled.drawRect(0, 45, 128, 7, SSD1306_WHITE); // bingkai bar
  int barLength = limit ? (int)((uint64_t)elapsed * 124 / limit) : 0; // panjang isi bar (maks 124 px)
  oled.fillRect(2, 47, barLength, 3, SSD1306_WHITE);

  char buffer[24];
  oled.setTextSize(1);
  oled.setCursor(0, 56);
  oled.printf("%lu s", (unsigned long)(elapsed / 1000));
  bool floatRun = !settling && (waterChange || manualToFloat);
  snprintf(buffer, sizeof(buffer), floatRun ? "max %lu s" : "of %lu s", (unsigned long)(limit / 1000));
  oledRight(buffer, 56);
}

bool pumpScreenActive() {
  return state != IDLE || drainOn || fillOn;
}

uint32_t oledDrawnAt = 0;


// Gambar OLED berdasarkan state skrg, cuma kalo oledny ga ketemu skip
void drawOled() {
  if (!oledOk) return;
  oledDrawnAt = millis();
  oled.clearDisplay();
  oled.setTextColor(SSD1306_WHITE);
  if (pumpScreenActive()) drawPumpScreen();
  else drawStatusScreen();
  oled.display(); // kirim buffer ke layar
}

// Buat read temp
void readTemperature() {
  float reading = DEVICE_DISCONNECTED_C;
  if (temperatureSensorCount < 1) {
    temperatureSensors.begin();
    if (temperatureSensors.getDeviceCount() >= 1 && temperatureSensors.getAddress(temperatureSensorAddress, 0)) {
      temperatureSensorCount = 1;
      Serial.println("DS18B20 found");
    }
  }

  for (int i = 0; temperatureSensorCount >= 1 && i < 3; i++) {
    reading = temperatureSensors.getTempC(temperatureSensorAddress);
    bool valid = reading > -55 && reading < 125 && reading != 85.0f; // -55..125 = rentang DS18B20
    if (valid) {
      tankTemperature = reading;
      return;
    }
    delay(5);
  }

  tankTemperature = NAN;
}

//Cycle sensor per 3s: matiin TDS, baca suhu, nyalain TDS, baca TDS, baca turbidity, jalanin model, hitung skor + cek rule, kirim data + update OLED
void sensorCycle() {
  uint32_t elapsed = millis() - cycleStart;
  if (phase == 0) {
    digitalWrite(PIN_TDS_POWER, LOW);
    temperatureSensors.requestTemperatures();
    phase = 1;


  } else if (phase == 1 && elapsed >= 1000) {
    readTemperature();
    digitalWrite(PIN_TDS_POWER, HIGH);
    phase = 2;
  } else if (phase == 2 && elapsed >= 1800) {
    if (adsOk) {
      tdsVoltage = readVoltageMedian(ADS_CH_TDS);
      float waterTemperature = isnan(tankTemperature) ? 25.0f : tankTemperature;
      float voltageAt25 = tdsVoltage / (1.0f + 0.02f * (waterTemperature - 25.0f));
      float curve = 133.42f * voltageAt25 * voltageAt25 * voltageAt25 - 255.86f * voltageAt25 * voltageAt25 + 857.39f * voltageAt25;
      tdsPpm = curve * 0.5f * TDS_K;
    }
    digitalWrite(PIN_TDS_POWER, LOW);
    phase = 3;
  } else if (phase == 3 && elapsed >= 1900) {
    if (adsOk) {
      turbidityVoltage = readVoltageMedian(ADS_CH_TURB) * DIVIDER_RATIO;

      turbidityIndex = (TURB_V_CLEAR - turbidityVoltage) / TURB_V_SPAN * 100.0f;
      turbidityIndex = constrain(turbidityIndex, 0.0f, 100.0f);

      // jalanin model pake TDS dan tegangan turbidity, confidence diisi lewat pointer
      float waterTemperature = isnan(tankTemperature) ? 25.0f : tankTemperature;
      modelClass = classifyWaterFromReadings(tdsPpm, tdsVoltage, turbidityIndex, turbidityVoltage, waterTemperature, &modelConfidence);
    }
    score = computeScore();
    runRules();
    phase = 4;
  } else if (phase == 4 && elapsed >= CYCLE_MS) {
    publishData();
    drawOled();
    cycleStart = millis();
    phase = 0;
  }
}

// Jalan setup waktu esp nyala
void setup() {
  Serial.begin(115200);
  delay(300);
  pinMode(PIN_RELAY_DRAIN, OUTPUT);
  relay(PIN_RELAY_DRAIN, false);
  pinMode(PIN_RELAY_FILL, OUTPUT);
  relay(PIN_RELAY_FILL, false);
  pinMode(PIN_BUZZER, OUTPUT);
  digitalWrite(PIN_BUZZER, LOW);
  pinMode(PIN_TDS_POWER, OUTPUT);
  digitalWrite(PIN_TDS_POWER, LOW);
  pinMode(PIN_FLOAT_TOP, INPUT_PULLUP);
  pinMode(PIN_FLOAT_BOT, INPUT_PULLUP);
  updateFloat(topFloat, true);
  updateFloat(bottomFloat, true);

  Wire.begin(PIN_SDA, PIN_SCL);
  bool foundOled = false;
  bool foundAds = false;
  for (uint8_t address = 1; address < 127; address++) {
    Wire.beginTransmission(address);
    if (Wire.endTransmission() == 0) {
      if (address == OLED_ADDR) foundOled = true;
      if (address == ADS_ADDR) foundAds = true;
    }
  }

  // OLED ama ADS
  oledOk = foundOled && oled.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR);
  adsOk = foundAds && ads.begin(ADS_ADDR, &Wire);
  if (adsOk) ads.setGain(GAIN_ONE);
  if (oledOk) {
    oled.setTextColor(SSD1306_WHITE);
    oled.clearDisplay();
    oled.setCursor(0, 0);
    oled.print("IoT Project");
    oled.display();
  }

  // Temp
  temperatureSensors.begin();
  temperatureSensors.setWaitForConversion(false);
  temperatureSensorCount = temperatureSensors.getDeviceCount();
  if (temperatureSensorCount >= 1 && !temperatureSensors.getAddress(temperatureSensorAddress, 0)) temperatureSensorCount = 0;
  Serial.printf("OLED %s, ADS %s, DS18B20: %d\n", oledOk ? "OK" : "FAIL", adsOk ? "OK" : "FAIL", temperatureSensorCount);

  // Wifi
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  lastWifiTry = millis();
  configTime(7 * 3600, 0, "pool.ntp.org", "time.google.com");

  // MQTT
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setBufferSize(1024); // default 256 byte terlalu kecil buat JSON data
  mqtt.setCallback(onMqtt); // fungsi yang dipanggil kalau ada perintah masuk

  Serial.println("Commands: change | stop | auto on/off | beep | drain 3 | fill 3 | drain_float | fill_float");
  cycleStart = millis();
}


// Ini loop yg dijalanin ama esp terus2an
void loop() {
  updateFloat(topFloat);
  updateFloat(bottomFloat);
  keepConnected();
  handleSerial();
  
  runStateMachine();
  sensorCycle();
  updateBuzzer();
  if (pumpScreenActive() && millis() - oledDrawnAt >= 500) drawOled();
}
