# IoT Project: kode lengkap

Paket ini berisi semua kode untuk Assignment 2 dan tahap AI (AOL):

```
iot/
├─ firmware/iot_project/    Firmware ESP32 (sensor, skor, aturan otomatis, MQTT)
│   ├─ iot_project.ino
│   └─ config.h             SEMUA pengaturan dan kalibrasi ada di sini
├─ server/                  Next.js full-stack (React + API): MQTT -> PostgreSQL, dashboard, ekspor CSV
│   ├─ app/                 Halaman (dashboard, login) dan API (app/api/*/route.ts)
│   ├─ components/          Komponen React (Dashboard, LoginForm)
│   ├─ lib/                 Database, MQTT ingest, login
│   ├─ instrumentation.ts   Menyalakan koneksi MQTT dan database saat server start
│   └─ tools/simulate.js    ESP32 palsu untuk tes tanpa hardware
├─ nodered/                 Dashboard Node-RED (Dashboard 2.0) dari topik MQTT yang sama
└─ ml/                      Machine learning (Python)
    ├─ train_classifier.py  Klasifikasi kondisi air: clear / slightly_turbid / dirty
    ├─ anomaly_detection.py Deteksi anomali sensor
    └─ predict_live.py      Prediksi langsung, hasilnya tampil di dashboard
```

## Kesesuaian dengan aturan tugas

| Persyaratan | Di kode |
|---|---|
| ESP32, minimal 3 sensor | DS18B20 (suhu), TDS, turbidity (+ volume buang perkiraan) |
| Minimal 2 aktuator, rule-based | Pompa buang dan pompa isi (relay), buzzer, dan OLED. Aturan R1 (skor < 60 tiga kali → ganti air 10/20/30%), R2 (selisih suhu), R3 (volume), R7 (timeout 3 menit), R10 (cooldown) |
| MQTT | `TOPIC_BASE/data` tiap 5 detik, `/event`, `/cmd`, `/status` |
| Penyimpanan terus-menerus | PostgreSQL: tabel `readings` dan `events` |
| Dashboard | Nilai live, status aktuator, grafik riwayat, tombol kontrol, log event. Ada juga dashboard Node-RED di `nodered/` |
| Dataset minimal 1.000 baris | Ekspor CSV dari dashboard. 1.000 baris = sekitar 83 menit logging |

## 1. Firmware ESP32

