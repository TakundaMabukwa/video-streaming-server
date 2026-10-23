const express = require('express');
const {
  listAlertDefinitions,
  createAlertDefinition,
  updateAlertDefinition,
  deleteAlertDefinition,
  upsertDefinitionOverride,
  bulkUpsertDefinitionOverrides,
  deleteDefinitionOverride,
  deleteAllDefinitionOverrides,
  listDefinitionApplicableCcs,
  listAllDefinitionApplicableCcs,
  listAlertGroupConfigs,
  createAlertGroupConfig,
  updateAlertGroupConfig,
  deleteAlertGroupConfig,
  upsertGroupConfigOverride,
  bulkUpsertGroupConfigOverrides,
  deleteGroupConfigOverride,
  listGroupApplicableCcs,
  listAllGroupApplicableCcs,
  listGroupComboWarnings,
} = require('../controllers/alertConfigController');

const router = express.Router();

// Definition Overrides (CC-specific) — must come before /:id routes
router.put('/definitions/:definition_id/overrides/bulk', bulkUpsertDefinitionOverrides);
router.put('/definitions/:definition_id/overrides', upsertDefinitionOverride);
router.delete('/definitions/:definition_id/overrides', deleteAllDefinitionOverrides);
router.delete('/definitions/:definition_id/overrides/:cc_id', deleteDefinitionOverride);

// Applicable cost centers for a definition (which CCs an override exists for)
router.get('/definitions/applicable-ccs', listAllDefinitionApplicableCcs);
router.get('/definitions/:id/applicable-ccs', listDefinitionApplicableCcs);

// Alert Definitions (base/global)
router.get('/definitions', listAlertDefinitions);
router.post('/definitions', createAlertDefinition);
router.put('/definitions/:id', updateAlertDefinition);
router.delete('/definitions/:id', deleteAlertDefinition);

// Group Config Overrides (CC-specific) — must come before /:id routes
router.put('/groups/:group_id/overrides/bulk', bulkUpsertGroupConfigOverrides);
router.put('/groups/:group_id/overrides', upsertGroupConfigOverride);
router.delete('/groups/:group_id/overrides/:cc_id', deleteGroupConfigOverride);

// Applicable cost centers for a group (which CCs an override exists for)
router.get('/groups/applicable-ccs', listAllGroupApplicableCcs);
router.get('/groups/:id/applicable-ccs', listGroupApplicableCcs);

// Combo health: members that are not in a CC's alert set can never complete.
router.get('/groups/combo-warnings', listGroupComboWarnings);

// Alert Group Configs (base/global)
router.get('/groups', listAlertGroupConfigs);
router.post('/groups', createAlertGroupConfig);
router.put('/groups/:id', updateAlertGroupConfig);
router.delete('/groups/:id', deleteAlertGroupConfig);

module.exports = router;
