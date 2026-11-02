export const esc = (v: unknown) =>
  v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
export const wib = (e: number) => new Date((e + 7 * 3600) * 1000).toISOString().replace('T', ' ').slice(0, 19);
export function csvResponse(lines: string[], filename: string) {
  return new Response(lines.join('\n'), {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"` },
  });
}