**Library** (Arduino IDE → Library Manager): Adafruit SSD1306, Adafruit GFX, Adafruit BusIO,
Adafruit ADS1X15, OneWire (Paul Stoffregen), DallasTemperature (Miles Burton),
PubSubClient (Nick O'Leary), ArduinoJson (Benoit Blanchon, versi 7).

**Board:** ESP32 Dev Module (core esp32 by Espressif 3.x).

**Langkah:**
1. Buka `firmware/iot_project/iot_project.ino` (folder `iot_project` harus berisi `iot_project.ino` dan `config.h`).
2. Di `config.h` isi `WIFI_SSID`, `WIFI_PASS`. `TOPIC_BASE` boleh dibiarkan, asal sama dengan server.
3. Cek nilai kalibrasi: `TURB_V_CLEAR` (tegangan turbidity di air bening), `DRAIN_ML_PER_SEC` (15,8 dari tes Anda),
   `FILL_ML_PER_SEC` (ukur pompa isi dengan cara yang sama), `TANK_WATER_ML` (volume air di bak).
4. Upload, buka Serial Monitor 115200, akhir baris **Newline**.

**Pin** (sama dengan sketch tes terakhir): OLED/ADS1115 SDA D21, SCL D22 · DS18B20 D4 · daya TDS D13 ·
TDS → ADS A0 · turbidity → pembagi 10k/20k → ADS A1 · relay pompa buang D26, pompa isi D25 · buzzer D33.
pH dan float switch dimatikan (`USE_PH false`, `USE_FLOATS false`).

**Perintah Serial** (juga bisa dari dashboard):
`change 20` · `stop` · `reset` · `auto on` / `auto off` · `demo on` / `demo off` · `beep` · `drain 3` · `fill 3`

**Mode demo** memperpendek cooldown jadi 60 detik dan penundaan suhu jadi 30 detik, cocok untuk presentasi.

## 2. Server dan dashboard

Server memakai **PostgreSQL**. Cara paling mudah menjalankan server + database sekaligus adalah Docker:

```bash
cp .env.example .env      # isi DB_PASSWORD dan DASHBOARD_PASSWORD
docker compose up -d --build
```

Buka **http://localhost:7575**. Laptop cukup terhubung internet; tidak harus satu Wi-Fi dengan ESP32.

Tanpa Docker (butuh Node.js 20.9+ dan PostgreSQL yang sudah terpasang):

```bash
cd server
npm install
PGHOST=localhost PGUSER=iot_project PGPASSWORD=... PGDATABASE=iot_project npm run dev
```
Lalu buka http://localhost:3000. Tabel dibuat otomatis saat server pertama kali jalan.
Untuk mode produksi: `npm run build` lalu `npm start`.

Server ini harus berjalan terus (koneksi MQTT selalu tersambung), jadi jalankan di server sendiri
atau Docker, bukan di platform serverless seperti Vercel.

Tes tanpa hardware (data ditandai `sim` dan tidak ikut di CSV device):

```bash
npm run sim
```

Kalau Wi-Fi kampus memblokir MQTT (port 1883), pakai hotspot HP untuk ESP32 dan laptop.

## 2b. Dashboard Node-RED

Flow di `nodered/flows.json` subscribe ke `TOPIC_BASE/data` dan `/status` di broker.hivemq.com, lalu menampilkan gauge (skor, TDS, turbidity, suhu), status pompa, grafik 1 jam terakhir, dan tombol perintah (ganti air 20%, stop, reset, tes buzzer, mode auto) yang dikirim ke `TOPIC_BASE/cmd`. Firmware tidak perlu diubah, dan bisa jalan bersamaan dengan dashboard Next.js.

Butuh Node.js 18 atau lebih baru:

```bash
cd nodered
npm install
npm start
```

Buka http://localhost:1880/dashboard untuk dashboard, dan http://localhost:1880 untuk editor flow. Kalau `TOPIC_BASE` di `config.h` diganti, ganti juga topiknya di node `data`, `status` dan `cmd`.

## 3. Mengumpulkan dataset

1. Jalankan server, nyalakan ESP32. Titik "ESP32" dan "Live data" di dashboard harus hijau.
2. Biarkan berjalan minimal 83 menit untuk 1.000 baris (kartu **Dataset** menghitungnya).
3. Klik **Download CSV (device)**. File ini yang dilampirkan di laporan.

### Data berlabel untuk ML
Pilih label di kartu **Condition label** sebelum merekam tiap jenis air. Setiap baris baru disimpan dengan label itu.

| Label | Cara membuat air | Lama rekam |
|---|---|---|
| `clear` | air keran bersih | 10–15 menit |
| `slightly_turbid` | beberapa tetes susu atau sedikit tanah | 10–15 menit |
| `dirty` | lebih banyak susu/tanah + sejumput garam | 10–15 menit |

Tips: ulangi tiap kondisi 2–3 kali di waktu berbeda supaya model tidak hanya menghafal satu sesi.
Matikan pompa saat merekam (baris saat pompa jalan otomatis dibuang).

## 4. Machine learning

```bash
cd ml
pip install -r requirements.txt
python train_classifier.py --csv iot_project_dataset_2026-11-01.csv
python anomaly_detection.py --csv iot_project_dataset_2026-11-01.csv
python predict_live.py            # server harus jalan; hasil tampil di kartu "AI prediction"
```

**train_classifier.py** membandingkan Decision Tree, k-NN, Logistic Regression, dan Random Forest dengan
fitur TDS dan turbidity. Data dibagi per label berdasarkan waktu (awal untuk latih, akhir untuk uji) supaya
pembacaan yang hampir sama tidak bocor ke data uji. Hasil di `ml/results/`:
`metrics.md` (tabel akurasi dan F1, siap ditempel ke laporan), `confusion_matrix.png`,
`feature_importance.png`, `decision_tree_rules.txt`. Model terbaik disimpan di `ml/models/`.

### Model di ESP32 (decision tree)
Selain lewat laptop, model bisa jalan langsung di ESP32 sehingga tetap bekerja tanpa Wi-Fi:

```bash
cd ml
python export_tree.py --csv iot_project_dataset_2026-11-01.csv
```

Skrip ini melatih decision tree (fitur TDS dan turbidity, kedalaman maksimal 4), menampilkan akurasi
di data uji, lalu menulis `firmware/iot_project/water_model.h` berisi aturan `if-else`. Upload ulang firmware.
ESP32 lalu menampilkan hasilnya di OLED (CLEAR / SLIGHT / DIRTY), mengirimnya di kolom `ml` lewat MQTT,
dan dashboard menampilkannya di kartu "AI prediction". Kolom `ml` juga ikut di CSV.

Sebelum model dibuat, `water_model.h` berisi placeholder sehingga firmware tetap bisa di-compile.
Latih dan ekspor ulang setiap kali sensor dikalibrasi ulang.

**anomaly_detection.py** menandai nilai di luar rentang, sensor yang nyangkut (nilai sama persis 2 menit),
lonjakan mendadak, dan pembacaan aneh menurut Isolation Forest. Hasil: `results/anomalies.csv` dan `anomalies.png`.

## 5. Deploy dashboard ke server (Docker)

Mengikuti pola repo `stevenlie` dan `serverh1`: GitHub Actions di runner `shin` membangun image,
push ke Harbor, lalu `docker compose up` di server. Nginx + SSL dibuat lewat repo `ansible-infrastructure`.

File yang dipakai: `Dockerfile`, `docker-compose.yml`, `.github/workflows/deploy.yml`.
Ada dua container: `iot-project` (Next.js di Node 26, port **7575**) dan `iot-project-db` (PostgreSQL 17, tidak dibuka ke luar).
Data database tersimpan di volume Docker `iot_project_pg`.

### Langkah sekali saja
1. Kode ada di repo **`StevenLie14/IoT`**. Deploy berjalan saat ada push ke branch `main`.
2. Di `ansible-infrastructure/.env`: set `GITHUB_REPO_URL=https://github.com/StevenLie14/IoT`, lalu jalankan
   `--tags runner` (daftarkan runner `shin` ke repo ini) dan `--tags secret` (REGISTRY_* dan VAULT_*).
3. Di Vault, di path `VAULT_PATH` untuk repo ini, simpan `DB_PASSWORD` dan `DASHBOARD_PASSWORD` (wajib),
   dan opsional `DB_USER`, `DB_NAME`, `DASHBOARD_USER`, `MQTT_URL`, `TOPIC_BASE`.
4. Buat DNS A record, misalnya `iot.stevenlie.site`, ke IP server.
5. Di `ansible-infrastructure/inventory/host_vars/nginx.yml`: `domain_name: "iot.stevenlie.site"`,
   `frontend_port: 7575`, `has_backend: false`, lalu jalankan `--tags nginx`.

Setelah itu setiap push ke `main` otomatis build dan deploy. Buka `https://iot.stevenlie.site`
dan login dengan `DASHBOARD_USER` (bawaan `admin`) dan `DASHBOARD_PASSWORD`.
Halaman login muncul otomatis. Sesi berlaku 7 hari, dan mengganti `DASHBOARD_PASSWORD` membuat semua sesi keluar.
Setelah 10 kali password salah dari satu alamat IP, login dikunci 15 menit.

Prediksi live dari laptop ke server online:
`python predict_live.py --server https://iot.stevenlie.site --user admin --password <password>`

### Jalankan dengan Docker di komputer sendiri
```bash
cp .env.example .env      # isi DB_PASSWORD dan DASHBOARD_PASSWORD
docker compose up -d --build
```
Buka http://localhost:7575.

**Tanpa `DASHBOARD_PASSWORD`, dashboard tidak punya login dan siapa pun bisa menyalakan pompa.**
Selalu isi password kalau dashboard bisa diakses dari internet.

## Status pengujian

- Server, dashboard, simulator, dan aturan otomatis (di simulator) sudah diuji jalan.
- Skrip ML sudah diuji dengan data sintetis untuk memastikan berjalan. Angka akurasi untuk laporan harus dari data asli Anda.
- Image Docker sudah diuji jalan (login, data tetap ada setelah restart, health check).
- Firmware **belum di-compile**; compile dan uji di Arduino IDE Anda.
