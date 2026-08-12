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
      console.log('[METTAX AUTH] Request URL:', `${this.baseURL}/system/createToken`);
      console.log('[METTAX AUTH] Request Body:', JSON.stringify(requestBody, null, 2));
      console.log('[METTAX AUTH] Request Headers:', { 'Content-Type': 'application/json' });
      
      const response = await axios.post(`${this.baseURL}/system/createToken`, requestBody, {
        headers: { 'Content-Type': 'application/json' },
        httpsAgent
      });

      console.log('[METTAX AUTH] Response Status:', response.status);
      console.log('[METTAX AUTH] Response Data:', JSON.stringify(response.data, null, 2));

      if (response.data.code === 0) {
        this.token = response.data.data;
        this.tokenExpiry = Date.now() + (4 * 60 * 60 * 1000); // 4 hours
        console.log('[METTAX AUTH] Token obtained successfully, expires in 4 hours');
        return this.token;
      }
      throw new Error(response.data.msg || 'Token creation failed');
    } catch (error) {
      if (error.response) {
        console.error('[METTAX AUTH] Error Response Status:', error.response.status);
        console.error('[METTAX AUTH] Error Response Data:', JSON.stringify(error.response.data, null, 2));
        console.error('[METTAX AUTH] Error Response Headers:', JSON.stringify(error.response.headers, null, 2));
      }
      throw new Error(`Authentication failed: ${error.message}`);
    }
  }

  async makeRequest(endpoint, data = {}, timeout = 20000) {
    const token = await this.getToken();
    console.log('[METTAX API] Request URL:', `${this.baseURL}${endpoint}`);
    console.log('[METTAX API] Request Body:', JSON.stringify(data, null, 2));
    console.log('[METTAX API] Request Headers:', { 'Authorization': token, 'Content-Type': 'application/json' });
    
    try {
      const response = await axios.post(`${this.baseURL}${endpoint}`, data, {
        headers: {
          'Authorization': token,
          'Content-Type': 'application/json'
        },
        timeout,
        httpsAgent
      });
      console.log('[METTAX API] Response Status:', response.status);
      console.log('[METTAX API] Response Data:', JSON.stringify(response.data, null, 2));
      return response.data;
    } catch (error) {
      if (error.response) {
        console.error('[METTAX API] Error Response Status:', error.response.status);
        console.error('[METTAX API] Error Response Data:', JSON.stringify(error.response.data, null, 2));
        console.error('[METTAX API] Error Response Headers:', JSON.stringify(error.response.headers, null, 2));
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