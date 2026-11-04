"""Train a tree model on the IoT Project dataset and export it as C code for the ESP32.

The model comparison and EDA live in water_quality_models.ipynb; this script only builds
the model that goes into the firmware.

Two models are supported:
  forest (default): a small Random Forest, every tree becomes a C function and the trees vote
  tree            : a single decision tree, easiest to read

The model becomes plain if-else statements in firmware/iot_project/water_model.h, so the
ESP32 classifies the water itself (no Wi-Fi or laptop needed).

Usage:
    python export_tree.py --csv data.csv
    python export_tree.py --csv data.csv --trees 10 --max-depth 3 --features tds turb_v
    python export_tree.py --csv data.csv --model tree --max-depth 3

Then upload the firmware again (the header is picked up automatically).
Retrain and export again whenever the sensors are re-calibrated.
"""
import argparse
import os
import sys

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, classification_report
from sklearn.tree import DecisionTreeClassifier, _tree, export_text

LABEL_ORDER = ["clear", "slightly_turbid", "dirty"]


def load(path, features, include_sim=False):
    """Reads the dashboard CSV and keeps labelled readings with all chosen features.
    Older exports with pump or source columns are filtered the same way the dashboard does now."""
    df = pd.read_csv(path)
    missing = [c for c in features + ["label", "timestamp_wib"] if c not in df.columns]
    if missing:
        sys.exit(f"CSV is missing columns: {missing}")
    if not include_sim and "source" in df.columns:
        df = df[df["source"] == "device"]
    for c in ("drain", "fill"):
        if c in df.columns:
            df = df[df[c].fillna(0) == 0]
    df = df.dropna(subset=["label"] + features)
    df["time"] = pd.to_datetime(df["timestamp_wib"])
    return df.sort_values("time").reset_index(drop=True)


def time_split(df, test_frac):
    """Per label: first part of the recording for training, the last part for testing.
    Neighbouring readings are almost identical, so a random split would leak test data into training."""
    train, test = [], []
    for _, g in df.groupby("label"):
        cut = int(len(g) * (1 - test_frac))
        train.append(g.iloc[:cut])
        test.append(g.iloc[cut:])
    return pd.concat(train), pd.concat(test)

# Dataset column -> firmware argument of classifyWaterFromReadings()
FIRMWARE_ARGS = ["tds", "tds_v", "turb", "turb_v", "t_tank"]
DEFAULT_OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "firmware", "iot_project", "water_model.h")
SHORT_NAMES = {"clear": "CLEAR", "slightly_turbid": "SLIGHT", "dirty": "DIRTY"}   # fits on the OLED


def leaf_shares(tree, i):
    """Class shares (summing to 1) of the training rows that ended in leaf i."""
    counts = tree.value[i][0]
    return counts / counts.sum()


def tree_to_c(tree, classes, features, leaf, indent="  "):
    """Turns one sklearn tree into nested C if-else lines. `leaf(shares, pad)` writes each leaf."""
    lines = []

    def node(i, depth):
        pad = indent * depth
        if tree.feature[i] == _tree.TREE_UNDEFINED:
            lines.extend(leaf(leaf_shares(tree, i), pad))
            return
        name, thr = features[tree.feature[i]], float(tree.threshold[i])
        lines.append(f"{pad}if ({name} <= {thr:.6f}f) {{")
        node(tree.children_left[i], depth + 1)
        lines.append(f"{pad}}} else {{")
        node(tree.children_right[i], depth + 1)
        lines.append(f"{pad}}}")

    node(0, 1)
    return "\n".join(lines)


def single_tree_body(clf, features):
    """C body for one decision tree: each leaf returns its most common class."""
    def leaf(shares, pad):
        cls = int(np.argmax(shares))
        return [f"{pad}return {cls};  // {clf.classes_[cls]} ({shares[cls]:.0%} of training rows here)"]
    return "", tree_to_c(clf.tree_, clf.classes_, features, leaf)


def forest_body(clf, features):
    """C code for a Random Forest: one function per tree adds its class shares to votes[],
    then the class with the highest total wins (the same soft vote sklearn uses)."""
    n = len(clf.classes_)

    def leaf(shares, pad):
        adds = " ".join(f"votes[{c}] += {s:.4f}f;" for c, s in enumerate(shares) if s > 0)
        return [f"{pad}{adds}"]

    functions = []
    for k, est in enumerate(clf.estimators_):
        body = tree_to_c(est.tree_, clf.classes_, features, leaf)
        functions.append(
            f"static inline void waterTree{k}(float* votes, float tds, float tds_v, float turb, float turb_v, float t_tank) {{\n"
            f"  (void)tds; (void)tds_v; (void)turb; (void)turb_v; (void)t_tank;\n{body}\n}}\n")

    calls = "\n".join(f"  waterTree{k}(votes, tds, tds_v, turb, turb_v, t_tank);" for k in range(len(clf.estimators_)))
    body = (f"  float votes[{n}] = {{0}};\n{calls}\n"
            f"  int best = 0;\n"
            f"  for (int c = 1; c < {n}; c++) {{\n"
            f"    if (votes[c] > votes[best]) best = c;\n"
            f"  }}\n"
            f"  return best;")
    return "\n".join(functions), body


