// Library yang dipakai:
// WiFi.h            -> koneksi Wi-Fi bawaan ESP32
// time.h            -> ambil jam dari internet (NTP) buat timestamp
// Wire.h            -> komunikasi I2C (dipakai OLED dan ADS1115, pin SDA/SCL)
// Adafruit_GFX/SSD1306 -> gambar teks dan garis di layar OLED 128x64
// Adafruit_ADS1X15  -> baca ADC eksternal ADS1115 (TDS dan turbidity)
// OneWire/DallasTemperature -> baca sensor suhu DS18B20 lewat 1 kabel data
// PubSubClient      -> client MQTT (kirim data, terima perintah)
// ArduinoJson       -> bikin dan baca pesan JSON
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
#include "config.h" // semua pin, threshold, dan kalibrasi ada di sini
#include "water_model.h" // model Random Forest hasil ml/export_tree.py (tiap tree jadi if-else)

// Objek untuk tiap perangkat
Adafruit_SSD1306 oled(128, 64, &Wire, -1); // layar 128x64 lewat I2C, -1 = tanpa pin reset
Adafruit_ADS1115 ads;                      // ADC 16-bit eksternal
OneWire oneWire(PIN_TEMP);                 // bus 1-Wire di pin data DS18B20
DallasTemperature temps(&oneWire);         // driver DS18B20 di atas bus itu
WiFiClient netClient;                      // koneksi TCP biasa (tanpa TLS) ke broker
PubSubClient mqtt(netClient);              // client MQTT yang jalan di atas koneksi TCP tadi

// State
bool oledOk = false, adsOk = false; // true kalau OLED / ADS1115 ketemu waktu boot
int tempCount = 0;                  // jumlah DS18B20 yang ketemu (0 = belum ketemu)
DeviceAddress tempAddr;             // alamat unik DS18B20, disimpan biar baca langsung tanpa scan

// Nilai sensor terakhir
float tTank = NAN;                  // suhu air (NAN = belum ada / gagal baca)
float tdsV = 0, tdsPpm = 0;         // tegangan mentah TDS dan hasil ppm
float turbV = 0, turbIdx = 0;       // tegangan turbidity dan indeks 0-100 (0 = jernih)
int   score = 100;                  // health score 0-100
int   mlClass = -1;                 // prediksi model: index ke WATER_LABELS (clear / dirty / slightly_turbid), -1 = belum ada
float mlConf = 0;                   // confidence: berapa bagian dari 10 tree yang setuju (0..1)

// State machine ganti air:
// IDLE (diam) -> DRAINING (buang) -> SETTLING (jeda) -> FILLING (isi) -> IDLE
enum State { IDLE, DRAINING, SETTLING, FILLING };
const char* STATE_NAMES[] = {"idle", "draining", "settling", "filling"}; // nama yang dikirim ke dashboard
State state = IDLE;
bool autoMode = false;              // mode otomatis, selalu mati waktu ESP32 baru nyala
int lowCount = 0;                   // berapa kali berturut-turut skor < threshold (buat R1)
int mlDirtyCount = 0;               // berapa kali berturut-turut model yakin airnya dirty (buat R4)
uint32_t stateSince = 0, cooldownUntil = 0; // kapan masuk state sekarang, dan sampai kapan cooldown

// Ini buat testing manual
bool manualDrain = false, manualFill = false; // pompa buang / isi lagi jalan karena tes manual
bool manualToFloat = false;         // tes "sampai float" (bukan tes beberapa detik)
uint32_t manualUntil = 0;           // kapan tes manual harus berhenti
uint32_t manualStart = 0, manualRunMs = 0; // mulai kapan dan berapa lama, buat progress bar OLED

bool drainOn = false, fillOn = false, buzzerOn = false; // status aktuator sekarang

// Buzzer dibunyikan tanpa delay(): beepsLeft = sisa bunyi, beepPhase = lagi nyala/mati,
// beepNext = kapan ganti fase berikutnya
int beepsLeft = 0;
bool beepPhase = false;
uint32_t beepNext = 0;

// Siklus sensor 3 detik dibagi jadi beberapa fase (lihat sensorCycle)
uint32_t cycleStart = 0;            // waktu mulai siklus sekarang
int phase = 0;                      // fase ke berapa di siklus ini

