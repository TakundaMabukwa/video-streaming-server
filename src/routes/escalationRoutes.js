const express = require('express');
const {
  listEscalationGroups,
  createEscalationGroup,
  updateEscalationGroup,
  deleteEscalationGroup,
} = require('../controllers/escalationController');

const router = express.Router();

router.get('/groups', listEscalationGroups);
router.post('/groups', createEscalationGroup);
router.put('/groups/:id', updateEscalationGroup);
router.delete('/groups/:id', deleteEscalationGroup);

module.exports = router;
