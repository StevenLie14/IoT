"""
Train Random Forest buat klasifikasi air (clear / slightly_turbid / dirty),
terus export ke C++ pakai micromlgen biar bisa jalan langsung di ESP32.

Cara pakai:
    python export_tree.py --csv data/iot_project_dataset_2026-11-04.csv

Hasilnya ke firmware/iot_project/water_model.h, habis itu tinggal upload ulang firmware.
"""
import argparse
import os

import numpy as np
import pandas as pd
from micromlgen import port
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, classification_report

FEATURES = ["tds", "turb_v"]
LABELS = ["clear", "slightly_turbid", "dirty"]
SHORT = {"clear": "CLEAR", "slightly_turbid": "SLIGHT", "dirty": "DIRTY"}  # buat OLED
OUT_FILE = os.path.join(os.path.dirname(__file__), "..", "firmware", "iot_project", "water_model.h")


def split_by_time(df, test_size):
    # Data tiap label itu 1 sesi rekaman, baris yang deket hampir sama semua.
    # Jadi jangan random split: ambil bagian awal buat train, bagian akhir buat test.
    train, test = [], []
    for _, group in df.groupby("label"):
        cut = int(len(group) * (1 - test_size))
        train.append(group[:cut])
        test.append(group[cut:])
    return pd.concat(train), pd.concat(test)


def predict_esp32(model, X):
    # Di kode micromlgen tiap tree kasih 1 vote, yang paling banyak menang.
    # sklearn pakai rata-rata probabilitas, jadi kita hitung ulang biar sama kayak di ESP32.
    votes = np.zeros((len(X), len(model.classes_)))
    for tree in model.estimators_:
        pred = tree.predict(X).astype(int)
        votes[np.arange(len(X)), pred] += 1
    return model.classes_[votes.argmax(axis=1)]


parser = argparse.ArgumentParser()
parser.add_argument("--csv", required=True)
parser.add_argument("--trees", type=int, default=10)
parser.add_argument("--depth", type=int, default=3)
parser.add_argument("--test-size", type=float, default=0.2)
args = parser.parse_args()

# Load data
df = pd.read_csv(args.csv)
df = df.dropna(subset=FEATURES + ["label"])
df["timestamp_wib"] = pd.to_datetime(df["timestamp_wib"])
df = df.sort_values("timestamp_wib")
print("Jumlah data:", len(df))
print(df["label"].value_counts(), "\n")

# Cek akurasi dulu pakai split 80/20
train, test = split_by_time(df, args.test_size)
model = RandomForestClassifier(n_estimators=args.trees, max_depth=args.depth, random_state=42)
model.fit(train[FEATURES].values, train["label"])
pred = predict_esp32(model, test[FEATURES].values)
accuracy = accuracy_score(test["label"], pred)
print(f"Train: {len(train)}  Test: {len(test)}")
print(f"Akurasi test: {accuracy:.3f}")
print(classification_report(test["label"], pred, labels=LABELS))

# Model final dilatih pakai semua data
X = df[FEATURES].values
model = RandomForestClassifier(n_estimators=args.trees, max_depth=args.depth, random_state=42)
model.fit(X, df["label"])
match = (predict_esp32(model, X) == model.predict(X)).mean()
print(f"Hasil vote ESP32 sama dengan sklearn: {match:.1%}")
for name, value in zip(FEATURES, model.feature_importances_):
    print(f"Importance {name}: {value:.2f}")

# Export ke C++
classes = list(model.classes_)
code = port(model, classmap=dict(enumerate(classes)))
labels_c = ", ".join(f'"{c}"' for c in classes)
short_c = ", ".join(f'"{SHORT[c]}"' for c in classes)
nodes = sum(tree.tree_.node_count for tree in model.estimators_)

header = f"""// Model kualitas air untuk ESP32, dibuat otomatis oleh ml/export_tree.py (micromlgen).
// Jangan diedit manual, train ulang aja kalau datanya berubah.
// Random Forest {args.trees} tree, depth {args.depth}, {nodes} node, {len(df)} data
// Input: x[0] = tds, x[1] = turb_v | akurasi test: {accuracy:.3f}
{code.strip()}

#define WATER_MODEL_AVAILABLE 1
#define WATER_MODEL_CLASSES {len(classes)}

static const char* const WATER_LABELS[] = {{{labels_c}}};
static const char* const WATER_SHORT[]  = {{{short_c}}};

// Dipanggil dari iot_project.ino, return index ke WATER_LABELS
inline int classifyWaterFromReadings(float tds, float tds_v, float turb, float turb_v, float t_tank) {{
  (void)tds_v; (void)turb; (void)t_tank;  // ga dipakai model
  static Eloquent::ML::Port::RandomForest model;
  float x[] = {{tds, turb_v}};
  return model.predict(x);
}}
"""

with open(OUT_FILE, "w", newline="\n") as f:
    f.write(header)
print("Model disimpan ke", os.path.normpath(OUT_FILE))