// Gabungin TOPIC_BASE dengan sub-topic, contoh topic("data") -> "iot-project/steven-.../data"
String topic(const char* sub) { return String(TOPIC_BASE) + "/" + sub; }

// Waktu sekarang dalam detik Unix. Kalau jam belum disinkron NTP, kirim 0
// (server nanti pakai jam server sendiri)
uint32_t epochNow() {
  time_t t = time(nullptr);
  bool clockSet = t > 1600000000;   // a date before 2020 means NTP has not answered yet
  return clockSet ? (uint32_t)t : 0;
}

// Nyalain / matiin relay. Modul relay yang dipakai active-low (LOW = nyala),
// jadi kalau RELAY_ACTIVE_LOW true, levelnya dibalik
void relay(int pin, bool on) {
  bool pinHigh = RELAY_ACTIVE_LOW ? !on : on;
  digitalWrite(pin, pinHigh ? HIGH : LOW);
}

// Kirim satu event (pompa nyala/mati, ganti state, fault, dll) ke topic "event" dan ke Serial.
// type = jenis event, name = nama, value = angka, detail = keterangan teks
void publishEvent(const char* type, const char* name, float value, const String& detail) {
  JsonDocument doc;
  doc["ts"] = epochNow();
  doc["type"] = type;
  doc["name"] = name;
  doc["value"] = value;
  doc["detail"] = detail;
  char buf[256];
  size_t n = serializeJson(doc, buf, sizeof(buf));               // ubah jadi teks JSON
  if (mqtt.connected()) mqtt.publish(topic("event").c_str(), (const uint8_t*)buf, n, false); // false = tidak retained
  Serial.printf("[event] %s %s %.2f %s\n", type, name, value, detail.c_str());
}

// Nyalain / matiin pompa buang. "why" = alasan, dikirim sebagai event.
// Pompa buang dan pompa isi tidak boleh nyala bareng, jadi pompa isi dimatikan dulu
void setDrain(bool on, const char* why) {
  if (on == drainOn) return;          // sudah di kondisi itu, tidak usah apa-apa
  if (on && fillOn) {
    fillOn = false;
    relay(PIN_RELAY_FILL, false);
  }
  drainOn = on;
  relay(PIN_RELAY_DRAIN, on);
  publishEvent("actuator", "drain", on ? 1 : 0, why);
}

// Sama seperti setDrain, tapi untuk pompa isi
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

// Minta buzzer bunyi n kali. Bunyinya diatur di updateBuzzer() tiap loop
void beep(int n) {
  beepsLeft = n;
  beepPhase = false;
  beepNext = millis();
}

// Pindah ke state baru, catat waktunya, dan kirim event "state" ke dashboard
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
FloatInput fTop = { PIN_FLOAT_TOP, FLOAT_TOP_TRIGGERED_LEVEL, false, false, 0 }; // float atas (tangki penuh)
FloatInput fBot = { PIN_FLOAT_BOT, FLOAT_BOT_TRIGGERED_LEVEL, false, false, 0 }; // float bawah (tangki rendah)

// Baca satu float dan update status debounce-nya. first = true waktu boot:
// langsung pakai nilai mentah tanpa nunggu debounce
void updateFloat(FloatInput& f, bool first = false) {
  bool raw = digitalRead(f.pin) == f.triggeredLevel; // true = float lagi kepicu
  uint32_t now = millis();

  if (first) {
    f.stable = raw;
    f.candidate = raw;
    f.since = now;
    return;
  }

  if (raw != f.candidate) {
    // Nilai mentah berubah: mulai hitung waktu dari sekarang
    f.candidate = raw;
    f.since = now;
  } else if (raw != f.stable && now - f.since >= FLOAT_DEBOUNCE_MS) {
    // Nilai baru sudah bertahan cukup lama: baru dianggap benar
    f.stable = raw;
  }
}

bool floatTop() { return fTop.stable; } // tank full
bool floatBot() { return fBot.stable; } // tank low

// Median of n samples, so a single noisy sample does not count
// Ambil n sampel dari channel ADS, urutkan (insertion sort), lalu ambil nilai tengah
float readVoltsMedian(int ch, int n = 11) {
  float samples[16];
  if (n > 16) n = 16;                 // array cuma muat 16
  for (int i = 0; i < n; i++) {
    samples[i] = ads.computeVolts(ads.readADC_SingleEnded(ch)); // nilai ADC mentah -> volt
  }

  // Insertion sort: geser nilai yang lebih besar ke kanan sampai posisinya pas
  for (int i = 1; i < n; i++) {
    float value = samples[i];
    int j = i - 1;
    while (j >= 0 && samples[j] > value) {
      samples[j + 1] = samples[j];
      j--;
    }
    samples[j + 1] = value;
  }
  return samples[n / 2];              // nilai tengah = median
}

