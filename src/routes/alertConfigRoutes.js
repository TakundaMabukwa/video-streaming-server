const express = require('express');
const {
  listAlertDefinitions,
  createAlertDefinition,
  updateAlertDefinition,
  deleteAlertDefinition,
  listAlertGroupConfigs,
  createAlertGroupConfig,
  updateAlertGroupConfig,
  deleteAlertGroupConfig,
} = require('../controllers/alertConfigController');

const router = express.Router();

// Alert Definitions
router.get('/definitions', listAlertDefinitions);
router.post('/definitions', createAlertDefinition);
router.put('/definitions/:id', updateAlertDefinition);
router.delete('/definitions/:id', deleteAlertDefinition);

// Alert Group Configs
router.get('/groups', listAlertGroupConfigs);
router.post('/groups', createAlertGroupConfig);
router.put('/groups/:id', updateAlertGroupConfig);
router.delete('/groups/:id', deleteAlertGroupConfig);

module.exports = router;
