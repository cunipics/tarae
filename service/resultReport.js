function toIsoTime(value) {
  if (!value) return null;
  const date = new Date(String(value).includes('T') ? value : String(value).replace(' ', 'T'));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function comparableUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:') url.protocol = 'https:';
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    const params = [...url.searchParams.entries()].sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
    url.search = '';
    for (const [key, val] of params) url.searchParams.append(key, val);
    return url.toString();
  } catch (error) {
    return String(value || '');
  }
}

const STANDARD_TECHNIQUES = new Set(['JAMO', 'HOMOGLYPH', 'TRANSPARENT', 'OFFSCREEN']);
const EXTRA_TECHNIQUES = new Set(['ETC', 'NONSTANDARD_PORT', 'REFLECTED_SEARCH']);

function normalizedTechnique(value) {
  return STANDARD_TECHNIQUES.has(value) || EXTRA_TECHNIQUES.has(value) ? value : 'ETC';
}

function uniqueFindingRows(rows) {
  const seen = new Set();
  return rows.filter(row => {
    const key = [comparableUrl(row.url), row.location, normalizedTechnique(row.technique)].join('\u001f');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildResultReports(master, rows) {
  const start = toIsoTime(master.started_at);
  const finish = toIsoTime(master.finished_at) || new Date().toISOString();
  const measuredSeconds = start ? Math.max(0, Math.round((Date.parse(finish) - Date.parse(start)) / 1000)) : 0;
  const elapsed = measuredSeconds > 0 ? measuredSeconds : Math.max(0, Number(master.elapsed_sec) || 0);
  const meta = {
    topic: 'TOPIC',
    entry_url: master.entry_url,
    started_at: start,
    finished_at: finish,
    elapsed_sec: elapsed,
    tool_version: master.tool_version || '1.0.0'
  };

  const main = { meta, findings: [] };
  const extra = { meta, findings: [] };
  const uniqueRows = uniqueFindingRows(rows);
  for (const row of uniqueRows) {
    const technique = normalizedTechnique(row.technique);

    const target = STANDARD_TECHNIQUES.has(technique) ? main : extra;
    const finding = {
      id: `f_${String(target.findings.length + 1).padStart(3, '0')}`,
      url: row.url,
      is_violation: row.is_violation === true || row.is_violation === 1,
      location: row.location,
      evidence_text: row.evidence_text,
      technique
    };
    if (target === extra) finding.extra_finding = row.extra_finding || '추가 탐지';
    target.findings.push(finding);
  }

  return {
    main,
    extra,
    counts: {
      main: main.findings.length,
      extra: extra.findings.length,
      raw: rows.length,
      duplicate: rows.length - uniqueRows.length
    }
  };
}

module.exports = { buildResultReports, uniqueFindingRows };