// Sub-score: 100 at the good value, 0 at the bad value, linear in between
// Contoh TDS: good 300, bad 700 -> 300 ppm = 100, 500 ppm = 50, 700 ppm ke atas = 0
float lin(float v, float good, float bad) {
  float t = (v - good) / (bad - good);   // 0 at good, 1 at bad
  t = constrain(t, 0.0f, 1.0f);          // dibatasi 0..1 biar skor tidak minus / lebih dari 100
  return 100.0f * (1.0f - t);
}

// Hitung health score 0-100 dari rata-rata berbobot:
// TDS 50 %, turbidity 37.5 %, suhu 12.5 %
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
    if (tTank < 24)      tempScore = lin(tTank, 24, 20); // makin dingin makin jelek, 20 C = 0
    else if (tTank > 30) tempScore = lin(tTank, 30, 34); // makin panas makin jelek, 34 C = 0
    else                 tempScore = 100.0f;
    weightedSum += 0.125f * tempScore;
    totalWeight += 0.125f;
  }

  // Dibagi totalWeight: kalau suhu tidak ada, bobot TDS dan turbidity otomatis jadi lebih besar
  return (int)roundf(weightedSum / totalWeight);
}

// Mulai ganti air: masuk DRAINING dan nyalakan pompa buang.
// Kalau tangki sudah rendah (float bawah kepicu), langsung lompat ke SETTLING
void startChange(const char* reason) {
  if (state != IDLE) {
    Serial.println("Change already running");
    return;
  }
  manualDrain = false;                // batalkan tes manual yang mungkin lagi jalan
  manualFill = false;
  enterState(DRAINING, reason);

  if (floatBot()) {
    enterState(SETTLING, "tank already low");
    return;
  }
  setDrain(true, reason);
}

// Stop darurat: matikan kedua pompa, batalkan tes manual, balik ke IDLE
void stopAll(const char* why) {
  setDrain(false, why);
  setFill(false, why);
  manualDrain = false;
  manualFill = false;
  if (state != IDLE) enterState(IDLE, why);
}

// Selesai ganti air: matikan pompa isi, mulai cooldown 30 menit, balik ke IDLE
void finishChange(const char* why) {
  setFill(false, why);
  cooldownUntil = millis() + COOLDOWN_MS;   // R3
  enterState(IDLE, "change done");
  lowCount = 0;                             // hitungan R1 dan R4 dimulai dari nol lagi
  mlDirtyCount = 0;
}

// Pump ran too long without reaching its float (stuck float, dry pump, leak)
// Semua pompa mati, buzzer 5x, mode otomatis dimatikan sampai dicek orang
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

// Dipanggil tiap loop: urus tes pompa manual, lalu jalankan state machine ganti air
void runStateMachine() {
  uint32_t now = millis();

  // --- Tes manual ---
  // (int32_t)(now - manualUntil) >= 0 artinya waktunya sudah lewat; ditulis begini biar
  // tetap benar walaupun millis() overflow (balik ke 0 setelah ~49 hari)
  bool timeUp = (int32_t)(now - manualUntil) >= 0;
  if (manualToFloat && timeUp && (manualDrain || manualFill)) {   // never reached the float
    pumpFault(manualDrain ? "drain timeout" : "fill timeout");
    manualToFloat = false;
  }
  // Tes buang berhenti kalau waktunya habis atau float bawah kepicu
  if (manualDrain && (timeUp || floatBot())) {
    setDrain(false, timeUp ? "manual end: time up" : "manual end: bottom float");
    manualDrain = false;
  }
  // Tes isi berhenti kalau waktunya habis atau float atas kepicu
  if (manualFill && (timeUp || floatTop())) {
    setFill(false, timeUp ? "manual end: time up" : "manual end: top float");
    manualFill = false;
  }
  if (!manualDrain && !manualFill) manualToFloat = false;

  // --- Ganti air otomatis / manual ---
  switch (state) {
    case DRAINING:   // R2: bottom float ends draining
      if (now - stateSince >= DRAIN_TIMEOUT_MS) {   // kelamaan, float bawah tidak pernah kena
        pumpFault("drain timeout");
        break;
      }
      if (floatBot()) {
        setDrain(false, "bottom float");
        enterState(SETTLING, "bottom float reached");
      }
      break;
    case SETTLING:   // jeda SETTLE_MS (3 detik) antara buang dan isi
      if (now - stateSince >= SETTLE_MS) {
        enterState(FILLING, "refill until top float");
        if (floatTop()) finishChange("tank already full");
        else setFill(true, "refill");
      }
      break;
    case FILLING:    // R3: top float ends the refill
      if (now - stateSince >= FILL_TIMEOUT_MS) {    // kelamaan, float atas tidak pernah kena
        pumpFault("fill timeout");
        break;
      }
      if (floatTop()) finishChange("top float");
      break;
    default: break;  // IDLE: tidak ada yang dikerjakan
  }
}

