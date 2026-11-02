// Placeholder: no model trained yet.
// Run `python ml/export_tree.py --csv <dataset.csv>` to replace this file with the trained tree.
#pragma once

#define WATER_MODEL_AVAILABLE 0
#define WATER_MODEL_CLASSES 0

static const char* const WATER_LABELS[] = {""};
static const char* const WATER_SHORT[]  = {""};

inline int classifyWaterFromReadings(float tds, float tds_v, float turb, float turb_v, float t_tank) {
  (void)tds; (void)tds_v; (void)turb; (void)turb_v; (void)t_tank;
  return -1;   // no model
}
