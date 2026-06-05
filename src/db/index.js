const { query, closePool } = require('./pool');
const { initializeDatabase } = require('./schema');
const alerts = require('./alerts');
const media = require('./media');
const documents = require('./documents');
const alertGroups = require('./alert_groups');

module.exports = {
  query,
  closePool,
  initializeDatabase,
  ...alerts,
  ...media,
  ...documents,
  ...alertGroups,
};
