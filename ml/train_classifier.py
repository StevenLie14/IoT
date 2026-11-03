"""Train a water-condition classifier (clear / slightly_turbid / dirty) from the IoT Project dataset.

Input : the CSV exported from the dashboard (Download CSV), with a `label` column that you
        set on the dashboard while testing each kind of water.
Output: models/water_condition_model.joblib  (best model + feature list)
        results/metrics.md, results/confusion_matrix.png, results/feature_importance.png,
        results/decision_tree_rules.txt

Usage:
    python train_classifier.py --csv iot_project_dataset.csv
    python train_classifier.py --csv data.csv --features tds turb t_tank

Default features are tds and turb. Temperature is left out on purpose: it does not decide how
dirty the water is (TDS is already temperature-compensated), and if each label was recorded at a
different room temperature the model would learn the temperature instead of the water condition.

Only rows with source = device are used, so simulator rows never end up in the model.
"""
import argparse
import os
import sys

import joblib
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (ConfusionMatrixDisplay, accuracy_score, classification_report,
                             confusion_matrix, f1_score)
from sklearn.neighbors import KNeighborsClassifier
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.tree import DecisionTreeClassifier, export_text

LABEL_ORDER = ["clear", "slightly_turbid", "dirty"]


def load(path, features, include_sim):
    """Reads the dashboard CSV and keeps only labelled device readings taken while no pump runs."""
    df = pd.read_csv(path)
    missing = [c for c in features + ["label", "timestamp_wib"] if c not in df.columns]
    if missing:
        sys.exit(f"CSV is missing columns: {missing}")
    if not include_sim and "source" in df.columns:
        df = df[df["source"] == "device"]
    df = df.dropna(subset=["label"] + features)
    # Readings taken while a pump runs are disturbed (bubbles), so leave them out
    for c in ("drain", "fill"):
        if c in df.columns:
            df = df[df[c].fillna(0) == 0]
    df["time"] = pd.to_datetime(df["timestamp_wib"])
    return df.sort_values("time").reset_index(drop=True)


def time_split(df, test_frac):
    """Per label: first part of the recording for training, the last part for testing.
    Consecutive readings are almost identical, so a random split would leak test data into training."""
    train, test = [], []
    for _, g in df.groupby("label"):
        cut = int(len(g) * (1 - test_frac))
        train.append(g.iloc[:cut])
        test.append(g.iloc[cut:])
    return pd.concat(train), pd.concat(test)


def main():
    """Trains and compares the models, then saves the best one with its metrics and plots."""
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--csv", required=True, help="dataset CSV exported from the dashboard")
    ap.add_argument("--features", nargs="+", default=["tds", "turb"])
    ap.add_argument("--test-frac", type=float, default=0.25)
    ap.add_argument("--include-sim", action="store_true", help="also use simulator rows (pipeline test only)")
    ap.add_argument("--out", default=".", help="folder for models/ and results/")
    a = ap.parse_args()

    df = load(a.csv, a.features, a.include_sim)
    if a.include_sim:
        print("WARNING: simulator rows included. Use this only to test the pipeline, not for the report.\n")
    counts = df["label"].value_counts()
    print("Rows per label:\n" + counts.to_string() + "\n")
    if len(counts) < 2 or counts.min() < 20:
        sys.exit("Need at least 2 labels with 20+ rows each. Collect more labelled data on the dashboard.")

    labels = [l for l in LABEL_ORDER if l in counts.index] + [l for l in counts.index if l not in LABEL_ORDER]
    train, test = time_split(df, a.test_frac)
    Xtr, ytr, Xte, yte = train[a.features], train["label"], test[a.features], test["label"]
    print(f"Train rows: {len(train)}, test rows: {len(test)}  (time-ordered split per label)\n")

    models = {
        "Decision Tree": DecisionTreeClassifier(max_depth=4, random_state=42),
        "k-NN (k=5)": make_pipeline(StandardScaler(), KNeighborsClassifier(n_neighbors=5)),
        "Logistic Regression": make_pipeline(StandardScaler(), LogisticRegression(max_iter=1000)),
        "Random Forest": RandomForestClassifier(n_estimators=200, max_depth=6, random_state=42),
    }
    rows, fitted = [], {}
    for name, m in models.items():
        m.fit(Xtr, ytr)
        p = m.predict(Xte)
        rows.append((name, accuracy_score(yte, p), f1_score(yte, p, average="macro")))
        fitted[name] = m
    res = pd.DataFrame(rows, columns=["model", "accuracy", "macro_f1"]).sort_values("macro_f1", ascending=False)
    print(res.to_string(index=False, float_format=lambda v: f"{v:.3f}") + "\n")

    best_name = res.iloc[0]["model"]
    best = fitted[best_name]
    pred = best.predict(Xte)
    report = classification_report(yte, pred, labels=labels, zero_division=0)
    print(f"Best model: {best_name}\n{report}")

    os.makedirs(os.path.join(a.out, "models"), exist_ok=True)
    rdir = os.path.join(a.out, "results")
    os.makedirs(rdir, exist_ok=True)
    joblib.dump({"model": best, "features": a.features, "labels": labels, "name": best_name},
                os.path.join(a.out, "models", "water_condition_model.joblib"))

    # Confusion matrix
    cm = confusion_matrix(yte, pred, labels=labels)
    fig, ax = plt.subplots(figsize=(5, 4.2))
    ConfusionMatrixDisplay(cm, display_labels=labels).plot(ax=ax, cmap="Blues", colorbar=False)
    ax.set_title(f"Confusion matrix - {best_name}")
    fig.tight_layout(); fig.savefig(os.path.join(rdir, "confusion_matrix.png"), dpi=150); plt.close(fig)

    # Feature importance (Random Forest) and readable rules (Decision Tree)
    rf = fitted["Random Forest"]
    fig, ax = plt.subplots(figsize=(5, 3))
    order = np.argsort(rf.feature_importances_)
    ax.barh(np.array(a.features)[order], rf.feature_importances_[order], color="#2563eb")
    ax.set_title("Feature importance (Random Forest)")
    fig.tight_layout(); fig.savefig(os.path.join(rdir, "feature_importance.png"), dpi=150); plt.close(fig)
    rules = export_text(fitted["Decision Tree"], feature_names=list(a.features))
    open(os.path.join(rdir, "decision_tree_rules.txt"), "w").write(rules)

    with open(os.path.join(rdir, "metrics.md"), "w") as f:
        f.write("# Water-condition classifier results\n\n")
        f.write(f"Dataset: {a.csv}  \nFeatures: {', '.join(a.features)}  \n")
        f.write(f"Rows per label: {counts.to_dict()}  \nTrain/test: {len(train)}/{len(test)} (time-ordered split per label)\n\n")
        f.write("| Model | Accuracy | Macro F1 |\n|---|---|---|\n")
        for _, r in res.iterrows():
            f.write(f"| {r['model']} | {r['accuracy']:.3f} | {r['macro_f1']:.3f} |\n")
        f.write(f"\nBest model: **{best_name}**\n\n```\n{report}\n```\n\nDecision tree rules:\n\n```\n{rules}```\n")
    print(f"Saved model to {os.path.join(a.out, 'models')} and results to {rdir}")


if __name__ == "__main__":
    main()