// True kalau prediksi terakhir model adalah "dirty" dan cukup yakin (>= ML_MIN_CONFIDENCE, 60 %)
bool mlSaysDirty() {
  // Tidak ada model, atau index-nya di luar daftar label -> anggap tidak dirty
  if (!WATER_MODEL_AVAILABLE || mlClass < 0 || mlClass >= WATER_MODEL_CLASSES) return false;
  return strcmp(WATER_LABELS[mlClass], "dirty") == 0 && mlConf >= ML_MIN_CONFIDENCE;
}

// R4 (AI rule), or R1 (score rule) without a model: checked once per sensor cycle
// R4: model bilang dirty (yakin >= 60 %) sebanyak ML_DIRTY_READINGS kali berturut-turut -> ganti air.
// R1 (skor < 60 lima kali) cuma dipakai kalau firmware di-compile tanpa model.
void runRules() {
  // A running pump stirs the water, so readings taken while it runs do not count
  if (drainOn || fillOn) {
    lowCount = 0;
    mlDirtyCount = 0;
    return;
  }

  if (score < SCORE_THRESHOLD) lowCount++;
  else lowCount = 0;                  // sekali saja skor bagus, hitungan diulang dari nol

  if (mlSaysDirty()) mlDirtyCount++;
  else mlDirtyCount = 0;              // sekali saja model tidak bilang dirty, hitungan diulang

  bool cooling = (int32_t)(millis() - cooldownUntil) < 0; // masih dalam 30 menit setelah ganti air
  if (!autoMode || state != IDLE || cooling) return;      // syarat dasar belum terpenuhi

  // The model decides. R1 only runs when the firmware is built without a model.
  if (WATER_MODEL_AVAILABLE) {
    if (mlDirtyCount >= ML_DIRTY_READINGS) {
      // value event = confidence, detail contoh: "model predicts dirty (100 %) for 5 readings"
      publishEvent("rule", "R4", mlConf, String("model predicts dirty (") + (int)roundf(mlConf * 100) + " %) for " + ML_DIRTY_READINGS + " readings");
      beep(3);
      startChange("auto R4 (AI)");
    }
  } else if (lowCount >= LOW_READINGS_TO_ACT) {
    publishEvent("rule", "R1", score, String("score below ") + SCORE_THRESHOLD + " for " + LOW_READINGS_TO_ACT + " readings");
    beep(3);
    startChange("auto R1");
  }
}

// Jalankan satu perintah, dari dashboard (MQTT) maupun dari Serial Monitor.
// cmd = nama perintah, arg = angka (detik untuk tes pompa, 1/0 untuk on/off)
void handleCommand(const String& cmd, int arg) {
  if (cmd == "change")        startChange("manual change");  // ganti air sekarang
  else if (cmd == "stop")     stopAll("stop command");       // matikan semua pompa
  else if (cmd == "auto") {                                  // mode otomatis on/off
    autoMode = arg != 0;
    publishEvent("mode", "auto", autoMode, "");
  }
  else if (cmd == "beep")     beep(1);                       // tes buzzer
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
    bool drain = cmd.startsWith("drain");     // true = pompa buang, false = pompa isi
    bool toFloat = cmd.endsWith("_float");    // true = jalan sampai float

    // Refuse a run that would go past a float: no fill when full, no drain when low
    if (!drain && floatTop()) {
      publishEvent("refused", "fill", 0, "top float already reached");
      return;
    }
    if (drain && floatBot()) {
      publishEvent("refused", "drain", 0, "bottom float already reached");
      return;
    }

    // Tentukan berapa lama pompa boleh jalan
    uint32_t runMs;
    const char* why;
    if (toFloat) {
      runMs = drain ? DRAIN_TIMEOUT_MS : FILL_TIMEOUT_MS;   // batas maksimal = timeout (2 menit)
      why = drain ? "manual: drain to bottom float" : "manual: fill to top float";
    } else {
      int seconds = arg > 0 ? min(arg, 30) : 3;            // default 3 detik, paling lama 30
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
    // Berhentinya diurus runStateMachine() (waktu habis / float kena)
  }
  else Serial.printf("Unknown command: %s\n", cmd.c_str());
}

