const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const config = require('./config/config');
const routes = require('./routes');
const { sendError } = require('./helpers/response');

const app = express();

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(cors());

// Body parsing middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files
app.use(express.static('public'));
app.use('/js', express.static('node_modules'));

// Routes
app.use('/api', routes);

// 404 handler
app.use('*', (req, res) => {
  sendError(res, 'Route not found', 404);
});

// Global error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  sendError(res, 'Something went wrong!', 500);
});

app.listen(config.port, () => {
  console.log(`Server running on port ${config.port} in ${config.nodeEnv} mode`);
});
