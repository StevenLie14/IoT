export type Reading = {
  id: number;
  epoch: number;
  source: string;
  label: string | null;
  t_tank: number | null;
  tds: number | null;
  tds_v: number | null;
  turb: number | null;
  turb_v: number | null;
  f_top: number | null;
  f_bot: number | null;
  score: number | null;
  state: string | null;
  drain: number | null;
  fill: number | null;
  buzzer: number | null;
  auto: number | null;
  ml: string | null;
  ml_conf?: number | null;
  stored?: number;
};

export type Health = {
  mqtt: boolean;
  device: string;
  dataFresh: boolean;
  label: string;
  recording: boolean;
};

export type Prediction = {
  prediction: string;
  confidence?: number | null;
  source: string;
};

export type Stats = {
  n: number;
  events: number;
  device: number;
  sim: number;
  first: number | null;
  labels: { label: string; n: number }[];
};

export type LogEvent = {
  epoch: number;
  type: string;
  name?: string | null;
  value?: number | null;
  detail?: string | null;
};

export type Command = {
  cmd: string;
  sec?: number;
  on?: boolean;
};