// Dipanggil PubSubClient waktu ada pesan masuk di topic "cmd".
// Contoh pesan: {"cmd":"auto","on":true} atau {"cmd":"drain","sec":3}
void onMqtt(char* t, byte* payload, unsigned int len) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, len)) return;   // JSON rusak -> abaikan
  String cmd = doc["cmd"] | "";                     // | "" = nilai default kalau tidak ada
  // The argument arrives as {"on": true/false} for modes or {"sec": N} for pump tests
  int arg;
  if (doc["on"].is<bool>()) arg = doc["on"].as<bool>() ? 1 : 0;
  else                      arg = doc["sec"] | 0;
  handleCommand(cmd, arg);
}

// Baca teks yang diketik di Serial Monitor, contoh "drain 3" atau "auto on".
// Huruf dikumpulkan sampai Enter (\n), lalu dipecah jadi perintah dan argumen
void handleSerial() {
  static String line;                 // static = isinya tetap ada di panggilan berikutnya
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\r') continue;          // abaikan carriage return
    if (c != '\n') {
      line += c;
      continue;
    }

    // Satu baris lengkap sudah masuk
    line.trim();
    if (line.length()) {
      int space = line.indexOf(' ');
      String cmd = space < 0 ? line : line.substring(0, space);        // kata pertama
      String argText = space < 0 ? "" : line.substring(space + 1);     // sisanya

      int arg;
      if (argText == "on")       arg = 1;
      else if (argText == "off") arg = 0;
      else                       arg = argText.toInt();               // angka, atau 0 kalau kosong
      handleCommand(cmd, arg);
    }
    line = "";
  }
}

uint32_t lastWifiTry = 0, lastMqttTry = 0; // kapan terakhir coba konek

// Reconnects in the background so the loop never blocks
// Wi-Fi dicoba ulang tiap 10 detik, MQTT tiap 5 detik. Tidak ada delay(),
// jadi sensor dan pompa tetap jalan walaupun internet putus
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
    // Client ID harus unik di broker, jadi pakai MAC address ESP32
    String id = "iot-project-" + String((uint32_t)ESP.getEfuseMac(), HEX);
    // Last will: kalau ESP32 putus tiba-tiba, broker sendiri yang kirim "offline" ke topic status
    if (mqtt.connect(id.c_str(), topic("status").c_str(), 1, true, "offline")) {
      mqtt.publish(topic("status").c_str(), "online", true); // retained, jadi dashboard baru langsung tahu
      mqtt.subscribe(topic("cmd").c_str());                   // dengarkan perintah dari dashboard
      Serial.println("MQTT connected");
    } else {
      Serial.printf("MQTT connect failed, state %d\n", mqtt.state());
    }
  }
  mqtt.loop();                        // proses pesan masuk dan jaga koneksi tetap hidup
}

// Readings without a temperature are not sent
// Kirim semua nilai sensor dan status sebagai satu JSON ke topic "data" (tiap 3 detik)
void publishData() {
  if (isnan(tTank)) return;
  JsonDocument doc;
  doc["ts"] = epochNow();
  doc["src"] = "device";                          // pembeda dari data simulator
  doc["t_tank"] = roundf(tTank * 100) / 100;      // dibulatkan 2 desimal
  doc["tds"] = roundf(tdsPpm * 10) / 10;          // 1 desimal
  doc["tds_v"] = roundf(tdsV * 1000) / 1000;      // 3 desimal
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
  // Prediksi model ikut dikirim: ml = label, ml_conf = confidence (dashboard menampilkan keduanya)
  if (WATER_MODEL_AVAILABLE && mlClass >= 0 && mlClass < WATER_MODEL_CLASSES) {
    doc["ml"] = WATER_LABELS[mlClass];
    doc["ml_conf"] = roundf(mlConf * 100) / 100;
  }
  char buf[768];
  size_t n = serializeJson(doc, buf, sizeof(buf));
  if (mqtt.connected()) mqtt.publish(topic("data").c_str(), (const uint8_t*)buf, n, false);
  Serial.println(buf);                            // juga tampil di Serial Monitor
}

