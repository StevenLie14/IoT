import argparse
import os

import joblib
from micromlgen import port

# Untuk generate code c++ dari joblib yg dh disimpen

SHORT = {"clear": "CLEAR", "slightly_turbid": "SLIGHT", "dirty": "DIRTY"} 
HERE = os.path.dirname(os.path.abspath(__file__))
OUT_FILE = os.path.join(HERE, "..", "firmware", "iot_project", "water_model.h")


parser = argparse.ArgumentParser()
parser.add_argument("--model", default=os.path.join(HERE, "models", "random_forest.joblib"),
                    help="model yang disimpan notebook (bagian 10)")
args = parser.parse_args()

# Load model dari notebook
saved = joblib.load(args.model)
model = saved["model"]

assert saved["features"] == ["tds", "turb_v"], saved["features"]
trees = len(model.estimators_)

classes = list(model.classes_)
code = port(model, classmap=dict(enumerate(classes)))
assert code.count("return classIdx;") == 1 and code.count("public:") == 1
code = code.replace("return classIdx;", "lastVotes = maxVotes;\n                        return classIdx;")
code = code.replace("public:", "public:\n                    float lastVotes = 0;", 1)
labels_c = ", ".join(f'"{c}"' for c in classes)
short_c = ", ".join(f'"{SHORT[c]}"' for c in classes)

header = f"""
// DO NOT EDIT: code ini hasil dari ml/export_tree.py
{code.strip()}

#define WATER_MODEL_AVAILABLE 1
#define WATER_MODEL_CLASSES {len(classes)}

static const char* const WATER_LABELS[] = {{{labels_c}}};
static const char* const WATER_SHORT[]  = {{{short_c}}};

#define WATER_MODEL_TREES {trees}

// function ini panggil dari main ino file yang return WATER LABELS dengan confidence (vote tiap tree)
inline int classifyWaterFromReadings(float tds, float tds_v, float turb, float turb_v, float t_tank, float* confidence) {{
  (void)tds_v; (void)turb; (void)t_tank;  // ga dipakai model
  static Eloquent::ML::Port::RandomForest model;
  float x[] = {{tds, turb_v}};
  int classIdx = model.predict(x);
  if (confidence) *confidence = model.lastVotes / WATER_MODEL_TREES;
  return classIdx;
}}
"""

with open(OUT_FILE, "w", newline="\n") as f:
    f.write(header)
print("Model disimpan ke", os.path.normpath(OUT_FILE))