def forest_predict_like_c(clf, X):
    """Runs the same soft vote as the generated C, to check the export matches sklearn."""
    votes = np.zeros((len(X), len(clf.classes_)))
    for est in clf.estimators_:
        leaves = est.apply(X)
        votes += np.array([leaf_shares(est.tree_, i) for i in leaves])
    return clf.classes_[np.argmax(votes, axis=1)]


def make_model(a):
    """The model chosen on the command line, not trained yet."""
    if a.model == "tree":
        return DecisionTreeClassifier(max_depth=a.max_depth, random_state=42)
    return RandomForestClassifier(n_estimators=a.trees, max_depth=a.max_depth, random_state=42)


def main():
    """Trains the model, prints its accuracy and writes firmware/iot_project/water_model.h."""
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--csv", required=True)
    ap.add_argument("--model", choices=["forest", "tree"], default="forest")
    ap.add_argument("--trees", type=int, default=10, help="number of trees (forest only)")
    ap.add_argument("--max-depth", type=int, default=3)
    ap.add_argument("--features", nargs="+", default=["tds", "turb_v"])
    ap.add_argument("--test-frac", type=float, default=0.25)
    ap.add_argument("--include-sim", action="store_true", help="also use simulator rows (pipeline test only)")
    ap.add_argument("--out", default=DEFAULT_OUT)
    a = ap.parse_args()

    bad = [f for f in a.features if f not in FIRMWARE_ARGS]
    if bad:
        sys.exit(f"The ESP32 only has these values: {FIRMWARE_ARGS}. Not available: {bad}")

    df = load(a.csv, a.features, a.include_sim)
    counts = df["label"].value_counts()
    if len(counts) < 2 or counts.min() < 20:
        sys.exit("Need at least 2 labels with 20+ rows each.")
    train, test = time_split(df, a.test_frac)

    # Check accuracy on held-out data first, then train the final model on everything
    check = make_model(a).fit(train[a.features], train["label"])
    pred = check.predict(test[a.features])
    accuracy = accuracy_score(test["label"], pred)
    labels = [l for l in LABEL_ORDER if l in counts.index] + [l for l in counts.index if l not in LABEL_ORDER]
    print(f"Test accuracy (time-ordered split): {accuracy:.3f}")
    print(classification_report(test["label"], pred, labels=labels, zero_division=0))

    clf = make_model(a).fit(df[a.features], df["label"])
    classes = list(clf.classes_)
    short = [SHORT_NAMES.get(c, c.upper()[:6]) for c in classes]

    if a.model == "forest":
        same = (forest_predict_like_c(clf, df[a.features].values) == clf.predict(df[a.features])).mean()
        if same < 1:
            sys.exit(f"Export check failed: C vote matches sklearn on only {same:.1%} of rows.")
        helpers, body = forest_body(clf, a.features)
        nodes = sum(t.tree_.node_count for t in clf.estimators_)
        model_line = f"Random Forest, {a.trees} trees, max depth {a.max_depth}, {nodes} nodes"
    else:
        helpers, body = single_tree_body(clf, a.features)
        model_line = f"Decision tree, max depth {a.max_depth}, {clf.tree_.node_count} nodes"

    header = f"""// Water-condition model for the ESP32.
// Generated by ml/export_tree.py from {os.path.basename(a.csv)} - do not edit by hand.
// {model_line}
// Features: {', '.join(a.features)} | {len(df)} training rows
// Held-out accuracy: {accuracy:.3f}
#pragma once

#define WATER_MODEL_AVAILABLE 1
#define WATER_MODEL_CLASSES {len(classes)}

static const char* const WATER_LABELS[] = {{{', '.join(f'"{c}"' for c in classes)}}};
static const char* const WATER_SHORT[]  = {{{', '.join(f'"{s}"' for s in short)}}};

{helpers}
// Returns an index into WATER_LABELS.
inline int classifyWaterFromReadings(float tds, float tds_v, float turb, float turb_v, float t_tank) {{
  (void)tds; (void)tds_v; (void)turb; (void)turb_v; (void)t_tank;
{body}
}}
"""
    with open(a.out, "w", newline="\n") as f:
        f.write(header)

    if a.model == "tree":
        print("Tree rules:\n" + export_text(clf, feature_names=list(a.features)))
    else:
        print(f"{model_line}. The C vote matches sklearn on every training row.")
        print("Feature importance: " + ", ".join(f"{f} {v:.2f}" for f, v in zip(a.features, clf.feature_importances_)))
    print(f"Wrote {os.path.normpath(a.out)}")


if __name__ == "__main__":
    main()