// Bunyikan buzzer sesuai antrian beep(): tiap 150 ms ganti nyala/mati, tanpa delay()
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

// Tulis teks di tengah layar (horizontal) di baris y dengan ukuran huruf size
void oledCentered(const char* text, int y, int size) {
  int16_t x1, y1;
  uint16_t w, h;
  oled.setTextSize(size);
  oled.getTextBounds(text, 0, 0, &x1, &y1, &w, &h); // ukur lebar teks
  oled.setCursor((128 - w) / 2, y);
  oled.print(text);
}

// Tulis teks rata kanan di baris y (huruf ukuran 1 = lebar 6 piksel)
void oledRight(const char* text, int y) {
  oled.setTextSize(1);
  oled.setCursor(128 - 6 * strlen(text), y);
  oled.print(text);
}

// Layar utama (waktu tidak ada pompa jalan)
void drawStatusScreen() {
  // Baris atas: mode di kiri, status koneksi di kanan, lalu garis pemisah
  oled.setTextSize(1);
  oled.setCursor(0, 0);
  oled.print(autoMode ? "AUTO" : "MANUAL");
  const char* link = mqtt.connected() ? "online" : (WiFi.status() == WL_CONNECTED ? "no mqtt" : "no wifi");
  oledRight(link, 0);
  oled.drawFastHLine(0, 10, 128, SSD1306_WHITE);

  // Kiri: health score besar
  char buf[16];
  snprintf(buf, sizeof(buf), "%d", score);
  oled.setTextSize(3);
  oled.setCursor(score >= 100 ? 0 : 9, 16);   // angka 3 digit digeser ke kiri biar muat
  oled.print(buf);
  oled.setTextSize(1);
  oled.setCursor(9, 42);
  oled.print("score");

  // Kanan atas: kotak putih berisi prediksi model CLEAR / SLIGHT / DIRTY (teks hitam di atas putih)
  bool hasModel = WATER_MODEL_AVAILABLE && mlClass >= 0 && mlClass < WATER_MODEL_CLASSES;
  oled.fillRoundRect(62, 14, 66, 13, 3, SSD1306_WHITE);
  oled.setTextColor(SSD1306_BLACK);
  oled.setTextSize(1);
  const char* water = hasModel ? WATER_SHORT[mlClass] : "NO MODEL";
  oled.setCursor(62 + (66 - 6 * (int)strlen(water)) / 2, 17);
  oled.print(water);
  oled.setTextColor(SSD1306_WHITE);

  // Kanan bawah: suhu air (--.-C kalau tidak ada)
  if (isnan(tTank)) snprintf(buf, sizeof(buf), "--.-C");
  else              snprintf(buf, sizeof(buf), "%.1fC", tTank);
  oled.setTextSize(2);
  oled.setCursor(66, 32);
  oled.print(buf);

  // Baris bawah: TDS di kiri, turbidity di kanan
  oled.drawFastHLine(0, 52, 128, SSD1306_WHITE);
  oled.setTextSize(1);
  oled.setCursor(0, 56);
  oled.printf("TDS %.0f ppm", tdsPpm);
  snprintf(buf, sizeof(buf), "Turb %.0f%%", turbIdx);
  oledRight(buf, 56);
}

