const express = require('express');
const {
  listAlertDefinitions,
  createAlertDefinition,
  updateAlertDefinition,
  deleteAlertDefinition,
  upsertDefinitionOverride,
  bulkUpsertDefinitionOverrides,
  deleteDefinitionOverride,
  listAlertGroupConfigs,
  createAlertGroupConfig,
  updateAlertGroupConfig,
  deleteAlertGroupConfig,
  upsertGroupConfigOverride,
  bulkUpsertGroupConfigOverrides,
  deleteGroupConfigOverride,
} = require('../controllers/alertConfigController');

const router = express.Router();

// Definition Overrides (CC-specific) — must come before /:id routes
router.put('/definitions/:definition_id/overrides/bulk', bulkUpsertDefinitionOverrides);
router.put('/definitions/:definition_id/overrides', upsertDefinitionOverride);
router.delete('/definitions/:definition_id/overrides/:cc_id', deleteDefinitionOverride);

// Alert Definitions (base/global)
router.get('/definitions', listAlertDefinitions);
router.post('/definitions', createAlertDefinition);
router.put('/definitions/:id', updateAlertDefinition);
router.delete('/definitions/:id', deleteAlertDefinition);

// Group Config Overrides (CC-specific) — must come before /:id routes
router.put('/groups/:group_id/overrides/bulk', bulkUpsertGroupConfigOverrides);
router.put('/groups/:group_id/overrides', upsertGroupConfigOverride);
router.delete('/groups/:group_id/overrides/:cc_id', deleteGroupConfigOverride);

// Alert Group Configs (base/global)
router.get('/groups', listAlertGroupConfigs);
router.post('/groups', createAlertGroupConfig);
router.put('/groups/:id', updateAlertGroupConfig);
router.delete('/groups/:id', deleteAlertGroupConfig);

module.exports = router;
