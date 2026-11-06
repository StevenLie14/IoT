import { requireAuth } from '@/lib/auth';
import { csvResponse, escapeCsv, toWib } from '@/lib/csv';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

// Dataset Column
const DATA_COLUMNS = ['t_tank', 'tds', 'tds_v', 'turb', 'turb_v', 'label'];

const PUMP_QUIET_SECONDS = 5;


// Buat download dataset dari esp ke csv 
export async function GET(request: Request) {
  const denied = await requireAuth(request);
  if (denied) return denied;

  
  const result = await query("SELECT reading.* FROM readings reading WHERE reading.source = 'device' AND NOT EXISTS (SELECT 1 FROM readings pump WHERE pump.source = reading.source AND (pump.drain = 1 OR pump.fill = 1) AND pump.epoch BETWEEN reading.epoch - $1 AND reading.epoch) ORDER BY reading.id", [PUMP_QUIET_SECONDS]);

  const lines = [['timestamp_wib', ...DATA_COLUMNS].join(',')];
  for (const row of result.rows) {
    const values = [toWib(row.epoch), ...DATA_COLUMNS.map((column) => row[column])];
    lines.push(values.map(escapeCsv).join(','));
  }

  const date = new Date().toISOString().slice(0, 10);
  return csvResponse(lines, `iot_project_dataset_${date}.csv`);
}
