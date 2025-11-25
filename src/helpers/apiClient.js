const axios = require('axios');
const config = require('../config/config');

class ApiClient {
  constructor() {
    this.baseURL = 'https://mettahub.mettaxiot.com/gps/v2/openapi';
    this.token = null;
    this.tokenExpiry = null;
  }

  async getToken() {
    if (this.token && this.tokenExpiry && Date.now() < this.tokenExpiry) {
      return this.token;
    }

    try {
      const response = await axios.post(`${this.baseURL}/system/createToken`, {
        apiKey: config.videoApiKey,
        apiSecret: config.videoApiSecret
      }, {
        headers: { 'Content-Type': 'application/json' }
      });

      if (response.data.code === 0) {
        this.token = response.data.data;
        this.tokenExpiry = Date.now() + (4 * 60 * 60 * 1000); // 4 hours
        return this.token;
      }
      throw new Error(response.data.msg || 'Token creation failed');
    } catch (error) {
      throw new Error(`Authentication failed: ${error.message}`);
    }
  }

  async makeRequest(endpoint, data = {}) {
    const token = await this.getToken();
    
    try {
      const response = await axios.post(`${this.baseURL}${endpoint}`, data, {
        headers: {
          'Authorization': token,
          'Content-Type': 'application/json'
        }
      });
      return response.data;
    } catch (error) {
      throw new Error(`API request failed: ${error.message}`);
    }
  }
}

module.exports = new ApiClient();