// Layar waktu pompa jalan: ganti air atau tes pompa, lagi ngapain, sampai kapan, sudah berapa lama
void drawPumpScreen() {
  uint32_t now = millis();
  bool waterChange = state != IDLE;                           // ganti air (bukan tes manual)
  bool draining = waterChange ? state == DRAINING : drainOn;
  bool settling = state == SETTLING;

  // Judul di kotak putih paling atas
  oled.fillRect(0, 0, 128, 11, SSD1306_WHITE);
  oled.setTextColor(SSD1306_BLACK);
  oledCentered(waterChange ? "WATER CHANGE" : "PUMP TEST", 2, 1);
  oled.setTextColor(SSD1306_WHITE);

  // Aksi sekarang dengan huruf besar
  const char* action = settling ? "WAITING" : (draining ? "DRAINING" : "FILLING");
  oledCentered(action, 16, 2);

  // Tentukan keterangan "sampai kapan", waktu berjalan, dan batas waktunya
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
  oled.drawRect(0, 45, 128, 7, SSD1306_WHITE);                         // bingkai bar
  int fill = limit ? (int)((uint64_t)elapsed * 124 / limit) : 0;       // panjang isi bar (maks 124 px)
  oled.fillRect(2, 47, fill, 3, SSD1306_WHITE);

  // Baris bawah: detik berjalan di kiri, batas waktu di kanan
  char buf[24];
  oled.setTextSize(1);
  oled.setCursor(0, 56);
  oled.printf("%lu s", (unsigned long)(elapsed / 1000));
  bool floatRun = !settling && (waterChange || manualToFloat);
  snprintf(buf, sizeof(buf), floatRun ? "max %lu s" : "of %lu s", (unsigned long)(limit / 1000));
  oledRight(buf, 56);
}

// Layar pompa dipakai selama ganti air atau ada pompa yang nyala
bool pumpScreenActive() {
  return state != IDLE || drainOn || fillOn;
}

uint32_t oledDrawnAt = 0; // kapan terakhir layar digambar

