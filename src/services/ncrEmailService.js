// Server-side NCR escalation email.
//
// The browser used to build this email and hand it to the outbox. Now the
// background job builds it from the STORED form data, so the escalation goes
// out even if the operator's tab closed right after saving the NCR.
const db = require('../db');

const RISK_COLORS = { high: '#dc2626', medium: '#d97706', low: '#2563eb' };

function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function chip(text, color) {
  return `<span style="display:inline-block;background:${color}1a;color:${color};border:1px solid ${color}55;border-radius:999px;padding:2px 9px;font-size:12px;font-weight:700;margin:0 4px 4px 0">${esc(text)}</span>`;
}
function detailRow(label, valueHtml, isLast = false) {
  return `<tr>
  <td style="padding:9px 12px;border-bottom:1px solid #e2e8f0;color:#64748b;font-size:12px;width:34%;vertical-align:top;${isLast ? '' : ''}">${esc(label)}</td>
  <td style="padding:9px 12px;border-bottom:1px solid #e2e8f0;color:#1e293b;font-size:13px;line-height:1.55;${isLast ? 'border-bottom:none;' : ''}">${valueHtml}</td>
</tr>`;
}

function buildHtml(p = {}) {
  const risk = String(p.riskRating || '').toLowerCase();
  const riskChip = risk ? chip(risk.charAt(0).toUpperCase() + risk.slice(1), RISK_COLORS[risk] || '#64748b') : '';
  const classChips = (p.classifications || []).filter(Boolean).map((c) => chip(c, '#0f172a')).join('');
  const rootCauseText = (p.rootCauses || []).filter(Boolean).join(', ');
  const vehicle = [p.fleetNumber, p.registration ? `Reg ${p.registration}` : null].filter(Boolean).join(' &middot; ');

  const rows = [
    p.ncrNo ? detailRow('NCR number', `<span style="font-weight:700">${esc(p.ncrNo)}</span>`) : '',
    p.alertId ? detailRow('Alert', `${esc(p.alertId)}${p.alertType ? ` &nbsp;&middot;&nbsp; ${esc(p.alertType)}` : ''}${p.severity ? ` &nbsp;&middot;&nbsp; <span style="color:#dc2626;font-weight:700">${esc(p.severity)}</span>` : ''}`) : '',
    detailRow('Date / time', `${esc(p.date || '')}${p.time ? ` &nbsp;${esc(p.time)}` : ''}${p.lastOccurrence ? `<br><span style="color:#64748b">Last occurrence: ${esc(p.lastOccurrence)}</span>` : ''}`),
    detailRow('Vehicle', vehicle ? `<span style="font-weight:700">${vehicle}</span>` : '—'),
    detailRow('Driver', esc(p.driverName || 'Unknown')),
    p.secondDriverName ? detailRow('Second driver', esc(p.secondDriverName)) : '',
    detailRow('Department', `${esc(p.department || '—')}${p.responsibleManager ? ` &nbsp;&middot;&nbsp; Manager: ${esc(p.responsibleManager)}` : ''}${p.section ? ` &nbsp;&middot;&nbsp; Section: ${esc(p.section)}` : ''}`),
    p.site || p.location ? detailRow('Location', `${esc(p.site || '')}${p.site && p.location ? '<br>' : ''}${esc(p.location || '')}`) : '',
    p.duration ? detailRow('Duration', esc(p.duration)) : '',
    classChips || (p.classifications || []).length ? detailRow('Classification', classChips || '—') : '',
    riskChip ? detailRow('Risk rating', riskChip) : '',
    rootCauseText ? detailRow('Root causes', esc(rootCauseText)) : '',
    p.description ? detailRow('Description', esc(p.description).replace(/\n/g, '<br>')) : '',
    p.correctiveAction ? detailRow('Corrective action', esc(p.correctiveAction).replace(/\n/g, '<br>')) : '',
    p.preventiveAction ? detailRow('Preventive action', esc(p.preventiveAction).replace(/\n/g, '<br>')) : '',
    p.investigator || p.manager ? detailRow('Investigation', `${p.investigator ? `Investigator: ${esc(p.investigator)}` : ''}${p.investigator && p.manager ? '<br>' : ''}${p.manager ? `Manager: ${esc(p.manager)}` : ''}`, !p.documentUrl) : '',
    p.documentUrl ? detailRow('NCR document', `<a href="${esc(p.documentUrl)}" style="color:#2563eb;font-weight:700">Download the signed NCR report (PDF)</a>`, true) : '',
  ].join('');

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:#f1f5f9;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-text-size-adjust:100%">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f1f5f9">
    <tr><td align="center" style="padding:28px 12px">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:#ffffff;border-radius:10px;border:1px solid #e2e8f0;overflow:hidden">
        <tr>
          <td style="background-color:#0f172a;padding:22px 28px">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="font-size:20px;font-weight:800;color:#ffffff;letter-spacing:0.5px">SRS</td>
                <td align="right" style="font-size:12px;color:#94a3b8;text-transform:uppercase;letter-spacing:1.2px">Non-Conformance Report</td>
              </tr>
            </table>
          </td>
        </tr>
        <tr><td style="height:4px;background-color:#dc2626;font-size:0;line-height:0">&nbsp;</td></tr>
        <tr>
          <td style="padding:28px 28px 6px 28px">
            <div style="font-size:16px;font-weight:700;color:#0f172a;line-height:1.4">A Non-Conformance Report has been issued${p.ncrNo ? ` — reference <span style="color:#dc2626">${esc(p.ncrNo)}</span>` : ''}</div>
            <div style="font-size:15px;color:#334155;line-height:1.6;margin-top:10px">
              This NCR was raised from a video alert and is routed to your escalation group for review and follow-up.
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 28px 4px 28px">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e2e8f0;border-radius:8px;border-collapse:separate;overflow:hidden">${rows}</table>
          </td>
        </tr>
        <tr>
          <td style="padding:18px 28px 10px 28px;font-size:14px;color:#334155;line-height:1.6">
            Please review the report and take the necessary corrective and preventive action.
          </td>
        </tr>
        <tr>
          <td style="padding:16px 28px 26px 28px;border-top:1px solid #e2e8f0">
            <div style="font-size:12px;color:#94a3b8;line-height:1.6;padding-top:12px">
              This is an automated notification from SRS &middot; Please do not reply to this email.
            </div>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

const coversNcr = (ids, costCenterId) =>
  Array.isArray(ids) && ids.map((n) => Number(n)).includes(Number(costCenterId));

async function resolveVehicleCostCenter(fleetNumber, registration) {
  const fleet = String(fleetNumber || '').trim();
  const reg = String(registration || '').trim();
  if (!fleet && !reg) return { costCenterId: null, costCenterName: null, vehicleFound: false };
  try {
    const { fetchVehiclesFromSupabase } = require('../helpers/supabaseClient');
    const rows = await fetchVehiclesFromSupabase();
    const list = Array.isArray(rows) ? rows : (rows?.data || []);
    const match = list.find((v) => {
      const vf = String(v?.fleet_number || '').trim().toUpperCase();
      const vr = String(v?.registration_number || '').trim().toUpperCase();
      if (fleet && vf === fleet.toUpperCase()) return true;
      if (reg && vr === reg.toUpperCase()) return true;
      return false;
    });
    if (!match) return { costCenterId: null, costCenterName: null, vehicleFound: false };
    const ccId = match.cost_center_id != null ? Number(match.cost_center_id) : null;
    return {
      costCenterId: ccId && ccId > 0 ? ccId : null,
      costCenterName: match.cost_center || match.cost_centres || null,
      vehicleFound: true,
    };
  } catch (err) {
    throw new Error(`Could not resolve the vehicle cost center: ${err.message}`);
  }
}

async function escalationGroupsForCostCenter(costCenterId) {
  const groups = await db.query(
    'SELECT * FROM escalation_groups WHERE cost_center_id = $1 ORDER BY name',
    [Number(costCenterId)]
  );
  const groupIds = groups.rows.map((g) => g.id);
  let membersByGroup = {};
  if (groupIds.length > 0) {
    const members = await db.query(
      `SELECT em.escalation_group_id, em.email, em.is_active
       FROM escalation_group_members em
       WHERE em.escalation_group_id = ANY($1)
       ORDER BY em.email`,
      [groupIds]
    );
    for (const m of members.rows) {
      if (!membersByGroup[m.escalation_group_id]) membersByGroup[m.escalation_group_id] = [];
      membersByGroup[m.escalation_group_id].push(m);
    }
  }
  return groups.rows.map((g) => ({
    ...g,
    ncr_cost_center_ids: g.ncr_cost_center_ids || [],
    members: membersByGroup[g.id] || [],
  }));
}

/**
 * Build + queue the escalation email for a stored NCR.
 * @param {object} payload  { ncrFormId } or the NCR payload fields
 */
async function enqueueEscalationEmail(payload = {}) {
  const form = payload.form || {};
  const ncrNo = String(form.ncrNo || payload.ncrNo || '').trim();
  if (!ncrNo) throw new Error('ncrNo is required');

  const html = buildHtml({
    ncrNo,
    alertId: form.alertId,
    alertType: form.alertType,
    severity: form.alertSeverity,
    date: form.date,
    time: form.time,
    lastOccurrence: form.lastOccurrence,
    fleetNumber: form.vehicleFleetNumber || form.fleetNumber,
    registration: form.vehicleRegistration,
    driverName: form.driverName,
    secondDriverName: form.secondDriverName,
    department: form.department,
    responsibleManager: form.responsibleManager,
    section: form.section,
    site: form.site,
    location: form.location,
    duration: form.duration,
    classifications: form.classifications || [],
    riskRating: form.riskRating,
    rootCauses: form.rootCauses || [],
    description: form.description,
    correctiveAction: form.correctiveAction,
    preventiveAction: form.preventiveAction,
    investigator: form.investigator,
    manager: form.manager,
    documentUrl: payload.documentUrl || form.documentUrl || null,
  });
  const subject = `NCR ${ncrNo}`;

  const vehicle = await resolveVehicleCostCenter(
    form.vehicleFleetNumber || form.fleetNumber,
    form.vehicleRegistration
  );
  if (!vehicle.costCenterId) {
    return {
      queued: false,
      recipients: 0,
      note: vehicle.vehicleFound
        ? 'Vehicle has no cost center — no escalation group to notify'
        : 'No vehicle found for this fleet/registration — no escalation group to notify',
    };
  }

  const groups = await escalationGroupsForCostCenter(vehicle.costCenterId);
  const targets = groups
    .filter((g) => coversNcr(g.ncr_cost_center_ids, vehicle.costCenterId))
    .map((g) => ({
      name: g.name,
      to: [...new Set((g.members || []).filter((m) => m.is_active !== false && m.email).map((m) => String(m.email).trim()))],
    }))
    .filter((g) => g.to.length > 0);

  if (targets.length === 0) {
    return { queued: false, recipients: 0, note: 'No active escalation group covers this cost center for NCRs' };
  }

  let queued = 0;
  for (const g of targets) {
    await db.query(
      `INSERT INTO ncr_email_outbox (to_addrs, subject, html, ncr_no, group_name)
       VALUES ($1::text[], $2, $3, $4, $5)`,
      [g.to, subject, html, ncrNo, g.name]
    );
    queued += 1;
  }
  return {
    queued: true,
    groups: queued,
    recipients: targets.reduce((n, g) => n + g.to.length, 0),
  };
}

module.exports = { enqueueEscalationEmail, buildHtml };
