// Model kualitas air untuk ESP32, dibuat otomatis oleh ml/export_tree.py (micromlgen).
// Jangan diedit manual, train ulang aja kalau datanya berubah.
// Random Forest 10 tree, depth 3, 54 node, 1022 data
// Input: x[0] = tds, x[1] = turb_v | akurasi test: 1.000
#pragma once
#include <cstdarg>
namespace Eloquent {
    namespace ML {
        namespace Port {
            class RandomForest {
                public:
                    /**
                    * Predict class for features vector
                    */
                    int predict(float *x) {
                        uint8_t votes[3] = { 0 };
                        // tree #1
                        if (x[1] <= 1.6675000190734863) {
                            if (x[0] <= 666.2000122070312) {
                                votes[2] += 1;
                            }

                            else {
                                votes[1] += 1;
                            }
                        }

                        else {
                            votes[0] += 1;
                        }

                        // tree #2
                        if (x[0] <= 665.5000152587891) {
                            if (x[0] <= 311.90000915527344) {
                                votes[0] += 1;
                            }

                            else {
                                votes[2] += 1;
                            }
                        }

                        else {
                            votes[1] += 1;
                        }

                        // tree #3
                        if (x[0] <= 666.2000122070312) {
                            if (x[1] <= 1.6665000319480896) {
                                votes[2] += 1;
                            }

                            else {
                                votes[0] += 1;
                            }
                        }

                        else {
                            votes[1] += 1;
                        }

                        // tree #4
                        if (x[0] <= 312.0) {
                            votes[0] += 1;
                        }

                        else {
                            if (x[0] <= 666.2000122070312) {
                                votes[2] += 1;
                            }

                            else {
                                votes[1] += 1;
                            }
                        }

                        // tree #5
                        if (x[1] <= 1.6669999957084656) {
                            if (x[1] <= 1.456999957561493) {
                                if (x[1] <= 1.4519999623298645) {
                                    votes[1] += 1;
                                }

                                else {
                                    votes[1] += 1;
                                }
                            }

                            else {
                                if (x[0] <= 665.5000152587891) {
                                    votes[2] += 1;
                                }

                                else {
                                    votes[1] += 1;
                                }
                            }
                        }

                        else {
                            votes[0] += 1;
                        }

                        // tree #6
                        if (x[1] <= 1.6610000133514404) {
                            if (x[0] <= 661.8500061035156) {
                                votes[2] += 1;
                            }

                            else {
                                votes[1] += 1;
                            }
                        }

                        else {
                            votes[0] += 1;
                        }

                        // tree #7
                        if (x[0] <= 665.5000152587891) {
                            if (x[0] <= 312.0) {
                                votes[0] += 1;
                            }

                            else {
                                votes[2] += 1;
                            }
                        }

                        else {
                            votes[1] += 1;
                        }

                        // tree #8
                        if (x[0] <= 666.2000122070312) {
                            if (x[1] <= 1.6675000190734863) {
                                votes[2] += 1;
                            }

                            else {
                                votes[0] += 1;
                            }
                        }

                        else {
                            votes[1] += 1;
                        }

                        // tree #9
                        if (x[0] <= 666.2000122070312) {
                            if (x[0] <= 311.90000915527344) {
                                votes[0] += 1;
                            }

                            else {
                                votes[2] += 1;
                            }
                        }

                        else {
                            votes[1] += 1;
                        }

                        // tree #10
                        if (x[1] <= 1.668999969959259) {
                            if (x[0] <= 668.75) {
                                votes[2] += 1;
                            }

                            else {
                                votes[1] += 1;
                            }
                        }

                        else {
                            votes[0] += 1;
                        }

                        // return argmax of votes
                        uint8_t classIdx = 0;
                        float maxVotes = votes[0];

                        for (uint8_t i = 1; i < 3; i++) {
                            if (votes[i] > maxVotes) {
                                classIdx = i;
                                maxVotes = votes[i];
                            }
                        }

                        return classIdx;
                    }

                    /**
                    * Predict readable class name
                    */
                    const char* predictLabel(float *x) {
                        return idxToLabel(predict(x));
                    }

                    /**
                    * Convert class idx to readable name
                    */
                    const char* idxToLabel(uint8_t classIdx) {
                        switch (classIdx) {
                            case 0:
                            return "clear";
                            case 1:
                            return "dirty";
                            case 2:
                            return "slightly_turbid";
                            default:
                            return "Houston we have a problem";
                        }
                    }

                protected:
                };
            }
        }
    }

#define WATER_MODEL_AVAILABLE 1
#define WATER_MODEL_CLASSES 3

static const char* const WATER_LABELS[] = {"clear", "dirty", "slightly_turbid"};
static const char* const WATER_SHORT[]  = {"CLEAR", "DIRTY", "SLIGHT"};

// Dipanggil dari iot_project.ino, return index ke WATER_LABELS
inline int classifyWaterFromReadings(float tds, float tds_v, float turb, float turb_v, float t_tank) {
  (void)tds_v; (void)turb; (void)t_tank;  // ga dipakai model
  static Eloquent::ML::Port::RandomForest model;
  float x[] = {tds, turb_v};
  return model.predict(x);
}
