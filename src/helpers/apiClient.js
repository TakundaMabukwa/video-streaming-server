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

  async makeRequest(endpoint, data = {}, timeout = 20000) {
    const token = await this.getToken();
    
    try {
      const response = await axios.post(`${this.baseURL}${endpoint}`, data, {
        headers: {
          'Authorization': token,
          'Content-Type': 'application/json'
        },
        timeout
      });
      return response.data;
    } catch (error) {
      throw new Error(`API request failed: ${error.message}`);
    }
  }

  async getLiveNodes() {
    if (this._cachedNodes && Date.now() < this._nodesCacheExpiry) {
      return this._cachedNodes;
    }
    const response = await this.makeRequest('/video/nodes', {});
    if (response.code === 0 && response.data?.liveNodes?.length > 0) {
      this._cachedNodes = response.data.liveNodes;
      this._nodesCacheExpiry = Date.now() + 10 * 60 * 1000; // cache 10 min
      return this._cachedNodes;
    }
    return [];
  }

  async tryNodesForStream(deviceId, channelId, bitstreamType = 1) {
    let lastResult = null;

    const tryOnce = async (body) => {
      try {
        const result = await this.makeRequest('/video/live', body, 10000);
        if (result.code === 0 && result.data) return result;
        lastResult = result;
      } catch {
        lastResult = lastResult || { code: -1, msg: 'Request failed' };
      }
      return null;
    };

    let result = await tryOnce({ deviceId, channelId, bitstreamType });
    if (result) return result;

    const nodes = await this.getLiveNodes();
    for (const node of nodes) {
      if (!node.nodeValue) continue;
      result = await tryOnce({ deviceId, channelId, bitstreamType, nodeValue: node.nodeValue });
      if (result) return result;
    }
    return lastResult || { code: -1, msg: 'No stream available' };
  }
}

module.exports = new ApiClient();