// Gambar ulang seluruh layar OLED (kalau OLED tidak ketemu, dilewati)
void drawOled() {
  if (!oledOk) return;
  oledDrawnAt = millis();
  oled.clearDisplay();
  oled.setTextColor(SSD1306_WHITE);
  if (pumpScreenActive()) drawPumpScreen();
  else                    drawStatusScreen();
  oled.display();                     // kirim buffer ke layar
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

  // Coba baca maksimal 3 kali
  for (int i = 0; tempCount >= 1 && i < 3; i++) {
    v = temps.getTempC(tempAddr);
    // -127 = no answer, 85 = power-on value before any conversion
    bool valid = v > -55 && v < 125 && v != 85.0f;   // -55..125 = rentang DS18B20
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
// 1.9 s read turbidity, run the model, compute score, run rules
// 3 s (CYCLE_MS) publish
// Tiap panggilan cuma ngecek "sudah waktunya fase berikutnya belum", jadi tidak pernah nunggu
void sensorCycle() {
  uint32_t t = millis() - cycleStart;   // sudah berapa ms sejak siklus mulai
  if (phase == 0) {
    digitalWrite(PIN_TDS_POWER, LOW);   // board TDS dimatikan
    temps.requestTemperatures();        // DS18B20 mulai mengukur (butuh sampai ~750 ms)
    phase = 1;
  } else if (phase == 1 && t >= 1000) {
    readTemperature();
    digitalWrite(PIN_TDS_POWER, HIGH);  // board TDS dinyalakan, tunggu stabil
    phase = 2;
  } else if (phase == 2 && t >= 1800) {
    if (adsOk) {
      tdsV = readVoltsMedian(ADS_CH_TDS);
      // Compensate to 25 C (2 % per degree), then the sensor's standard voltage-to-ppm curve
      float waterTemp = isnan(tTank) ? 25.0f : tTank;   // kalau suhu tidak ada, anggap 25 C
      float v25 = tdsV / (1.0f + 0.02f * (waterTemp - 25.0f));
      float curve = 133.42f * v25 * v25 * v25 - 255.86f * v25 * v25 + 857.39f * v25; // rumus dari pembuat sensor
      tdsPpm = curve * 0.5f * TDS_K;    // 0.5 = faktor TDS standar, TDS_K = kalibrasi pakai TDS pen
    }
    digitalWrite(PIN_TDS_POWER, LOW);
    phase = 3;
  } else if (phase == 3 && t >= 1900) {
    if (adsOk) {
      turbV = readVoltsMedian(ADS_CH_TURB) * DIVIDER_RATIO; // x1.5 balikin pembagi tegangan 10k/20k
      // 0 = as clear as calibration, 100 = TURB_V_SPAN volts darker
      turbIdx = (TURB_V_CLEAR - turbV) / TURB_V_SPAN * 100.0f;
      turbIdx = constrain(turbIdx, 0.0f, 100.0f);
      // Jalankan model di ESP32. Yang dipakai model cuma TDS (ppm) dan tegangan turbidity;
      // mlConf diisi lewat pointer (&mlConf)
      float waterTemp = isnan(tTank) ? 25.0f : tTank;
      mlClass = classifyWaterFromReadings(tdsPpm, tdsV, turbIdx, turbV, waterTemp, &mlConf);
    }
    score = computeScore();
    runRules();
    phase = 4;
  } else if (phase == 4 && t >= CYCLE_MS) {
    publishData();
    drawOled();
    cycleStart = millis();              // mulai siklus berikutnya
    phase = 0;
  }
}

// Jalan sekali waktu ESP32 nyala
void setup() {
  Serial.begin(115200);
  delay(300);
  // Semua output dibuat aman dulu: relay mati, buzzer mati, TDS mati
  pinMode(PIN_RELAY_DRAIN, OUTPUT); relay(PIN_RELAY_DRAIN, false);
  pinMode(PIN_RELAY_FILL, OUTPUT);  relay(PIN_RELAY_FILL, false);
  pinMode(PIN_BUZZER, OUTPUT); digitalWrite(PIN_BUZZER, LOW);
  pinMode(PIN_TDS_POWER, OUTPUT); digitalWrite(PIN_TDS_POWER, LOW);
  // Float pakai pull-up internal, lalu baca posisi awalnya
  pinMode(PIN_FLOAT_TOP, INPUT_PULLUP); pinMode(PIN_FLOAT_BOT, INPUT_PULLUP);
  updateFloat(fTop, true); updateFloat(fBot, true);

  // Scan semua alamat I2C buat cek OLED (0x3C) dan ADS1115 (0x48) ada atau tidak
  Wire.begin(PIN_SDA, PIN_SCL);
  bool foundOled = false, foundAds = false;
  for (uint8_t a = 1; a < 127; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) { if (a == OLED_ADDR) foundOled = true; if (a == ADS_ADDR) foundAds = true; }
  }
  oledOk = foundOled && oled.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR);
  adsOk  = foundAds && ads.begin(ADS_ADDR, &Wire);
  if (adsOk) ads.setGain(GAIN_ONE);   // rentang baca ADS +-4.096 V
  if (oledOk) { oled.setTextColor(SSD1306_WHITE); oled.clearDisplay(); oled.setCursor(0, 0); oled.print("IoT Project"); oled.display(); }

  // DS18B20: cari sensornya dan simpan alamatnya
  temps.begin();
  temps.setWaitForConversion(false);  // requestTemperatures() tidak nunggu 750 ms (non-blocking)
  tempCount = temps.getDeviceCount();
  if (tempCount >= 1 && !temps.getAddress(tempAddr, 0)) tempCount = 0;
  Serial.printf("OLED %s, ADS %s, DS18B20: %d\n", oledOk ? "OK" : "FAIL", adsOk ? "OK" : "FAIL", tempCount);

  // Wi-Fi, jam NTP, dan MQTT (konek-nya sendiri diurus keepConnected di loop)
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  lastWifiTry = millis();
  configTime(7 * 3600, 0, "pool.ntp.org", "time.google.com");   // WIB
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setBufferSize(1024);           // default 256 byte terlalu kecil buat JSON data
  mqtt.setCallback(onMqtt);           // fungsi yang dipanggil kalau ada perintah masuk

  Serial.println("Commands: change | stop | auto on/off | beep | drain 3 | fill 3 | drain_float | fill_float");
  cycleStart = millis();
}

// Jalan terus-menerus. Semua fungsi di sini cepat (tanpa delay panjang),
// jadi float, perintah, dan buzzer langsung bereaksi
void loop() {
  updateFloat(fTop); updateFloat(fBot); // baca float tiap loop
  keepConnected();                      // jaga Wi-Fi dan MQTT
  handleSerial();                       // perintah dari Serial Monitor
  runStateMachine();                    // pompa dan ganti air
  sensorCycle();                        // baca sensor tiap 3 detik
  updateBuzzer();                       // bunyi buzzer
  // The pump screen counts seconds, so redraw it more often than once per sensor cycle
  if (pumpScreenActive() && millis() - oledDrawnAt >= 500) drawOled();
}
