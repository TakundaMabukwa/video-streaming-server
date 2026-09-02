const express = require('express');
const {
  listEscalationGroups,
  createEscalationGroup,
  updateEscalationGroup,
  deleteEscalationGroup,
  searchAlertDefinitions,
} = require('../controllers/escalationController');

const router = express.Router();

router.get('/groups', listEscalationGroups);
router.post('/groups', createEscalationGroup);
router.put('/groups/:id', updateEscalationGroup);
router.delete('/groups/:id', deleteEscalationGroup);

router.get('/alerts', searchAlertDefinitions);

module.exports = router;
