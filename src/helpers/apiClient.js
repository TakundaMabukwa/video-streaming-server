const axios = require('axios');
const https = require('https');
const fs = require('fs');
const path = require('path');
const config = require('../config/config');

const skycamxCerts = [];
const certBundlePath = path.join(__dirname, '../../certs/skycamx-ca-bundle.pem');
try {
  if (fs.existsSync(certBundlePath)) {
    skycamxCerts.push(fs.readFileSync(certBundlePath));
    console.log('[API] Loaded skycamx CA certificate from', certBundlePath);
  }
} catch (e) {
  console.warn('[API] Could not load skycamx cert bundle:', e.message);
}

const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
  ca: skycamxCerts.length > 0 ? skycamxCerts : undefined,
});

class ApiClient {
  constructor() {
    // Use new skycamx.co.za base URL from env, fallback to mettaxiot.com
    this.baseURL = process.env.NEXT_PUBLIC_VIDEO_BASE_URL || 'https://www.skycamx.co.za/gps/v2/openapi';
    this.token = null;
    this.tokenExpiry = null;
  }

  async getToken() {
    if (this.token && this.tokenExpiry && Date.now() < this.tokenExpiry) {
      return this.token;
    }

    try {
      const requestBody = {
        apiKey: config.videoApiKey,
        apiSecret: config.videoApiSecret
      };
      const response = await axios.post(`${this.baseURL}/system/createToken`, requestBody, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000,
        httpsAgent
      });

      if (response.data.code === 0) {
        this.token = response.data.data;
        this.tokenExpiry = Date.now() + (4 * 60 * 60 * 1000); // 4 hours
        return this.token;
      }
      throw new Error(response.data.msg || 'Token creation failed');
    } catch (error) {
      if (error.response) {
        console.error('[METTAX AUTH] failed:', error.response.status, error.response.data?.msg || error.message);
      }
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
        timeout,
        httpsAgent
      });
      return response.data;
    } catch (error) {
      if (error.response) {
        console.error('[METTAX API]', endpoint, 'failed:', error.response.status, error.response.data?.msg || error.message);
      }
      if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
        throw new Error('Connection timed out. The device may be offline or unreachable.');
      }
      if (error.code === 'ENOTFOUND' || error.code === 'ENETUNREACH') {
        throw new Error('Network error. Please check your internet connection.');
      }
      throw new Error(error.message || 'Request failed');
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
      } catch (error) {
        lastResult = { code: -1, msg: error.message || 'Request failed' };
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