'use strict';
const assert = require('assert');
const catalog = require('../src/alerts/catalog');
const zoneNotifications = require('../src/services/zoneNotifications');

let passed = 0;
function check(name, condition, detail) {
  if (!condition) throw new Error(`${name}${detail ? `: ${detail}` : ''}`);
  passed += 1;
  console.log(`  PASS  ${name}`);
}

const events = [];
zoneNotifications.setBroadcast((event) => events.push(event));

check('classifies approaching zone', catalog.isSelfMonitoringZoneAlert({ signalCode: catalog.ZONE_APPROACHING_CODE }));
check('classifies entering high risk', catalog.isSelfMonitoringZoneAlert({ signalCode: catalog.ZONE_ENTRY_CODE }));
check('classifies entering no-go', catalog.isSelfMonitoringZoneAlert({ signalCode: catalog.NOGO_ENTRY_CODE }));
check('classifies entering no stopping', catalog.isSelfMonitoringZoneAlert({ signalCode: catalog.NO_STOP_ENTRY_CODE }));
check('classifies signal loss', catalog.isSelfMonitoringZoneAlert({ signalCode: catalog.SIGNAL_LOSS_ENTRY_CODE }));
check('classifies by alarm name', catalog.isSelfMonitoringZoneAlert({ alarmType: 'Entering Signal Loss Area' }));
check('does not classify stop alert', !catalog.isSelfMonitoringZoneAlert({ signalCode: catalog.ZONE_STOP_IMMEDIATE_CODE }));

check('high-risk entry by code is Geotab archive-only', catalog.isHighRiskEntryAlert({ signalCode: catalog.ZONE_ENTRY_CODE }));
check('high-risk entry by name is Geotab archive-only', catalog.isHighRiskEntryAlert({ name: 'Entering High Risk Area' }));
check('no-go entry is not high-risk archive-only', !catalog.isHighRiskEntryAlert({ name: 'Entering No-Go Zone', signalCode: catalog.NOGO_ENTRY_CODE }));
check('no-stopping entry is not high-risk archive-only', !catalog.isHighRiskEntryAlert({ name: 'Entering No Stopping Zone', signalCode: catalog.NO_STOP_ENTRY_CODE }));
check('approaching is not high-risk archive-only', !catalog.isHighRiskEntryAlert({ signalCode: catalog.ZONE_APPROACHING_CODE }));
check('signal loss is not high-risk archive-only', !catalog.isHighRiskEntryAlert({ signalCode: catalog.SIGNAL_LOSS_ENTRY_CODE }));
check('stop alert is not high-risk archive-only', !catalog.isHighRiskEntryAlert({ signalCode: catalog.ZONE_STOP_IMMEDIATE_CODE }));
check('null def is not high-risk archive-only', !catalog.isHighRiskEntryAlert(null));

const first = zoneNotifications.upsert({
  fleet_number: 'B29',
  kind: 'approaching',
  alert_type: 'Approaching Zone',
  zone_id: 'zone-1',
  zone_name: 'Test Zone',
  severity: 'medium',
  eta_seconds: 20,
});
const second = zoneNotifications.upsert({
  fleet_number: 'B29',
  kind: 'approaching',
  alert_type: 'Approaching Zone',
  zone_id: 'zone-1',
  zone_name: 'Test Zone',
  severity: 'medium',
  eta_seconds: 10,
});
check('approach upsert dedupes', first.id === second.id);
check('approach upsert refreshes ETA', second.eta_seconds === 10);
check('snapshot contains notification', zoneNotifications.snapshot().some((row) => row.id === first.id));
check('broadcast upsert emitted', events.filter((event) => event.type === 'ZONE_NOTIFICATION_UPSERT').length >= 2);

zoneNotifications.removeApproach('B29', 'zone-1');
check('approach remove clears notification', !zoneNotifications.snapshot().some((row) => row.id === first.id));
check('broadcast remove emitted', events.some((event) => event.type === 'ZONE_NOTIFICATION_REMOVE' && event.id === first.id));

const entry = zoneNotifications.upsert({
  fleet_number: 'B29',
  kind: 'entering',
  alert_type: 'Entering No-Go Zone',
  zone_id: 'zone-2',
  zone_name: 'No-Go Zone',
  severity: 'critical',
});
check('entry created', !!entry);
zoneNotifications.removeEntry('B29', 'zone-2');
check('entry removed on exit', !zoneNotifications.snapshot().some((row) => row.id === entry.id));

const expired = zoneNotifications.upsert({
  fleet_number: 'B30',
  kind: 'signal_loss',
  alert_type: 'Entering Signal Loss Area',
  zone_name: 'Signal area',
  severity: 'critical',
});
expired.expires_at = Date.now() - 1;
zoneNotifications.sweep();
check('expired notification swept', !zoneNotifications.snapshot().some((row) => row.id === expired.id));

console.log(`zone-notifications: ${passed} passed, 0 failed`);
