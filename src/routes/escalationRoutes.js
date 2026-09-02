const express = require('express');
const {
  listEscalationGroups,
  createEscalationGroup,
  updateEscalationGroup,
  deleteEscalationGroup,
  listAlertGroupsForSelection,
} = require('../controllers/escalationController');

const router = express.Router();

router.get('/groups', listEscalationGroups);
router.post('/groups', createEscalationGroup);
router.put('/groups/:id', updateEscalationGroup);
router.delete('/groups/:id', deleteEscalationGroup);

router.get('/alert-groups', listAlertGroupsForSelection);

module.exports = router;
