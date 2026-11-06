// Buat ubah data jadi csv

export function escapeCsv(value: unknown) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

// Waktu Unix -> "YYYY-MM-DD HH:MM:SS" dalam WIB (UTC+7)
export function toWib(epoch: number) {
  return new Date((epoch + 7 * 3600) * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

// Bikin response yang langsung ke-download sebagai file CSV
export function csvResponse(lines: string[], filename: string) {
  return new Response(lines.join('\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}
